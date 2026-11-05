import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { auditar } from '../auditoria.js';
import { soloDueno, exigirPermiso } from '../auth.js';
import { conflicto, invalido, noEncontrado, prohibido } from '../errores.js';
import { codigo, h } from '../finanzas.js';
import { validar, idDeRuta, idNum } from '../validar.js';

export const pedidos = Router();

const SELECT_PEDIDO = `
  SELECT o.id, o.cliente_id, c.nombre AS cliente, o.estado, o.total, o.creado, o.cargado_por,
         u.nombre AS cargado_por_nombre, o.entregado_en, o.cancelado_en, o.cancelado_motivo,
         (SELECT json_agg(json_build_object('productoId', i.producto_id, 'nombre', pr.nombre, 'cantidad', i.cantidad,
                                            'precio', i.precio, 'subtotal', i.subtotal) ORDER BY pr.nombre)
            FROM pedido_items i JOIN productos pr ON pr.id = i.producto_id WHERE i.pedido_id = o.id) AS items,
         (SELECT d.id FROM deudas d WHERE d.pedido_id = o.id) AS deuda_id
    FROM pedidos o JOIN usuarios c ON c.id = o.cliente_id JOIN usuarios u ON u.id = o.cargado_por`;

function visibles(req) {
  if (req.user.rol === 'cliente') return { sql: 'o.cliente_id = $1', params: [req.user.id] };
  exigirPermiso(req, 'pedidos', 'No tenés permiso para ver pedidos');
  return { sql: 'true', params: [] };
}

pedidos.get('/', h(async (req) => {
  const v = visibles(req);
  const { rows } = await query(`${SELECT_PEDIDO} WHERE ${v.sql} ORDER BY o.creado DESC LIMIT 500`, v.params);
  return { body: rows };
}));

const esquemaPedido = z.object({
  clienteId: idNum.optional(),
  items: z.array(z.object({ productoId: z.string().regex(/^[A-Z0-9-]{2,16}$/), cantidad: z.number().int().min(1).max(500) }).strict())
    .min(1, 'no puede estar vacío').max(30)
    .refine((l) => new Set(l.map((i) => i.productoId)).size === l.length, 'tiene productos repetidos'),
}).strict();

pedidos.post('/', h(async (req) => {
  const b = validar(esquemaPedido, req.body);
  let clienteId;
  if (req.user.rol === 'cliente') {
    if (b.clienteId !== undefined && b.clienteId !== req.user.id) throw prohibido('No podés hacer pedidos para otro cliente');
    clienteId = req.user.id;
  } else {
    exigirPermiso(req, 'pedidos', 'No tenés permiso para registrar pedidos');
    if (!b.clienteId) throw invalido('Falta clienteId');
    clienteId = b.clienteId;
  }
  return tx(async (c) => {
    const { rows: [cl] } = await c.query("SELECT id FROM usuarios WHERE id = $1 AND rol = 'cliente' AND activo", [clienteId]);
    if (!cl) throw invalido('Cliente inexistente');
    // Los precios salen del catálogo del servidor; nunca del navegador.
    const { rows: prods } = await c.query('SELECT id, precio FROM productos WHERE activo AND id = ANY($1)', [b.items.map((i) => i.productoId)]);
    const precio = new Map(prods.map((p) => [p.id, p.precio]));
    for (const i of b.items) if (!precio.has(i.productoId)) throw invalido(`Producto inexistente: ${i.productoId}`);
    const total = b.items.reduce((s, i) => s + precio.get(i.productoId) * i.cantidad, 0);
    const { rows: [o] } = await c.query(
      'INSERT INTO pedidos (cliente_id, total, cargado_por) VALUES ($1, $2, $3) RETURNING id', [clienteId, total, req.user.id]);
    for (const i of b.items) {
      await c.query('INSERT INTO pedido_items (pedido_id, producto_id, cantidad, precio) VALUES ($1, $2, $3, $4)',
        [o.id, i.productoId, i.cantidad, precio.get(i.productoId)]);
    }
    await auditar(c, req, { tipo: 'pedido_creado', entidad: 'pedido', entidadId: o.id, importe: total, estadoDespues: 'solicitado' });
    const { rows: [pedido] } = await c.query(`${SELECT_PEDIDO} WHERE o.id = $1`, [o.id]);
    return { status: 201, body: { pedido } };
  });
}));

pedidos.post('/:id/entregar', h(async (req) => {
  soloDueno(req);
  const id = idDeRuta(req.params.id);
  validar(z.object({}).strict(), req.body);
  return tx(async (c) => {
    const { rows: [o] } = await c.query('SELECT * FROM pedidos WHERE id = $1 FOR UPDATE', [id]);
    if (!o) throw noEncontrado('Pedido inexistente');
    if (o.estado !== 'solicitado') throw conflicto(`El pedido está ${o.estado}`);
    await c.query("UPDATE pedidos SET estado = 'entregado', entregado_por = $2, entregado_en = now() WHERE id = $1", [id, req.user.id]);
    const { rows: [d] } = await c.query(
      `INSERT INTO deudas (tipo, cliente_id, origen, pedido_id, importe, saldo, creado_por)
       VALUES ('cliente', $1, $2, $3, $4, $4, $5) RETURNING id, importe, saldo`,
      [o.cliente_id, `Pedido ${codigo('P', id)}`, id, o.total, req.user.id]);
    await c.query(
      "INSERT INTO movimientos (tipo, cliente_id, deuda_id, pedido_id, importe, creado_por) VALUES ('venta', $1, $2, $3, $4, $5)",
      [o.cliente_id, d.id, id, o.total, req.user.id]);
    await auditar(c, req, {
      tipo: 'pedido_entregado', entidad: 'pedido', entidadId: id, importe: o.total,
      estadoAntes: 'solicitado', estadoDespues: 'entregado', autorizadoPor: req.user.id, ref: `genera ${codigo('D', d.id)}`,
    });
    const { rows: [pedido] } = await c.query(`${SELECT_PEDIDO} WHERE o.id = $1`, [id]);
    return { body: { pedido, deuda: d } };
  });
}));

pedidos.post('/:id/cancelar', h(async (req) => {
  const id = idDeRuta(req.params.id);
  const b = validar(z.object({ motivo: z.string().trim().max(200).optional() }).strict(), req.body);
  return tx(async (c) => {
    const { rows: [o] } = await c.query('SELECT * FROM pedidos WHERE id = $1 FOR UPDATE', [id]);
    const puede = o && (req.user.rol === 'dueno' || (req.user.rol === 'cliente' && o.cliente_id === req.user.id));
    if (!puede) throw noEncontrado('Pedido inexistente');
    if (o.estado !== 'solicitado') throw conflicto('Solo se cancelan pedidos que todavía no se entregaron');
    await c.query(
      "UPDATE pedidos SET estado = 'cancelado', cancelado_por = $2, cancelado_en = now(), cancelado_motivo = $3 WHERE id = $1",
      [id, req.user.id, b.motivo || null]);
    await auditar(c, req, {
      tipo: 'pedido_cancelado', entidad: 'pedido', entidadId: id, importe: o.total,
      estadoAntes: 'solicitado', estadoDespues: 'cancelado', motivo: b.motivo || null,
    });
    const { rows: [pedido] } = await c.query(`${SELECT_PEDIDO} WHERE o.id = $1`, [id]);
    return { body: { pedido } };
  });
}));
