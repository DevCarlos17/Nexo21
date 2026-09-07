# Delta for Deposito Inactivo Guard

## MODIFIED Requirements

### Requirement: Reingreso Automático en NCR POS-Express

`crearNotaCredito` (flujo POS, sesión activa) MUST reintegrate stock to `venta.deposito_id` when active, or fall back automatically to `es_principal=1` when inactive, without prompting the cajero — UNLESS the cajero unlocks explicit choice via the second supervisor PIN (see `notas-credito-pos` spec), in which case the explicit-choice path below applies instead. The NCR admin module (Tradicional, explicit destino choice) is now IN SCOPE — see the new "Reingreso con Elección Explícita (Tradicional)" requirement below.
(Previously: the NCR admin module with explicit destino choice was explicitly out of scope; this delta brings it in scope and adds the second-PIN override path for the POS flow.)

#### Scenario: Reingreso al depósito de origen

- GIVEN a venta whose `deposito_id` is still active
- WHEN a cajero creates an NCR in POS without using the second PIN
- THEN stock reintegrates to the original depósito automatically

#### Scenario: Fallback automático al principal

- GIVEN a venta whose `deposito_id` is now inactive
- WHEN a cajero creates an NCR in POS without using the second PIN
- THEN stock reintegrates to the current principal depósito, no choice presented to the cajero

#### Scenario: Segundo PIN habilita elección explícita en POS

- GIVEN a cajero in the POS NC flow who enters the second supervisor PIN
- WHEN the NC is confirmed
- THEN the cajero explicitly selects the reingreso depósito instead of following the automatic rail

## ADDED Requirements

### Requirement: Reingreso con Elección Explícita (Tradicional)

En el módulo Tradicional de NC, el usuario MUST elegir explícitamente el depósito de reingreso entre los depósitos activos de la empresa (`useDepositosVentaActivos`), sin riel automático. Esto aplica a CUALQUIER factura de la empresa, sin importar sesión de origen.

#### Scenario: Selector de depósito obligatorio en Tradicional

- GIVEN un usuario emitiendo una NC en el módulo Tradicional
- WHEN llega al paso de reingreso de stock
- THEN se le presenta un selector con los depósitos activos de la empresa, sin preselección automática silenciosa

#### Scenario: Depósito inactivo no aparece como opción

- GIVEN un depósito con `is_active=0`
- WHEN se abre el selector de depósito en Tradicional
- THEN ese depósito no aparece entre las opciones

#### Scenario: Factura de sesión cerrada permite elección igual

- GIVEN una factura perteneciente a una sesión de caja ya cerrada
- WHEN se emite la NC desde el módulo Tradicional
- THEN el selector de depósito funciona igual que para cualquier otra factura — el guard DB (`validate_movimiento_inventario_insert`) sigue rechazando destinos inactivos como defensa en profundidad

### Requirement: Aislamiento Multi-tenant en Selector Tradicional

El selector de depósitos del módulo Tradicional MUST filtrar por `empresa_id` del usuario actual.

#### Scenario: Selector scoped a empresa

- GIVEN dos empresas con depósitos propios
- WHEN un usuario de la empresa A abre el selector en Tradicional
- THEN solo ve depósitos de su propia empresa
</content>
