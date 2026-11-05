// Carga datos de ejemplo pasando por la misma API (con todas sus validaciones).
// Requiere que el dueño ya exista. Uso:
//   DUENO_EMAIL=vos@ejemplo.com DUENO_PASSWORD=... npm run db:demo
// Crea: catálogo, 2 granjas, 1 empleado y 3 clientes (contraseña DEMO_PASSWORD o "demo-huevazo-2026"),
// pedidos, cobros confirmados, rechazados y pendientes, y pagos a granjas.
import pg from 'pg';
import { config } from '../src/config.js';

process.env.COOKIE_SECURE = 'false';
const { crearApp } = await import('../src/app.js');
const { cerrar } = await import('../src/db.js');

const CLAVE = process.env.DEMO_PASSWORD || 'demo-huevazo-2026';
const dueno = { email: process.env.DUENO_EMAIL, password: process.env.DUENO_PASSWORD };
if (!dueno.email || !dueno.password) { console.error('Definí DUENO_EMAIL y DUENO_PASSWORD'); process.exit(1); }

const admin = new pg.Client({ connectionString: config.databaseAdminUrl });
await admin.connect();
await admin.query(`INSERT INTO productos (id, nombre, unidad, precio) VALUES
  ('MB-G', 'Maple blanco grande', 'maple de 30 u.', 680000),
  ('MC-G', 'Maple color grande', 'maple de 30 u.', 740000),
  ('MB-M', 'Maple blanco mediano', 'maple de 30 u.', 590000),
  ('MB-J', 'Maple blanco jumbo', 'maple de 30 u.', 830000),
  ('CJ-B', 'Cajón blanco grande', 'cajón de 12 maples (360 u.)', 7800000)
  ON CONFLICT (id) DO NOTHING`);
await admin.query("INSERT INTO granjas (nombre) VALUES ('Granja Los Aromos'), ('Avícola San Javier') ON CONFLICT (nombre) DO NOTHING");
await admin.end();

const server = crearApp().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api`;

function sesion() {
  let cookie = '';
  const pedir = async (method, ruta, body) => {
    const r = await fetch(base + ruta, {
      method, headers: { 'x-huevazo': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const j = await r.json();
    if (!r.ok) throw new Error(`${method} ${ruta}: ${r.status} ${j.error}`);
    return j;
  };
  return { get: (r) => pedir('GET', r), post: (r, b = {}) => pedir('POST', r, b), patch: (r, b) => pedir('PATCH', r, b),
    login: async (email, password) => { await pedir('POST', '/auth/login', { email, password }); } };
}
const k = () => 'demo-' + Math.random().toString(36).slice(2);
const fecha = (diasAtras) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Cordoba' })
  .format(new Date(Date.now() - diasAtras * 86400000));

try {
  const d = sesion(); await d.login(dueno.email, dueno.password);
  const existentes = await d.get('/usuarios');
  const crear = async (nombre, email, tipo) => existentes.find((u) => u.email === email)
    || (await d.post('/usuarios', { nombre, email, tipo, password: CLAVE })).usuario;
  const lucas = await crear('Lucas Ferreyra', 'lucas@demo.huevazo', 'empleado');
  const pedro = await crear('Almacén Don Pedro', 'pedro@demo.huevazo', 'cliente');
  const espiga = await crear('Panadería La Espiga', 'espiga@demo.huevazo', 'cliente');
  const gallo = await crear('Rotisería El Gallo', 'gallo@demo.huevazo', 'cliente');
  await d.patch(`/usuarios/${lucas.id}/permisos`, { pedidos: true, pagos_recibidos: true, pagos_granja: true });

  const [aromos, sanjavier] = await d.get('/granjas').then((gs) => [gs.find((g) => g.nombre === 'Granja Los Aromos'), gs.find((g) => g.nombre === 'Avícola San Javier')]);
  const c1 = (await d.post('/compras', { granjaId: aromos.id, detalle: '120 maples blanco grande', importe: 54000000 })).deuda;
  const c2 = (await d.post('/compras', { granjaId: sanjavier.id, detalle: '60 maples color grande', importe: 31800000 })).deuda;

  const cp = sesion(); await cp.login('pedro@demo.huevazo', CLAVE);
  const ce = sesion(); await ce.login('espiga@demo.huevazo', CLAVE);
  const em = sesion(); await em.login('lucas@demo.huevazo', CLAVE);

  const o1 = (await cp.post('/pedidos', { items: [{ productoId: 'CJ-B', cantidad: 2 }, { productoId: 'MC-G', cantidad: 5 }] })).pedido;
  const dp = (await d.post(`/pedidos/${o1.id}/entregar`)).deuda;
  const o2 = (await ce.post('/pedidos', { items: [{ productoId: 'CJ-B', cantidad: 1 }, { productoId: 'MB-M', cantidad: 10 }] })).pedido;
  await d.post(`/pedidos/${o2.id}/entregar`);
  const o3 = (await em.post('/pedidos', { clienteId: gallo.id, items: [{ productoId: 'MB-G', cantidad: 8 }] })).pedido;
  await d.post(`/pedidos/${o3.id}/entregar`);

  const p1 = (await cp.post('/pagos', { importe: 10000000, fecha: fecha(4), medio: 'transferencia', referencia: 'OP 88213467' })).pago;
  await d.post(`/pagos/${p1.id}/confirmar`, { importeAprobado: 10000000, aplicaciones: [{ deudaId: dp.id, importe: 10000000 }], idempotencyKey: k() });
  await d.post('/pagos-granja', { granjaId: aromos.id, importe: 30000000, fecha: fecha(3), medio: 'transferencia', referencia: 'OP 88219001',
    observaciones: 'Pago parcial de la compra', aplicaciones: [{ deudaId: c1.id, importe: 30000000 }] });
  const p2 = (await ce.post('/pagos', { importe: 5000000, fecha: fecha(2), medio: 'transferencia', referencia: 'OP 7731022' })).pago;
  await d.post(`/pagos/${p2.id}/rechazar`, { motivo: 'La operación no figura en el extracto bancario.' });
  await cp.post('/pagos', { importe: 9500000, fecha: fecha(1), medio: 'transferencia', referencia: 'OP 88240512', nota: 'Cancelo lo que queda del pedido' });
  const p4 = (await em.post('/pagos', { clienteId: gallo.id, importe: 5440000, fecha: fecha(1), medio: 'efectivo', nota: 'Cobrado en el reparto' })).pago;
  await d.post(`/pagos/${p4.id}/revision`);
  await cp.post('/pedidos', { items: [{ productoId: 'MC-G', cantidad: 3 }] });
  await em.post('/pagos-granja', { granjaId: sanjavier.id, importe: 15000000, fecha: fecha(0), medio: 'transferencia', referencia: 'OP 88251177',
    observaciones: 'Adelanto pedido por la granja', aplicaciones: [{ deudaId: c2.id, importe: 15000000 }] });
  console.log(`Datos de ejemplo cargados. Usuarios de prueba con contraseña "${CLAVE}": lucas@, pedro@, espiga@, gallo@demo.huevazo`);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  server.close();
  await cerrar();
}
