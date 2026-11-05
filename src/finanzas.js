import { auditar } from './auditoria.js';
import { invalido } from './errores.js';

export const codigo = (pre, id) => `${pre}-${String(id).padStart(4, '0')}`;

export function pesos(c) {
  const neg = c < 0; c = Math.abs(c);
  const e = Math.floor(c / 100), r = c % 100;
  return `${neg ? '-' : ''}$ ${e.toLocaleString('es-AR')}${r ? ',' + String(r).padStart(2, '0') : ''}`;
}

/** Envuelve un handler async para que Express 4 reciba sus errores. */
export const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((r) => {
  if (r && !res.headersSent) res.status(r.status || 200).json(r.body);
}, next);

/**
 * Aplica un pago confirmado a una lista de deudas dentro de la transacción c.
 * Bloquea las deudas (FOR UPDATE, en orden de id para evitar interbloqueos), valida
 * pertenencia, saldos y disponible, y registra cada aplicación con su auditoría.
 * Los saldos los mueven los triggers; si algo no cierra, la base aborta la transacción.
 */
export async function aplicarADeudas(c, req, { tipo, pagoId, parteId, aplicaciones, disponible, ref }) {
  if (!aplicaciones.length) return 0;
  const total = aplicaciones.reduce((s, a) => s + a.importe, 0);
  if (total > disponible) {
    throw invalido(`Las aplicaciones suman ${pesos(total)} y el pago tiene ${pesos(disponible)} disponibles`);
  }
  const ids = aplicaciones.map((a) => a.deudaId).sort((a, b) => a - b);
  const { rows } = await c.query(
    'SELECT id, tipo, cliente_id, granja_id, saldo, origen FROM bloquear_deudas($1::bigint[])',
    [ids]);
  const porId = new Map(rows.map((d) => [d.id, d]));
  for (const a of aplicaciones) {
    const d = porId.get(a.deudaId);
    if (!d) throw invalido(`La deuda ${codigo('D', a.deudaId)} no existe`);
    const duenio = tipo === 'cliente' ? d.cliente_id : d.granja_id;
    if (d.tipo !== tipo || duenio !== parteId) throw invalido(`La deuda ${codigo('D', d.id)} no pertenece a esta cuenta`);
    if (a.importe > d.saldo) {
      throw invalido(`A la deuda ${codigo('D', d.id)} le quedan ${pesos(d.saldo)}; no se pueden aplicar ${pesos(a.importe)}`);
    }
  }
  const col = tipo === 'cliente' ? 'pago_id' : 'pago_granja_id';
  for (const a of aplicaciones) {
    const d = porId.get(a.deudaId);
    const { rows: [ap] } = await c.query(
      `INSERT INTO aplicaciones (${col}, deuda_id, importe, creado_por) VALUES ($1, $2, $3, $4) RETURNING id`,
      [pagoId, d.id, a.importe, req.user.id]);
    await auditar(c, req, {
      tipo: 'aplicacion', entidad: 'deuda', entidadId: d.id, importe: a.importe,
      valoresAntes: { saldo: d.saldo }, valoresDespues: { saldo: d.saldo - a.importe },
      autorizadoPor: req.user.id, ref: `${ref}, aplicación ${ap.id}`,
    });
    d.saldo -= a.importe;
  }
  return total;
}

/** Revierte todas las aplicaciones activas de un pago (anulación). */
export async function revertirAplicaciones(c, req, { tipo, pagoId, motivo, ref }) {
  const col = tipo === 'cliente' ? 'pago_id' : 'pago_granja_id';
  const { rows } = await c.query(
    `SELECT a.id, a.deuda_id, a.importe FROM aplicaciones a
      WHERE a.${col} = $1 AND NOT a.revertida ORDER BY a.deuda_id`, [pagoId]);
  for (const a of rows) {
    const { rows: [d] } = await c.query('SELECT saldo FROM bloquear_deudas(ARRAY[$1]::bigint[])', [a.deuda_id]);
    await c.query(
      `UPDATE aplicaciones SET revertida = true, revertida_por = $2, revertida_en = now(), reversion_motivo = $3
        WHERE id = $1`, [a.id, req.user.id, motivo]);
    await auditar(c, req, {
      tipo: 'aplicacion_revertida', entidad: 'deuda', entidadId: a.deuda_id, importe: a.importe,
      valoresAntes: { saldo: d.saldo }, valoresDespues: { saldo: d.saldo + a.importe },
      autorizadoPor: req.user.id, motivo, ref: `${ref}, aplicación ${a.id}`,
    });
  }
  return rows.length;
}
