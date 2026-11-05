export class HttpError extends Error {
  constructor(status, mensaje, extra) {
    super(mensaje);
    this.status = status;
    this.extra = extra;
  }
}

export const prohibido = (m = 'No tenés permiso para esta operación') => new HttpError(403, m);
export const noEncontrado = (m = 'No encontrado') => new HttpError(404, m);
export const conflicto = (m) => new HttpError(409, m);
export const invalido = (m) => new HttpError(422, m);

export function exigir(cond, err) {
  if (!cond) throw err;
}

/** Traduce errores de PostgreSQL a respuestas HTTP sin filtrar detalles internos. */
export function desdePostgres(e) {
  if (!e || typeof e.code !== 'string') return null;
  if (/^HZ\d{3}$/.test(e.code)) return new HttpError(Number(e.code.slice(2)), e.message);
  switch (e.code) {
    case '23505':
      if (/referencia/.test(e.constraint || '')) return conflicto('Ya hay un pago informado con ese número de operación');
      if (/un_solo_dueno/.test(e.constraint || '')) return prohibido('Ya existe un dueño');
      if (/email/.test(e.constraint || '')) return conflicto('Ya existe un usuario con ese email');
      if (/comprobante/.test(e.constraint || '')) return conflicto('Ese comprobante ya está asociado a otro pago');
      return conflicto('El registro ya existe');
    case '23514':
      if (/saldo/.test(e.constraint || '') || /deudas_saldo/.test(e.constraint || ''))
        return invalido('La operación dejaría una deuda con saldo negativo');
      if (/aplicado/.test(e.constraint || '')) return invalido('Las aplicaciones superan el importe disponible del pago');
      return invalido('Los datos no cumplen las reglas del sistema');
    case '23503':
      return invalido('Referencia a un registro inexistente');
    case '42501':
      return prohibido('Operación no permitida');
    case '40P01':
    case '40001':
      return conflicto('Otra operación modificó los mismos datos. Volvé a intentarlo.');
    default:
      return null;
  }
}
