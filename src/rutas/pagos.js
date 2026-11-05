import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { auditar, conIdempotencia } from '../auditoria.js';
import { soloDueno, exigirPermiso } from '../auth.js';
import { HttpError, conflicto, invalido, noEncontrado, prohibido } from '../errores.js';
import { aplicarADeudas, revertirAplicaciones, codigo, h, pesos } from '../finanzas.js';
import {
  validar, idDeRuta, idNum, centavos, fechaPago, medio, referencia, moneda, motivo, claveIdempotencia, aplicaciones,
} from '../validar.js';

export const pagos = Router();

const SELECT_PAGO = `
  SELECT p.id, p.cliente_id, c.nombre AS cliente, p.importe, p.moneda, p.fecha, p.medio, p.referencia, p.nota,
         p.estado, p.informado_por, ui.nombre AS informado_por_nombre, p.informado_rol, p.creado,
         p.revision_en, p.importe_aprobado, p.aplicado,
         CASE WHEN p.importe_aprobado IS NULL OR p.estado <> 'confirmado' THEN 0 ELSE p.importe_aprobado - p.aplicado END AS disponible,
         p.confirmado_en, uc.nombre AS confirmado_por_nombre,
         p.rechazado_en, p.rechazo_motivo, p.anulado_en, p.anulacion_motivo,
         p.comprobante_id, cp.nombre AS comprobante_nombre, cp.tam AS comprobante_tam, cp.mime AS comprobante_mime
    FROM pagos p
    JOIN usuarios c  ON c.id = p.cliente_id
    JOIN usuarios ui ON ui.id = p.informado_por
    LEFT JOIN usuarios uc ON uc.id = p.confirmado_por
    LEFT JOIN comprobantes cp ON cp.id = p.comprobante_id`;

/** Filtro de visibilidad aplicado en SQL: el servidor verifica la propiedad de cada pago. */
function visibilidad(req, n) {
  if (req.user.rol === 'dueno') return { sql: 'true', params: [] };
  if (req.user.rol === 'cliente') return { sql: `p.cliente_id = $${n}`, params: [req.user.id] };
  return { sql: `p.informado_por = $${n}`, params: [req.user.id] };
}

async function leerPago(c, req, id) {
  const v = visibilidad(req, 2);
  const { rows: [p] } = await c.query(`${SELECT_PAGO} WHERE p.id = $1 AND ${v.sql}`, [id, ...v.params]);
  if (!p) throw noEncontrado('Pago inexistente');
  const { rows: aps } = await c.query(
    `SELECT a.id, a.deuda_id, d.origen, a.importe, a.creado, a.revertida, a.revertida_en
       FROM aplicaciones a JOIN deudas d ON d.id = a.deuda_id WHERE a.pago_id = $1 ORDER BY a.id`, [id]);
  p.aplicaciones = aps;
  if (req.user.rol === 'dueno') {
    const { rows: hist } = await c.query(
      `SELECT seq, en, tipo, usuario_rol, (SELECT nombre FROM usuarios WHERE id = a.usuario_id) AS usuario,
              importe, estado_antes, estado_despues, motivo
         FROM auditoria a WHERE (entidad = 'pago' AND entidad_id = $1) OR ref LIKE $2 ORDER BY seq`,
      [String(id), `${codigo('PG', id)} %`]);
    p.historial = hist;
  }
  return p;
}

pagos.get('/', h(async (req) => {
  const v = visibilidad(req, 1);
  const estado = typeof req.query.estado === 'string' ? req.query.estado : null;
  const params = [...v.params];
  let filtro = '';
  if (estado) { params.push(estado.split(',')); filtro = ` AND p.estado::text = ANY($${params.length})`; }
  const { rows } = await query(`${SELECT_PAGO} WHERE ${v.sql}${filtro} ORDER BY p.creado DESC LIMIT 500`, params);
  return { body: rows };
}));

pagos.get('/:id', h(async (req) => ({ body: await leerPago({ query }, req, idDeRuta(req.params.id)) })));

const esquemaNuevo = z.object({
  clienteId: idNum.optional(), importe: centavos, moneda, fecha: fechaPago, medio, referencia,
  nota: z.string().trim().max(300).default(''), comprobanteId: idNum.optional(),
}).strict();

pagos.post('/', h(async (req) => {
  const b = validar(esquemaNuevo, req.body);
  let clienteId;
  if (req.user.rol === 'cliente') {
    if (b.clienteId !== undefined && b.clienteId !== req.user.id) throw prohibido('No podés informar pagos de otro cliente');
    clienteId = req.user.id;
  } else {
    if (req.user.rol === 'empleado') exigirPermiso(req, 'pagos_recibidos', 'No tenés permiso para informar pagos recibidos');
    if (!b.clienteId) throw invalido('Falta clienteId');
    clienteId = b.clienteId;
  }
  if (['transferencia', 'billetera'].includes(b.medio) && !b.referencia) {
    throw invalido('Las transferencias necesitan el número de operación');
  }
  return tx(async (c) => {
    const { rows: [cl] } = await c.query("SELECT id FROM usuarios WHERE id = $1 AND rol = 'cliente' AND activo", [clienteId]);
    if (!cl) throw invalido('Cliente inexistente');
    if (b.comprobanteId) {
      const { rows: [cp] } = await c.query('SELECT subido_por FROM comprobantes WHERE id = $1', [b.comprobanteId]);
      if (!cp || cp.subido_por !== req.user.id) throw invalido('Comprobante inexistente');
    }
    // estado, importe_aprobado y demás campos de autorización los fija el trigger: siempre 'pendiente'.
    const { rows: [p] } = await c.query(
      `INSERT INTO pagos (cliente_id, importe, fecha, medio, referencia, nota, comprobante_id, informado_por, informado_rol)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, estado`,
      [clienteId, b.importe, b.fecha, b.medio, b.referencia, b.nota, b.comprobanteId ?? null, req.user.id, req.user.rol]);
    await auditar(c, req, {
      tipo: 'pago_informado', entidad: 'pago', entidadId: p.id, importe: b.importe,
      estadoAntes: null, estadoDespues: p.estado,
      valoresDespues: { cliente_id: clienteId, medio: b.medio, referencia: b.referencia, fecha: b.fecha },
    });
    return { status: 201, body: { pago: await leerPago(c, req, p.id) } };
  });
}));

// Los pagos no se editan ni se borran: todo cambio pasa por una acción explícita y auditada.
pagos.patch('/:id', () => { throw new HttpError(405, 'Los pagos no se editan. Usá confirmar, rechazar o anular.'); });
pagos.put('/:id', () => { throw new HttpError(405, 'Los pagos no se editan. Usá confirmar, rechazar o anular.'); });
pagos.delete('/:id', () => { throw new HttpError(405, 'Los pagos no se borran. Un pago confirmado se anula y conserva su historial.'); });

async function bloquearPago(c, id) {
  const { rows: [p] } = await c.query('SELECT * FROM pagos WHERE id = $1 FOR UPDATE', [id]);
  if (!p) throw noEncontrado('Pago inexistente');
  return p;
}
const ESTADOS = { pendiente: 'pendiente', en_revision: 'en revisión', confirmado: 'confirmado', rechazado: 'rechazado', anulado: 'anulado' };

pagos.post('/:id/revision', h(async (req) => {
  soloDueno(req);
  const id = idDeRuta(req.params.id);
  validar(z.object({}).strict(), req.body);
  return tx(async (c) => {
    const p = await bloquearPago(c, id);
    if (p.estado !== 'pendiente') throw conflicto(`El pago está ${ESTADOS[p.estado]}`);
    await c.query("UPDATE pagos SET estado = 'en_revision', revision_por = $2, revision_en = now() WHERE id = $1", [id, req.user.id]);
    await auditar(c, req, { tipo: 'pago_en_revision', entidad: 'pago', entidadId: id, importe: p.importe, estadoAntes: 'pendiente', estadoDespues: 'en_revision' });
    return { body: { pago: await leerPago(c, req, id) } };
  });
}));

const esquemaConfirmar = z.object({
  importeAprobado: centavos, aplicaciones: aplicaciones.default([]), idempotencyKey: claveIdempotencia,
}).strict();

pagos.post('/:id/confirmar', h(async (req) => {
  soloDueno(req);
  const id = idDeRuta(req.params.id);
  const b = validar(esquemaConfirmar, req.body);
  return conIdempotencia(req, 'confirmar_pago', `pago:${id}`, b.idempotencyKey, async (c) => {
    // FOR UPDATE: una segunda confirmación simultánea espera acá y luego ve el estado ya confirmado.
    const p = await bloquearPago(c, id);
    if (!['pendiente', 'en_revision'].includes(p.estado)) {
      throw conflicto(`El pago está ${ESTADOS[p.estado]}; solo se confirman pagos pendientes o en revisión`);
    }
    if (b.importeAprobado > p.importe) throw invalido('No se puede aprobar más de lo informado');
    await c.query(
      `UPDATE pagos SET estado = 'confirmado', importe_aprobado = $2, confirmado_por = $3, confirmado_en = now()
        WHERE id = $1`, [id, b.importeAprobado, req.user.id]);
    await c.query(
      `INSERT INTO movimientos (tipo, cliente_id, pago_id, importe, creado_por) VALUES ('cobro', $1, $2, $3, $4)`,
      [p.cliente_id, id, b.importeAprobado, req.user.id]);
    await auditar(c, req, {
      tipo: 'pago_confirmado', entidad: 'pago', entidadId: id, importe: b.importeAprobado,
      estadoAntes: p.estado, estadoDespues: 'confirmado',
      valoresAntes: { importe_aprobado: null }, valoresDespues: { importe_aprobado: b.importeAprobado },
      autorizadoPor: req.user.id,
      motivo: b.importeAprobado < p.importe ? `Aprobado ${pesos(b.importeAprobado)} de ${pesos(p.importe)} informados` : null,
    });
    const aplicado = await aplicarADeudas(c, req, {
      tipo: 'cliente', pagoId: id, parteId: p.cliente_id, aplicaciones: b.aplicaciones,
      disponible: b.importeAprobado, ref: `${codigo('PG', id)} confirmación`,
    });
    return { status: 200, body: { pago: await leerPago(c, req, id), aplicado, disponible: b.importeAprobado - aplicado } };
  });
}));

const esquemaAplicar = z.object({ aplicaciones: aplicaciones.refine((l) => l.length > 0, 'no puede estar vacío'), idempotencyKey: claveIdempotencia }).strict();

pagos.post('/:id/aplicar', h(async (req) => {
  soloDueno(req);
  const id = idDeRuta(req.params.id);
  const b = validar(esquemaAplicar, req.body);
  return conIdempotencia(req, 'aplicar_pago', `pago:${id}`, b.idempotencyKey, async (c) => {
    const p = await bloquearPago(c, id);
    if (p.estado !== 'confirmado') throw conflicto('Solo se aplican pagos confirmados');
    const disponible = p.importe_aprobado - p.aplicado;
    const aplicado = await aplicarADeudas(c, req, {
      tipo: 'cliente', pagoId: id, parteId: p.cliente_id, aplicaciones: b.aplicaciones, disponible,
      ref: `${codigo('PG', id)} aplicación posterior`,
    });
    return { status: 200, body: { pago: await leerPago(c, req, id), aplicado, disponible: disponible - aplicado } };
  });
}));

pagos.post('/:id/rechazar', h(async (req) => {
  soloDueno(req);
  const id = idDeRuta(req.params.id);
  const b = validar(z.object({ motivo }).strict(), req.body);
  return tx(async (c) => {
    const p = await bloquearPago(c, id);
    if (!['pendiente', 'en_revision'].includes(p.estado)) throw conflicto(`El pago está ${ESTADOS[p.estado]}`);
    await c.query(
      `UPDATE pagos SET estado = 'rechazado', rechazado_por = $2, rechazado_en = now(), rechazo_motivo = $3 WHERE id = $1`,
      [id, req.user.id, b.motivo]);
    await auditar(c, req, {
      tipo: 'pago_rechazado', entidad: 'pago', entidadId: id, importe: p.importe,
      estadoAntes: p.estado, estadoDespues: 'rechazado', autorizadoPor: req.user.id, motivo: b.motivo,
    });
    return { body: { pago: await leerPago(c, req, id) } };
  });
}));

pagos.post('/:id/anular', h(async (req) => {
  soloDueno(req);
  const id = idDeRuta(req.params.id);
  const b = validar(z.object({ motivo }).strict(), req.body);
  return tx(async (c) => {
    const p = await bloquearPago(c, id);
    if (p.estado !== 'confirmado') throw conflicto('Solo se anulan pagos confirmados');
    await revertirAplicaciones(c, req, { tipo: 'cliente', pagoId: id, motivo: b.motivo, ref: `${codigo('PG', id)} anulación` });
    const { rows: [cobro] } = await c.query("SELECT id FROM movimientos WHERE tipo = 'cobro' AND pago_id = $1", [id]);
    await c.query(
      `INSERT INTO movimientos (tipo, cliente_id, pago_id, importe, motivo, movimiento_origen_id, creado_por)
       VALUES ('reversion_cobro', $1, $2, $3, $4, $5, $6)`,
      [p.cliente_id, id, p.importe_aprobado, b.motivo, cobro?.id ?? null, req.user.id]);
    await c.query(
      `UPDATE pagos SET estado = 'anulado', anulado_por = $2, anulado_en = now(), anulacion_motivo = $3 WHERE id = $1`,
      [id, req.user.id, b.motivo]);
    await auditar(c, req, {
      tipo: 'pago_anulado', entidad: 'pago', entidadId: id, importe: p.importe_aprobado,
      estadoAntes: 'confirmado', estadoDespues: 'anulado', autorizadoPor: req.user.id, motivo: b.motivo,
      ref: cobro ? `revierte movimiento ${cobro.id}` : null,
    });
    return { body: { pago: await leerPago(c, req, id) } };
  });
}));
