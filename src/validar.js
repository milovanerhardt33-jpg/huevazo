import { z } from 'zod';
import { HttpError } from './errores.js';
import { config } from './config.js';

/** Campos que nunca se aceptan del cliente: la autoridad y el estado los decide el servidor. */
export const CAMPOS_PROTEGIDOS = [
  'role', 'rol', 'status', 'estado', 'balance', 'saldo', 'debt', 'deuda', 'approvedBy', 'approvedAt',
  'aprobadoPor', 'aprobadoEn', 'confirmadoPor', 'confirmadoEn', 'aplicado', 'permisos', 'usuarioId',
  'informadoPor', 'autorizadoPor', 'id',
];

export const MAX_CENTAVOS = 10_000_000_000_000; // 100 mil millones de pesos

export const centavos = z.number({ invalid_type_error: 'debe ser un número' })
  .int('debe ser un entero de centavos (sin decimales)')
  .positive('debe ser mayor que cero')
  .max(MAX_CENTAVOS, 'está fuera de rango');

export const centavosConSigno = z.number().int('debe ser un entero de centavos')
  .refine((v) => v !== 0, 'no puede ser cero')
  .refine((v) => Math.abs(v) <= MAX_CENTAVOS, 'está fuera de rango');

export const idNum = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export function hoy() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.zonaHoraria }).format(new Date());
}

export const fechaPago = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'debe tener formato AAAA-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(s + 'T00:00:00Z')), 'no es una fecha válida')
  .refine((s) => s <= hoy(), 'no puede ser futura')
  .refine((s) => s >= '2000-01-01', 'es demasiado antigua');

export const medio = z.enum(['transferencia', 'efectivo', 'billetera', 'cheque', 'deposito'], {
  errorMap: () => ({ message: 'no es un medio de pago válido' }),
});

export const referencia = z.string().trim().max(60, 'admite hasta 60 caracteres').default('');
export const moneda = z.literal('ARS', { errorMap: () => ({ message: 'solo se admite ARS' }) }).optional();
export const motivo = z.string().trim().min(5, 'explicá el motivo (mínimo 5 caracteres)').max(300);
export const claveIdempotencia = z.string().min(8, 'debe tener al menos 8 caracteres').max(100)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'tiene caracteres no permitidos');

export const aplicaciones = z.array(z.object({ deudaId: idNum, importe: centavos }).strict())
  .max(50, 'admite hasta 50 deudas por operación')
  .refine((l) => new Set(l.map((a) => a.deudaId)).size === l.length, 'hay deudas repetidas');

/**
 * Valida un cuerpo con un esquema estricto. Rechaza (400) cualquier campo protegido y
 * cualquier campo desconocido, en lugar de ignorarlo silenciosamente.
 */
export function validar(esquema, cuerpo) {
  const datos = cuerpo && typeof cuerpo === 'object' && !Array.isArray(cuerpo) ? cuerpo : {};
  const prohibidos = Object.keys(datos).filter((k) => CAMPOS_PROTEGIDOS.includes(k));
  if (prohibidos.length) {
    throw new HttpError(400, `Campos no permitidos: ${prohibidos.join(', ')}. El servidor determina estos valores.`);
  }
  const r = esquema.safeParse(datos);
  if (!r.success) {
    const i = r.error.issues[0];
    const campo = i.path.join('.') || 'cuerpo';
    if (i.code === 'unrecognized_keys') throw new HttpError(400, `Campos desconocidos: ${i.keys.join(', ')}`);
    if (i.code === 'invalid_type' && i.received === 'undefined') throw new HttpError(422, `Falta ${campo}`);
    throw new HttpError(422, `${campo} ${i.message}`);
  }
  return r.data;
}

export function idDeRuta(valor) {
  if (!/^\d{1,15}$/.test(String(valor))) throw new HttpError(404, 'No encontrado');
  return Number(valor);
}
