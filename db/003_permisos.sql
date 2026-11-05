-- El Huevazo · privilegios mínimos del usuario de la aplicación
-- La API se conecta como huevazo_app. Este usuario:
--   * no puede escribir saldos (deudas.saldo, pagos.aplicado): solo cambian por triggers;
--   * no puede cambiar roles de usuarios;
--   * no puede editar ni borrar auditoría, movimientos, pagos, deudas ni aplicaciones;
--   * solo puede actualizar las columnas de estado previstas en cada flujo.

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM huevazo_app;
GRANT USAGE ON SCHEMA public TO huevazo_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO huevazo_app;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO huevazo_app;

GRANT INSERT ON usuarios, permisos_empleado, sesiones, granjas, pedidos, pedido_items, deudas,
                comprobantes, pagos, pagos_granja, aplicaciones, movimientos, auditoria, idempotencia
  TO huevazo_app;

GRANT UPDATE (nombre, password_hash, activo)                        ON usuarios          TO huevazo_app;
GRANT UPDATE (pedidos, pagos_recibidos, pagos_granja, actualizado)  ON permisos_empleado TO huevazo_app;
GRANT DELETE                                                        ON sesiones          TO huevazo_app;
GRANT UPDATE (nombre, unidad, precio, activo)                       ON productos         TO huevazo_app;
GRANT INSERT                                                        ON productos         TO huevazo_app;
GRANT UPDATE (activo)                                               ON granjas           TO huevazo_app;
GRANT UPDATE (estado, entregado_por, entregado_en, cancelado_por, cancelado_en, cancelado_motivo)
  ON pedidos TO huevazo_app;
GRANT UPDATE (estado, revision_por, revision_en, importe_aprobado, confirmado_por, confirmado_en,
              rechazado_por, rechazado_en, rechazo_motivo, anulado_por, anulado_en, anulacion_motivo)
  ON pagos TO huevazo_app;
GRANT UPDATE (estado, autorizado_por, autorizado_en, rechazado_por, rechazado_en, rechazo_motivo,
              anulado_por, anulado_en, anulacion_motivo)
  ON pagos_granja TO huevazo_app;
GRANT UPDATE (revertida, revertida_por, revertida_en, reversion_motivo) ON aplicaciones TO huevazo_app;
GRANT UPDATE (estado_http, respuesta)                               ON idempotencia      TO huevazo_app;
GRANT DELETE                                                        ON idempotencia      TO huevazo_app;
