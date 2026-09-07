# Notas de Crédito — Liquidación Specification

## Purpose

Define CÓMO se salda una NC ya emitida (ver `notas-credito-emision`). Toda NC MUST resolverse mediante una modalidad. Tres modalidades base no tocan efectivo; una condicional (refund tesorería) sí, fuera del cajón POS activo. El gate anti-fraude es el requisito central.

## Requirements

### Requirement: Selección obligatoria de modalidad

El sistema MUST exigir que toda NC declare una modalidad de liquidación entre `SALDO_FAVOR`, `COMPENSACION_VENTA`, `AJUSTE_CXC`, o (condicional) `REFUND_TESORERIA`. No existe una modalidad "sin definir".

> Nota de reconciliación (obs #2812, resuelta en Slice 3): el campo persistido `notas_credito.liquidacion_modalidad` acepta un quinto valor, `EFECTIVO_REAL`, que NO es una modalidad de liquidación seleccionable en el sentido de este requisito — es la condición interna que dispara la Regla de Oro (egreso real del cajón POS activo, ver `notas-credito-pos`). Se documenta aquí solo para que el trail de artefactos (spec ↔ design.md Decisión 4/5 ↔ CHECK de `migrations/0091_notas_credito_schema.sql`) quede internamente consistente.

#### Scenario: NC sin modalidad rechazada

- GIVEN un intento de crear NC sin modalidad de liquidación
- WHEN se invoca `crearNotaCredito()`
- THEN se rechaza antes de escribir cualquier registro

### Requirement: Modalidad SALDO_FAVOR (SAFC)

`SALDO_FAVOR` MUST generar un registro SAFC (`movimientos_cuenta` tipo `SAFC`, negativo en `saldo_actual` del cliente) reusando la infraestructura existente (`registrarSafExcedente`), trazable hasta `nota_credito_id`. MUST NOT insertar ningún movimiento de caja/banco.

#### Scenario: SAFC trazable a la NC

- GIVEN una NC con modalidad `SALDO_FAVOR`
- WHEN se liquida
- THEN el `movimientos_cuenta` generado referencia el `nota_credito_id` de origen

#### Scenario: Cero impacto en caja

- GIVEN una NC liquidada como `SALDO_FAVOR`
- WHEN se liquida
- THEN no se inserta ningún `movimientos_metodo_cobro` ni movimiento bancario

### Requirement: Modalidad COMPENSACION_VENTA

`COMPENSACION_VENTA` MUST aplicar el monto de la NC como abono a una nueva venta simultánea; solo el diferencial (si lo hay) MUST registrarse en caja.

#### Scenario: Compensación cubre el total de la nueva venta

- GIVEN una NC con saldo suficiente para cubrir una nueva venta
- WHEN se aplica como `COMPENSACION_VENTA`
- THEN la nueva venta queda saldada sin movimiento de efectivo

#### Scenario: Compensación parcial con diferencial en caja

- GIVEN una NC con saldo menor al total de la nueva venta
- WHEN se aplica como `COMPENSACION_VENTA`
- THEN solo el diferencial se cobra por el método indicado y se registra en caja

### Requirement: Modalidad AJUSTE_CXC

`AJUSTE_CXC` MUST reducir el saldo pendiente del cliente (`clientes.saldo_actual` vía `movimientos_cuenta`) sin generar ningún movimiento de efectivo.

#### Scenario: Reducción de saldo pendiente

- GIVEN un cliente con saldo pendiente igual o mayor al monto de la NC
- WHEN se liquida como `AJUSTE_CXC`
- THEN el saldo pendiente del cliente disminuye por el monto de la NC, sin movimiento de caja

### Requirement: Gate anti-fraude de no-desembolso

El sistema MUST bloquear a nivel de función (no solo de UI) el campo de salida de efectivo cuando la modalidad de liquidación es `SALDO_FAVOR`, `COMPENSACION_VENTA` o `AJUSTE_CXC`. Solo `REFUND_TESORERIA` (o efectivo real bajo Regla de Oro en POS, ver `notas-credito-pos`) MUST permitir un campo de salida de efectivo.

#### Scenario: Intento de forzar salida de efectivo en modalidad no-efectivo

- GIVEN una llamada directa a la función de liquidación (con o sin pasar por la UI) con modalidad `SALDO_FAVOR`/`COMPENSACION_VENTA`/`AJUSTE_CXC` y un monto de salida de efectivo distinto de cero
- WHEN se ejecuta la función
- THEN se rechaza — el bloqueo vive en la función, no solo se oculta en la UI

### Requirement: Modalidad REFUND_TESORERIA (condicional)

`REFUND_TESORERIA` MUST insertar un egreso en `movimientos_bancarios` o `mov_caja_fuerte` con `validado=0`, pendiente de conciliación, reusando el patrón `validado`/`validado_por`/`reversado` existente. MUST tener impacto `$0.00` sobre el cajón POS activo (ver Regla de Oro en `notas-credito-pos`).

#### Scenario: Egreso pendiente de conciliación

- GIVEN una NC liquidada como `REFUND_TESORERIA`
- WHEN se registra el egreso
- THEN queda con `validado=0`, visible en el flujo de conciliación existente

#### Scenario: Sin impacto en sesión POS activa

- GIVEN una sesión POS activa y una NC liquidada como `REFUND_TESORERIA` contra una factura histórica
- WHEN se liquida
- THEN el cuadre de la sesión activa no cambia

### Requirement: Aislamiento multi-tenant

Toda escritura de liquidación MUST quedar filtrada/asociada a la `empresa_id` del usuario actual.

#### Scenario: Registro scoped a empresa

- GIVEN una NC de la empresa A liquidada en cualquier modalidad
- WHEN se genera el registro de liquidación
- THEN pertenece a `empresa_id` A
</content>
