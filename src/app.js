import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { config } from './config.js';
import { autenticar, antiCsrf, iniciarSesion, cerrarSesion, leerToken, cookieSesion, hashPassword, verificarPassword } from './auth.js';
import { HttpError, desdePostgres } from './errores.js';
import { query } from './db.js';
import { h } from './finanzas.js';
import { validar } from './validar.js';
import { pagos } from './rutas/pagos.js';
import { pedidos } from './rutas/pedidos.js';
import { deudas, movimientos } from './rutas/deudas.js';
import { granjas, compras, pagosGranja } from './rutas/granjas.js';
import { usuarios, clientes } from './rutas/usuarios.js';
import { auditoria, catalogo, comprobantes } from './rutas/varios.js';

const publico = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function crearApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: config.cookieSecure ? [] : null,
      },
    },
    strictTransportSecurity: config.cookieSecure,
  }));

  const api = express.Router();
  api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  // Chequeo de salud para el proveedor de hosting: responde solo si la base contesta.
  api.get('/salud', async (_req, res) => {
    try { await query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });
  api.use(antiCsrf);
  api.use((req, res, next) => (req.path === '/comprobantes' && req.method === 'POST')
    ? next() : express.json({ limit: '100kb', strict: true })(req, res, next));

  // ---- sesión (sin autenticación previa)
  api.post('/auth/login', h(async (req, res) => {
    const b = validar(z.object({ email: z.string().max(160), password: z.string().max(200) }).strict(), req.body);
    const token = await iniciarSesion(b.email, b.password, req.ip, req.get('user-agent'));
    res.set('Set-Cookie', cookieSesion(token, config.sessionHours * 3600));
    return { body: { ok: true } };
  }));
  api.post('/auth/logout', h(async (req, res) => {
    await cerrarSesion(leerToken(req));
    res.set('Set-Cookie', cookieSesion('', 0));
    return { body: { ok: true } };
  }));

  // Permite a la interfaz saber si hay sesión sin provocar un 401.
  api.get('/auth/sesion', (req, res, next) => {
    if (!leerToken(req)) return res.json({ activa: false });
    autenticar(req, res, (err) => (err ? res.json({ activa: false }) : res.json({ activa: true, usuario: req.user })));
  });

  // ---- todo lo demás requiere sesión
  api.use(autenticar);
  api.post('/auth/password', h(async (req) => {
    const b = validar(z.object({ actual: z.string().max(200), nueva: z.string().min(10).max(200) }).strict(), req.body);
    const { rows: [u] } = await query('SELECT password_hash FROM usuarios WHERE id = $1', [req.user.id]);
    if (!(await verificarPassword(b.actual, u.password_hash))) throw new HttpError(422, 'La contraseña actual no es correcta');
    await query('UPDATE usuarios SET password_hash = $2 WHERE id = $1', [req.user.id, await hashPassword(b.nueva)]);
    await query('DELETE FROM sesiones WHERE usuario_id = $1 AND token_hash <> sha256(convert_to($2, \'UTF8\'))', [req.user.id, leerToken(req)]);
    return { body: { ok: true } };
  }));
  api.use('/usuarios', usuarios);
  api.use('/clientes', clientes);
  api.use('/catalogo', catalogo);
  api.use('/pedidos', pedidos);
  api.use('/pagos', pagos);
  api.use('/deudas', deudas);
  api.use('/movimientos', movimientos);
  api.use('/granjas', granjas);
  api.use('/compras', compras);
  api.use('/pagos-granja', pagosGranja);
  api.use('/comprobantes', comprobantes);
  api.use('/auditoria', auditoria);
  api.use((req) => { throw new HttpError(404, `Ruta inexistente: ${req.method} ${req.originalUrl}`); });

  app.use('/api', api);
  app.use(express.static(publico, { index: 'index.html', maxAge: '1h' }));
  app.get('*', (_req, res) => res.sendFile(path.join(publico, 'index.html')));

  // ---- manejo de errores: nunca se filtran detalles internos
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    let e = err instanceof HttpError ? err : desdePostgres(err);
    if (!e && err?.type === 'entity.parse.failed') e = new HttpError(400, 'El cuerpo no es JSON válido');
    if (!e && err?.type === 'entity.too.large') e = new HttpError(413, 'El archivo o el cuerpo es demasiado grande');
    if (!e) {
      console.error(new Date().toISOString(), req.method, req.originalUrl, err);
      e = new HttpError(500, 'Error interno');
    }
    res.status(e.status).json({ error: e.message });
  });
  return app;
}
