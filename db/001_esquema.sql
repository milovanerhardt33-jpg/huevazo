-- El Huevazo · esquema base
-- Todos los importes son bigint en centavos de peso (ARS). Nunca se usan tipos de punto flotante.

CREATE TYPE rol_usuario        AS ENUM ('dueno', 'empleado', 'cliente');
CREATE TYPE medio_pago         AS ENUM ('transferencia', 'efectivo', 'billetera', 'cheque', 'deposito');
CREATE TYPE estado_pago        AS ENUM ('pendiente', 'en_revision', 'confirmado', 'rechazado', 'anulado');
CREATE TYPE estado_pago_granja AS ENUM ('pendiente', 'confirmado', 'rechazado', 'anulado');
CREATE TYPE estado_pedido      AS ENUM ('solicitado', 'entregado', 'cancelado');
CREATE TYPE tipo_deuda         AS ENUM ('cliente', 'granja');
CREATE TYPE tipo_movimiento    AS ENUM ('venta', 'cobro', 'reversion_cobro', 'compra', 'pago_proveedor',
                                        'reversion_pago_proveedor', 'ajuste');

-- ---------------------------------------------------------------- usuarios
CREATE TABLE usuarios (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email          text NOT NULL CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  nombre         text NOT NULL CHECK (length(nombre) BETWEEN 1 AND 120),
  rol            rol_usuario NOT NULL,
  password_hash  text NOT NULL,
  activo         boolean NOT NULL DEFAULT true,
  creado         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX usuarios_email_unico ON usuarios (email);
-- Un único dueño: un segundo INSERT/UPDATE con rol 'dueno' viola este índice.
CREATE UNIQUE INDEX un_solo_dueno ON usuarios (rol) WHERE rol = 'dueno';

CREATE TABLE permisos_empleado (
  usuario_id      bigint PRIMARY KEY REFERENCES usuarios (id),
  pedidos         boolean NOT NULL DEFAULT false,
  pagos_recibidos boolean NOT NULL DEFAULT false,
  pagos_granja    boolean NOT NULL DEFAULT false,
  actualizado     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sesiones (
  token_hash  bytea PRIMARY KEY,
  usuario_id  bigint NOT NULL REFERENCES usuarios (id),
  creada      timestamptz NOT NULL DEFAULT now(),
  expira      timestamptz NOT NULL,
  ip          text,
  user_agent  text
);
CREATE INDEX sesiones_usuario ON sesiones (usuario_id);

-- ---------------------------------------------------------------- catálogo y granjas
CREATE TABLE productos (
  id      text PRIMARY KEY CHECK (id ~ '^[A-Z0-9-]{2,16}$'),
  nombre  text NOT NULL,
  unidad  text NOT NULL,
  precio  bigint NOT NULL CHECK (precio > 0 AND precio <= 10000000000000),
  activo  boolean NOT NULL DEFAULT true
);

CREATE TABLE granjas (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre  text NOT NULL UNIQUE CHECK (length(nombre) BETWEEN 1 AND 120),
  activo  boolean NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------- pedidos
CREATE TABLE pedidos (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cliente_id        bigint NOT NULL REFERENCES usuarios (id),
  estado            estado_pedido NOT NULL DEFAULT 'solicitado',
  total             bigint NOT NULL CHECK (total > 0),
  cargado_por       bigint NOT NULL REFERENCES usuarios (id),
  creado            timestamptz NOT NULL DEFAULT now(),
  entregado_por     bigint REFERENCES usuarios (id),
  entregado_en      timestamptz,
  cancelado_por     bigint REFERENCES usuarios (id),
  cancelado_en      timestamptz,
  cancelado_motivo  text
);
CREATE INDEX pedidos_cliente ON pedidos (cliente_id);

CREATE TABLE pedido_items (
  pedido_id    bigint NOT NULL REFERENCES pedidos (id),
  producto_id  text NOT NULL REFERENCES productos (id),
  cantidad     integer NOT NULL CHECK (cantidad BETWEEN 1 AND 500),
  precio       bigint NOT NULL CHECK (precio > 0),
  subtotal     bigint GENERATED ALWAYS AS (cantidad * precio) STORED,
  PRIMARY KEY (pedido_id, producto_id)
);

-- ---------------------------------------------------------------- deudas
-- saldo lo mantienen exclusivamente los triggers de aplicaciones y ajustes.
CREATE TABLE deudas (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tipo        tipo_deuda NOT NULL,
  cliente_id  bigint REFERENCES usuarios (id),
  granja_id   bigint REFERENCES granjas (id),
  origen      text NOT NULL CHECK (length(origen) BETWEEN 1 AND 160),
  pedido_id   bigint UNIQUE REFERENCES pedidos (id),   -- un pedido genera una sola deuda
  importe     bigint NOT NULL CHECK (importe > 0 AND importe <= 10000000000000),
  saldo       bigint NOT NULL CHECK (saldo >= 0),
  creado      timestamptz NOT NULL DEFAULT now(),
  creado_por  bigint NOT NULL REFERENCES usuarios (id),
  CONSTRAINT deuda_una_parte CHECK (
    (tipo = 'cliente' AND cliente_id IS NOT NULL AND granja_id IS NULL) OR
    (tipo = 'granja'  AND granja_id  IS NOT NULL AND cliente_id IS NULL))
);
CREATE INDEX deudas_cliente ON deudas (cliente_id) WHERE cliente_id IS NOT NULL;
CREATE INDEX deudas_granja  ON deudas (granja_id)  WHERE granja_id  IS NOT NULL;

-- ---------------------------------------------------------------- comprobantes
CREATE TABLE comprobantes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subido_por  bigint NOT NULL REFERENCES usuarios (id),
  nombre      text NOT NULL CHECK (length(nombre) BETWEEN 1 AND 120),
  mime        text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  tam         integer NOT NULL CHECK (tam BETWEEN 1 AND 5242880),
  sha256      bytea NOT NULL,
  datos       bytea NOT NULL,
  creado      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- pagos de clientes (dinero recibido)
CREATE TABLE pagos (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cliente_id        bigint NOT NULL REFERENCES usuarios (id),
  importe           bigint NOT NULL CHECK (importe > 0 AND importe <= 10000000000000),
  moneda            char(3) NOT NULL DEFAULT 'ARS' CHECK (moneda = 'ARS'),
  fecha             date NOT NULL,
  medio             medio_pago NOT NULL,
  referencia        text NOT NULL DEFAULT '' CHECK (length(referencia) <= 60),
  comprobante_id    bigint UNIQUE REFERENCES comprobantes (id),
  nota              text NOT NULL DEFAULT '' CHECK (length(nota) <= 300),
  estado            estado_pago NOT NULL DEFAULT 'pendiente',
  informado_por     bigint NOT NULL REFERENCES usuarios (id),
  informado_rol     rol_usuario NOT NULL,
  creado            timestamptz NOT NULL DEFAULT now(),
  revision_por      bigint REFERENCES usuarios (id),
  revision_en       timestamptz,
  importe_aprobado  bigint CHECK (importe_aprobado > 0 AND importe_aprobado <= importe),
  aplicado          bigint NOT NULL DEFAULT 0 CHECK (aplicado >= 0),
  confirmado_por    bigint REFERENCES usuarios (id),
  confirmado_en     timestamptz,
  rechazado_por     bigint REFERENCES usuarios (id),
  rechazado_en      timestamptz,
  rechazo_motivo    text,
  anulado_por       bigint REFERENCES usuarios (id),
  anulado_en        timestamptz,
  anulacion_motivo  text,
  CONSTRAINT aplicado_hasta_aprobado CHECK (aplicado <= coalesce(importe_aprobado, 0)),
  CONSTRAINT confirmacion_completa CHECK (
    (estado IN ('confirmado', 'anulado')) =
    (importe_aprobado IS NOT NULL AND confirmado_por IS NOT NULL AND confirmado_en IS NOT NULL)),
  CONSTRAINT rechazo_con_motivo CHECK (
    (estado = 'rechazado') = (rechazo_motivo IS NOT NULL AND rechazado_por IS NOT NULL AND rechazado_en IS NOT NULL)),
  CONSTRAINT anulacion_con_motivo CHECK (
    (estado = 'anulado') = (anulacion_motivo IS NOT NULL AND anulado_por IS NOT NULL AND anulado_en IS NOT NULL)),
  CONSTRAINT anulado_sin_aplicaciones CHECK (estado <> 'anulado' OR aplicado = 0)
);
CREATE INDEX pagos_cliente ON pagos (cliente_id);
CREATE INDEX pagos_estado  ON pagos (estado);
-- Una misma operación bancaria no se puede informar dos veces (salvo que la anterior haya sido rechazada).
CREATE UNIQUE INDEX pagos_referencia_unica ON pagos (medio, lower(referencia))
  WHERE referencia <> '' AND estado <> 'rechazado';

-- ---------------------------------------------------------------- pagos a granjas (dinero pagado)
CREATE TABLE pagos_granja (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  granja_id         bigint NOT NULL REFERENCES granjas (id),
  importe           bigint NOT NULL CHECK (importe > 0 AND importe <= 10000000000000),
  moneda            char(3) NOT NULL DEFAULT 'ARS' CHECK (moneda = 'ARS'),
  fecha             date NOT NULL,
  medio             medio_pago NOT NULL,
  referencia        text NOT NULL DEFAULT '' CHECK (length(referencia) <= 60),
  comprobante_id    bigint UNIQUE REFERENCES comprobantes (id),
  observaciones     text NOT NULL DEFAULT '' CHECK (length(observaciones) <= 300),
  estado            estado_pago_granja NOT NULL DEFAULT 'pendiente',
  preparado_por     bigint NOT NULL REFERENCES usuarios (id),
  preparado_rol     rol_usuario NOT NULL,
  creado            timestamptz NOT NULL DEFAULT now(),
  propuesta         jsonb NOT NULL DEFAULT '[]'::jsonb,
  aplicado          bigint NOT NULL DEFAULT 0 CHECK (aplicado >= 0),
  autorizado_por    bigint REFERENCES usuarios (id),
  autorizado_en     timestamptz,
  rechazado_por     bigint REFERENCES usuarios (id),
  rechazado_en      timestamptz,
  rechazo_motivo    text,
  anulado_por       bigint REFERENCES usuarios (id),
  anulado_en        timestamptz,
  anulacion_motivo  text,
  CONSTRAINT pg_aplicado_hasta_importe CHECK (aplicado <= importe),
  CONSTRAINT pg_aplica_solo_confirmado CHECK (estado = 'confirmado' OR aplicado = 0),
  CONSTRAINT pg_autorizacion_completa CHECK (
    (estado IN ('confirmado', 'anulado')) = (autorizado_por IS NOT NULL AND autorizado_en IS NOT NULL)),
  CONSTRAINT pg_rechazo_con_motivo CHECK (
    (estado = 'rechazado') = (rechazo_motivo IS NOT NULL AND rechazado_por IS NOT NULL)),
  CONSTRAINT pg_anulacion_con_motivo CHECK (
    (estado = 'anulado') = (anulacion_motivo IS NOT NULL AND anulado_por IS NOT NULL))
);
CREATE UNIQUE INDEX pagos_granja_referencia_unica ON pagos_granja (medio, lower(referencia))
  WHERE referencia <> '' AND estado <> 'rechazado';

-- ---------------------------------------------------------------- aplicaciones de pagos a deudas
CREATE TABLE aplicaciones (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pago_id           bigint REFERENCES pagos (id),
  pago_granja_id    bigint REFERENCES pagos_granja (id),
  deuda_id          bigint NOT NULL REFERENCES deudas (id),
  importe           bigint NOT NULL CHECK (importe > 0),
  creado            timestamptz NOT NULL DEFAULT now(),
  creado_por        bigint NOT NULL REFERENCES usuarios (id),
  revertida         boolean NOT NULL DEFAULT false,
  revertida_por     bigint REFERENCES usuarios (id),
  revertida_en      timestamptz,
  reversion_motivo  text,
  CONSTRAINT aplicacion_un_pago CHECK ((pago_id IS NULL) <> (pago_granja_id IS NULL)),
  CONSTRAINT reversion_completa CHECK (
    revertida = (revertida_por IS NOT NULL AND revertida_en IS NOT NULL AND reversion_motivo IS NOT NULL))
);
CREATE INDEX aplicaciones_pago   ON aplicaciones (pago_id) WHERE pago_id IS NOT NULL;
CREATE INDEX aplicaciones_pagog  ON aplicaciones (pago_granja_id) WHERE pago_granja_id IS NOT NULL;
CREATE INDEX aplicaciones_deuda  ON aplicaciones (deuda_id);

-- ---------------------------------------------------------------- libro de movimientos (solo anexado)
CREATE TABLE movimientos (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tipo                  tipo_movimiento NOT NULL,
  cliente_id            bigint REFERENCES usuarios (id),
  granja_id             bigint REFERENCES granjas (id),
  deuda_id              bigint REFERENCES deudas (id),
  pago_id               bigint REFERENCES pagos (id),
  pago_granja_id        bigint REFERENCES pagos_granja (id),
  pedido_id             bigint REFERENCES pedidos (id),
  movimiento_origen_id  bigint REFERENCES movimientos (id),
  importe               bigint NOT NULL CHECK (importe <> 0),
  motivo                text CHECK (motivo IS NULL OR length(motivo) <= 300),
  creado                timestamptz NOT NULL DEFAULT now(),
  creado_por            bigint NOT NULL REFERENCES usuarios (id),
  CONSTRAINT ajuste_con_deuda_y_motivo CHECK (tipo <> 'ajuste' OR (deuda_id IS NOT NULL AND length(motivo) >= 5)),
  CONSTRAINT solo_ajuste_negativo CHECK (tipo = 'ajuste' OR importe > 0),
  CONSTRAINT movimiento_una_parte CHECK ((cliente_id IS NULL) <> (granja_id IS NULL))
);
CREATE INDEX movimientos_cliente ON movimientos (cliente_id) WHERE cliente_id IS NOT NULL;
CREATE INDEX movimientos_granja  ON movimientos (granja_id)  WHERE granja_id IS NOT NULL;

-- ---------------------------------------------------------------- auditoría (solo anexado, encadenada)
CREATE TABLE auditoria (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seq              bigint NOT NULL UNIQUE,
  evento_uuid      uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  en               timestamptz NOT NULL,
  usuario_id       bigint NOT NULL REFERENCES usuarios (id),
  usuario_rol      rol_usuario NOT NULL,
  tipo             text NOT NULL,
  entidad          text NOT NULL,
  entidad_id       text NOT NULL,
  importe          bigint,
  estado_antes     text,
  estado_despues   text,
  valores_antes    jsonb,
  valores_despues  jsonb,
  autorizado_por   bigint REFERENCES usuarios (id),
  motivo           text,
  ref              text,
  ip               text,
  prev_hash        text NOT NULL,
  hash             text NOT NULL
);
CREATE INDEX auditoria_entidad ON auditoria (entidad, entidad_id);
CREATE INDEX auditoria_tipo    ON auditoria (tipo);

-- ---------------------------------------------------------------- idempotencia
CREATE TABLE idempotencia (
  usuario_id   bigint NOT NULL REFERENCES usuarios (id),
  operacion    text NOT NULL,
  clave        text NOT NULL CHECK (length(clave) BETWEEN 8 AND 100),
  recurso      text NOT NULL,
  estado_http  integer,
  respuesta    jsonb,
  creado       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (usuario_id, operacion, clave)
);
