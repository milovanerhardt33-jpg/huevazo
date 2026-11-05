// Aplica el esquema con el usuario administrativo y (re)crea el usuario de mínimo privilegio.
// Uso: npm run db:migrar
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../src/config.js';
import { claveApp } from './clave-app.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db');
const SIEMPRE = new Set(['003_permisos.sql']); // los permisos se reaplican en cada migración

const c = new pg.Client({ connectionString: config.databaseAdminUrl });
await c.connect();
try {
  const clave = claveApp();
  if (!clave || clave.length < 12) throw new Error('APP_DB_PASSWORD debe tener al menos 12 caracteres');
  const { rowCount } = await c.query("SELECT 1 FROM pg_roles WHERE rolname = 'huevazo_app'");
  const sql = rowCount ? 'ALTER ROLE huevazo_app WITH LOGIN PASSWORD '
    : 'CREATE ROLE huevazo_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ';
  await c.query(sql + `'${clave.replace(/'/g, "''")}'`);

  await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (archivo text PRIMARY KEY, aplicado timestamptz NOT NULL DEFAULT now())');
  const hechos = new Set((await c.query('SELECT archivo FROM schema_migrations')).rows.map((r) => r.archivo));
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (hechos.has(f) && !SIEMPRE.has(f)) continue;
    await c.query('BEGIN');
    try {
      await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await c.query('INSERT INTO schema_migrations (archivo) VALUES ($1) ON CONFLICT (archivo) DO UPDATE SET aplicado = now()', [f]);
      await c.query('COMMIT');
      console.log('aplicado', f);
    } catch (e) {
      await c.query('ROLLBACK');
      throw new Error(`Falló ${f}: ${e.message}`);
    }
  }
  console.log('Base lista.');
} finally {
  await c.end();
}
