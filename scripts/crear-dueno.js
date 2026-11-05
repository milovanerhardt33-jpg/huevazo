// Crea al único dueño del sistema. Es la ÚNICA forma de crear ese rol: se conecta con el usuario
// administrativo de la base, que la API nunca usa. Si ya existe un dueño, falla.
//
// Uso manual:
//   npm run db:crear-dueno -- --email vos@ejemplo.com --nombre "Nombre"
//   (la contraseña se pide por consola o se toma de DUENO_PASSWORD)
//
// Uso automático al arrancar (--si-falta): toma DUENO_EMAIL, DUENO_NOMBRE y DUENO_PASSWORD del entorno.
// Si ya hay un dueño o faltan esas variables, no hace nada y termina sin error.
import pg from 'pg';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { config } from '../src/config.js';
import { hashPassword } from '../src/auth.js';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const siFalta = process.argv.includes('--si-falta');
const email = (arg('email') || process.env.DUENO_EMAIL || '').trim().toLowerCase();
const nombre = (arg('nombre') || process.env.DUENO_NOMBRE || 'Dueño').trim();

const c = new pg.Client({ connectionString: config.databaseAdminUrl });
await c.connect();
try {
  if (siFalta) {
    const { rowCount } = await c.query("SELECT 1 FROM usuarios WHERE rol = 'dueno'");
    if (rowCount) { console.log('Dueño: ya existe.'); process.exit(0); }
    if (!email || !process.env.DUENO_PASSWORD) {
      console.log('Dueño: todavía no existe. Definí DUENO_EMAIL y DUENO_PASSWORD para crearlo en el próximo arranque.');
      process.exit(0);
    }
  }
  if (!email) { console.error('Indicá --email'); process.exit(1); }

  let password = process.env.DUENO_PASSWORD;
  if (!password) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    password = await rl.question('Contraseña del dueño (mínimo 10 caracteres): ');
    rl.close();
  }
  const hash = await hashPassword(password);

  await c.query('BEGIN');
  const { rows: [u] } = await c.query(
    "INSERT INTO usuarios (email, nombre, rol, password_hash) VALUES ($1, $2, 'dueno', $3) RETURNING id", [email, nombre, hash]);
  await c.query(
    `INSERT INTO auditoria (usuario_id, tipo, entidad, entidad_id, estado_despues, ref)
     VALUES ($1, 'dueno_creado', 'usuario', $2, 'dueno', 'script administrativo crear-dueno')`, [u.id, String(u.id)]);
  await c.query('COMMIT');
  console.log(`Dueño creado (usuario ${u.id}, ${email}).`);
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(e.constraint === 'un_solo_dueno' ? 'Ya existe un dueño. El sistema admite uno solo.' : e.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
