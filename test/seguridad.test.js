// Pruebas de seguridad financiera. Cada bloque intenta romper una regla de la especificación.
// Requiere DATABASE_URL y DATABASE_ADMIN_URL apuntando a una base *_test (se borra al empezar).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prepararBase, iniciarServidor, Sesion, adminDb, appDb, DUENO, CLAVE, hoy, clave } from './ayuda.js';

let srv, dueno, empleado, pedro, espiga, ids = {};

before(async () => {
  await prepararBase();
  srv = await iniciarServidor();
  dueno = await new Sesion(srv.base).login(DUENO.email, DUENO.password);
  const crear = async (nombre, email, tipo) => (await dueno.post('/usuarios', { nombre, email, tipo, password: CLAVE })).body.usuario;
  ids.lucas = (await crear('Lucas Ferreyra', 'lucas@huevazo.test', 'empleado')).id;
  ids.pedro = (await crear('Almacén Don Pedro', 'pedro@huevazo.test', 'cliente')).id;
  ids.espiga = (await crear('Panadería La Espiga', 'espiga@huevazo.test', 'cliente')).id;
  await dueno.patch(`/usuarios/${ids.lucas}/permisos`, { pedidos: true, pagos_recibidos: true, pagos_granja: true });
  empleado = await new Sesion(srv.base).login('lucas@huevazo.test', CLAVE);
  pedro = await new Sesion(srv.base).login('pedro@huevazo.test', CLAVE);
  espiga = await new Sesion(srv.base).login('espiga@huevazo.test', CLAVE);

  // Pedido de Don Pedro entregado: deuda de $193.000
  const o = await pedro.post('/pedidos', { items: [{ productoId: 'CJ-B', cantidad: 2 }, { productoId: 'MC-G', cantidad: 5 }] });
  assert.equal(o.status, 201);
  const e = await dueno.post(`/pedidos/${o.body.pedido.id}/entregar`);
  ids.deudaPedro = e.body.deuda.id;
  const o2 = await espiga.post('/pedidos', { items: [{ productoId: 'MB-G', cantidad: 10 }] });
  ids.deudaEspiga = (await dueno.post(`/pedidos/${o2.body.pedido.id}/entregar`)).body.deuda.id;
});
after(async () => { srv?.server.close(); const { cerrar } = await import('../src/db.js'); await cerrar(); });

const saldo = async (id) => (await (await dueno.get('/deudas')).body).find((d) => d.id === id).saldo;
const pagoBase = (extra = {}) => ({ importe: 5000000, fecha: hoy(), medio: 'transferencia', referencia: 'OP ' + clave(), ...extra });

// ------------------------------------------------------------------ 1. roles y escalamiento
test('nadie se convierte en dueño por la API', async () => {
  assert.equal((await pedro.patch('/usuarios/me', { rol: 'dueno' })).status, 403);
  assert.equal((await empleado.patch(`/usuarios/${ids.lucas}`, { role: 'dueno' })).status, 403);
  assert.equal((await dueno.patch(`/usuarios/${ids.lucas}`, { rol: 'dueno' })).status, 403, 'ni el dueño transfiere el rol por la API');
  assert.equal((await dueno.post('/usuarios', { nombre: 'X', email: 'x@huevazo.test', tipo: 'dueno', password: CLAVE })).status, 422);
  assert.equal((await dueno.post('/usuarios', { nombre: 'X', email: 'x@huevazo.test', rol: 'dueno', password: CLAVE })).status, 403);
  const me = await pedro.get('/usuarios/me');
  assert.equal(me.body.rol, 'cliente');
});

test('un empleado no se otorga permisos ni accede a funciones financieras', async () => {
  assert.equal((await empleado.patch(`/usuarios/${ids.lucas}/permisos`, { pedidos: true })).status, 403);
  assert.equal((await empleado.patch('/usuarios/me/permisos', { confirmar_pagos: true })).status, 403);
  assert.equal((await dueno.patch(`/usuarios/${ids.lucas}/permisos`, { confirmar_pagos: true })).status, 422, 'no existen permisos financieros delegables');
  assert.equal((await empleado.get('/auditoria')).status, 403);
  assert.equal((await empleado.get('/deudas?tipo=cliente')).status, 403);
  assert.equal((await empleado.post(`/deudas/${ids.deudaPedro}/ajustes`, { importe: -100, motivo: 'descuento' })).status, 403);
  assert.equal((await empleado.patch(`/deudas/${ids.deudaPedro}`, { saldo: 0 })).status, 403);
});

// ------------------------------------------------------------------ 2. informar ≠ confirmar
test('informar un pago nunca lo confirma, aunque se envíe el estado', async () => {
  const antes = await saldo(ids.deudaPedro);
  const r = await pedro.post('/pagos', pagoBase({ estado: 'confirmado', approvedBy: ids.pedro }));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /estado, approvedBy/);
  const ok = await pedro.post('/pagos', pagoBase());
  assert.equal(ok.status, 201);
  assert.equal(ok.body.pago.estado, 'pendiente');
  assert.equal(await saldo(ids.deudaPedro), antes, 'un pago pendiente no cambia saldos');
});

test('un cliente no confirma ni aplica sus pagos', async () => {
  const p = (await pedro.post('/pagos', pagoBase())).body.pago;
  assert.equal((await pedro.post(`/pagos/${p.id}/confirmar`, { importeAprobado: p.importe, idempotencyKey: clave() })).status, 403);
  assert.equal((await empleado.post(`/pagos/${p.id}/confirmar`, { importeAprobado: p.importe, idempotencyKey: clave() })).status, 403);
  assert.equal((await pedro.patch(`/pagos/${p.id}`, { estado: 'confirmado' })).status, 405);
  assert.equal((await pedro.pedir('PATCH', `/pagos/${p.id}`, { nota: 'x' })).status, 405);
});

// ------------------------------------------------------------------ 3. propiedad de los recursos
test('un cliente solo ve sus propios datos', async () => {
  const pe = (await espiga.post('/pagos', pagoBase())).body.pago;
  assert.equal((await pedro.get(`/pagos/${pe.id}`)).status, 404);
  assert.ok((await pedro.get('/pagos')).body.every((p) => p.cliente_id === ids.pedro));
  assert.ok((await pedro.get('/deudas')).body.every((d) => d.cliente_id === ids.pedro));
  assert.ok((await pedro.get('/deudas?parte=' + ids.espiga)).body.every((d) => d.cliente_id === ids.pedro));
  assert.ok((await pedro.get('/movimientos')).body.every((m) => m.cliente_id === ids.pedro));
  assert.ok((await pedro.get('/pedidos')).body.every((o) => o.cliente_id === ids.pedro));
  assert.equal((await pedro.post('/pagos', pagoBase({ clienteId: ids.espiga }))).status, 403);
  assert.equal((await pedro.get('/auditoria')).status, 403);
});

// ------------------------------------------------------------------ 4. confirmación, transacción, idempotencia
test('confirmar aplica a deudas y es atómico: si una aplicación falla, no se guarda nada', async () => {
  const p = (await pedro.post('/pagos', pagoBase({ importe: 10000000 }))).body.pago;
  const s0 = await saldo(ids.deudaPedro);
  // aplicación a una deuda de otro cliente → falla y revierte la confirmación completa
  const mal = await dueno.post(`/pagos/${p.id}/confirmar`, {
    importeAprobado: 10000000, idempotencyKey: clave(),
    aplicaciones: [{ deudaId: ids.deudaPedro, importe: 5000000 }, { deudaId: ids.deudaEspiga, importe: 5000000 }],
  });
  assert.equal(mal.status, 422);
  assert.equal((await dueno.get(`/pagos/${p.id}`)).body.estado, 'pendiente');
  assert.equal(await saldo(ids.deudaPedro), s0);

  const ok = await dueno.post(`/pagos/${p.id}/confirmar`, {
    importeAprobado: 10000000, idempotencyKey: clave(), aplicaciones: [{ deudaId: ids.deudaPedro, importe: 10000000 }],
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.pago.estado, 'confirmado');
  assert.equal(await saldo(ids.deudaPedro), s0 - 10000000);
  ids.pagoConfirmado = p.id;
});

test('no se aplica más de lo aprobado ni más de lo adeudado', async () => {
  const p = (await pedro.post('/pagos', pagoBase({ importe: 1000000 }))).body.pago;
  const r1 = await dueno.post(`/pagos/${p.id}/confirmar`, {
    importeAprobado: 1000000, idempotencyKey: clave(), aplicaciones: [{ deudaId: ids.deudaPedro, importe: 2000000 }],
  });
  assert.equal(r1.status, 422);
  assert.equal((await dueno.post(`/pagos/${p.id}/confirmar`, { importeAprobado: 2000000, idempotencyKey: clave() })).status, 422,
    'no se aprueba más de lo informado');
  const r2 = await dueno.post(`/pagos/${ids.pagoConfirmado}/aplicar`, {
    idempotencyKey: clave(), aplicaciones: [{ deudaId: ids.deudaPedro, importe: 1 }],
  });
  assert.equal(r2.status, 422, 'el pago ya no tiene disponible');
});

test('la misma clave de idempotencia no duplica la confirmación', async () => {
  const p = (await pedro.post('/pagos', pagoBase({ importe: 100000 }))).body.pago;
  const cuerpo = { importeAprobado: 100000, idempotencyKey: clave(), aplicaciones: [{ deudaId: ids.deudaPedro, importe: 100000 }] };
  const s0 = await saldo(ids.deudaPedro);
  const [a, b] = await Promise.all([dueno.post(`/pagos/${p.id}/confirmar`, cuerpo), dueno.post(`/pagos/${p.id}/confirmar`, cuerpo)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.ok(a.body.repetida || b.body.repetida, 'una de las dos es la repetición');
  assert.equal(await saldo(ids.deudaPedro), s0 - 100000, 'se aplicó una sola vez');
  const c = await adminDb();
  const { rows: [m] } = await c.query("SELECT count(*)::int AS n FROM movimientos WHERE tipo = 'cobro' AND pago_id = $1", [p.id]);
  await c.end();
  assert.equal(m.n, 1);
});

test('dos confirmaciones simultáneas con claves distintas: solo una prospera', async () => {
  const p = (await pedro.post('/pagos', pagoBase({ importe: 100000 }))).body.pago;
  const mk = () => dueno.post(`/pagos/${p.id}/confirmar`, { importeAprobado: 100000, idempotencyKey: clave(), aplicaciones: [{ deudaId: ids.deudaPedro, importe: 100000 }] });
  const s0 = await saldo(ids.deudaPedro);
  const rs = await Promise.all([mk(), mk(), mk()]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal(await saldo(ids.deudaPedro), s0 - 100000);
});

test('rechazar exige motivo y no mueve saldos; anular revierte las aplicaciones', async () => {
  const p = (await pedro.post('/pagos', pagoBase({ importe: 300000 }))).body.pago;
  assert.equal((await dueno.post(`/pagos/${p.id}/rechazar`, { motivo: '' })).status, 422);
  const s0 = await saldo(ids.deudaPedro);
  assert.equal((await dueno.post(`/pagos/${p.id}/rechazar`, { motivo: 'No figura en el extracto' })).status, 200);
  assert.equal(await saldo(ids.deudaPedro), s0);
  assert.equal((await dueno.post(`/pagos/${p.id}/confirmar`, { importeAprobado: 300000, idempotencyKey: clave() })).status, 409);

  const q = (await pedro.post('/pagos', pagoBase({ importe: 200000 }))).body.pago;
  await dueno.post(`/pagos/${q.id}/confirmar`, { importeAprobado: 200000, idempotencyKey: clave(), aplicaciones: [{ deudaId: ids.deudaPedro, importe: 200000 }] });
  assert.equal(await saldo(ids.deudaPedro), s0 - 200000);
  const an = await dueno.post(`/pagos/${q.id}/anular`, { motivo: 'Transferencia devuelta por el banco' });
  assert.equal(an.status, 200);
  assert.equal(an.body.pago.estado, 'anulado');
  assert.equal(await saldo(ids.deudaPedro), s0, 'la deuda vuelve a su saldo anterior');
  assert.ok(an.body.pago.aplicaciones.every((a) => a.revertida), 'las aplicaciones se conservan como revertidas');
});

// ------------------------------------------------------------------ 5. validaciones
test('importes: enteros de centavos, sin decimales, en rango', async () => {
  assert.equal((await pedro.post('/pagos', pagoBase({ importe: 1000.5 }))).status, 422);
  assert.equal((await pedro.post('/pagos', pagoBase({ importe: -5 }))).status, 422);
  assert.equal((await pedro.post('/pagos', pagoBase({ importe: '1000' }))).status, 422);
  assert.equal((await pedro.post('/pagos', pagoBase({ importe: 1e16 }))).status, 422);
  assert.equal((await pedro.post('/pagos', pagoBase({ moneda: 'USD' }))).status, 422);
  assert.equal((await pedro.post('/pagos', pagoBase({ fecha: '2999-01-01' }))).status, 422);
});

test('una misma operación bancaria no se informa dos veces', async () => {
  const ref = 'OP ' + clave();
  assert.equal((await pedro.post('/pagos', pagoBase({ referencia: ref }))).status, 201);
  assert.equal((await pedro.post('/pagos', pagoBase({ referencia: ref.toUpperCase() }))).status, 409);
});

test('peticiones sin el encabezado anti-CSRF se rechazan', async () => {
  assert.equal((await pedro.pedir('POST', '/pagos', pagoBase(), { sinCsrf: true })).status, 403);
  assert.equal((await new Sesion(srv.base).get('/pagos')).status, 401);
});

test('ajustes: solo el dueño, con motivo, sin dejar saldo negativo', async () => {
  const s0 = await saldo(ids.deudaEspiga);
  assert.equal((await dueno.post(`/deudas/${ids.deudaEspiga}/ajustes`, { importe: -(s0 + 1), motivo: 'bonificación total' })).status, 422);
  assert.equal((await dueno.post(`/deudas/${ids.deudaEspiga}/ajustes`, { importe: -68000, motivo: 'x' })).status, 422);
  const r = await dueno.post(`/deudas/${ids.deudaEspiga}/ajustes`, { importe: -68000, motivo: '1 maple llegó roto' });
  assert.equal(r.status, 201);
  assert.equal(r.body.deuda.saldo, s0 - 68000);
});

// ------------------------------------------------------------------ 6. pagos a granjas
test('un empleado prepara un pago a granja; solo el dueño lo autoriza', async () => {
  const g = (await dueno.get('/granjas')).body[0];
  const d = (await dueno.post('/compras', { granjaId: g.id, detalle: '120 maples blanco grande', importe: 54000000 })).body.deuda;
  const r = await empleado.post('/pagos-granja', {
    granjaId: g.id, importe: 15000000, fecha: hoy(), medio: 'transferencia', referencia: 'OP ' + clave(),
    aplicaciones: [{ deudaId: d.id, importe: 15000000 }],
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.pagoGranja.estado, 'pendiente');
  const deudaGranja = async () => (await dueno.get('/deudas?tipo=granja')).body.find((x) => x.id === d.id).saldo;
  assert.equal(await deudaGranja(), 54000000, 'pendiente: la deuda no cambia');
  assert.equal((await empleado.post(`/pagos-granja/${r.body.pagoGranja.id}/autorizar`, { idempotencyKey: clave() })).status, 403);
  const a = await dueno.post(`/pagos-granja/${r.body.pagoGranja.id}/autorizar`, { idempotencyKey: clave() });
  assert.equal(a.status, 200);
  assert.equal(await deudaGranja(), 39000000);
});

// ------------------------------------------------------------------ 7. defensas en la base de datos
test('la base rechaza escrituras directas del usuario de la aplicación', async () => {
  const c = await appDb();
  const intento = async (sql, params) => { try { await c.query(sql, params); return 'ok'; } catch (e) { return e.code; } };
  assert.equal(await intento('UPDATE deudas SET saldo = 0 WHERE id = $1', [ids.deudaPedro]), '42501');
  assert.equal(await intento('UPDATE pagos SET aplicado = 0'), '42501');
  assert.equal(await intento("UPDATE usuarios SET rol = 'dueno' WHERE id = $1", [ids.pedro]), '42501');
  assert.equal(await intento('DELETE FROM auditoria'), '42501');
  assert.equal(await intento("UPDATE auditoria SET motivo = 'x'"), '42501');
  assert.equal(await intento('DELETE FROM movimientos'), '42501');
  assert.equal(await intento("INSERT INTO usuarios (email, nombre, rol, password_hash) VALUES ('z@z.zz', 'Z', 'dueno', 'x')"), 'HZ403');
  // Un INSERT directo que pretende nacer confirmado queda pendiente igual.
  const { rows: [p] } = await c.query(
    `INSERT INTO pagos (cliente_id, importe, fecha, medio, informado_por, informado_rol, estado, importe_aprobado, confirmado_por, confirmado_en)
     VALUES ($1, 100, current_date, 'efectivo', $1, 'cliente', 'confirmado', 100, $1, now()) RETURNING estado, importe_aprobado`, [ids.pedro]);
  assert.deepEqual([p.estado, p.importe_aprobado], ['pendiente', null]);
  // Una confirmación con un usuario que no es dueño la rechaza el trigger.
  assert.equal(await intento("UPDATE pagos SET estado = 'confirmado', importe_aprobado = importe, confirmado_por = $1, confirmado_en = now() WHERE estado = 'pendiente'", [ids.lucas]), 'HZ403');
  await c.end();
});

test('la auditoría es inalterable y la cadena detecta ediciones por fuera', async () => {
  const v1 = (await dueno.get('/auditoria/verificar')).body;
  assert.equal(v1.cadena.integra, true);
  assert.equal(v1.conciliacion.ok, true, 'saldos guardados = saldos calculados');
  assert.equal((await dueno.del('/auditoria/1')).status, 405);
  const a = await adminDb();
  await assert.rejects(a.query("UPDATE auditoria SET importe = 1 WHERE seq = 3"), /solo anexado/);
  // Un administrador que desactiva el trigger y edita la tabla queda en evidencia.
  await a.query('ALTER TABLE auditoria DISABLE TRIGGER auditoria_inmutable');
  await a.query('UPDATE auditoria SET importe = 1 WHERE seq = 3');
  await a.query('ALTER TABLE auditoria ENABLE TRIGGER auditoria_inmutable');
  await a.end();
  const v2 = (await dueno.get('/auditoria/verificar')).body;
  assert.equal(v2.cadena.integra, false);
  assert.equal(v2.cadena.roto_en, 3);
});
