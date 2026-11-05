import { Router } from 'express';
import express from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { auditar } from '../auditoria.js';
import { soloDueno } from '../auth.js';
import { HttpError, invalido, noEncontrado } from '../errores.js';
import { h } from '../finanzas.js';
import { validar, centavos } from '../validar.js';

// ------------------------------------------------------------------ auditoría (solo dueño, solo lectura)
export const auditoria = Router();

auditoria.get('/', h(async (req) => {
  soloDueno(req);
  const params = [], cond = [];
  if (typeof req.query.tipo === 'string' && req.query.tipo) { params.push(req.query.tipo); cond.push(`a.tipo = $${params.length}`); }
  if (typeof req.query.entidad === 'string' && req.query.entidad) { params.push(req.query.entidad); cond.push(`a.entidad = $${params.length}`); }
  if (typeof req.query.entidadId === 'string' && req.query.entidadId) { params.push(req.query.entidadId); cond.push(`a.entidad_id = $${params.length}`); }
  const limite = Math.min(Math.max(parseInt(req.query.limite, 10) || 200, 1), 1000);
  params.push(limite);
  const { rows } = await query(
    `SELECT a.seq, a.evento_uuid, a.en, a.usuario_id, u.nombre AS usuario, a.usuario_rol, a.tipo, a.entidad, a.entidad_id,
            a.importe, a.estado_antes, a.estado_despues, a.valores_antes, a.valores_despues,
            a.autorizado_por, ua.nombre AS autorizado_por_nombre, a.motivo, a.ref, a.prev_hash, a.hash
       FROM auditoria a JOIN usuarios u ON u.id = a.usuario_id LEFT JOIN usuarios ua ON ua.id = a.autorizado_por
      WHERE ${cond.length ? cond.join(' AND ') : 'true'}
      ORDER BY a.seq DESC LIMIT $${params.length}`, params);
  return { body: rows };
}));

auditoria.get('/verificar', h(async (req) => {
  soloDueno(req);
  const { rows: [cadena] } = await query('SELECT * FROM verificar_auditoria()');
  const { rows: deudas } = await query('SELECT id, saldo_guardado, saldo_calculado FROM conciliacion_deudas WHERE saldo_guardado <> saldo_calculado');
  const { rows: pagos } = await query('SELECT tipo, id, aplicado_guardado, aplicado_calculado FROM conciliacion_pagos WHERE aplicado_guardado <> aplicado_calculado');
  return { body: { cadena, conciliacion: { ok: !deudas.length && !pagos.length, deudas, pagos } } };
}));

for (const m of ['patch', 'put', 'delete']) {
  auditoria[m]('/:id', () => {
    throw new HttpError(405, 'La auditoría es de solo anexado: nadie puede editar ni borrar eventos desde la aplicación.');
  });
}

// ------------------------------------------------------------------ catálogo
export const catalogo = Router();
catalogo.get('/', h(async () => {
  const { rows } = await query('SELECT id, nombre, unidad, precio FROM productos WHERE activo ORDER BY nombre');
  return { body: rows };
}));
catalogo.post('/', h(async (req) => {
  soloDueno(req);
  const b = validar(z.object({
    id: z.string().regex(/^[A-Z0-9-]{2,16}$/, 'debe tener 2 a 16 letras mayúsculas, números o guiones'),
    nombre: z.string().trim().min(1).max(80), unidad: z.string().trim().min(1).max(60), precio: centavos,
  }).strict(), req.body);
  return tx(async (c) => {
    await c.query('INSERT INTO productos (id, nombre, unidad, precio) VALUES ($1, $2, $3, $4)', [b.id, b.nombre, b.unidad, b.precio]);
    await auditar(c, req, { tipo: 'producto_creado', entidad: 'producto', entidadId: b.id, importe: b.precio, valoresDespues: b });
    return { status: 201, body: { producto: b } };
  });
}));
catalogo.get('/todos', h(async (req) => {
  soloDueno(req);
  const { rows } = await query('SELECT id, nombre, unidad, precio, activo FROM productos ORDER BY activo DESC, nombre');
  return { body: rows };
}));
catalogo.patch('/:id', h(async (req) => {
  soloDueno(req);
  const b = validar(z.object({ precio: centavos.optional(), activo: z.boolean().optional(), nombre: z.string().trim().min(1).max(80).optional() }).strict(), req.body);
  return tx(async (c) => {
    const { rows: [p] } = await c.query('SELECT * FROM productos WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!p) throw noEncontrado('Producto inexistente');
    await c.query('UPDATE productos SET precio = coalesce($2, precio), activo = coalesce($3, activo), nombre = coalesce($4, nombre) WHERE id = $1',
      [p.id, b.precio ?? null, b.activo ?? null, b.nombre ?? null]);
    await auditar(c, req, {
      tipo: 'producto_modificado', entidad: 'producto', entidadId: p.id,
      valoresAntes: { precio: p.precio, activo: p.activo, nombre: p.nombre }, valoresDespues: b,
    });
    return { body: { ok: true } };
  });
}));

// ------------------------------------------------------------------ comprobantes
export const comprobantes = Router();
const MAX = 5 * 1024 * 1024;

function detectarTipo(buf) {
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

comprobantes.post('/', express.raw({ type: () => true, limit: MAX }), h(async (req) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) throw invalido('El archivo está vacío');
  const mime = detectarTipo(buf);
  if (!mime) throw invalido('Solo se aceptan comprobantes en PDF, JPG, PNG o WEBP');
  let nombre = 'comprobante';
  try { nombre = decodeURIComponent(req.get('x-nombre-archivo') || nombre); } catch { /* nombre por defecto */ }
  nombre = nombre.replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(0, 120) || 'comprobante';
  const sha = crypto.createHash('sha256').update(buf).digest();
  const { rows: [cp] } = await query(
    'INSERT INTO comprobantes (subido_por, nombre, mime, tam, sha256, datos) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, nombre, mime, tam',
    [req.user.id, nombre, mime, buf.length, sha, buf]);
  return { status: 201, body: { comprobante: cp } };
}));

comprobantes.get('/:id', async (req, res, next) => {
  try {
    if (!/^\d{1,15}$/.test(req.params.id)) throw noEncontrado();
    const id = Number(req.params.id);
    // Propiedad: el dueño ve todos; los demás solo los que subieron o los de sus propios pagos.
    const { rows: [cp] } = await query(
      `SELECT c.nombre, c.mime, c.datos FROM comprobantes c
        WHERE c.id = $1 AND ($2 = 'dueno' OR c.subido_por = $3
              OR EXISTS (SELECT 1 FROM pagos p WHERE p.comprobante_id = c.id AND p.cliente_id = $3))`,
      [id, req.user.rol, req.user.id]);
    if (!cp) throw noEncontrado('Comprobante inexistente');
    res.set({
      'Content-Type': cp.mime,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(cp.nombre)}`,
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
    });
    res.send(cp.datos);
  } catch (e) { next(e); }
});
