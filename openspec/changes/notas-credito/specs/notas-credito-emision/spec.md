# Notas de Crédito — Emisión Specification

## Purpose

`crearNotaCredito()` es el documento fiscal que anula total o parcialmente una factura de venta específica, reemplazando la función actual (solo TOTAL, no escribe `notas_credito_det`, bug `created_by`). Cubre SOLO la emisión (correlativo, vínculo a factura, desglose fiscal, reingreso de stock, atomicidad). La liquidación está en `notas-credito-liquidacion`.

## Requirements

### Requirement: Vínculo obligatorio a factura de origen

Toda NC MUST referenciar un `venta_id` existente y válido de la misma `empresa_id`. El sistema MUST NOT permitir crear una NC sin factura de origen — es un requisito fiscal, no un CxC genérico.

#### Scenario: Creación sin venta_id rechazada

- GIVEN un intento de crear NC sin `venta_id`, o con `venta_id` de otra `empresa_id`
- WHEN se invoca `crearNotaCredito()`
- THEN la operación se rechaza antes de escribir cualquier registro

### Requirement: Correlativo NCR por empresa

El número de NC (`nro_ncr`) MUST generarse como `NCR-000001` incremental, calculado por `COUNT(*)` filtrado por `empresa_id`, y MUST estar protegido por una restricción `UNIQUE(empresa_id, nro_ncr)` a nivel de base de datos.

#### Scenario: Numeración aislada por empresa

- GIVEN dos empresas, cada una con NCs previas (o ninguna)
- WHEN cada una crea una nueva NC
- THEN cada correlativo avanza independientemente (la primera de una empresa nueva es `NCR-000001`)

#### Scenario: Colisión de correlativo bloqueada por constraint

- GIVEN una carrera de escritura que intente insertar el mismo `nro_ncr` dos veces para la misma empresa
- WHEN la segunda escritura llega a Postgres
- THEN el `UNIQUE(empresa_id, nro_ncr)` la rechaza

### Requirement: Tipos TOTAL y PARCIAL con tope acumulado

Una NC MUST ser `tipo IN ('TOTAL','PARCIAL')`. El sistema MUST impedir que la suma acumulada de NCs contra una misma factura exceda el total de esa factura (trigger Postgres existente).

#### Scenario: NC parcial dentro del saldo disponible

- GIVEN una factura con NCs previas cuyo acumulado es menor al total
- WHEN se emite una NC `tipo='PARCIAL'` dentro del remanente
- THEN la operación se acepta

#### Scenario: NC excede el saldo disponible

- GIVEN una factura cuyas NCs acumuladas ya cubren su total
- WHEN se intenta emitir otra NC contra la misma factura
- THEN el trigger de tope rechaza el INSERT

### Requirement: Desglose fiscal hereda tasa y alícuota histórica

Para NC `tipo='PARCIAL'`, cada línea de `notas_credito_det` MUST inheredar la tasa de cambio y la alícuota IVA de la línea ORIGINAL de la factura (`ventas_det`), no la tasa/alícuota vigente al momento de emitir la NC. Esto es un requisito de auditoría SENIAT.

#### Scenario: Tasa histórica preservada

- GIVEN una factura emitida con tasa de cambio X, y la tasa vigente hoy es Y (X ≠ Y)
- WHEN se emite una NC parcial contra esa factura
- THEN cada línea de `notas_credito_det` registra la tasa X, no Y

#### Scenario: Alícuota mixta preservada por línea

- GIVEN una factura con líneas a distintas alícuotas IVA (general/reducida/exenta)
- WHEN se emite una NC parcial que afecta varias líneas
- THEN cada línea de `notas_credito_det` conserva la alícuota original de su línea correspondiente

### Requirement: Reingreso de stock vía Kardex

La NC MUST reintegrar stock creando un nuevo `movimiento_inventario` (nunca editando `inventario_stock` directamente), respetando la inmutabilidad del Kardex. Líneas de servicio (`tipo='S'`) MUST NOT generar movimiento de Kardex.

#### Scenario: Reingreso de producto físico

- GIVEN una NC sobre una línea de producto con stock (`tipo != 'S'`)
- WHEN se emite la NC
- THEN se inserta un `movimiento_inventario` de entrada y `inventario_stock` se actualiza como efecto de ese insert

### Requirement: Escritura atómica única, sin bug de columna inexistente

`crearNotaCredito()` MUST ejecutar todas sus escrituras (header, `notas_credito_det`, Kardex, reversa de pagos, liquidación) dentro de un único `db.writeTransaction()`, sin insertar valores en columnas inexistentes del schema Postgres/PowerSync real (no mockeado).

#### Scenario: Falla a mitad de transacción revierte todo

- GIVEN un fallo simulado en el paso de reingreso de stock
- WHEN se intenta crear la NC
- THEN ni el header, ni `notas_credito_det`, ni la liquidación quedan persistidos

#### Scenario: Insert contra DB real no lanza error de columna

- GIVEN el schema real de `notas_credito` (migración 0006 + PowerSync)
- WHEN se ejecuta `crearNotaCredito()` contra una base no mockeada
- THEN el INSERT se completa sin error de columna inexistente

### Requirement: Aislamiento multi-tenant

Toda query de lectura o escritura de NC MUST filtrar por `empresa_id` del usuario actual.

#### Scenario: Listado aislado por empresa

- GIVEN dos empresas con NCs propias
- WHEN un usuario de la empresa A consulta el listado
- THEN solo ve las NC de su propia empresa
</content>
