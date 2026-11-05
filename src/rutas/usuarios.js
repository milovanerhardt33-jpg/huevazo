import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { auditar } from '../auditoria.js';
import { soloDueno, hashPassword } from '../auth.js';
import { HttpError, invalido, noEncontrado, prohibido } from '../errores.js';
import { h } from '../finanzas.js';
import { validar, idDeRuta } from '../validar.js';

export const usuarios = Router();
export const PERMISOS_OPERATIVOS = ['pedidos', 'pagos_recibidos', 'pagos_granja'];

usuarios.get('/me', h(async (req) => ({ body: req.user })));

usuarios.get('/', h(async (req) => {
  soloDueno(req);
  const { rows } = await query(
    `SELECT u.id, u.nombre, u.email, u.rol, u.activo, u.creado,
            p.pedidos, p.pagos_recibidos, p.pagos_granja
       FROM usuarios u LEFT JOIN permisos_empleado p ON p.usuario_id = u.id ORDER BY u.rol, u.nombre`);
  return { body: rows };
}));

const esquemaNuevo = z.object({
  nombre: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email('no es un email válido').max(160),
  tipo: z.enum(['cliente', 'empleado'], { errorMap: () => ({ message: 'debe ser cliente o empleado' }) }),
  password: z.string().min(10, 'debe tener al menos 10 caracteres').max(200),
}).strict();

usuarios.post('/', h(async (req) => {
  soloDueno(req);
  if (req.body && ('rol' in req.body || 'role' in req.body)) {
    throw prohibido('El rol no se envía: se indica el tipo (cliente o empleado). El rol de dueño no se asigna por la API.');
  }
  const b = validar(esquemaNuevo, req.body);
  const hash = await hashPassword(b.password);
  return tx(async (c) => {
    const { rows: [u] } = await c.query(
      'INSERT INTO usuarios (email, nombre, rol, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, nombre, email, rol',
      [b.email, b.nombre, b.tipo, hash]);
    if (b.tipo === 'empleado') await c.query('INSERT INTO permisos_empleado (usuario_id) VALUES ($1)', [u.id]);
    await auditar(c, req, { tipo: 'usuario_creado', entidad: 'usuario', entidadId: u.id, estadoDespues: u.rol, ref: u.email });
    return { status: 201, body: { usuario: u } };
  });
}));

// Cambios de rol: nunca por la API. Ni siquiera el dueño puede transferir la titularidad desde acá.
usuarios.patch('/:id', h(async (req) => {
  const b = req.body || {};
  if ('rol' in b || 'role' in b) {
    throw prohibido('Los roles no se modifican por la API. La titularidad del dueño no es transferible desde la aplicación.');
  }
  soloDueno(req);
  const id = idDeRuta(req.params.id);
  const datos = validar(z.object({ nombre: z.string().trim().min(1).max(120).optional(), activo: z.boolean().optional() }).strict(), b);
  return tx(async (c) => {
    const { rows: [u] } = await c.query('SELECT id, nombre, activo, rol FROM usuarios WHERE id = $1 FOR UPDATE', [id]);
    if (!u) throw noEncontrado('Usuario inexistente');
    if (u.rol === 'dueno' && datos.activo === false) throw prohibido('El dueño no se puede desactivar');
    await c.query('UPDATE usuarios SET nombre = coalesce($2, nombre), activo = coalesce($3, activo) WHERE id = $1',
      [id, datos.nombre ?? null, datos.activo ?? null]);
    if (datos.activo === false) await c.query('DELETE FROM sesiones WHERE usuario_id = $1', [id]);
    await auditar(c, req, {
      tipo: 'usuario_modificado', entidad: 'usuario', entidadId: id,
      valoresAntes: { nombre: u.nombre, activo: u.activo }, valoresDespues: datos,
    });
    return { body: { ok: true } };
  });
}));

usuarios.patch('/:id/permisos', h(async (req) => {
  if (req.user.rol !== 'dueno') throw prohibido('Solo el dueño gestiona permisos');
  const id = req.params.id === 'me' ? req.user.id : idDeRuta(req.params.id);
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  for (const k of Object.keys(b)) {
    if (!PERMISOS_OPERATIVOS.includes(k)) throw invalido(`Permiso desconocido: ${k}. Los permisos financieros no se pueden delegar.`);
    if (typeof b[k] !== 'boolean') throw invalido(`${k} debe ser true o false`);
  }
  return tx(async (c) => {
    const { rows: [u] } = await c.query('SELECT rol FROM usuarios WHERE id = $1', [id]);
    if (!u) throw noEncontrado('Usuario inexistente');
    if (u.rol !== 'empleado') throw invalido('Solo se configuran permisos de empleados');
    await c.query('INSERT INTO permisos_empleado (usuario_id) VALUES ($1) ON CONFLICT (usuario_id) DO NOTHING', [id]);
    const { rows: [antes] } = await c.query(
      'SELECT pedidos, pagos_recibidos, pagos_granja FROM permisos_empleado WHERE usuario_id = $1 FOR UPDATE', [id]);
    const nuevo = { ...antes, ...b };
    await c.query('UPDATE permisos_empleado SET pedidos = $2, pagos_recibidos = $3, pagos_granja = $4 WHERE usuario_id = $1',
      [id, nuevo.pedidos, nuevo.pagos_recibidos, nuevo.pagos_granja]);
    await auditar(c, req, {
      tipo: 'permisos_modificados', entidad: 'usuario', entidadId: id,
      valoresAntes: antes, valoresDespues: nuevo, autorizadoPor: req.user.id,
    });
    return { body: { id, permisos: nuevo } };
  });
}));

usuarios.delete('/:id', () => { throw new HttpError(405, 'Los usuarios no se borran: se desactivan.'); });

export const clientes = Router();
clientes.get('/', h(async (req) => {
  if (req.user.rol === 'cliente') throw prohibido('No autorizado');
  const { rows } = await query("SELECT id, nombre FROM usuarios WHERE rol = 'cliente' AND activo ORDER BY nombre");
  return { body: rows };
}));
