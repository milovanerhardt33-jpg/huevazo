// Clave del usuario de base huevazo_app.
// Si APP_DB_PASSWORD está definida se usa esa. Si no, se deriva de la clave administrativa con
// HMAC-SHA256: nadie tiene que inventarla ni guardarla, y como las migraciones la reaplican en
// cada arranque, sigue sincronizada aunque cambie la clave administrativa.
import crypto from 'node:crypto';

export function claveApp(env = process.env) {
  if (env.APP_DB_PASSWORD) return env.APP_DB_PASSWORD;
  const admin = decodeURIComponent(new URL(env.DATABASE_ADMIN_URL).password || '');
  if (admin.length < 12) throw new Error('Definí APP_DB_PASSWORD (la clave administrativa es demasiado corta para derivarla)');
  return crypto.createHmac('sha256', admin).update('huevazo_app').digest('base64url');
}
