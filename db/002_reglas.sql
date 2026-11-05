-- El Huevazo · reglas de negocio aplicadas dentro de la base de datos
-- Segunda línea de defensa: aunque el código de la API tuviera un error, la base rechaza
-- estados inválidos, saldos inconsistentes, roles indebidos y ediciones de la auditoría.
-- Los errores propios usan SQLSTATE 'HZxxx' (xxx = código HTTP sugerido).

CREATE FUNCTION hz_error(codigo text, mensaje text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = codigo, MESSAGE = mensaje;
END $$;

CREATE FUNCTION rol_de(uid bigint) RETURNS rol_usuario
LANGUAGE sql STABLE AS $$ SELECT rol FROM usuarios WHERE id = uid $$;

-- ================================================================ usuarios
-- El usuario de la aplicación (huevazo_app) nunca puede crear un dueño ni cambiar un rol.
-- El dueño se crea solo con el script administrativo, que se conecta con otro usuario de base.
CREATE FUNCTION trg_usuarios_rol() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'huevazo_app' THEN
    IF TG_OP = 'INSERT' AND NEW.rol = 'dueno' THEN
      PERFORM hz_error('HZ403', 'El rol de dueño no se puede asignar desde la aplicación');
    END IF;
    IF TG_OP = 'UPDATE' THEN
      IF NEW.rol IS DISTINCT FROM OLD.rol THEN
        PERFORM hz_error('HZ403', 'Los roles no se pueden modificar desde la aplicación');
      END IF;
      IF OLD.rol = 'dueno' AND NOT NEW.activo THEN
        PERFORM hz_error('HZ403', 'El dueño no se puede desactivar desde la aplicación');
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.id IS DISTINCT FROM OLD.id THEN
    PERFORM hz_error('HZ403', 'El identificador de usuario es inmutable');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER usuarios_rol BEFORE INSERT OR UPDATE ON usuarios
  FOR EACH ROW EXECUTE FUNCTION trg_usuarios_rol();

CREATE FUNCTION trg_permisos_empleado() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF rol_de(NEW.usuario_id) IS DISTINCT FROM 'empleado' THEN
    PERFORM hz_error('HZ422', 'Solo los empleados tienen permisos configurables');
  END IF;
  NEW.actualizado := now();
  RETURN NEW;
END $$;
CREATE TRIGGER permisos_empleado_valida BEFORE INSERT OR UPDATE ON permisos_empleado
  FOR EACH ROW EXECUTE FUNCTION trg_permisos_empleado();

-- ================================================================ pedidos
CREATE FUNCTION trg_pedidos() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF rol_de(NEW.cliente_id) IS DISTINCT FROM 'cliente' THEN
      PERFORM hz_error('HZ422', 'El pedido debe ser de un cliente');
    END IF;
    NEW.estado := 'solicitado';
    NEW.entregado_por := NULL; NEW.entregado_en := NULL;
    NEW.cancelado_por := NULL; NEW.cancelado_en := NULL;
    RETURN NEW;
  END IF;
  IF (NEW.cliente_id, NEW.total, NEW.cargado_por, NEW.creado) IS DISTINCT FROM
     (OLD.cliente_id, OLD.total, OLD.cargado_por, OLD.creado) THEN
    PERFORM hz_error('HZ403', 'Los datos de un pedido registrado no se modifican');
  END IF;
  IF NEW.estado <> OLD.estado THEN
    IF OLD.estado <> 'solicitado' THEN
      PERFORM hz_error('HZ409', 'El pedido ya no está solicitado');
    END IF;
    IF NEW.estado = 'entregado' AND rol_de(NEW.entregado_por) IS DISTINCT FROM 'dueno' THEN
      PERFORM hz_error('HZ403', 'Solo el dueño confirma entregas');
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pedidos_reglas BEFORE INSERT OR UPDATE ON pedidos
  FOR EACH ROW EXECUTE FUNCTION trg_pedidos();

-- ================================================================ deudas
CREATE FUNCTION trg_deudas_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF rol_de(NEW.creado_por) IS DISTINCT FROM 'dueno' THEN
    PERFORM hz_error('HZ403', 'Solo el dueño genera deudas');
  END IF;
  IF NEW.tipo = 'cliente' AND rol_de(NEW.cliente_id) IS DISTINCT FROM 'cliente' THEN
    PERFORM hz_error('HZ422', 'La deuda debe ser de un cliente');
  END IF;
  NEW.saldo := NEW.importe;   -- toda deuda nace con saldo igual al importe
  RETURN NEW;
END $$;
CREATE TRIGGER deudas_insert BEFORE INSERT ON deudas
  FOR EACH ROW EXECUTE FUNCTION trg_deudas_insert();

CREATE FUNCTION trg_deudas_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.tipo, NEW.cliente_id, NEW.granja_id, NEW.origen, NEW.pedido_id, NEW.importe, NEW.creado, NEW.creado_por)
     IS DISTINCT FROM
     (OLD.id, OLD.tipo, OLD.cliente_id, OLD.granja_id, OLD.origen, OLD.pedido_id, OLD.importe, OLD.creado, OLD.creado_por) THEN
    PERFORM hz_error('HZ403', 'Los datos de una deuda no se modifican; registrá un ajuste');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deudas_update BEFORE UPDATE ON deudas
  FOR EACH ROW EXECUTE FUNCTION trg_deudas_update();

-- ================================================================ pagos de clientes
CREATE FUNCTION trg_pagos_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r rol_usuario;
BEGIN
  IF rol_de(NEW.cliente_id) IS DISTINCT FROM 'cliente' THEN
    PERFORM hz_error('HZ422', 'El pago debe ser de un cliente');
  END IF;
  r := rol_de(NEW.informado_por);
  IF r = 'cliente' AND NEW.informado_por <> NEW.cliente_id THEN
    PERFORM hz_error('HZ403', 'Un cliente solo puede informar sus propios pagos');
  END IF;
  -- Informar un pago nunca equivale a confirmarlo: el estado inicial lo fija la base.
  NEW.informado_rol := r;
  NEW.estado := 'pendiente';
  NEW.importe_aprobado := NULL; NEW.aplicado := 0;
  NEW.revision_por := NULL; NEW.revision_en := NULL;
  NEW.confirmado_por := NULL; NEW.confirmado_en := NULL;
  NEW.rechazado_por := NULL; NEW.rechazado_en := NULL; NEW.rechazo_motivo := NULL;
  NEW.anulado_por := NULL; NEW.anulado_en := NULL; NEW.anulacion_motivo := NULL;
  NEW.creado := now();
  RETURN NEW;
END $$;
CREATE TRIGGER pagos_insert BEFORE INSERT ON pagos
  FOR EACH ROW EXECUTE FUNCTION trg_pagos_insert();

CREATE FUNCTION trg_pagos_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.cliente_id, NEW.importe, NEW.moneda, NEW.fecha, NEW.medio, NEW.referencia, NEW.comprobante_id,
      NEW.nota, NEW.informado_por, NEW.informado_rol, NEW.creado)
     IS DISTINCT FROM
     (OLD.id, OLD.cliente_id, OLD.importe, OLD.moneda, OLD.fecha, OLD.medio, OLD.referencia, OLD.comprobante_id,
      OLD.nota, OLD.informado_por, OLD.informado_rol, OLD.creado) THEN
    PERFORM hz_error('HZ403', 'Los datos informados de un pago no se modifican');
  END IF;
  IF OLD.estado IN ('confirmado', 'anulado') AND
     (NEW.importe_aprobado, NEW.confirmado_por, NEW.confirmado_en) IS DISTINCT FROM
     (OLD.importe_aprobado, OLD.confirmado_por, OLD.confirmado_en) THEN
    PERFORM hz_error('HZ403', 'Una confirmación registrada no se modifica');
  END IF;
  IF NEW.estado <> OLD.estado THEN
    IF NOT (
      (OLD.estado = 'pendiente'   AND NEW.estado IN ('en_revision', 'confirmado', 'rechazado')) OR
      (OLD.estado = 'en_revision' AND NEW.estado IN ('confirmado', 'rechazado')) OR
      (OLD.estado = 'confirmado'  AND NEW.estado = 'anulado')) THEN
      PERFORM hz_error('HZ409', format('Transición no permitida: %s → %s', OLD.estado, NEW.estado));
    END IF;
    IF NEW.estado = 'en_revision' AND rol_de(NEW.revision_por) IS DISTINCT FROM 'dueno' THEN
      PERFORM hz_error('HZ403', 'Solo el dueño revisa pagos');
    END IF;
    IF NEW.estado = 'confirmado' AND rol_de(NEW.confirmado_por) IS DISTINCT FROM 'dueno' THEN
      PERFORM hz_error('HZ403', 'Solo el dueño confirma pagos');
    END IF;
    IF NEW.estado = 'rechazado' AND rol_de(NEW.rechazado_por) IS DISTINCT FROM 'dueno' THEN
      PERFORM hz_error('HZ403', 'Solo el dueño rechaza pagos');
    END IF;
    IF NEW.estado = 'anulado' AND rol_de(NEW.anulado_por) IS DISTINCT FROM 'dueno' THEN
      PERFORM hz_error('HZ403', 'Solo el dueño anula pagos');
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pagos_update BEFORE UPDATE ON pagos
  FOR EACH ROW EXECUTE FUNCTION trg_pagos_update();

-- ================================================================ pagos a granjas
CREATE FUNCTION trg_pagos_granja_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.preparado_rol := rol_de(NEW.preparado_por);
  IF NEW.preparado_rol NOT IN ('dueno', 'empleado') THEN
    PERFORM hz_error('HZ403', 'Solo el dueño o un empleado autorizado registran pagos a granjas');
  END IF;
  -- Todo pago a granja nace pendiente; si lo registra el dueño, se autoriza en la misma transacción.
  NEW.estado := 'pendiente'; NEW.aplicado := 0;
  NEW.autorizado_por := NULL; NEW.autorizado_en := NULL;
  NEW.rechazado_por := NULL; NEW.rechazado_en := NULL; NEW.rechazo_motivo := NULL;
  NEW.anulado_por := NULL; NEW.anulado_en := NULL; NEW.anulacion_motivo := NULL;
  NEW.creado := now();
  RETURN NEW;
END $$;
CREATE TRIGGER pagos_granja_insert BEFORE INSERT ON pagos_granja
  FOR EACH ROW EXECUTE FUNCTION trg_pagos_granja_insert();

CREATE FUNCTION trg_pagos_granja_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.granja_id, NEW.importe, NEW.moneda, NEW.fecha, NEW.medio, NEW.referencia, NEW.comprobante_id,
      NEW.observaciones, NEW.preparado_por, NEW.preparado_rol, NEW.creado, NEW.propuesta)
     IS DISTINCT FROM
     (OLD.id, OLD.granja_id, OLD.importe, OLD.moneda, OLD.fecha, OLD.medio, OLD.referencia, OLD.comprobante_id,
      OLD.observaciones, OLD.preparado_por, OLD.preparado_rol, OLD.creado, OLD.propuesta) THEN
    PERFORM hz_error('HZ403', 'Los datos de un pago a granja registrado no se modifican');
  END IF;
  IF NEW.estado <> OLD.estado THEN
    IF NOT ((OLD.estado = 'pendiente' AND NEW.estado IN ('confirmado', 'rechazado')) OR
            (OLD.estado = 'confirmado' AND NEW.estado = 'anulado')) THEN
      PERFORM hz_error('HZ409', format('Transición no permitida: %s → %s', OLD.estado, NEW.estado));
    END IF;
    IF NEW.estado = 'confirmado' AND rol_de(NEW.autorizado_por) IS DISTINCT FROM 'dueno' THEN
      PERFORM hz_error('HZ403', 'Solo el dueño autoriza pagos a granjas');
    END IF;
    IF NEW.estado = 'rechazado' AND rol_de(NEW.rechazado_por) IS DISTINCT FROM 'dueno' THEN
      PERFORM hz_error('HZ403', 'Solo el dueño rechaza pagos a granjas');
    END IF;
    IF NEW.estado = 'anulado' AND rol_de(NEW.anulado_por) IS DISTINCT FROM 'dueno' THEN
      PERFORM hz_error('HZ403', 'Solo el dueño anula pagos a granjas');
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pagos_granja_update BEFORE UPDATE ON pagos_granja
  FOR EACH ROW EXECUTE FUNCTION trg_pagos_granja_update();

-- ================================================================ aplicaciones
-- Al insertar una aplicación se descuenta el saldo de la deuda y se suma al aplicado del pago.
-- Corren como dueño de la base (SECURITY DEFINER) porque el usuario de la aplicación
-- no tiene permiso para escribir saldos directamente.
CREATE FUNCTION trg_aplicaciones_antes() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE d deudas%ROWTYPE; parte bigint; est text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.pago_id, NEW.pago_granja_id, NEW.deuda_id, NEW.importe, NEW.creado, NEW.creado_por)
       IS DISTINCT FROM
       (OLD.id, OLD.pago_id, OLD.pago_granja_id, OLD.deuda_id, OLD.importe, OLD.creado, OLD.creado_por) THEN
      PERFORM hz_error('HZ403', 'Una aplicación registrada no se modifica');
    END IF;
    IF OLD.revertida AND NOT NEW.revertida THEN
      PERFORM hz_error('HZ403', 'Una reversión no se deshace');
    END IF;
    IF NEW.revertida AND NOT OLD.revertida AND rol_de(NEW.revertida_por) IS DISTINCT FROM 'dueno' THEN
      PERFORM hz_error('HZ403', 'Solo el dueño revierte aplicaciones');
    END IF;
    RETURN NEW;
  END IF;

  IF rol_de(NEW.creado_por) IS DISTINCT FROM 'dueno' THEN
    PERFORM hz_error('HZ403', 'Solo el dueño aplica pagos a deudas');
  END IF;
  NEW.revertida := false; NEW.revertida_por := NULL; NEW.revertida_en := NULL; NEW.reversion_motivo := NULL;
  SELECT * INTO d FROM deudas WHERE id = NEW.deuda_id;
  IF NEW.pago_id IS NOT NULL THEN
    SELECT cliente_id, estado::text INTO parte, est FROM pagos WHERE id = NEW.pago_id;
    IF est IS DISTINCT FROM 'confirmado' THEN
      PERFORM hz_error('HZ409', 'Solo se aplican pagos confirmados');
    END IF;
    IF d.tipo <> 'cliente' OR d.cliente_id <> parte THEN
      PERFORM hz_error('HZ422', format('La deuda %s no pertenece al cliente del pago', d.id));
    END IF;
  ELSE
    SELECT granja_id, estado::text INTO parte, est FROM pagos_granja WHERE id = NEW.pago_granja_id;
    IF est IS DISTINCT FROM 'confirmado' THEN
      PERFORM hz_error('HZ409', 'Solo se aplican pagos a granja autorizados');
    END IF;
    IF d.tipo <> 'granja' OR d.granja_id <> parte THEN
      PERFORM hz_error('HZ422', format('La deuda %s no pertenece a la granja del pago', d.id));
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER aplicaciones_antes BEFORE INSERT OR UPDATE ON aplicaciones
  FOR EACH ROW EXECUTE FUNCTION trg_aplicaciones_antes();

CREATE FUNCTION trg_aplicaciones_saldos() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE signo int;
BEGIN
  IF TG_OP = 'INSERT' THEN
    signo := 1;
  ELSIF NEW.revertida AND NOT OLD.revertida THEN
    signo := -1;
  ELSE
    RETURN NULL;
  END IF;
  -- El CHECK (saldo >= 0) impide aplicar más de lo que se debe;
  -- el CHECK (aplicado <= importe_aprobado) impide aplicar más de lo que se cobró.
  UPDATE deudas SET saldo = saldo - signo * NEW.importe WHERE id = NEW.deuda_id;
  IF NEW.pago_id IS NOT NULL THEN
    UPDATE pagos SET aplicado = aplicado + signo * NEW.importe WHERE id = NEW.pago_id;
  ELSE
    UPDATE pagos_granja SET aplicado = aplicado + signo * NEW.importe WHERE id = NEW.pago_granja_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER aplicaciones_saldos AFTER INSERT OR UPDATE ON aplicaciones
  FOR EACH ROW EXECUTE FUNCTION trg_aplicaciones_saldos();

-- ================================================================ movimientos (solo anexado)
CREATE FUNCTION trg_movimientos_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF rol_de(NEW.creado_por) IS DISTINCT FROM 'dueno' THEN
    PERFORM hz_error('HZ403', 'Solo el dueño registra movimientos financieros');
  END IF;
  NEW.creado := now();
  RETURN NEW;
END $$;
CREATE TRIGGER movimientos_insert BEFORE INSERT ON movimientos
  FOR EACH ROW EXECUTE FUNCTION trg_movimientos_insert();

CREATE FUNCTION trg_movimientos_ajuste() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.tipo = 'ajuste' THEN
    UPDATE deudas SET saldo = saldo + NEW.importe WHERE id = NEW.deuda_id;  -- CHECK (saldo >= 0)
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER movimientos_ajuste AFTER INSERT ON movimientos
  FOR EACH ROW EXECUTE FUNCTION trg_movimientos_ajuste();

CREATE FUNCTION trg_solo_anexado() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM hz_error('HZ405', format('La tabla %s es de solo anexado: no se modifican ni se borran registros', TG_TABLE_NAME));
  RETURN NULL;
END $$;
CREATE TRIGGER movimientos_inmutables BEFORE UPDATE OR DELETE ON movimientos
  FOR EACH ROW EXECUTE FUNCTION trg_solo_anexado();
CREATE TRIGGER movimientos_sin_truncate BEFORE TRUNCATE ON movimientos
  FOR EACH STATEMENT EXECUTE FUNCTION trg_solo_anexado();

-- Pagos, deudas y aplicaciones tampoco se borran nunca.
CREATE TRIGGER pagos_sin_borrar BEFORE DELETE ON pagos FOR EACH ROW EXECUTE FUNCTION trg_solo_anexado();
CREATE TRIGGER pagos_granja_sin_borrar BEFORE DELETE ON pagos_granja FOR EACH ROW EXECUTE FUNCTION trg_solo_anexado();
CREATE TRIGGER deudas_sin_borrar BEFORE DELETE ON deudas FOR EACH ROW EXECUTE FUNCTION trg_solo_anexado();
CREATE TRIGGER aplicaciones_sin_borrar BEFORE DELETE ON aplicaciones FOR EACH ROW EXECUTE FUNCTION trg_solo_anexado();

-- ================================================================ auditoría encadenada
-- Cada evento guarda el hash del anterior; cualquier edición por fuera de la aplicación
-- (incluso de un administrador de base) rompe la cadena y verificar_auditoria() la detecta.
CREATE FUNCTION auditoria_hash(a auditoria) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(concat_ws('|',
    a.seq::text,
    a.evento_uuid::text,
    to_char(a.en AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    a.usuario_id::text, a.usuario_rol::text, a.tipo, a.entidad, a.entidad_id,
    coalesce(a.importe::text, '∅'), coalesce(a.estado_antes, '∅'), coalesce(a.estado_despues, '∅'),
    coalesce(a.valores_antes::text, '∅'), coalesce(a.valores_despues::text, '∅'),
    coalesce(a.autorizado_por::text, '∅'), coalesce(a.motivo, '∅'), coalesce(a.ref, '∅'),
    coalesce(a.ip, '∅'), a.prev_hash), 'UTF8')), 'hex')
$$;

CREATE FUNCTION trg_auditoria_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE ultimo auditoria%ROWTYPE;
BEGIN
  -- Serializa las inserciones para que la cadena sea lineal.
  PERFORM pg_advisory_xact_lock(hashtext('huevazo.auditoria'));
  SELECT * INTO ultimo FROM auditoria ORDER BY seq DESC LIMIT 1;
  NEW.seq := coalesce(ultimo.seq, 0) + 1;
  NEW.prev_hash := coalesce(ultimo.hash, repeat('0', 64));
  NEW.en := clock_timestamp();
  NEW.evento_uuid := gen_random_uuid();
  NEW.usuario_rol := rol_de(NEW.usuario_id);   -- el rol se toma de la base, no de quien inserta
  IF NEW.usuario_rol IS NULL THEN
    PERFORM hz_error('HZ422', 'Usuario de auditoría inexistente');
  END IF;
  NEW.hash := auditoria_hash(NEW);
  RETURN NEW;
END $$;
CREATE TRIGGER auditoria_insert BEFORE INSERT ON auditoria
  FOR EACH ROW EXECUTE FUNCTION trg_auditoria_insert();
CREATE TRIGGER auditoria_inmutable BEFORE UPDATE OR DELETE ON auditoria
  FOR EACH ROW EXECUTE FUNCTION trg_solo_anexado();
CREATE TRIGGER auditoria_sin_truncate BEFORE TRUNCATE ON auditoria
  FOR EACH STATEMENT EXECUTE FUNCTION trg_solo_anexado();

CREATE FUNCTION verificar_auditoria() RETURNS TABLE (integra boolean, eventos bigint, roto_en bigint, ultimo_hash text)
LANGUAGE plpgsql STABLE AS $$
DECLARE a auditoria%ROWTYPE; previo text := repeat('0', 64); n bigint := 0; esperado bigint := 0;
BEGIN
  FOR a IN SELECT * FROM auditoria ORDER BY seq LOOP
    n := n + 1; esperado := esperado + 1;
    IF a.seq <> esperado OR a.prev_hash <> previo OR auditoria_hash(a) <> a.hash THEN
      RETURN QUERY SELECT false, (SELECT count(*) FROM auditoria), a.seq, a.hash;
      RETURN;
    END IF;
    previo := a.hash;
  END LOOP;
  RETURN QUERY SELECT true, n, NULL::bigint, previo;
END $$;

-- Conciliación: el saldo guardado de cada deuda debe coincidir con su historia.
CREATE VIEW conciliacion_deudas AS
SELECT d.id, d.saldo AS saldo_guardado,
       d.importe
       + coalesce((SELECT sum(m.importe) FROM movimientos m WHERE m.tipo = 'ajuste' AND m.deuda_id = d.id), 0)
       - coalesce((SELECT sum(a.importe) FROM aplicaciones a WHERE a.deuda_id = d.id AND NOT a.revertida), 0)
       AS saldo_calculado
FROM deudas d;

CREATE VIEW conciliacion_pagos AS
SELECT 'cliente'::text AS tipo, p.id, p.aplicado AS aplicado_guardado,
       coalesce((SELECT sum(a.importe) FROM aplicaciones a WHERE a.pago_id = p.id AND NOT a.revertida), 0) AS aplicado_calculado
FROM pagos p
UNION ALL
SELECT 'granja', g.id, g.aplicado,
       coalesce((SELECT sum(a.importe) FROM aplicaciones a WHERE a.pago_granja_id = g.id AND NOT a.revertida), 0)
FROM pagos_granja g;

-- El usuario de la aplicación no tiene UPDATE sobre deudas, así que no puede usar FOR UPDATE.
-- Esta función bloquea las filas (en orden de id) para el resto de la transacción.
CREATE FUNCTION bloquear_deudas(ids bigint[]) RETURNS SETOF deudas
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT * FROM deudas WHERE id = ANY(ids) ORDER BY id FOR UPDATE
$$;
