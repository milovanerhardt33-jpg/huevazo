import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { auditar } from '../auditoria.js';
import { soloDueno, tienePermiso } from '../auth.js';
import { HttpError, invalido, noEncontrado, prohibido } from '../errores.js';
import { codigo, h, pesos } from '../finanzas.js';
import { validar, idDeRuta, centavosConSigno, motivo } from '../validar.js';

export const deudas = Router();

const SELECT_DEUDA = `
  SELECT d.id, d.tipo, d.cliente_id, d.granja_id, coalesce(c.nombre, g.nombre) AS parte, d.origen, d.pedido_id,
         d.importe, d.saldo, d.creado
    FROM deudas d LEFT JOIN usuarios c ON c.id = d.cliente_id LEFT JOIN granjas g ON g.id = d.granja_id`;

deudas.get('/', h(async (req) => {
  const cond = [], params = [];
  const tipo = req.query.tipo;
  if (tipo !== undefined && !['cliente', 'granja'].includes(tipo)) throw invalido('tipo debe ser cliente o granja');
  if (req.user.rol === 'cliente') {
    params.push(req.user.id); cond.push(`d.cliente_id = $${params.length}`);
  } else if (req.user.rol === 'empleado') {
    // Un empleado solo consulta deudas con granjas, y solo si prepara pagos a granjas.
    if (tipo !== 'granja' || !tienePermiso(req.user, 'pagos_granja')) throw prohibido('No tenés acceso a las deudas');
  }
  if (tipo) { params.push(tipo); cond.push(`d.tipo = $${params.length}`); }
  if (req.query.parte && req.user.rol !== 'cliente') {
    if (!/^\d{1,15}$/.test(req.query.parte)) throw invalido('parte inválida');
    params.push(Number(req.query.parte)); cond.push(`coalesce(d.cliente_id, d.granja_id) = $${params.length}`);
  }
  if (req.query.abiertas === '1') cond.push('d.saldo > 0');
  const { rows } = await query(`${SELECT_DEUDA} WHERE ${cond.length ? cond.join(' AND ') : 'true'} ORDER BY d.creado, d.id`, params);
  return { body: rows };
}));

deudas.patch('/:id', (req) => {
  if (req.user.rol !== 'dueno') throw prohibido('No podés modificar deudas ni saldos');
  throw new HttpError(405, 'Las deudas no se sobrescriben. Registrá un ajuste con motivo.');
});
deudas.put('/:id', () => { throw new HttpError(405, 'Las deudas no se sobrescriben. Registrá un ajuste con motivo.'); });
deudas.delete('/:id', () => { throw new HttpError(405, 'Las deudas no se borran. Registrá un ajuste con motivo.'); });

deudas.post('/:id/ajustes', h(async (req) => {
  soloDueno(req);
  const id = idDeRuta(req.params.id);
  const b = validar(z.object({ importe: centavosConSigno, motivo }).strict(), req.body);
  return tx(async (c) => {
    const { rows: [d] } = await c.query('SELECT * FROM bloquear_deudas(ARRAY[$1]::bigint[])', [id]);
    if (!d) throw noEncontrado('Deuda inexistente');
    if (d.saldo + b.importe < 0) throw invalido(`El ajuste dejaría la deuda en negativo (saldo actual ${pesos(d.saldo)})`);
    const { rows: [m] } = await c.query(
      `INSERT INTO movimientos (tipo, cliente_id, granja_id, deuda_id, importe, motivo, creado_por)
       VALUES ('ajuste', $1, $2, $3, $4, $5, $6) RETURNING id`,
      [d.cliente_id, d.granja_id, id, b.importe, b.motivo, req.user.id]);
    await auditar(c, req, {
      tipo: 'ajuste', entidad: 'deuda', entidadId: id, importe: b.importe,
      valoresAntes: { saldo: d.saldo }, valoresDespues: { saldo: d.saldo + b.importe },
      autorizadoPor: req.user.id, motivo: b.motivo, ref: `movimiento ${m.id} sobre ${codigo('D', id)}`,
    });
    const { rows: [deuda] } = await c.query(`${SELECT_DEUDA} WHERE d.id = $1`, [id]);
    return { status: 201, body: { deuda } };
  });
}));

export const movimientos = Router();
movimientos.get('/', h(async (req) => {
  const params = [];
  let where = 'true';
  if (req.user.rol === 'cliente') { params.push(req.user.id); where = 'm.cliente_id = $1'; }
  else {
    soloDueno(req);
    const n = (v) => { if (!/^\d{1,15}$/.test(v)) throw invalido('Parámetro inválido'); return Number(v); };
    if (req.query.cliente) { params.push(n(req.query.cliente)); where = 'm.cliente_id = $1'; }
    else if (req.query.granja) { params.push(n(req.query.granja)); where = 'm.granja_id = $1'; }
  }
  const { rows } = await query(
    `SELECT m.id, m.tipo, m.cliente_id, m.granja_id, m.deuda_id, m.pago_id, m.pago_granja_id, m.pedido_id,
            m.movimiento_origen_id, m.importe, m.motivo, m.creado
       FROM movimientos m WHERE ${where} ORDER BY m.id DESC LIMIT 500`, params);
  return { body: rows };
}));
