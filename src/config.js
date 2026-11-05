try { process.loadEnvFile?.(); } catch { /* sin archivo .env: se usan las variables del entorno */ }

function requerida(nombre) {
  const v = process.env[nombre];
  if (!v) throw new Error(`Falta la variable de entorno ${nombre}`);
  return v;
}

export const config = {
  get databaseUrl() { return requerida('DATABASE_URL'); },
  get databaseAdminUrl() { return requerida('DATABASE_ADMIN_URL'); },
  port: Number(process.env.PORT || 3000),
  cookieSecure: process.env.COOKIE_SECURE !== 'false',
  sessionHours: Number(process.env.SESSION_HOURS || 12),
  trustProxy: Number(process.env.TRUST_PROXY || 0),
  zonaHoraria: 'America/Argentina/Cordoba',
};
