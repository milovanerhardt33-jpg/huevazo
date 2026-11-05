// Utilidades de prueba: base descartable, servidor en un puerto libre y un cliente HTTP con cookies.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

process.env.COOKIE_SECURE = 'false';
const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DUENO = { email: 'dueno@huevazo.test', password: 'dueno-clave-segura' };
export const CLAVE = 'clave-de-prueba-123';

export async function prepararBase() {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url || !/\/[a-z0-9_]*_test(\?|$)/.test(url)) {
    throw new Error('Las pruebas borran la base: DATABASE_ADMIN_URL debe apuntar a una base cuyo nombre termine en _test');
  }
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.end();
  execFileSync(process.execPath, [path.join(raiz, 'scripts/migrar.js')], { env: process.env, stdio: 'pipe' });
  execFileSync(process.execPath, [path.join(raiz, 'scripts/crear-dueno.js'), '--email', DUENO.email, '--nombre', 'Dueño'],
    { env: { ...process.env, DUENO_PASSWORD: DUENO.password }, stdio: 'pipe' });
  const a = await adminDb();
  await a.query(`INSERT INTO productos (id, nombre, unidad, precio) VALUES
    ('MB-G', 'Maple blanco grande', 'maple de 30 u.', 680000),
    ('MC-G', 'Maple color grande', 'maple de 30 u.', 740000),
    ('CJ-B', 'Cajón blanco grande', 'cajón de 12 maples', 7800000)`);
  await a.query("INSERT INTO granjas (nombre) VALUES ('Granja Los Aromos'), ('Avícola San Javier')");
  await a.end();
}

export async function adminDb() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await c.connect();
  return c;
}
export async function appDb() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  return c;
}

export async function iniciarServidor() {
  const { crearApp } = await import('../src/app.js');
  const server = crearApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${server.address().port}`, server };
}

export class Sesion {
  constructor(base) { this.base = base; this.cookie = ''; }
  async pedir(method, ruta, body, { sinCsrf = false, headers = {} } = {}) {
    const h = { ...headers };
    if (!sinCsrf) h['x-huevazo'] = '1';
    if (this.cookie) h.cookie = this.cookie;
    let cuerpo;
    if (Buffer.isBuffer(body)) cuerpo = body;
    else if (body !== undefined) { h['content-type'] = 'application/json'; cuerpo = JSON.stringify(body); }
    const r = await fetch(this.base + '/api' + ruta, { method, headers: h, body: cuerpo });
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const tipo = r.headers.get('content-type') || '';
    return { status: r.status, body: tipo.includes('json') ? await r.json() : await r.arrayBuffer() };
  }
  get(r) { return this.pedir('GET', r); }
  post(r, b = {}) { return this.pedir('POST', r, b); }
  patch(r, b = {}) { return this.pedir('PATCH', r, b); }
  del(r) { return this.pedir('DELETE', r); }
  async login(email, password) {
    const r = await this.post('/auth/login', { email, password });
    if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.body)}`);
    return this;
  }
}

export const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Cordoba' }).format(new Date());
export const clave = () => 'k-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
