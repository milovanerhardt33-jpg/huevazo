import pg from 'pg';
import { config } from './config.js';

// bigint (int8) → Number. Los importes están acotados por CHECK a 1e13 centavos,
// muy por debajo de Number.MAX_SAFE_INTEGER, así que la conversión es exacta.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`Entero fuera de rango seguro: ${v}`);
  return n;
});
// date → texto AAAA-MM-DD, sin conversiones de zona horaria.
pg.types.setTypeParser(1082, (v) => v);

let pool;
export function getPool() {
  if (!pool) pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
  return pool;
}

export function query(text, params) {
  return getPool().query(text, params);
}

/**
 * Ejecuta fn dentro de una transacción READ COMMITTED.
 * Si fn lanza un error, se revierte todo: nunca queda un pago confirmado sin sus movimientos.
 */
export async function tx(fn) {
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function cerrar() {
  if (pool) { await pool.end(); pool = undefined; }
}
