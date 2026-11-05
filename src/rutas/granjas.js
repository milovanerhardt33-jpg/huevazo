import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { auditar, conIdempotencia } from '../auditoria.js';
import { soloDueno, exigirPermiso } from '../auth.js';
import { conflicto, invalido, noEncontrado } from '../errores.js';
import { aplicarADeudas, revertirAplicaciones, codigo, h, pesos } from '../finanzas.js';
import {
  validar, idDeRuta, idNum, centavos, fechaPago, medio, referencia, moneda, motivo, claveIdempotencia, aplicaciones,
} from '../validar.js';

export const granjas = Router();

granjas.get('/', h(async (req) => {
  exigirPermiso(req, 'pagos_granja', 'No autorizado');
  const { rows } = await query(
    `SELECT g.id, g.nombre, g.activo,
            coalesce((SELECT sum(saldo) FROM deudas d WHERE d.granja_id = g.id), 0)::bigint AS saldo
       FROM granjas g ORDER BY g.nombre`);
  return { body: rows };
}));

granjas.post('/', h(async (req) => {
  soloDueno(req);
  const b = validar(z.object({ nombre: z.string().trim().min(1).max(120) }).strict(), req.body);
  return tx(async (c) => {
    const { rows: [g] } = await c.query('INSERT INTO granjas (nombre) VALUES ($1) RETURNING id, nombre', [b.nombre]);
    await auditar(c, req, { tipo: 'granja_creada', entidad: 'granja', entidadId: g.id, ref: g.nombre });
    return { status: 201, body: { granja: g } };
  });
}));

export const compras = Router();
compras.post('/', h(async (req) => {
  soloDueno(req);
  const b = validar(z.object({ granjaId: idNum, detalle: z.string().trim().min(3).max(120), importe: centavos }).strict(), req.body);
  return tx(async (c) => {
    const { rows: [g] } = await c.query('SELECT id, nombre FROM granjas WHERE id = $1 AND activo', [b.granjaId]);
    if (!g) throw invalido('Granja inexistente');
    const { rows: [d] } = await c.query(
      `INSERT INTO deudas (tipo, granja_id, origen, importe, saldo, creado_por) VALUES ('granja', $1, $2, $3, $3, $4)
       RETURNING id, tipo, granja_id, origen, importe, saldo, creado`,
      [g.id, `Compra: ${b.detalle}`, b.importe, req.user.id]);
    await c.query(
      "INSERT INTO movimientos (tipo, granja_id, deuda_id, importe, creado_por) VALUES ('compra', $1, $2, $3, $4)",
      [g.id, d.id, b.importe, req.user.id]);
    await auditar(c, req, {
      tipo: 'compra_registrada', entidad: 'deuda', entidadId: d.id, importe: b.importe,
      valoresDespues: { saldo: b.importe }, autorizadoPor: req.user.id, ref: g.nombre,
    });
    return { status: 201, body: { deuda: { ...d, parte: g.nombre } } };
  });
}));

export const pagosGranja = Router();

const SELECT_PG = `
  SELECT p.id, p.granja_id, g.nombre AS granja, p.importe, p.moneda, p.fecha, p.medio, p.referencia, p.observaciones,
         p.estado, p.preparado_por, u.nombre AS preparado_por_nombre, p.preparado_rol, p.creado, p.propuesta, p.aplicado,
         p.autorizado_en, ua.nombre AS autorizado_por_nombre, p.rechazado_en, p.rechazo_motivo, p.anulado_en, p.anulacion_motivo,
         p.comprobante_id, cp.nombre AS comprobante_nombre, cp.tam AS comprobante_tam,
         (SELECT coalesce(json_agg(json_build_object('id', a.id, 'deuda_id', a.deuda_id, 'origen', d.origen,
                    'importe', a.importe, 'revertida', a.revertida) ORDER BY a.id), '[]')
            FROM aplicaciones a JOIN deudas d ON d.id = a.deuda_id WHERE a.pago_granja_id = p.id) AS aplicaciones
    FROM pagos_granja p
    JOIN granjas g ON g.id = p.granja_id
    JOIN usuarios u ON u.id = p.preparado_por
    LEFT JOIN usuarios ua ON ua.id = p.autorizado_por
    LEFT JOIN comprobantes cp ON cp.id = p.comprobante_id`;

function visibles(req) {
  if (req.user.rol === 'dueno') return { sql: 'true', params: [] };
  exigirPermiso(req, 'pagos_granja', 'No autorizado');
  return { sql: 'p.preparado_por = $X', params: [req.user.id] };
}
async function leer(c, req, id) {
  const v = visibles(req);
  const { rows: [p] } = await c.query(`${SELECT_PG} WHERE p.id = $1 AND ${v.sql.replace('$X', '$2')}`, [id, ...v.params]);
  if (!p) throw noEncontrado('Pago inexistente');
  return p;
}

pagosGranja.get('/', h(async (req) => {
  const v = visibles(req);
  const { rows } = await query(`${SELECT_PG} WHERE ${v.sql.replace('$X', '$1')} ORDER BY p.creado DESC LIMIT 500`, v.params);
  return { body: rows };
}));
pagosGranja.get('/:id', h(async (req) => ({ body: await leer({ query }, req, idDeRuta(req.params.id)) })));

const esquemaNuevo = z.object({
  granjaId: idNum, importe: centavos, moneda, fecha: fechaPago, medio, referencia,
  observaciones: z.string().trim().max(300).default(''), comprobanteId: idNum.optional(),
  aplicaciones: aplicaciones.default([]), idempotencyKey: claveIdempotencia.optional(),
}).strict();

async function autorizar(c, req, p, aps) {
  await c.query("UPDATE pagos_granja SET estado = 'confirmado', autorizado_por = $2, autorizado_en = now() WHERE id = $1", [p.id, req.user.id]);
  await c.query(
    "INSERT INTO movimientos (tipo, granja_id, pago_granja_id, importe, creado_por) VALUES ('pago_proveedor', $1, $2, $3, $4)",
    [p.granja_id, p.id, p.importe, req.user.id]);
  await auditar(c, req, {
    tipo: p.preparado_por === req.user.id ? 'pago_granja_registrado' : 'pago_granja_autorizado',
    entidad: 'pago_granja', entidadId: p.id, importe: p.importe, estadoAntes: 'pendiente', estadoDespues: 'confirmado',
    autorizadoPor: req.user.id, ref: p.preparado_por === req.user.id ? null : `preparado por usuario ${p.preparado_por}`,
  });
  return aplicarADeudas(c, req, {
    tipo: 'granja', pagoId: p.id, parteId: p.granja_id, aplicaciones: aps, disponible: p.importe,
    ref: `${codigo('PP', p.id)} autorización`,
  });
}

pagosGranja.post('/', h(async (req) => {
  exigirPermiso(req, 'pagos_granja', 'No tenés permiso para registrar pagos a granjas');
  const b = validar(esquemaNuevo, req.body);
  if (['transferencia', 'billetera'].includes(b.medio) && !b.referencia) throw invalido('Las transferencias necesitan el número de operación');
  const sumaProp = b.aplicaciones.reduce((s, a) => s + a.importe, 0);
  if (sumaProp > b.importe) throw invalido(`El reparto suma ${pesos(sumaProp)} y el pago es de ${pesos(b.importe)}`);

  const crear = async (c) => {
    const { rows: [g] } = await c.query('SELECT id FROM granjas WHERE id = $1 AND activo', [b.granjaId]);
    if (!g) throw invalido('Granja inexistente');
    if (b.comprobanteId) {
      const { rows: [cp] } = await c.query('SELECT subido_por FROM comprobantes WHERE id = $1', [b.comprobanteId]);
      if (!cp || cp.subido_por !== req.user.id) throw invalido('Comprobante inexistente');
    }
    if (b.aplicaciones.length) {
      const { rows } = await c.query('SELECT id FROM deudas WHERE id = ANY($1::bigint[]) AND tipo = $2 AND granja_id = $3',
        [b.aplicaciones.map((a) => a.deudaId), 'granja', g.id]);
      if (rows.length !== b.aplicaciones.length) throw invalido('Alguna deuda del reparto no es de esta granja');
    }
    const { rows: [p] } = await c.query(
      `INSERT INTO pagos_granja (granja_id, importe, fecha, medio, referencia, observaciones, comprobante_id, preparado_por, preparado_rol, propuesta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [g.id, b.importe, b.fecha, b.medio, b.referencia, b.observaciones, b.comprobanteId ?? null, req.user.id, req.user.rol,
        JSON.stringify(b.aplicaciones)]);
    await auditar(c, req, {
      tipo: 'pago_granja_preparado', entidad: 'pago_granja', entidadId: p.id, importe: p.importe,
      estadoDespues: 'pendiente', valoresDespues: { propuesta: b.aplicaciones },
    });
    // Si lo registra el dueño, queda autorizado en la misma transacción.
    if (req.user.rol === 'dueno') await autorizar(c, req, p, b.aplicaciones);
    return { status: 201, body: { pagoGranja: await leer(c, req, p.id) } };
  };
  if (b.idempotencyKey) return conIdempotencia(req, 'crear_pago_granja', 'nuevo', b.idempotencyKey, crear);
  return tx(crear);
}));

async function bloquear(c, id) {
  const { rows: [p] } = await c.query('SELECT * FROM pagos_granja WHERE id = $1 FOR UPDATE', [id]);
  if (!p) throw noEncontrado('Pago inexistente');
  return p;
}

pagosGranja.post('/:id/autorizar', h(async (req) => {
  soloDueno(req);
  const id = idDeRuta(req.params.id);
  const b = validar(z.object({ aplicaciones: aplicaciones.optional(), idempotencyKey: claveIdempotencia }).strict(), req.body);
  return conIdempotencia(req, 'autorizar_pago_granja', `pago_granja:${id}`, b.idempotencyKey, async (c) => {
    const p = await bloquear(c, id);
    if (p.estado !== 'pendiente') throw conflicto(`El pago está ${p.estado}`);
    const aps = b.aplicaciones ?? p.propuesta;
    const aplicado = await autorizar(c, req, p, aps);
    return { status: 200, body: { pagoGranja: await leer(c, req, id), aplicado } };
  });
}));

pagosGranja.post('/:id/rechazar', h(async (req) => {
  soloDueno(req);
  const id = idDeRuta(req.params.id);
  const b = validar(z.object({ motivo }).strict(), req.body);
  return tx(async (c) => {
    const p = await bloquear(c, id);
    if (p.estado !== 'pendiente') throw conflicto('Solo se rechazan pagos pendientes');
    await c.query("UPDATE pagos_granja SET estado = 'rechazado', rechazado_por = $2, rechazado_en = now(), rechazo_motivo = $3 WHERE id = $1",
      [id, req.user.id, b.motivo]);
    await auditar(c, req, {
      tipo: 'pago_granja_rechazado', entidad: 'pago_granja', entidadId: id, importe: p.importe,
      estadoAntes: 'pendiente', estadoDespues: 'rechazado', autorizadoPor: req.user.id, motivo: b.motivo,
    });
    return { body: { pagoGranja: await leer(c, req, id) } };
  });
}));

pagosGranja.post('/:id/anular', h(async (req) => {
  soloDueno(req);
  const id = idDeRuta(req.params.id);
  const b = validar(z.object({ motivo }).strict(), req.body);
  return tx(async (c) => {
    const p = await bloquear(c, id);
    if (p.estado !== 'confirmado') throw conflicto('Solo se anulan pagos autorizados');
    await revertirAplicaciones(c, req, { tipo: 'granja', pagoId: id, motivo: b.motivo, ref: `${codigo('PP', id)} anulación` });
    const { rows: [mov] } = await c.query("SELECT id FROM movimientos WHERE tipo = 'pago_proveedor' AND pago_granja_id = $1", [id]);
    await c.query(
      `INSERT INTO movimientos (tipo, granja_id, pago_granja_id, importe, motivo, movimiento_origen_id, creado_por)
       VALUES ('reversion_pago_proveedor', $1, $2, $3, $4, $5, $6)`, [p.granja_id, id, p.importe, b.motivo, mov?.id ?? null, req.user.id]);
    await c.query("UPDATE pagos_granja SET estado = 'anulado', anulado_por = $2, anulado_en = now(), anulacion_motivo = $3 WHERE id = $1",
      [id, req.user.id, b.motivo]);
    await auditar(c, req, {
      tipo: 'pago_granja_anulado', entidad: 'pago_granja', entidadId: id, importe: p.importe,
      estadoAntes: 'confirmado', estadoDespues: 'anulado', autorizadoPor: req.user.id, motivo: b.motivo,
    });
    return { body: { pagoGranja: await leer(c, req, id) } };
  });
}));
