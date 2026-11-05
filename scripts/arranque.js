// Arranque para producción (Railway, Render, un VPS o cualquier hosting que ejecute `npm start`).
//
// 1. Aplica las migraciones con el usuario administrativo de la base.
// 2. Crea al dueño si todavía no existe y están DUENO_EMAIL y DUENO_PASSWORD.
// 3. Inicia el servidor SIN las credenciales administrativas en su entorno: la aplicación solo
//    recibe la conexión de mínimo privilegio (huevazo_app).
//
// Variables mínimas:
//   DATABASE_ADMIN_URL  conexión con el usuario dueño de la base (en Railway: ${{Postgres.DATABASE_URL}})
// Opcionales:
//   APP_DB_PASSWORD     clave para huevazo_app; si falta, se deriva de la clave administrativa
//   DATABASE_URL        conexión de huevazo_app; si falta, se arma a partir de DATABASE_ADMIN_URL
//   DUENO_EMAIL, DUENO_PASSWORD, DUENO_NOMBRE   solo para el primer arranque; después borralas
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claveApp } from './clave-app.js';

try { process.loadEnvFile?.(); } catch { /* sin .env */ }
const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function falla(msg) { console.error(`[arranque] ${msg}`); process.exit(1); }
if (!process.env.DATABASE_ADMIN_URL) falla('Falta DATABASE_ADMIN_URL');
let clave;
try { clave = claveApp(); } catch (e) { falla(e.message); }
if (clave.length < 12) falla('APP_DB_PASSWORD debe tener al menos 12 caracteres');

// Conexión de la aplicación: mismo servidor y base, otro usuario.
let appUrl = process.env.DATABASE_URL;
if (!appUrl || appUrl === process.env.DATABASE_ADMIN_URL) {
  const u = new URL(process.env.DATABASE_ADMIN_URL);
  u.username = 'huevazo_app';
  u.password = clave;
  appUrl = u.toString();
}

const paso = (script, args = [], intentos = 1) => {
  for (let i = 1; i <= intentos; i++) {
    const r = spawnSync(process.execPath, [path.join(raiz, script), ...args], { stdio: 'inherit', env: process.env });
    if (r.status === 0) return;
    if (i < intentos) {
      console.error(`[arranque] ${script} falló (intento ${i} de ${intentos}); reintento en 3 segundos`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
    }
  }
  falla(`${script} terminó con error`);
};
// La red interna de la base puede tardar unos segundos en estar lista al arrancar el contenedor.
paso('scripts/migrar.js', [], 5);
paso('scripts/crear-dueno.js', ['--si-falta']);

const SECRETOS = ['DATABASE_ADMIN_URL', 'APP_DB_PASSWORD', 'DUENO_PASSWORD', 'DUENO_EMAIL', 'DUENO_NOMBRE',
  'DATABASE_PUBLIC_URL', 'PGPASSWORD', 'POSTGRES_PASSWORD'];
const env = { ...process.env, DATABASE_URL: appUrl };
for (const k of SECRETOS) delete env[k];
// Detrás del proxy HTTPS de la plataforma, la IP real llega en X-Forwarded-For.
if (!env.TRUST_PROXY && (env.RAILWAY_ENVIRONMENT || env.RENDER)) env.TRUST_PROXY = '1';

const server = spawn(process.execPath, [path.join(raiz, 'src/server.js')], { stdio: 'inherit', env });
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => server.kill(s));
server.on('exit', (code) => process.exit(code ?? 1));
