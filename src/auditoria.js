import { tx } from './db.js';
import { HttpError } from './errores.js';

/**
 * Agrega un evento a la auditoría dentro de la transacción en curso.
 * El rol, la fecha, el número de secuencia y el hash los completa la base.
 */
export async function auditar(c, req, ev) {
  await c.query(
    `INSERT INTO auditoria (usuario_id, tipo, entidad, entidad_id, importe, estado_antes, estado_despues,
                            valores_antes, valores_despues, autorizado_por, motivo, ref, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [req.user.id, ev.tipo, ev.entidad, String(ev.entidadId), ev.importe ?? null,
      ev.estadoAntes ?? null, ev.estadoDespues ?? null,
      ev.valoresAntes ? JSON.stringify(ev.valoresAntes) : null,
      ev.valoresDespues ? JSON.stringify(ev.valoresDespues) : null,
      ev.autorizadoPor ?? null, ev.motivo ?? null, ev.ref ?? null, req.ip ?? null]);
}

/**
 * Ejecuta una operación crítica una sola vez por clave de idempotencia.
 * Si llega la misma clave otra vez (doble clic, reintento de red), devuelve la respuesta
 * original sin volver a ejecutar nada. Dos peticiones simultáneas con la misma clave se
 * serializan en el índice único: la segunda espera y luego recibe la respuesta guardada.
 */
export async function conIdempotencia(req, operacion, recurso, clave, fn) {
  return tx(async (c) => {
    const ins = await c.query(
      `INSERT INTO idempotencia (usuario_id, operacion, clave, recurso) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING RETURNING 1`, [req.user.id, operacion, clave, recurso]);
    if (!ins.rowCount) {
      const { rows: [prev] } = await c.query(
        'SELECT recurso, estado_http, respuesta FROM idempotencia WHERE usuario_id = $1 AND operacion = $2 AND clave = $3',
        [req.user.id, operacion, clave]);
      if (prev.recurso !== recurso) throw new HttpError(422, 'Esa clave de idempotencia ya se usó para otra operación');
      if (prev.respuesta == null) throw new HttpError(409, 'La operación con esta clave todavía se está procesando');
      return { status: prev.estado_http, body: { ...prev.respuesta, repetida: true } };
    }
    const res = await fn(c);
    await c.query(
      'UPDATE idempotencia SET estado_http = $4, respuesta = $5 WHERE usuario_id = $1 AND operacion = $2 AND clave = $3',
      [req.user.id, operacion, clave, res.status, JSON.stringify(res.body)]);
    return res;
  });
}
