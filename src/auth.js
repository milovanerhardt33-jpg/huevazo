import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { query } from './db.js';
import { config } from './config.js';
import { HttpError } from './errores.js';

const scrypt = promisify(crypto.scrypt);
const PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const COOKIE = 'hz_sesion';

export async function hashPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10 || pw.length > 200) {
    throw new HttpError(422, 'La contraseña debe tener entre 10 y 200 caracteres');
  }
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw.normalize('NFKC'), salt, 32, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${h.toString('base64')}`;
}

export async function verificarPassword(pw, guardado) {
  const [alg, N, r, p, salt, hash] = String(guardado).split('$');
  if (alg !== 'scrypt') return false;
  const esperado = Buffer.from(hash, 'base64');
  const h = await scrypt(String(pw).normalize('NFKC'), Buffer.from(salt, 'base64'), esperado.length,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem });
  return crypto.timingSafeEqual(h, esperado);
}

// Hash ficticio para que un email inexistente tarde lo mismo que uno real.
const HASH_FICTICIO = await hashPassword('contraseña-ficticia-para-tiempos');

// Límite de intentos fallidos por IP + email (en memoria; con varias instancias usar Redis).
const intentos = new Map();
const VENTANA = 15 * 60 * 1000, MAX_FALLOS = 5;
function bloqueado(k) {
  const e = intentos.get(k);
  if (!e) return false;
  if (Date.now() - e.desde > VENTANA) { intentos.delete(k); return false; }
  return e.n >= MAX_FALLOS;
}
function fallo(k) {
  const e = intentos.get(k);
  if (!e || Date.now() - e.desde > VENTANA) intentos.set(k, { n: 1, desde: Date.now() });
  else e.n++;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

export async function iniciarSesion(email, password, ip, ua) {
  const clave = `${ip}|${String(email).toLowerCase()}`;
  if (bloqueado(clave)) throw new HttpError(429, 'Demasiados intentos. Esperá 15 minutos.');
  const { rows: [u] } = await query(
    'SELECT id, password_hash, activo FROM usuarios WHERE email = $1', [String(email).trim().toLowerCase()]);
  const ok = await verificarPassword(password, u ? u.password_hash : HASH_FICTICIO);
  if (!u || !ok || !u.activo) {
    fallo(clave);
    throw new HttpError(401, 'Email o contraseña incorrectos');
  }
  intentos.delete(clave);
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO sesiones (token_hash, usuario_id, expira, ip, user_agent)
     VALUES ($1, $2, now() + make_interval(hours => $3), $4, $5)`,
    [sha256(token), u.id, config.sessionHours, ip, String(ua || '').slice(0, 200)]);
  return token;
}

export async function cerrarSesion(token) {
  if (token) await query('DELETE FROM sesiones WHERE token_hash = $1', [sha256(token)]);
}

export function leerToken(req) {
  const c = req.headers.cookie || '';
  for (const parte of c.split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function cookieSesion(token, maxAgeSeg) {
  return [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeg}`,
    config.cookieSecure ? 'Secure' : ''].filter(Boolean).join('; ');
}

/** Middleware: identifica al usuario a partir de la sesión. El rol sale siempre de la base. */
export async function autenticar(req, _res, next) {
  try {
    const token = leerToken(req);
    if (!token) throw new HttpError(401, 'Iniciá sesión');
    const { rows: [u] } = await query(
      `SELECT u.id, u.nombre, u.email, u.rol, u.activo,
              coalesce(p.pedidos, false) AS pedidos,
              coalesce(p.pagos_recibidos, false) AS pagos_recibidos,
              coalesce(p.pagos_granja, false) AS pagos_granja
         FROM sesiones s
         JOIN usuarios u ON u.id = s.usuario_id
         LEFT JOIN permisos_empleado p ON p.usuario_id = u.id
        WHERE s.token_hash = $1 AND s.expira > now()`, [sha256(token)]);
    if (!u || !u.activo) throw new HttpError(401, 'La sesión venció. Iniciá sesión de nuevo.');
    req.user = {
      id: u.id, nombre: u.nombre, email: u.email, rol: u.rol,
      permisos: u.rol === 'empleado'
        ? { pedidos: u.pedidos, pagos_recibidos: u.pagos_recibidos, pagos_granja: u.pagos_granja }
        : u.rol === 'dueno' ? { pedidos: true, pagos_recibidos: true, pagos_granja: true } : {},
    };
    next();
  } catch (e) { next(e); }
}

/**
 * Protección CSRF: la cookie es SameSite=Strict y además toda petición que modifica datos
 * debe traer el encabezado X-Huevazo, que un sitio ajeno no puede enviar sin CORS.
 */
export function antiCsrf(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-huevazo') !== '1') return next(new HttpError(403, 'Falta el encabezado X-Huevazo'));
  const origin = req.get('origin');
  if (origin && new URL(origin).host !== req.get('host')) return next(new HttpError(403, 'Origen no permitido'));
  next();
}

export const tienePermiso = (u, p) => u.rol === 'dueno' || (u.rol === 'empleado' && u.permisos[p] === true);

export function soloDueno(req) {
  if (req.user.rol !== 'dueno') throw new HttpError(403, 'Solo el dueño puede realizar esta operación');
}

export function exigirPermiso(req, permiso, mensaje) {
  if (!tienePermiso(req.user, permiso)) throw new HttpError(403, mensaje || 'No tenés permiso para esta operación');
}
