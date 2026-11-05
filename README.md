# El Huevazo

Sistema de pedidos, cobros y pagos a granjas para una distribuidora de huevos, con control financiero exclusivo del dueño.

- **Backend:** Node.js 20+ y Express, con PostgreSQL 14+ (probado con 16).
- **Frontend:** HTML, CSS y JavaScript sin frameworks, servido por la misma aplicación.
- **Dependencias:** cuatro, con versiones fijas: `express`, `pg`, `helmet` y `zod`.

## Puesta en marcha

1. Crear el usuario administrativo y la base. Se hace una sola vez, como superusuario de PostgreSQL:

   ```sql
   CREATE ROLE huevazo_admin LOGIN CREATEROLE PASSWORD 'una-clave-larga';
   CREATE DATABASE huevazo OWNER huevazo_admin;
   ```

2. Configurar el entorno:

   ```bash
   cp .env.example .env        # completar las claves
   npm install
   ```

3. Crear las tablas, las reglas y el usuario de mínimo privilegio `huevazo_app`:

   ```bash
   npm run db:migrar
   ```

4. Crear al dueño. Es la **única** forma de crear ese rol, y falla si ya existe uno:

   ```bash
   npm run db:crear-dueno -- --email vos@tudominio.com --nombre "Tu nombre"
   ```

5. Opcional: cargar datos de ejemplo (catálogo, granjas, un empleado y tres clientes):

   ```bash
   DUENO_EMAIL=vos@tudominio.com DUENO_PASSWORD=... npm run db:demo
   ```

6. Iniciar el servidor:

   ```bash
   npm start                   # http://localhost:3000
   ```

   `npm start` aplica las migraciones y crea al dueño si falta. Después levanta el servidor solo con la conexión de mínimo privilegio: el proceso del servidor nunca recibe las credenciales administrativas. Para levantar únicamente el servidor, sin migrar, usá `npm run start:servidor`.

En producción, la aplicación tiene que ir detrás de HTTPS (Nginx, Caddy o el proxy de tu proveedor), con `COOKIE_SECURE=true` y `TRUST_PROXY=1`. Para probar en tu computadora sin HTTPS, usá `COOKIE_SECURE=false`.

## Publicar en Railway

No hace falta ningún archivo de configuración: Railway detecta Node.js y ejecuta `npm start`.

1. En Railway, creá un proyecto nuevo con **Deploy from GitHub repo** y elegí este repositorio.
2. En el mismo proyecto, agregá una base: **New → Database → PostgreSQL**.
3. En el servicio de la aplicación, abrí **Variables** y cargá:

   | Variable | Valor |
   |---|---|
   | `DATABASE_ADMIN_URL` | `${{Postgres.DATABASE_URL}}` (Railway completa la conexión interna) |
   | `DUENO_EMAIL` | El email con el que vas a entrar como dueño |
   | `DUENO_PASSWORD` | La contraseña del dueño, de al menos 10 caracteres |
   | `DUENO_NOMBRE` | Tu nombre (opcional) |

   `TRUST_PROXY` se configura solo en Railway y `COOKIE_SECURE` ya viene activado.

4. En **Settings → Networking**, tocá **Generate Domain** para obtener la dirección pública con HTTPS. Ahí también podés conectar un dominio propio.
5. Opcional: en **Settings → Deploy → Healthcheck Path**, poné `/api/salud`.
6. Cuando el primer despliegue termine, entrá con el email y la contraseña del dueño. Después **borrá** `DUENO_PASSWORD` de las variables: el dueño ya existe y el sistema no lo vuelve a crear.
7. Desde la aplicación, cargá el catálogo (pestaña Catálogo), las granjas y los clientes.

Para la copia de seguridad diaria, usá la función de backups de la base en Railway o un `pg_dump` programado hacia un destino externo.

## Pruebas de seguridad

```bash
# Usan una base descartable: el nombre DEBE terminar en _test, porque se borra al empezar
DATABASE_URL=postgres://huevazo_app:...@localhost/huevazo_test \
DATABASE_ADMIN_URL=postgres://huevazo_admin:...@localhost/huevazo_test \
APP_DB_PASSWORD=... npm test
```

Son 17 pruebas. Cada una intenta romper una regla: escalar a dueño, confirmar un pago propio, ver datos de otro cliente, confirmar dos veces en paralelo, aplicar más de lo cobrado, editar la auditoría, escribir saldos directo en la base, entre otras.

## Cómo se cumple cada punto de la especificación

Las reglas críticas se aplican en dos capas:

1. **La API** valida identidad, permisos, propiedad, estado y reglas de negocio.
2. **La base** las vuelve a exigir con triggers, restricciones y permisos por columna.

Así, ni un error en el código ni una conexión directa con el usuario de la aplicación pueden saltárselas.

| Punto | Implementación |
|---|---|
| **1. Roles** | El rol se lee de la base en cada petición (`src/auth.js`), nunca del cuerpo ni de la cookie. Un índice único parcial impide un segundo dueño. El usuario `huevazo_app` no tiene permiso para cambiar la columna `rol`, y un trigger le impide crear dueños. Los empleados solo tienen tres permisos operativos (`pedidos`, `pagos_recibidos`, `pagos_granja`); los financieros no existen como permiso delegable. |
| **2. Flujo de pagos** | Estados: `pendiente → en_revision → confirmado / rechazado`, y `confirmado → anulado`. El trigger `trg_pagos_insert` fuerza `pendiente` en todo INSERT, aunque se envíe otro estado. `trg_pagos_update` valida cada transición y exige que quien confirma, rechaza o anula sea el dueño. La API además rechaza con 400 cualquier campo protegido (`estado`, `approvedBy`, `saldo`, etc.). |
| **3. Integridad** | Los importes se guardan como `bigint` en centavos y se validan como enteros. `deudas.saldo` y `pagos.aplicado` solo los cambian triggers `SECURITY DEFINER`; la aplicación no tiene permiso de escritura sobre esas columnas. Las restricciones `saldo >= 0` y `aplicado <= importe_aprobado` hacen imposible aplicar de más. Confirmar, crear el movimiento y aplicar a las deudas ocurren en una sola transacción. Las vistas `conciliacion_*` comparan cada saldo con su historia. |
| **4. Pagos a granjas** | Tabla propia (`pagos_granja`), separada de los cobros. Un empleado con permiso prepara el pago con una propuesta de reparto, que queda `pendiente`. Solo el dueño lo autoriza; recién entonces se mueve la deuda. Si lo registra el dueño, se autoriza en la misma transacción. |
| **5. Backend y API** | La sesión usa una cookie `HttpOnly` y `SameSite=Strict`; el token se guarda hasheado y vence. Las contraseñas usan scrypt. Hay límite de intentos de ingreso. Toda escritura exige el encabezado anti-CSRF `X-Huevazo`. Las consultas son parametrizadas y los esquemas `zod` son estrictos. Un recurso ajeno responde 404, para no revelar que existe. Helmet agrega CSP y otros encabezados. La API se conecta con un usuario de base de mínimo privilegio (`db/003_permisos.sql`). |
| **6. Auditoría** | Tabla de solo anexado: no hay permiso de UPDATE ni DELETE, y los triggers bloquean UPDATE, DELETE y TRUNCATE incluso al administrador. Cada evento guarda el SHA-256 del anterior. `verificar_auditoria()` recorre la cadena y detecta cualquier edición, aunque se haya desactivado el trigger. Los ajustes y las reversiones son movimientos nuevos vinculados al original. |
| **7. Duplicados y concurrencia** | Confirmar y aplicar exigen `idempotencyKey`: la misma clave devuelve la respuesta original sin volver a ejecutar. `SELECT … FOR UPDATE` sobre el pago serializa confirmaciones simultáneas, y la segunda recibe 409. Un índice único impide informar dos veces la misma operación bancaria. Las deudas se bloquean en orden de id para evitar interbloqueos. |

## Estructura

```
db/001_esquema.sql      tablas y restricciones
db/002_reglas.sql       triggers: estados, saldos, auditoría encadenada, conciliación
db/003_permisos.sql     privilegios mínimos de huevazo_app (se reaplica en cada migración)
src/app.js              Express, seguridad, rutas
src/auth.js             sesiones, contraseñas, CSRF, roles y permisos
src/finanzas.js         aplicación y reversión de pagos sobre deudas
src/auditoria.js        registro de eventos e idempotencia
src/rutas/              pagos, pedidos, deudas, granjas, usuarios, auditoría, catálogo, comprobantes
public/                 interfaz
scripts/                migrar, crear-dueno, demo
test/                   pruebas de seguridad
```

## Decisiones y límites

- **Transferencia de titularidad:** no está implementada a propósito. La especificación la admite solo como mecanismo deliberado, autorizado y auditado. Si la necesitás, se puede agregar como script administrativo, igual que `crear-dueno`.
- **Comprobantes:** se guardan en la base (PDF, JPG, PNG o WEBP, hasta 5 MB). Se valida el tipo real del archivo, no solo su extensión. Con mucho volumen, conviene moverlos a almacenamiento de objetos.
- **Límite de intentos de ingreso:** se lleva en memoria. Si corrés varias instancias del servidor, hay que pasarlo a Redis o a la base.
- **Copias de seguridad:** hacé `pg_dump` diario a un destino al que la aplicación no tenga acceso de escritura. Guardar aparte el último hash de auditoría (`GET /api/auditoria/verificar`) permite comprobar más adelante que nadie reescribió la cadena completa.
- **Altas de clientes:** las hace el dueño desde «Clientes y equipo». No hay registro público.
