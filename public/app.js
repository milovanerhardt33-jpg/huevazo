// El Huevazo, interfaz. Toda autorización la decide el servidor: esta interfaz solo muestra
// u oculta acciones según el rol para comodidad; si alguien fuerza una acción, la API la rechaza.

const TZ = 'America/Argentina/Cordoba';
const MEDIOS = { transferencia: 'Transferencia', efectivo: 'Efectivo', billetera: 'Billetera virtual', cheque: 'Cheque', deposito: 'Depósito' };
const ESTADO = { pendiente: 'Pendiente', en_revision: 'En revisión', confirmado: 'Confirmado', rechazado: 'Rechazado', anulado: 'Anulado', solicitado: 'Solicitado', entregado: 'Entregado', cancelado: 'Cancelado' };
const ROLNOM = { dueno: 'Dueño', empleado: 'Empleado', cliente: 'Cliente' };
const PERMISOS = { pedidos: 'Registrar pedidos de clientes', pagos_recibidos: 'Informar pagos recibidos (quedan pendientes)', pagos_granja: 'Preparar pagos a granjas (quedan para autorizar)' };
const TIPOS_AUD = {
  pago_informado: 'Pago informado', pago_en_revision: 'Pago en revisión', pago_confirmado: 'Pago confirmado', pago_rechazado: 'Pago rechazado',
  pago_anulado: 'Pago anulado', aplicacion: 'Aplicación a deuda', aplicacion_revertida: 'Aplicación revertida', ajuste: 'Ajuste',
  pedido_creado: 'Pedido creado', pedido_entregado: 'Pedido entregado', pedido_cancelado: 'Pedido cancelado', compra_registrada: 'Compra a granja',
  pago_granja_preparado: 'Pago a granja preparado', pago_granja_registrado: 'Pago a granja registrado', pago_granja_autorizado: 'Pago a granja autorizado',
  pago_granja_rechazado: 'Pago a granja rechazado', pago_granja_anulado: 'Pago a granja anulado', permisos_modificados: 'Permisos modificados',
  usuario_creado: 'Usuario creado', usuario_modificado: 'Usuario modificado', dueno_creado: 'Dueño creado', granja_creada: 'Granja creada',
  producto_creado: 'Producto creado', producto_modificado: 'Producto modificado',
};
const PREFIJO = { pago: 'PG', pago_granja: 'PP', deuda: 'D', pedido: 'P', granja: 'G', usuario: 'U' };

// ------------------------------------------------------------------ utilidades
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cod = (p, id) => `${p}-${String(id).padStart(4, '0')}`;
function fmt(c) { const neg = c < 0; c = Math.abs(c); const e = Math.floor(c / 100), r = c % 100; return (neg ? '−' : '') + '$ ' + e.toLocaleString('es-AR') + (r ? ',' + String(r).padStart(2, '0') : ''); }
function fmtPlain(c) { const e = Math.floor(c / 100), r = c % 100; return e.toLocaleString('es-AR') + (r ? ',' + String(r).padStart(2, '0') : ''); }
function parseMoney(str) {
  const s = String(str || '').trim().replace(/\s/g, ''); if (!s) return 0;
  if (!/^(\d{1,3}(\.\d{3})+|\d+)(,\d{1,2})?$/.test(s)) return NaN;
  const [i, d = ''] = s.split(','); return parseInt(i.replace(/\./g, ''), 10) * 100 + parseInt((d + '00').slice(0, 2), 10);
}
const fDT = (iso) => new Intl.DateTimeFormat('es-AR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
const fD = (iso) => new Intl.DateTimeFormat('es-AR', { timeZone: TZ, day: '2-digit', month: '2-digit' }).format(new Date(iso));
const fYMD = (ymd) => (ymd ? ymd.slice(8, 10) + '/' + ymd.slice(5, 7) : '');
const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const chip = (e) => `<span class="chip c-${e}">${ESTADO[e] || e}</span>`;
const sum = (a) => a.reduce((x, y) => x + y, 0);
const nuevaClave = () => 'k-' + crypto.getRandomValues(new Uint32Array(4)).join('-');
const empty = (t) => `<div class="empty">${t}</div>`;

let tt;
function toast(m, k) { const t = $('#toast'); t.textContent = m; t.className = k || ''; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => { t.hidden = true; }, 4200); }

class ErrorApi extends Error { constructor(status, msg) { super(msg); this.status = status; } }
async function api(method, path, body, extraHeaders = {}) {
  const headers = { 'x-huevazo': '1', ...extraHeaders };
  let cuerpo;
  if (body instanceof Blob) cuerpo = body;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; cuerpo = JSON.stringify(body); }
  const r = await fetch('/api' + path, { method, headers, body: cuerpo, credentials: 'same-origin' });
  const datos = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
  if (r.status === 401 && yo && path !== '/auth/login') { yo = null; pantallaLogin('Tu sesión venció. Volvé a ingresar.'); throw new ErrorApi(401, 'Sesión vencida'); }
  if (!r.ok) throw new ErrorApi(r.status, datos?.error || 'No se pudo completar la operación');
  return datos;
}
const get = (p) => api('GET', p);
const post = (p, b = {}) => api('POST', p, b);
const patch = (p, b = {}) => api('PATCH', p, b);

async function subirComprobante(input) {
  const f = input?.files?.[0];
  if (!f) return undefined;
  if (f.size > 5 * 1024 * 1024) throw new ErrorApi(413, 'El comprobante supera los 5 MB');
  const r = await api('POST', '/comprobantes', f, { 'content-type': f.type || 'application/octet-stream', 'x-nombre-archivo': encodeURIComponent(f.name) });
  return r.comprobante.id;
}

// ------------------------------------------------------------------ estado de la interfaz
let yo = null;
const ui = { tab: {}, filtro: 'revisar', audTipo: '' };
const TABS = {
  dueno: [['resumen', 'Resumen'], ['pagos', 'Pagos'], ['pedidos', 'Pedidos'], ['cuentas', 'Cuentas'], ['granjas', 'Granjas'], ['auditoria', 'Auditoría'], ['personas', 'Clientes y equipo'], ['catalogo', 'Catálogo']],
  empleado: [['pedidos', 'Pedidos'], ['cobro', 'Informar cobro'], ['granja', 'Pago a granja'], ['permisos', 'Mis permisos']],
  cliente: [['cuenta', 'Mi cuenta'], ['pedir', 'Hacer pedido'], ['mispedidos', 'Mis pedidos'], ['pagar', 'Informar pago']],
};

function pantallaLogin(msg = '') {
  closeSheet();
  $('#app').innerHTML = `<main class="wrap login"><form class="card" data-form="login">
    <div class="brand"><div><b>El Huevazo</b><small>Distribución de huevos</small></div></div>
    <div class="field"><label for="lg-email">Email</label><input id="lg-email" type="email" autocomplete="username" required></div>
    <div class="field"><label for="lg-pw">Contraseña</label><input id="lg-pw" type="password" autocomplete="current-password" required></div>
    <div class="err" id="lg-err">${esc(msg)}</div>
    <div class="actions"><button class="btn primary" type="submit">Ingresar</button></div></form></main>`;
  $('#lg-email').focus();
}

let renderSeq = 0;
async function render() {
  const r = yo.rol, tabs = TABS[r];
  if (!ui.tab[r] || !tabs.some((t) => t[0] === ui.tab[r])) ui.tab[r] = tabs[0][0];
  if (!$('#main')) {
    $('#app').innerHTML = `<header class="top"><div class="wrap top-in">
      <div class="brand"><div><b>El Huevazo</b><small>Distribución de huevos</small></div></div>
      <div class="userbox"><b>${esc(yo.nombre)}</b><span class="rolepill">${ROLNOM[r]}</span><button class="linkbtn" data-act="salir">Salir</button></div>
      </div><nav class="tabs wrap" id="tabs" aria-label="Secciones"></nav></header>
      <main class="wrap" id="main"></main>`;
  }
  const seq = ++renderSeq;
  let html;
  try { html = await V[`${r}:${ui.tab[r]}`](); } catch (e) { if (e.status === 401) return; html = `<div class="badbox">${esc(e.message)}</div>`; }
  if (seq !== renderSeq) return;
  let pend = 0;
  if (r === 'dueno') { try { pend = (await get('/pagos?estado=pendiente,en_revision')).length + (await get('/pagos-granja')).filter((p) => p.estado === 'pendiente').length; } catch { /* sin contador */ } }
  $('#tabs').innerHTML = tabs.map(([k, l]) => `<button class="tab" data-act="tab" data-k="${k}" ${ui.tab[r] === k ? 'aria-current="page"' : ''}>${l}${k === 'pagos' && pend ? `<span class="count">${pend}</span>` : ''}</button>`).join('');
  $('#main').innerHTML = `<div class="view">${html}</div>`;
  document.querySelectorAll('#main .dist').forEach(autofill);
  calcCat();
}

// ------------------------------------------------------------------ piezas comunes
function rowPago(p, conCliente = true) {
  const sub = [conCliente ? `<span class="id">${cod('PG', p.id)}</span>` : '', conCliente ? MEDIOS[p.medio] : '', conCliente ? fYMD(p.fecha) : `<span class="id">${cod('PG', p.id)}</span>`,
    p.referencia ? esc(p.referencia) : '', p.informado_rol === 'empleado' ? 'informado por ' + esc(p.informado_por_nombre) : ''].filter(Boolean).join(', ');
  return `<button class="row" data-act="verPago" data-id="${p.id}"><div class="row-main"><span class="row-t">${conCliente ? esc(p.cliente) : MEDIOS[p.medio] + ', ' + fYMD(p.fecha)}</span><span class="row-s">${sub}</span></div><div class="row-end"><span class="amt">${fmt(p.importe)}</span>${chip(p.estado)}</div></button>`;
}
function rowPedido(o, quien) {
  const det = (o.items || []).map((i) => `${i.cantidad} × ${esc(i.nombre)}`).join(', ');
  const acc = o.estado === 'solicitado' && quien === 'dueno'
    ? `<div class="actions mt-6"><button class="btn small primary" data-act="entregar" data-id="${o.id}">Marcar entregado</button><button class="btn small" data-act="cancelarPedido" data-id="${o.id}">Cancelar</button></div>`
    : o.estado === 'solicitado' && quien === 'cliente' ? `<div class="actions mt-6"><button class="btn small" data-act="cancelarPedido" data-id="${o.id}">Cancelar pedido</button></div>` : '';
  return `<div class="row"><div class="row-main"><span class="row-t">${quien === 'cliente' ? 'Pedido ' + cod('P', o.id) : esc(o.cliente)}</span><span class="row-s">${quien === 'cliente' ? '' : `<span class="id">${cod('P', o.id)}</span>, `}${fD(o.creado)}, ${det}</span>${acc}</div><div class="row-end"><span class="amt">${fmt(o.total)}</span>${chip(o.estado)}</div></div>`;
}
function rowPP(p) {
  return `<button class="row" data-act="verPP" data-id="${p.id}"><div class="row-main"><span class="row-t">${esc(p.granja)}</span><span class="row-s"><span class="id">${cod('PP', p.id)}</span>, ${MEDIOS[p.medio]}, ${fYMD(p.fecha)}${p.referencia ? ', ' + esc(p.referencia) : ''}${p.estado === 'pendiente' && p.preparado_rol === 'empleado' ? ', preparado por ' + esc(p.preparado_por_nombre) : ''}</span></div><div class="row-end"><span class="amt out">−${fmt(p.importe)}</span>${chip(p.estado)}</div></button>`;
}
const moneyField = (id, label, val = '', hint = '') => `<div class="field"><label for="${id}">${label}</label><div class="money"><input id="${id}" inputmode="decimal" autocomplete="off" placeholder="0" value="${esc(val)}"></div>${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
const medioField = (id) => `<div class="field"><label for="${id}">Medio de pago</label><select id="${id}">${Object.entries(MEDIOS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>`;
const locked = (t) => `<div class="card"><h3>Sin permiso</h3><p class="muted">${t} El dueño puede habilitarlo.</p></div>`;

function distBlock(deudas, { limitSrc = '', limit = 0, preset = null } = {}) {
  const resumen = `<div class="dsum"><div>Aplicado<b class="d-ap">$ 0</b></div><div>Disponible<b class="d-lim">$ 0</b></div><div>Sin aplicar<b class="d-rest">$ 0</b></div></div>`;
  if (!deudas.length) return `<div class="dist" data-limit-src="${limitSrc}" data-limit="${limit}">${empty('No hay deudas abiertas en esta cuenta. El importe queda disponible para aplicar después.')}${resumen}</div>`;
  return `<div class="dist" data-limit-src="${limitSrc}" data-limit="${limit}" ${preset ? 'data-preset="1"' : ''}>${deudas.map((d) => {
    const pv = preset && preset.find((x) => x.deudaId === d.id);
    return `<div class="drow"><div class="row-main"><span class="row-t">${esc(d.origen)}</span><span class="row-s"><span class="id">${cod('D', d.id)}</span>, ${fD(d.creado)}, saldo <span class="mono">${fmt(d.saldo)}</span></span></div><div class="money"><input class="dist-in" id="dist-${d.id}" inputmode="decimal" data-deuda="${d.id}" data-saldo="${d.saldo}" aria-label="Aplicar a ${cod('D', d.id)}" value="${pv ? fmtPlain(Math.min(pv.importe, d.saldo)) : ''}"></div></div>`;
  }).join('')}${resumen}</div>`;
}
function distLimit(d) { if (d.dataset.limitSrc) { const v = parseMoney($('#' + d.dataset.limitSrc)?.value); return Number.isNaN(v) ? 0 : v; } return +d.dataset.limit; }
function autofill(d) {
  if (d.dataset.preset === '1') { d.dataset.preset = '0'; return recalc(d); }
  let rest = distLimit(d);
  d.querySelectorAll('.dist-in').forEach((i) => { const v = Math.min(+i.dataset.saldo, rest); i.value = v > 0 ? fmtPlain(v) : ''; rest -= Math.max(v, 0); });
  recalc(d);
}
function recalc(d) {
  const lim = distLimit(d); let ap = 0, mal = false;
  d.querySelectorAll('.dist-in').forEach((i) => { const v = parseMoney(i.value); if (Number.isNaN(v) || v > +i.dataset.saldo) mal = true; else ap += v; });
  d.querySelector('.d-ap').textContent = fmt(ap); d.querySelector('.d-lim').textContent = fmt(lim);
  const r = d.querySelector('.d-rest'); r.textContent = fmt(lim - ap); r.parentElement.classList.toggle('over', ap > lim || mal);
}
function distCollect(d) {
  const out = [];
  for (const i of d.querySelectorAll('.dist-in')) {
    const v = parseMoney(i.value);
    if (Number.isNaN(v)) throw new Error(`Importe inválido para ${cod('D', i.dataset.deuda)}`);
    if (v > 0) out.push({ deudaId: Number(i.dataset.deuda), importe: v });
  }
  return out;
}
async function catBlock() {
  const prods = await get('/catalogo');
  return `<div class="list cat">${prods.map((p) => `<div class="prod"><div class="row-main"><span class="row-t">${esc(p.nombre)}</span><span class="row-s">${esc(p.unidad)}, <span class="mono">${fmt(p.precio)}</span></span></div><div class="qty"><button type="button" data-act="qty" data-d="-1" data-p="${esc(p.id)}" aria-label="Quitar uno">−</button><input id="q-${esc(p.id)}" data-qty="${esc(p.id)}" data-precio="${p.precio}" inputmode="numeric" value="0" aria-label="Cantidad de ${esc(p.nombre)}"><button type="button" data-act="qty" data-d="1" data-p="${esc(p.id)}" aria-label="Agregar uno">+</button></div></div>`).join('') || empty('El catálogo está vacío.')}</div>
  <div class="total"><span>Total estimado</span><span class="amt" id="cat-total">$ 0</span></div>`;
}
function calcCat() { let t = 0; document.querySelectorAll('[data-qty]').forEach((i) => { const n = parseInt(i.value, 10); if (n > 0) t += n * +i.dataset.precio; }); const el = $('#cat-total'); if (el) el.textContent = fmt(t); }
async function pagoForm({ conCliente = false, boton = 'Informar pago' } = {}) {
  const cl = conCliente ? await get('/clientes') : [];
  return `<form class="card" data-form="pago">
  <div class="grid2">
    ${conCliente ? `<div class="field"><label for="pg-cliente">Cliente</label><select id="pg-cliente">${cl.map((c) => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('')}</select></div>` : ''}
    ${moneyField('pg-importe', 'Importe', '', 'Ej.: 95.000 o 95.000,50')}
    <div class="field"><label for="pg-fecha">Fecha del pago</label><input type="date" id="pg-fecha" value="${hoy()}" max="${hoy()}"></div>
    ${medioField('pg-medio')}
    <div class="field"><label for="pg-ref">Número de operación</label><input id="pg-ref" autocomplete="off" maxlength="60"><span class="hint">Obligatorio en transferencias</span></div>
    <div class="field"><label for="pg-comp">Comprobante</label><input type="file" id="pg-comp" accept="image/jpeg,image/png,image/webp,application/pdf"><span class="hint">PDF o imagen, hasta 5 MB</span></div>
  </div>
  <div class="field"><label for="pg-nota">Nota (opcional)</label><input id="pg-nota" maxlength="300"></div>
  <div class="err" id="pg-err"></div>
  <div class="actions"><button class="btn primary" type="submit">${boton}</button></div></form>`;
}
async function ppForm(boton) {
  const gs = await get('/granjas');
  if (!gs.length) return '<div class="card">Todavía no hay granjas cargadas.</div>';
  const ds = (await get(`/deudas?tipo=granja&abiertas=1&parte=${gs[0].id}`));
  return `<form class="card" data-form="pagoGranja">
  <div class="grid2">
   <div class="field"><label for="pp-granja">Granja o proveedor</label><select id="pp-granja">${gs.map((g) => `<option value="${g.id}">${esc(g.nombre)}</option>`).join('')}</select></div>
   ${moneyField('pp-importe', 'Importe pagado')}
   <div class="field"><label for="pp-fecha">Fecha</label><input type="date" id="pp-fecha" value="${hoy()}" max="${hoy()}"></div>
   ${medioField('pp-medio')}
   <div class="field"><label for="pp-ref">Número de operación</label><input id="pp-ref" autocomplete="off" maxlength="60"></div>
   <div class="field"><label for="pp-comp">Comprobante</label><input type="file" id="pp-comp" accept="image/jpeg,image/png,image/webp,application/pdf"></div>
  </div>
  <div class="field"><label for="pp-obs">Observaciones</label><input id="pp-obs" maxlength="300"></div>
  <div class="field"><span class="lbl">Deudas que cancela</span><div id="pp-dist">${distBlock(ds, { limitSrc: 'pp-importe' })}</div></div>
  <div class="err" id="pp-err"></div>
  <div class="actions"><button class="btn primary" type="submit">${boton}</button></div></form>`;
}

// ------------------------------------------------------------------ vistas del dueño
const V = {};
V['dueno:resumen'] = async () => {
  const [deudas, rev, pg, ped] = await Promise.all([get('/deudas'), get('/pagos?estado=pendiente,en_revision'), get('/pagos-granja'), get('/pedidos')]);
  const cobrar = sum(deudas.filter((d) => d.tipo === 'cliente').map((d) => d.saldo)), pagar = sum(deudas.filter((d) => d.tipo === 'granja').map((d) => d.saldo));
  const ppp = pg.filter((p) => p.estado === 'pendiente'), pp = ped.filter((o) => o.estado === 'solicitado');
  return `<div class="head"><div><h2>Resumen</h2><p>Lo que espera tu decisión. Ningún pago informado mueve saldos hasta que lo confirmes.</p></div></div>
  <div class="stats">
    <div class="stat in"><span>Por cobrar a clientes</span><b>${fmt(cobrar)}</b><small>${deudas.filter((d) => d.tipo === 'cliente' && d.saldo > 0).length} deudas abiertas</small></div>
    <div class="stat out"><span>A pagar a granjas</span><b>${fmt(pagar)}</b><small>${deudas.filter((d) => d.tipo === 'granja' && d.saldo > 0).length} deudas abiertas</small></div>
    <div class="stat"><span>Pagos por revisar</span><b>${fmt(sum(rev.map((p) => p.importe)))}</b><small>${rev.length} informados, sin efecto en saldos</small></div>
  </div>
  <section><div class="sect-t">Pagos de clientes por revisar</div><div class="list">${rev.length ? rev.map((p) => rowPago(p)).join('') : empty('No hay pagos esperando revisión.')}</div></section>
  <section><div class="sect-t">Pagos a granjas preparados por empleados</div><div class="list">${ppp.length ? ppp.map(rowPP).join('') : empty('Nada para autorizar.')}</div></section>
  <section><div class="sect-t">Pedidos sin entregar</div><div class="list">${pp.length ? pp.map((o) => rowPedido(o, 'dueno')).join('') : empty('Todos los pedidos están entregados.')}</div></section>`;
};
V['dueno:pagos'] = async () => {
  const all = await get('/pagos');
  const F = { revisar: (p) => ['pendiente', 'en_revision'].includes(p.estado), confirmado: (p) => p.estado === 'confirmado', rechazado: (p) => p.estado === 'rechazado', anulado: (p) => p.estado === 'anulado', todos: () => true };
  const L = { revisar: 'Por revisar', confirmado: 'Confirmados', rechazado: 'Rechazados', anulado: 'Anulados', todos: 'Todos' };
  const list = all.filter(F[ui.filtro]);
  return `<div class="head"><div><h2>Pagos de clientes</h2><p>Dinero recibido. Revisá el comprobante, confirmá el importe verificado y elegí qué deudas cancela.</p></div><button class="btn primary" data-act="nuevoPagoExterno">Registrar pago externo</button></div>
  <div class="filters">${Object.keys(F).map((k) => `<button class="fchip" data-act="filtro" data-k="${k}" aria-pressed="${ui.filtro === k}">${L[k]} <span class="mono">${all.filter(F[k]).length}</span></button>`).join('')}</div>
  <div class="list">${list.length ? list.map((p) => rowPago(p)).join('') : empty('No hay pagos en este estado.')}</div>`;
};
V['dueno:pedidos'] = async () => {
  const ped = await get('/pedidos');
  return `<div class="head"><div><h2>Pedidos</h2><p>Al marcar un pedido como entregado se genera la deuda del cliente con los precios del catálogo.</p></div><button class="btn primary" data-act="nuevoPedido">Nuevo pedido</button></div>
  <div class="list">${ped.length ? ped.map((o) => rowPedido(o, 'dueno')).join('') : empty('Todavía no hay pedidos.')}</div>`;
};
V['dueno:cuentas'] = async () => {
  const [deudas, cl] = await Promise.all([get('/deudas?tipo=cliente'), get('/clientes')]);
  return `<div class="head"><div><h2>Cuentas corrientes</h2><p>Saldo de cada cliente. Las correcciones se registran como ajustes con motivo; nunca se sobrescribe un saldo.</p></div></div>
  <div class="list">${cl.length ? cl.map((c) => { const ds = deudas.filter((d) => d.cliente_id === c.id); const s = sum(ds.map((d) => d.saldo)); return `<button class="row" data-act="verCuenta" data-id="${c.id}" data-nombre="${esc(c.nombre)}"><div class="row-main"><span class="row-t">${esc(c.nombre)}</span><span class="row-s">${ds.filter((d) => d.saldo > 0).length} deudas abiertas</span></div><div class="row-end"><span class="amt ${s > 0 ? 'out' : ''}">${fmt(s)}</span><span class="small muted">debe</span></div></button>`; }).join('') : empty('Todavía no hay clientes. Cargalos en “Clientes y equipo”.')}</div>`;
};
V['dueno:granjas'] = async () => {
  const [gs, deudas, pg] = await Promise.all([get('/granjas'), get('/deudas?tipo=granja'), get('/pagos-granja')]);
  return `<div class="head"><div><h2>Granjas y proveedores</h2><p>Dinero que pagás. Se registra aparte de los cobros a clientes.</p></div><div class="actions"><button class="btn" data-act="nuevaGranja">Nueva granja</button><button class="btn" data-act="nuevaCompra">Registrar compra</button><button class="btn primary" data-act="nuevoPagoGranja">Registrar pago directo</button></div></div>
  <div class="stats">${gs.map((g) => `<div class="stat out"><span>${esc(g.nombre)}</span><b>${fmt(g.saldo)}</b><small>${deudas.filter((d) => d.granja_id === g.id && d.saldo > 0).length} deudas abiertas</small></div>`).join('') || empty('Sin granjas.')}</div>
  <section><div class="sect-t">Deudas con granjas</div><div class="list">${deudas.length ? deudas.map((d) => `<div class="row"><div class="row-main"><span class="row-t">${esc(d.parte)}</span><span class="row-s"><span class="id">${cod('D', d.id)}</span>, ${fD(d.creado)}, ${esc(d.origen)}, original ${fmt(d.importe)}</span></div><div class="row-end"><span class="amt">${fmt(d.saldo)}</span><button class="btn small" data-act="ajuste" data-id="${d.id}">Ajustar</button></div></div>`).join('') : empty('Sin deudas.')}</div></section>
  <section><div class="sect-t">Pagos a granjas</div><div class="list">${pg.length ? pg.map(rowPP).join('') : empty('Sin pagos registrados.')}</div></section>`;
};
V['dueno:auditoria'] = async () => {
  const [ev, ver] = await Promise.all([get('/auditoria?limite=300' + (ui.audTipo ? '&tipo=' + encodeURIComponent(ui.audTipo) : '')), get('/auditoria/verificar')]);
  const ok = ver.cadena.integra && ver.conciliacion.ok;
  const cambio = (e) => {
    if (e.estado_antes || e.estado_despues) return `<span class="muted">estado:</span> ${esc(e.estado_antes || '—')} <span class="arrow">→</span> ${esc(e.estado_despues || '—')}`;
    if (e.valores_despues && 'saldo' in e.valores_despues) return `<span class="muted">saldo:</span> ${e.valores_antes ? fmt(e.valores_antes.saldo) : '—'} <span class="arrow">→</span> ${fmt(e.valores_despues.saldo)}`;
    if (e.valores_despues) return `<span class="muted">${esc(JSON.stringify(e.valores_despues)).slice(0, 120)}</span>`;
    return '';
  };
  return `<div class="head"><div><h2>Auditoría</h2><p>Registro de solo anexado. Cada evento guarda la huella del anterior: si alguien edita la base por fuera de la aplicación, la cadena se rompe y se nota.</p></div></div>
  <div class="${ok ? 'okbox' : 'badbox'}"><b>${ver.cadena.integra ? 'Cadena íntegra' : 'Cadena rota en el evento ' + ver.cadena.roto_en}</b>, ${ver.cadena.eventos} eventos, ${ver.conciliacion.ok ? 'saldos conciliados' : `<b>${ver.conciliacion.deudas.length + ver.conciliacion.pagos.length} saldos no coinciden con su historial</b>`}</div>
  <div class="actions"><div class="field minw-220"><label for="aud-tipo">Tipo de operación</label><select id="aud-tipo"><option value="">Todas</option>${Object.entries(TIPOS_AUD).map(([k, v]) => `<option value="${k}" ${ui.audTipo === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div></div>
  <div class="aud"><table><thead><tr><th>N.º</th><th>Fecha</th><th>Usuario</th><th>Operación</th><th>Entidad</th><th>Importe</th><th>Cambio</th><th>Autorizó</th><th>Motivo / referencia</th><th>Huella</th></tr></thead><tbody>
  ${ev.map((e) => `<tr class="${ver.cadena.roto_en === e.seq ? 'broken' : ''}"><td class="mono">${e.seq}</td><td class="mono">${fDT(e.en)}</td><td>${esc(e.usuario)}<br><span class="muted">${ROLNOM[e.usuario_rol]}</span></td><td>${TIPOS_AUD[e.tipo] || esc(e.tipo)}</td><td class="mono">${PREFIJO[e.entidad] ? cod(PREFIJO[e.entidad], e.entidad_id) : esc(e.entidad_id)}</td><td class="mono">${e.importe != null ? fmt(e.importe) : ''}</td><td>${cambio(e)}</td><td>${esc(e.autorizado_por_nombre || '')}</td><td>${esc(e.motivo || '')}${e.motivo && e.ref ? '<br>' : ''}<span class="muted">${esc(e.ref || '')}</span></td><td class="mono muted">${e.hash.slice(0, 10)}</td></tr>`).join('')}
  </tbody></table></div>`;
};
V['dueno:personas'] = async () => {
  const us = await get('/usuarios');
  const emp = us.filter((u) => u.rol === 'empleado'), cl = us.filter((u) => u.rol === 'cliente');
  return `<div class="head"><div><h2>Clientes y equipo</h2><p>Los empleados solo tienen permisos operativos. Nada de lo que hagan cambia un saldo sin tu autorización.</p></div><button class="btn primary" data-act="nuevoUsuario">Agregar persona</button></div>
  ${emp.map((u) => `<section><div class="sect-t">${esc(u.nombre)}, empleado ${u.activo ? '' : '<span class="chip c-off">Desactivado</span>'}</div><div class="list">${Object.entries(PERMISOS).map(([k, l]) => `<label class="toggle" for="perm-${u.id}-${k}"><span>${l}</span><input type="checkbox" id="perm-${u.id}-${k}" class="perm" data-u="${u.id}" data-k="${k}" ${u[k] ? 'checked' : ''}></label>`).join('')}</div></section>`).join('')}
  <section><div class="sect-t">Clientes</div><div class="list">${cl.length ? cl.map((u) => `<div class="row"><div class="row-main"><span class="row-t">${esc(u.nombre)}</span><span class="row-s">${esc(u.email)}</span></div><div class="row-end">${u.activo ? `<button class="btn small" data-act="activo" data-id="${u.id}" data-v="0">Desactivar</button>` : `<button class="btn small" data-act="activo" data-id="${u.id}" data-v="1">Reactivar</button>`}</div></div>`).join('') : empty('Todavía no cargaste clientes.')}</div></section>
  <section><div class="sect-t">Reservado al dueño, sin excepción</div><div class="card"><ul class="never"><li>Confirmar o rechazar pagos</li><li>Aplicar pagos a deudas y cuentas corrientes</li><li>Ajustar saldos y deudas</li><li>Autorizar pagos a granjas</li><li>Anular operaciones confirmadas</li><li>Ver la auditoría completa</li><li>Asignar roles: el rol de dueño no se puede otorgar desde la aplicación</li></ul></div></section>`;
};
V['dueno:catalogo'] = async () => {
  const ps = await get('/catalogo/todos');
  return `<div class="head"><div><h2>Catálogo</h2><p>Los pedidos toman siempre estos precios. Cambiar un precio no modifica pedidos ya registrados.</p></div><button class="btn primary" data-act="nuevoProducto">Nuevo producto</button></div>
  <div class="list">${ps.map((p) => `<form class="row" data-form="precio" data-id="${esc(p.id)}"><div class="row-main"><span class="row-t">${esc(p.nombre)} ${p.activo ? '' : '<span class="chip c-off">Inactivo</span>'}</span><span class="row-s"><span class="id">${esc(p.id)}</span>, ${esc(p.unidad)}</span></div><div class="row-end"><div class="money price-in"><input id="pr-${esc(p.id)}" inputmode="decimal" value="${fmtPlain(p.precio)}" aria-label="Precio de ${esc(p.nombre)}"></div><div class="actions"><button class="btn small" type="submit">Guardar</button><button class="btn small" type="button" data-act="prodActivo" data-id="${esc(p.id)}" data-v="${p.activo ? 0 : 1}">${p.activo ? 'Desactivar' : 'Activar'}</button></div></div></form>`).join('') || empty('Sin productos.')}</div>`;
};

// ------------------------------------------------------------------ vistas del empleado
V['empleado:pedidos'] = async () => {
  if (!yo.permisos.pedidos) return locked('No tenés habilitado registrar pedidos.');
  const [ped, cl, cat] = await Promise.all([get('/pedidos'), get('/clientes'), catBlock()]);
  return `<div class="head"><div><h2>Pedidos</h2><p>Cargás el pedido; la entrega y la deuda las confirma el dueño.</p></div></div>
  <form class="card" data-form="pedido"><h3>Cargar pedido</h3><div class="field"><label for="ped-cliente">Cliente</label><select id="ped-cliente">${cl.map((c) => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('')}</select></div>${cat}<div class="actions"><button class="btn primary" type="submit">Cargar pedido</button></div></form>
  <section><div class="sect-t">Pedidos</div><div class="list">${ped.map((o) => rowPedido(o, 'empleado')).join('') || empty('Sin pedidos.')}</div></section>`;
};
V['empleado:cobro'] = async () => {
  if (!yo.permisos.pagos_recibidos) return locked('No tenés habilitado informar pagos recibidos.');
  const [form, mis] = await Promise.all([pagoForm({ conCliente: true, boton: 'Informar cobro' }), get('/pagos')]);
  return `<div class="head"><div><h2>Informar un cobro</h2><p>Si un cliente te pagó en el reparto, informalo acá. Queda pendiente hasta que el dueño lo confirme.</p></div></div>
  ${form}<section><div class="sect-t">Cobros que informaste</div><div class="list">${mis.length ? mis.map((p) => rowPago(p)).join('') : empty('Todavía no informaste cobros.')}</div></section>`;
};
V['empleado:granja'] = async () => {
  if (!yo.permisos.pagos_granja) return locked('No tenés habilitado preparar pagos a granjas.');
  const [form, mis] = await Promise.all([ppForm('Enviar para autorizar'), get('/pagos-granja')]);
  return `<div class="head"><div><h2>Preparar pago a granja</h2><p>Cargás los datos y una propuesta de reparto. El dueño la revisa y la autoriza; recién ahí se actualiza la deuda.</p></div></div>
  ${form}<section><div class="sect-t">Pagos que preparaste</div><div class="list">${mis.length ? mis.map(rowPP).join('') : empty('Todavía no preparaste pagos.')}</div></section>`;
};
V['empleado:permisos'] = async () => `<div class="head"><div><h2>Mis permisos</h2><p>Los define el dueño. No podés modificarlos.</p></div></div>
  <div class="list">${Object.entries(PERMISOS).map(([k, l]) => `<div class="toggle"><span>${l}</span>${yo.permisos[k] ? '<span class="chip c-confirmado">Habilitado</span>' : '<span class="chip c-off">No</span>'}</div>`).join('')}</div>
  <section><div class="sect-t">Nunca disponible para empleados</div><div class="card"><ul class="never"><li>Confirmar o rechazar pagos</li><li>Modificar saldos o deudas</li><li>Aplicar pagos a cuentas corrientes</li><li>Borrar movimientos o eventos de auditoría</li><li>Cambiar permisos o asignarse el rol de dueño</li></ul></div></section>`;

// ------------------------------------------------------------------ vistas del cliente
const MVN = { venta: 'Pedido entregado', cobro: 'Pago confirmado', reversion_cobro: 'Pago anulado', ajuste: 'Ajuste' };
const refMov = (m) => (m.pago_id ? cod('PG', m.pago_id) : m.pedido_id ? cod('P', m.pedido_id) : m.deuda_id ? cod('D', m.deuda_id) : '');
const signoMov = (m) => (m.tipo === 'cobro' ? '−' + fmt(m.importe) : m.tipo === 'reversion_cobro' ? '+' + fmt(m.importe) : fmt(m.importe));
V['cliente:cuenta'] = async () => {
  const [ds, ps, mv] = await Promise.all([get('/deudas'), get('/pagos'), get('/movimientos')]);
  const saldo = sum(ds.map((d) => d.saldo)), pend = ps.filter((p) => ['pendiente', 'en_revision'].includes(p.estado));
  return `<div class="head"><div><h2>${esc(yo.nombre)}</h2><p>Tu cuenta corriente con El Huevazo.</p></div><button class="btn primary" data-act="tab" data-k="pagar">Informar un pago</button></div>
  <div class="stats"><div class="stat ${saldo > 0 ? 'out' : 'in'}"><span>Tu saldo</span><b>${fmt(saldo)}</b><small>${saldo > 0 ? 'a pagar' : 'al día'}</small></div>
  <div class="stat"><span>Pagos en revisión</span><b>${fmt(sum(pend.map((p) => p.importe)))}</b><small>${pend.length ? 'todavía no descuentan del saldo' : 'ninguno'}</small></div></div>
  ${pend.length ? `<div class="warnbox">Tenés ${pend.length} ${pend.length > 1 ? 'pagos' : 'pago'} esperando la revisión del dueño. Cuando se confirme, se descuenta de tu saldo.</div>` : ''}
  <section><div class="sect-t">Deudas</div><div class="list">${ds.length ? ds.map((d) => `<div class="row"><div class="row-main"><span class="row-t">${esc(d.origen)}</span><span class="row-s">${fD(d.creado)}, original ${fmt(d.importe)}</span></div><div class="row-end"><span class="amt">${fmt(d.saldo)}</span>${d.saldo === 0 ? '<span class="chip c-confirmado">Pagada</span>' : ''}</div></div>`).join('') : empty('No tenés deudas.')}</div></section>
  <section><div class="sect-t">Mis pagos</div><div class="list">${ps.length ? ps.map((p) => rowPago(p, false)).join('') : empty('Todavía no informaste pagos.')}</div></section>
  <section><div class="sect-t">Movimientos</div><div class="list">${mv.length ? mv.map((m) => `<div class="row"><div class="row-main"><span class="row-t">${MVN[m.tipo] || m.tipo}</span><span class="row-s">${fDT(m.creado)}, <span class="id">${refMov(m)}</span>${m.motivo ? ', ' + esc(m.motivo) : ''}</span></div><div class="row-end"><span class="amt ${m.tipo === 'cobro' || (m.tipo === 'ajuste' && m.importe < 0) ? 'in' : ''}">${signoMov(m)}</span></div></div>`).join('') : empty('Sin movimientos.')}</div></section>`;
};
V['cliente:pedir'] = async () => `<div class="head"><div><h2>Hacer un pedido</h2><p>Los precios los fija el catálogo. El pedido se suma a tu cuenta cuando se entrega.</p></div></div>
  <form class="card" data-form="pedido">${await catBlock()}<div class="actions"><button class="btn primary" type="submit">Enviar pedido</button></div></form>`;
V['cliente:mispedidos'] = async () => {
  const ped = await get('/pedidos');
  return `<div class="head"><div><h2>Mis pedidos</h2></div><button class="btn primary" data-act="tab" data-k="pedir">Nuevo pedido</button></div><div class="list">${ped.length ? ped.map((o) => rowPedido(o, 'cliente')).join('') : empty('Todavía no hiciste pedidos.')}</div>`;
};
V['cliente:pagar'] = async () => `<div class="head"><div><h2>Informar un pago</h2><p>Contanos qué pagaste y adjuntá el comprobante. El dueño lo revisa; hasta entonces tu saldo no cambia.</p></div></div>${await pagoForm()}`;

// ------------------------------------------------------------------ hojas
function openSheet(html) {
  $('#sheet-body').innerHTML = html; $('#sheet').hidden = false;
  $('#sheet-body').querySelectorAll('.dist').forEach(autofill);
  calcCat();
  const f = $('#sheet-body').querySelector('input:not([type=file]),select,textarea,button.primary');
  if (f) setTimeout(() => f.focus(), 30);
}
function closeSheet() { const s = $('#sheet'); if (s) { s.hidden = true; $('#sheet-body').innerHTML = ''; } }
const sh = (t, sub = '') => `<div class="sheet-head"><div><h3>${t}</h3>${sub ? `<div class="small muted">${sub}</div>` : ''}</div><button class="x" data-act="cerrar" aria-label="Cerrar">×</button></div>`;
const linkComp = (p) => (p.comprobante_id ? `<a class="filelink" href="/api/comprobantes/${p.comprobante_id}" target="_blank" rel="noopener">${esc(p.comprobante_nombre)}</a> <span class="muted">(${Math.max(1, Math.round(p.comprobante_tam / 1024))} KB)</span>` : '<span class="muted">sin comprobante</span>');

async function sheetPago(id) {
  const p = await get('/pagos/' + id); const own = yo.rol === 'dueno';
  openSheet(`${sh('Pago ' + cod('PG', p.id), esc(p.cliente))}<div>${chip(p.estado)}</div>
  <dl class="kv"><dt>Importe informado</dt><dd class="mono">${fmt(p.importe)}</dd><dt>Fecha del pago</dt><dd>${fYMD(p.fecha)}</dd><dt>Medio</dt><dd>${MEDIOS[p.medio]}</dd><dt>Operación</dt><dd class="mono">${esc(p.referencia) || '—'}</dd><dt>Comprobante</dt><dd>${linkComp(p)}</dd>${p.nota ? `<dt>Nota</dt><dd>${esc(p.nota)}</dd>` : ''}<dt>Informado por</dt><dd>${esc(p.informado_por_nombre)}, ${fDT(p.creado)}</dd>
  ${p.importe_aprobado != null ? `<dt>Aprobado</dt><dd class="mono">${fmt(p.importe_aprobado)}</dd><dt>Confirmó</dt><dd>${esc(p.confirmado_por_nombre)}, ${fDT(p.confirmado_en)}</dd>${p.estado === 'confirmado' ? `<dt>Aplicado</dt><dd class="mono">${fmt(p.aplicado)}</dd><dt>Disponible</dt><dd class="mono">${fmt(p.disponible)}</dd>` : ''}` : ''}
  ${p.rechazo_motivo ? `<dt>Motivo del rechazo</dt><dd>${esc(p.rechazo_motivo)}</dd><dt>Rechazado</dt><dd>${fDT(p.rechazado_en)}</dd>` : ''}
  ${p.anulacion_motivo ? `<dt>Motivo de anulación</dt><dd>${esc(p.anulacion_motivo)}</dd><dt>Anulado</dt><dd>${fDT(p.anulado_en)}</dd>` : ''}</dl>
  ${p.aplicaciones.length ? `<div><div class="sect-t">Deudas canceladas con este pago</div><div class="list">${p.aplicaciones.map((a) => `<div class="row"><div class="row-main"><span class="row-t">${esc(a.origen)}</span><span class="row-s"><span class="id">${cod('D', a.deuda_id)}</span>, ${fDT(a.creado)}</span></div><div class="row-end"><span class="amt ${a.revertida ? 'strike' : ''}">${fmt(a.importe)}</span>${a.revertida ? '<span class="small muted">revertida</span>' : ''}</div></div>`).join('')}</div></div>` : ''}
  ${['pendiente', 'en_revision'].includes(p.estado) && !own ? '<div class="warnbox">Este pago todavía no descuenta del saldo. Lo revisa el dueño.</div>' : ''}
  ${own && p.historial?.length ? `<div><div class="sect-t">Historial</div><div class="timeline">${p.historial.map((e) => `<div class="tl"><b>${TIPOS_AUD[e.tipo] || e.tipo}</b>, ${fDT(e.en)}, ${esc(e.usuario)}${e.importe != null ? ', <span class="mono">' + fmt(e.importe) + '</span>' : ''}${e.motivo ? '<br><span class="muted">' + esc(e.motivo) + '</span>' : ''}</div>`).join('')}</div></div>` : ''}
  ${own ? `<div class="actions">${p.estado === 'pendiente' ? `<button class="btn" data-act="revision" data-id="${p.id}">Pasar a revisión</button>` : ''}
    ${['pendiente', 'en_revision'].includes(p.estado) ? `<button class="btn primary" data-act="confirmar" data-id="${p.id}">Confirmar…</button><button class="btn danger" data-act="rechazar" data-id="${p.id}" data-t="cliente">Rechazar…</button>` : ''}
    ${p.estado === 'confirmado' && p.disponible > 0 ? `<button class="btn primary" data-act="aplicarSaldo" data-id="${p.id}">Aplicar disponible…</button>` : ''}
    ${p.estado === 'confirmado' ? `<button class="btn danger" data-act="anular" data-id="${p.id}">Anular…</button>` : ''}</div>` : ''}`);
}
async function sheetConfirmar(id, modo) {
  const p = await get('/pagos/' + id);
  const ds = await get(`/deudas?tipo=cliente&abiertas=1&parte=${p.cliente_id}`);
  openSheet(`${sh(modo === 'confirmar' ? 'Confirmar pago ' + cod('PG', p.id) : 'Aplicar disponible de ' + cod('PG', p.id), esc(p.cliente) + ', informó ' + fmt(p.importe) + ' por ' + MEDIOS[p.medio].toLowerCase() + (p.referencia ? ', ' + esc(p.referencia) : ''))}
  <form data-form="${modo}" data-id="${p.id}" data-key="${nuevaClave()}" class="grid-gap">
  ${modo === 'confirmar' ? moneyField('cf-importe', 'Importe verificado', fmtPlain(p.importe), 'Lo que efectivamente acreditó. Puede ser menor a lo informado, nunca mayor.') : `<div class="okbox">Disponible para aplicar: <b class="mono">${fmt(p.disponible)}</b></div>`}
  <div class="field"><span class="lbl">Deudas que cancela</span>${distBlock(ds, modo === 'confirmar' ? { limitSrc: 'cf-importe' } : { limit: p.disponible })}<span class="hint">Se reparte de la más vieja a la más nueva. Podés cambiar los importes.</span></div>
  <div class="err" id="cf-err"></div>
  <div class="actions"><button class="btn primary" type="submit">${modo === 'confirmar' ? 'Confirmar pago' : 'Aplicar'}</button><button class="btn" type="button" data-act="cerrar">Volver</button></div>
  <p class="small muted">La confirmación, el movimiento y las aplicaciones se guardan juntos: si algo falla, no se guarda nada.</p></form>`);
}
function sheetMotivo(titulo, sub, form, id, boton, t = '') {
  openSheet(`${sh(titulo, sub)}<form data-form="${form}" data-id="${id}" data-t="${t}" class="grid-gap"><div class="field"><label for="mot">Motivo</label><textarea id="mot" maxlength="300" required></textarea><span class="hint">Queda en la auditoría.</span></div><div class="err" id="mot-err"></div><div class="actions"><button class="btn danger" type="submit">${boton}</button><button class="btn" type="button" data-act="cerrar">Volver</button></div></form>`);
}
async function sheetCuenta(cid, nombre) {
  const [ds, mv, ps] = await Promise.all([get(`/deudas?tipo=cliente&parte=${cid}`), get(`/movimientos?cliente=${cid}`), get('/pagos')]);
  const MV = { venta: 'Venta (pedido entregado)', cobro: 'Cobro confirmado', reversion_cobro: 'Reversión de cobro', ajuste: 'Ajuste' };
  openSheet(`${sh(esc(nombre), 'Saldo ' + fmt(sum(ds.map((d) => d.saldo))))}
  <div><div class="sect-t">Deudas</div><div class="list">${ds.length ? ds.map((d) => `<div class="row"><div class="row-main"><span class="row-t">${esc(d.origen)}</span><span class="row-s"><span class="id">${cod('D', d.id)}</span>, ${fD(d.creado)}, original ${fmt(d.importe)}</span></div><div class="row-end"><span class="amt">${fmt(d.saldo)}</span><button class="btn small" data-act="ajuste" data-id="${d.id}">Ajustar</button></div></div>`).join('') : empty('Sin deudas.')}</div></div>
  <div><div class="sect-t">Pagos</div><div class="list">${ps.filter((p) => p.cliente_id === cid).map((p) => rowPago(p, false)).join('') || empty('Sin pagos.')}</div></div>
  <div><div class="sect-t">Movimientos</div><div class="list">${mv.length ? mv.map((m) => `<div class="row"><div class="row-main"><span class="row-t">${MV[m.tipo]}</span><span class="row-s">${fDT(m.creado)}, <span class="id">${refMov(m)}</span>${m.motivo ? ', ' + esc(m.motivo) : ''}</span></div><div class="row-end"><span class="amt">${signoMov(m)}</span></div></div>`).join('') : empty('Sin movimientos.')}</div></div>`);
}
async function sheetAjuste(did) {
  const d = (await get('/deudas')).find((x) => x.id === did);
  openSheet(`${sh('Ajustar ' + cod('D', d.id), esc(d.parte) + ', ' + esc(d.origen) + ', saldo ' + fmt(d.saldo))}
  <form data-form="ajuste" data-id="${d.id}" class="grid-gap">
  <div class="field"><span class="lbl">Tipo de ajuste</span><div class="actions"><label><input type="radio" name="aj-s" id="aj-menos" value="-1" checked> Reduce la deuda</label><label><input type="radio" name="aj-s" id="aj-mas" value="1"> Aumenta la deuda</label></div></div>
  ${moneyField('aj-importe', 'Importe')}
  <div class="field"><label for="aj-mot">Motivo</label><textarea id="aj-mot" maxlength="300" placeholder="Ej.: 2 maples llegaron rotos, se bonifican"></textarea></div>
  <div class="err" id="aj-err"></div>
  <div class="actions"><button class="btn primary" type="submit">Registrar ajuste</button><button class="btn" type="button" data-act="cerrar">Volver</button></div>
  <p class="small muted">El saldo no se sobrescribe: se agrega un movimiento de ajuste vinculado a ${cod('D', d.id)}.</p></form>`);
}
async function sheetPP(id) {
  const p = await get('/pagos-granja/' + id); const own = yo.rol === 'dueno';
  const ds = own && p.estado === 'pendiente' ? await get(`/deudas?tipo=granja&abiertas=1&parte=${p.granja_id}`) : [];
  openSheet(`${sh('Pago a granja ' + cod('PP', p.id), esc(p.granja))}<div>${chip(p.estado)}</div>
  <dl class="kv"><dt>Importe</dt><dd class="mono">${fmt(p.importe)}</dd><dt>Fecha</dt><dd>${fYMD(p.fecha)}</dd><dt>Medio</dt><dd>${MEDIOS[p.medio]}</dd><dt>Operación</dt><dd class="mono">${esc(p.referencia) || '—'}</dd><dt>Comprobante</dt><dd>${linkComp(p)}</dd>${p.observaciones ? `<dt>Observaciones</dt><dd>${esc(p.observaciones)}</dd>` : ''}<dt>Registró</dt><dd>${esc(p.preparado_por_nombre)}, ${fDT(p.creado)}</dd>${p.autorizado_en ? `<dt>Autorizó</dt><dd>${esc(p.autorizado_por_nombre)}, ${fDT(p.autorizado_en)}</dd>` : ''}${p.rechazo_motivo ? `<dt>Motivo del rechazo</dt><dd>${esc(p.rechazo_motivo)}</dd>` : ''}${p.anulacion_motivo ? `<dt>Motivo de anulación</dt><dd>${esc(p.anulacion_motivo)}</dd>` : ''}</dl>
  ${p.aplicaciones.length ? `<div><div class="sect-t">Deudas canceladas</div><div class="list">${p.aplicaciones.map((a) => `<div class="row"><div class="row-main"><span class="row-t">${esc(a.origen)}</span><span class="row-s"><span class="id">${cod('D', a.deuda_id)}</span></span></div><div class="row-end"><span class="amt ${a.revertida ? 'strike' : ''}">${fmt(a.importe)}</span></div></div>`).join('')}</div></div>` : ''}
  ${own && p.estado === 'pendiente' ? `<form data-form="autorizar" data-id="${p.id}" data-key="${nuevaClave()}" class="grid-gap"><div class="field"><span class="lbl">Reparto propuesto por ${esc(p.preparado_por_nombre)} (podés cambiarlo)</span>${distBlock(ds, { limit: p.importe, preset: p.propuesta })}</div><div class="err" id="au-err"></div><div class="actions"><button class="btn primary" type="submit">Autorizar pago</button><button class="btn danger" type="button" data-act="rechazar" data-id="${p.id}" data-t="granja">Rechazar…</button></div></form>` : ''}
  ${own && p.estado === 'confirmado' ? `<div class="actions"><button class="btn danger" data-act="anularPP" data-id="${p.id}">Anular…</button></div>` : ''}
  ${!own && p.estado === 'pendiente' ? '<div class="warnbox">Esperando la autorización del dueño. La deuda con la granja no cambia hasta entonces.</div>' : ''}`);
}

// ------------------------------------------------------------------ acciones
const recargar = async (msg) => { closeSheet(); await render(); if (msg) toast(msg); };
const ACT = {
  tab: (d) => { ui.tab[yo.rol] = d.k; closeSheet(); render(); window.scrollTo(0, 0); },
  filtro: (d) => { ui.filtro = d.k; render(); },
  cerrar: () => closeSheet(),
  salir: async () => { await post('/auth/logout').catch(() => {}); yo = null; pantallaLogin(); },
  verPago: (d) => sheetPago(+d.id),
  verPP: (d) => sheetPP(+d.id),
  verCuenta: (d) => sheetCuenta(+d.id, d.nombre),
  revision: async (d) => { await post(`/pagos/${d.id}/revision`); await render(); await sheetPago(+d.id); toast('Pago en revisión'); },
  confirmar: (d) => sheetConfirmar(+d.id, 'confirmar'),
  aplicarSaldo: (d) => sheetConfirmar(+d.id, 'aplicar'),
  rechazar: (d) => sheetMotivo('Rechazar ' + cod(d.t === 'granja' ? 'PP' : 'PG', d.id), 'El pago queda registrado como rechazado, sin efecto en saldos.', 'rechazo', d.id, 'Rechazar pago', d.t),
  anular: (d) => sheetMotivo('Anular ' + cod('PG', d.id), 'Se revierten sus aplicaciones y las deudas vuelven a su saldo anterior. El historial se conserva.', 'anulacion', d.id, 'Anular pago', 'cliente'),
  anularPP: (d) => sheetMotivo('Anular ' + cod('PP', d.id), 'Se revierten sus aplicaciones y la deuda con la granja vuelve a su saldo anterior.', 'anulacion', d.id, 'Anular pago', 'granja'),
  ajuste: (d) => sheetAjuste(+d.id),
  entregar: async (d) => { const r = await post(`/pedidos/${d.id}/entregar`); await recargar(`Pedido entregado. Se generó la deuda ${cod('D', r.deuda.id)} por ${fmt(r.deuda.importe)}`); },
  cancelarPedido: async (d) => { await post(`/pedidos/${d.id}/cancelar`, { motivo: 'Cancelado desde la aplicación' }); await recargar('Pedido cancelado'); },
  nuevoPagoExterno: async () => openSheet(sh('Registrar pago externo', 'Un pago que recibiste por fuera del sistema. Se crea pendiente y lo confirmás a continuación.') + await pagoForm({ conCliente: true, boton: 'Registrar y revisar' })),
  nuevoPedido: async () => { const [cl, cat] = await Promise.all([get('/clientes'), catBlock()]); openSheet(sh('Nuevo pedido') + `<form data-form="pedido" class="grid-gap"><div class="field"><label for="ped-cliente">Cliente</label><select id="ped-cliente">${cl.map((c) => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('')}</select></div>${cat}<div class="actions"><button class="btn primary" type="submit">Registrar pedido</button></div></form>`); },
  nuevaCompra: async () => { const gs = await get('/granjas'); openSheet(`${sh('Registrar compra a granja', 'Genera una deuda con el proveedor')}<form data-form="compra" class="grid-gap"><div class="field"><label for="co-granja">Granja</label><select id="co-granja">${gs.map((g) => `<option value="${g.id}">${esc(g.nombre)}</option>`).join('')}</select></div><div class="field"><label for="co-det">Detalle</label><input id="co-det" placeholder="Ej.: 80 maples blanco grande" maxlength="120"></div>${moneyField('co-importe', 'Importe total')}<div class="err" id="co-err"></div><div class="actions"><button class="btn primary" type="submit">Registrar compra</button><button class="btn" type="button" data-act="cerrar">Volver</button></div></form>`); },
  nuevaGranja: () => openSheet(`${sh('Nueva granja o proveedor')}<form data-form="granja" class="grid-gap"><div class="field"><label for="gr-nombre">Nombre</label><input id="gr-nombre" maxlength="120"></div><div class="err" id="gr-err"></div><div class="actions"><button class="btn primary" type="submit">Agregar</button></div></form>`),
  nuevoPagoGranja: async () => openSheet(sh('Registrar pago directo a granja', 'Como lo registra el dueño, queda autorizado al guardarlo.') + await ppForm('Registrar pago')),
  nuevoUsuario: () => openSheet(`${sh('Agregar persona', 'Clientes y empleados. El rol de dueño no se crea desde la aplicación.')}<form data-form="usuario" class="grid-gap"><div class="field"><label for="us-tipo">Tipo</label><select id="us-tipo"><option value="cliente">Cliente</option><option value="empleado">Empleado</option></select></div><div class="field"><label for="us-nombre">Nombre</label><input id="us-nombre" maxlength="120"></div><div class="field"><label for="us-email">Email</label><input id="us-email" type="email" maxlength="160"></div><div class="field"><label for="us-pw">Contraseña inicial</label><input id="us-pw" type="text" minlength="10" maxlength="200" autocomplete="new-password"><span class="hint">Mínimo 10 caracteres. Pasásela a la persona por un canal privado.</span></div><div class="err" id="us-err"></div><div class="actions"><button class="btn primary" type="submit">Crear</button></div></form>`),
  nuevoProducto: () => openSheet(`${sh('Nuevo producto')}<form data-form="producto" class="grid-gap"><div class="grid2"><div class="field"><label for="np-id">Código</label><input id="np-id" placeholder="MB-G" maxlength="16"></div><div class="field"><label for="np-nombre">Nombre</label><input id="np-nombre" placeholder="Maple blanco grande" maxlength="80"></div><div class="field"><label for="np-unidad">Unidad</label><input id="np-unidad" placeholder="maple, 30 u." maxlength="60"></div>${moneyField('np-precio', 'Precio')}</div><div class="err" id="np-err"></div><div class="actions"><button class="btn primary" type="submit">Agregar</button></div></form>`),
  activo: async (d) => { await patch(`/usuarios/${d.id}`, { activo: d.v === '1' }); await recargar(d.v === '1' ? 'Usuario reactivado' : 'Usuario desactivado'); },
  prodActivo: async (d) => { await patch(`/catalogo/${encodeURIComponent(d.id)}`, { activo: d.v === '1' }); await recargar('Producto actualizado'); },
  qty: (d) => { const i = $('#q-' + CSS.escape(d.p)); i.value = Math.max(0, (parseInt(i.value, 10) || 0) + +d.d); calcCat(); },
};

async function enviarDist(f, ruta, extra, mensaje, errId) {
  const err = f.querySelector('#' + errId); err.textContent = '';
  const b = { idempotencyKey: f.dataset.key };
  try { b.aplicaciones = distCollect(f.querySelector('.dist')); extra(b); } catch (x) { err.textContent = x.message; return; }
  try { const r = await post(ruta, b); await recargar(mensaje(r) + (r.repetida ? ' (ya estaba procesado)' : '')); } catch (x) { err.textContent = x.message; }
}
const leerMonto = (f, sel) => { const v = parseMoney(f.querySelector(sel).value); if (!v || Number.isNaN(v)) throw new Error('Escribí el importe, por ejemplo 95.000 o 95.000,50'); return v; };
async function conError(f, errId, fn) { const err = f.querySelector('#' + errId); if (err) err.textContent = ''; try { await fn(); } catch (x) { if (err) err.textContent = x.message; else toast(x.message, 'bad'); } }

const FORM = {
  login: (f) => conError(f, 'lg-err', async () => {
    await post('/auth/login', { email: f.querySelector('#lg-email').value, password: f.querySelector('#lg-pw').value });
    await arrancar();
  }),
  pedido: (f) => conError(f, 'x', async () => {
    const items = [...f.querySelectorAll('[data-qty]')].map((i) => ({ productoId: i.dataset.qty, cantidad: parseInt(i.value, 10) || 0 })).filter((i) => i.cantidad > 0);
    if (!items.length) throw new Error('Agregá al menos un producto');
    const cs = f.querySelector('#ped-cliente');
    const r = await post('/pedidos', { ...(cs ? { clienteId: +cs.value } : {}), items });
    await recargar(`Pedido ${cod('P', r.pedido.id)} cargado por ${fmt(r.pedido.total)}`);
  }),
  pago: (f) => conError(f, 'pg-err', async () => {
    const importe = leerMonto(f, '#pg-importe');
    const comprobanteId = await subirComprobante(f.querySelector('#pg-comp'));
    const cs = f.querySelector('#pg-cliente');
    const r = await post('/pagos', {
      ...(cs ? { clienteId: +cs.value } : {}), importe, fecha: f.querySelector('#pg-fecha').value, medio: f.querySelector('#pg-medio').value,
      referencia: f.querySelector('#pg-ref').value, nota: f.querySelector('#pg-nota').value, ...(comprobanteId ? { comprobanteId } : {}),
    });
    if (yo.rol === 'dueno') { await render(); await sheetConfirmar(r.pago.id, 'confirmar'); return; }
    await recargar(`Pago ${cod('PG', r.pago.id)} informado. Queda pendiente de revisión.`);
  }),
  pagoGranja: (f) => conError(f, 'pp-err', async () => {
    const importe = leerMonto(f, '#pp-importe');
    const aplicaciones = distCollect(f.querySelector('.dist'));
    const comprobanteId = await subirComprobante(f.querySelector('#pp-comp'));
    const r = await post('/pagos-granja', {
      granjaId: +f.querySelector('#pp-granja').value, importe, fecha: f.querySelector('#pp-fecha').value, medio: f.querySelector('#pp-medio').value,
      referencia: f.querySelector('#pp-ref').value, observaciones: f.querySelector('#pp-obs').value, aplicaciones,
      ...(comprobanteId ? { comprobanteId } : {}), idempotencyKey: f.dataset.key || (f.dataset.key = nuevaClave()),
    });
    await recargar(r.pagoGranja.estado === 'confirmado' ? `Pago ${cod('PP', r.pagoGranja.id)} registrado y aplicado` : `Pago ${cod('PP', r.pagoGranja.id)} enviado al dueño para autorizar`);
  }),
  confirmar: (f) => enviarDist(f, `/pagos/${f.dataset.id}/confirmar`, (b) => { b.importeAprobado = leerMonto(f, '#cf-importe'); },
    (r) => `Pago confirmado. Aplicado ${fmt(r.aplicado)}${r.disponible ? `, quedan ${fmt(r.disponible)} disponibles` : ''}`, 'cf-err'),
  aplicar: (f) => enviarDist(f, `/pagos/${f.dataset.id}/aplicar`, () => {}, (r) => `Aplicado ${fmt(r.aplicado)}`, 'cf-err'),
  autorizar: (f) => enviarDist(f, `/pagos-granja/${f.dataset.id}/autorizar`, () => {}, () => 'Pago a granja autorizado y aplicado', 'au-err'),
  rechazo: (f) => conError(f, 'mot-err', async () => {
    await post(f.dataset.t === 'granja' ? `/pagos-granja/${f.dataset.id}/rechazar` : `/pagos/${f.dataset.id}/rechazar`, { motivo: f.querySelector('#mot').value });
    await recargar('Pago rechazado. No se modificó ningún saldo.');
  }),
  anulacion: (f) => conError(f, 'mot-err', async () => {
    await post(f.dataset.t === 'granja' ? `/pagos-granja/${f.dataset.id}/anular` : `/pagos/${f.dataset.id}/anular`, { motivo: f.querySelector('#mot').value });
    await recargar('Pago anulado. Las deudas volvieron a su saldo anterior.');
  }),
  ajuste: (f) => conError(f, 'aj-err', async () => {
    const v = leerMonto(f, '#aj-importe'); const sg = f.querySelector('#aj-mas').checked ? 1 : -1;
    const r = await post(`/deudas/${f.dataset.id}/ajustes`, { importe: sg * v, motivo: f.querySelector('#aj-mot').value });
    await recargar(`Ajuste registrado. Nuevo saldo ${fmt(r.deuda.saldo)}`);
  }),
  compra: (f) => conError(f, 'co-err', async () => {
    const r = await post('/compras', { granjaId: +f.querySelector('#co-granja').value, detalle: f.querySelector('#co-det').value, importe: leerMonto(f, '#co-importe') });
    await recargar(`Compra registrada: deuda ${cod('D', r.deuda.id)}`);
  }),
  granja: (f) => conError(f, 'gr-err', async () => { await post('/granjas', { nombre: f.querySelector('#gr-nombre').value }); await recargar('Granja agregada'); }),
  usuario: (f) => conError(f, 'us-err', async () => {
    await post('/usuarios', { tipo: f.querySelector('#us-tipo').value, nombre: f.querySelector('#us-nombre').value, email: f.querySelector('#us-email').value, password: f.querySelector('#us-pw').value });
    await recargar('Persona agregada');
  }),
  producto: (f) => conError(f, 'np-err', async () => {
    await post('/catalogo', { id: f.querySelector('#np-id').value.trim().toUpperCase(), nombre: f.querySelector('#np-nombre').value, unidad: f.querySelector('#np-unidad').value, precio: leerMonto(f, '#np-precio') });
    await recargar('Producto agregado');
  }),
  precio: (f) => conError(f, 'x', async () => { await patch(`/catalogo/${encodeURIComponent(f.dataset.id)}`, { precio: leerMonto(f, '#pr-' + CSS.escape(f.dataset.id)) }); toast('Precio actualizado'); }),
};

// ------------------------------------------------------------------ eventos
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]'); if (!t) return;
  e.preventDefault();
  const fn = ACT[t.dataset.act];
  if (fn) Promise.resolve(fn(t.dataset, t)).catch((x) => { if (x.status !== 401) toast(x.message, 'bad'); });
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.classList.contains('dist-in')) recalc(t.closest('.dist'));
  else if (t.matches('[data-qty]')) calcCat();
  else if (t.id) document.querySelectorAll(`.dist[data-limit-src="${CSS.escape(t.id)}"]`).forEach(autofill);
});
document.addEventListener('change', async (e) => {
  const t = e.target;
  try {
    if (t.id === 'aud-tipo') { ui.audTipo = t.value; await render(); }
    else if (t.classList.contains('perm')) { await patch(`/usuarios/${t.dataset.u}/permisos`, { [t.dataset.k]: t.checked }); toast('Permiso actualizado'); }
    else if (t.id === 'pp-granja') {
      const ds = await get(`/deudas?tipo=granja&abiertas=1&parte=${t.value}`);
      const c = t.closest('form').querySelector('#pp-dist'); c.innerHTML = distBlock(ds, { limitSrc: 'pp-importe' }); autofill(c.querySelector('.dist'));
    }
  } catch (x) { toast(x.message, 'bad'); if (t.classList.contains('perm')) t.checked = !t.checked; }
});
document.addEventListener('submit', (e) => {
  const f = e.target; const fn = FORM[f.dataset.form]; if (!fn) return;
  e.preventDefault();
  const btn = f.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
  Promise.resolve(fn(f)).finally(() => { if (btn && btn.isConnected) btn.disabled = false; });
});

async function arrancar() {
  try { yo = await get('/usuarios/me'); } catch { return; }
  $('#app').innerHTML = '';
  await render();
}
(async () => {
  try {
    const s = await api('GET', '/auth/sesion');
    if (!s.activa) return pantallaLogin();
    yo = s.usuario; $('#app').innerHTML = ''; await render();
  } catch { pantallaLogin(); }
})();
