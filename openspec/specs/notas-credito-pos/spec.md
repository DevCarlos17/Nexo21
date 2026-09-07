# Notas de Crédito — Entrada POS Specification

## Purpose

Define el punto de entrada rápido de NC dentro de una sesión de caja activa: alcance de sesión, resolución de depósito por rieles, doble PIN, e impacto condicional en el cuadre (Regla de Oro). El entry Tradicional (cualquier factura, depósito explícito) está en el delta de `deposito-inactivo-guard`.

## Requirements

### Requirement: Alcance limitado a la sesión activa

La entrada POS de NC MUST listar TODAS las facturas (`ventas`) creadas dentro de la `sesion_caja_id` actualmente activa del cajero — reversadas o no — consultadas localmente vía `useFacturasSesionActiva` (offline-first, PowerSync). MUST proveer un buscador que filtre el listado por número de factura, nombre de cliente o estado (badge). Cada fila MUST mostrar fecha y hora, número de factura, cliente, monto en USD y en Bs, y sus badges correspondientes.

#### Scenario: Factura de la sesión actual visible

- GIVEN una venta creada en la sesión activa
- WHEN el cajero abre el flujo de NC en el POS
- THEN esa venta aparece en el listado

#### Scenario: Factura de sesión anterior no visible en POS

- GIVEN una venta de una sesión ya cerrada
- WHEN el cajero abre el flujo de NC en el POS
- THEN esa venta no aparece — debe usarse el módulo Tradicional

#### Scenario: Sesión activa sin facturas

- GIVEN una sesión de caja activa recién abierta, sin ventas registradas
- WHEN el cajero abre el flujo de NC en el POS
- THEN el listado se muestra vacío, sin error

#### Scenario: Buscador filtra por número de factura

- GIVEN un listado con varias facturas de la sesión activa
- WHEN el cajero escribe un número de factura en el buscador
- THEN el listado muestra solo las facturas cuyo número coincide

#### Scenario: Buscador filtra por nombre de cliente

- GIVEN un listado con facturas de distintos clientes
- WHEN el cajero escribe parte del nombre de un cliente en el buscador
- THEN el listado muestra solo las facturas de ese cliente

#### Scenario: Buscador filtra por estado

- GIVEN un listado con facturas en distintos estados (Contado, Crédito, Abonada, Reverso Total/Parcial)
- WHEN el cajero filtra por un estado específico
- THEN el listado muestra solo las facturas con ese estado

#### Scenario: Factura reversada permanece visible en el listado

- GIVEN una factura con una NC (total o parcial) ya emitida
- WHEN el cajero abre el listado
- THEN esa factura sigue apareciendo, con su badge de reverso correspondiente

### Requirement: Resolución de depósito por rieles

En la entrada POS, el sistema MUST resolver el depósito de reingreso automáticamente: al `deposito_id` de origen de la venta si está activo, o al depósito `es_principal=1` si el de origen está inactivo — sin pedir elección al cajero, salvo que se use el segundo PIN de override.

#### Scenario: Reingreso automático por riel

- GIVEN una venta cuyo depósito de origen está activo (o inactivo)
- WHEN se emite la NC en POS sin override
- THEN el stock reingresa al depósito de origen si está activo, o al principal si no, sin prompt al cajero

### Requirement: Modelo de doble PIN

El sistema MUST distinguir dos PINs independientes: (a) PIN de supervisor (`SupervisorPinDialog`), requerido para las acciones "Nota de crédito" y "Editar métodos de pago" solo si el usuario NO tiene el permiso `PERMISSIONS.SALES_NOTA_CREDITO` (si lo tiene, no se pide PIN para ninguna de las dos); (b) un SEGUNDO PIN de supervisor, independiente del anterior, requerido únicamente para desbloquear la elección explícita de depósito (salir del riel automático) durante la emisión de NC.

#### Scenario: Permiso determina el PIN para ambas acciones

- GIVEN un cajero con el permiso `PERMISSIONS.SALES_NOTA_CREDITO`, y otro sin él
- WHEN cada uno presiona "Nota de crédito" o "Editar métodos de pago"
- THEN el primero no ve solicitud de PIN; el segundo debe ingresar el PIN de supervisor antes de continuar

#### Scenario: Segundo PIN desbloquea elección de depósito

- GIVEN un cajero que quiere elegir el depósito de reingreso manualmente
- WHEN ingresa el segundo PIN de supervisor (distinto al de emisión)
- THEN se le presenta el selector de depósito explícito; sin ese PIN, el depósito se resuelve por rieles sin selector visible

#### Scenario: PIN incorrecto bloquea la acción

- GIVEN un cajero sin el permiso `PERMISSIONS.SALES_NOTA_CREDITO`
- WHEN ingresa un PIN de supervisor incorrecto
- THEN el sistema rechaza el PIN y no habilita ni "Nota de crédito" ni "Editar métodos de pago"

#### Scenario: PIN correcto habilita la acción elegida

- GIVEN un cajero sin el permiso, que presionó una de las dos acciones
- WHEN ingresa el PIN de supervisor correcto
- THEN el sistema habilita esa acción específica y procede con su flujo

### Requirement: Impacto condicional en cuadre — Regla de Oro

El cuadre de la sesión activa MUST cambiar ÚNICAMENTE cuando la NC es emitida en POS, contra una factura de la sesión activa, Y liquidada con salida real de efectivo/tarjeta de ESA sesión. En todos los demás casos (SAFC, compensación, ajuste CxC, o cualquier NC del módulo Tradicional) el impacto sobre la sesión activa MUST ser `$0.00`.

#### Scenario: POS + efectivo real de esta sesión disminuye el cajón

- GIVEN una NC emitida en POS contra una factura de la sesión activa, liquidada con salida de efectivo
- WHEN se confirma
- THEN se inserta un `movimientos_metodo_cobro` tipo EGRESO con `sesion_caja_id` de la sesión activa, y el cuadre lo refleja como salida

#### Scenario: POS + saldo a favor no afecta el cajón

- GIVEN una NC emitida en POS contra una factura de la sesión activa, liquidada como `SALDO_FAVOR`
- WHEN se confirma
- THEN no se inserta ningún `movimientos_metodo_cobro`; el cuadre no cambia

#### Scenario: Tradicional sobre factura histórica es neutro

- GIVEN una NC emitida en el módulo Tradicional contra una factura de una sesión ya cerrada
- WHEN se confirma, cualquiera sea la modalidad
- THEN la sesión activa del POS no registra ningún cambio en su cuadre

#### Scenario: Sesión cerrada permanece inmutable

- GIVEN una NC contra una factura de una sesión ya cerrada
- WHEN se emite la NC
- THEN `sesiones_caja` y `sesiones_caja_detalle` de esa sesión histórica no se editan

### Requirement: Aislamiento multi-tenant

Toda query de facturas disponibles y depósitos candidatos en el flujo POS MUST filtrar por `empresa_id` del usuario actual.

#### Scenario: Facturas visibles solo de la empresa propia

- GIVEN dos empresas con sesiones activas simultáneas
- WHEN un cajero de la empresa A abre el flujo de NC en POS
- THEN solo ve facturas de su propia sesión/empresa

### Requirement: Badges de estado de pago y reverso

Cada factura del listado MUST mostrar un badge de estado de pago derivado por una función pura `derivarEstadoPago(factura)`: **Contado** si el total pagado es igual al total de la factura; **Crédito** si el total pagado es 0; **Abonada** si el total pagado es mayor a 0 y menor al total de la factura. Adicionalmente, si existen registros en `notas_credito` asociados, MUST mostrarse un badge **Reverso Total** o **Reverso Parcial** según corresponda, pudiendo coexistir con el badge de estado de pago.

#### Scenario: Factura pagada en su totalidad muestra Contado

- GIVEN una factura cuyo total pagado es igual a su total
- WHEN se calcula su badge de estado
- THEN se muestra el badge Contado

#### Scenario: Factura sin pagos muestra Crédito

- GIVEN una factura con total pagado igual a 0
- WHEN se calcula su badge de estado
- THEN se muestra el badge Crédito

#### Scenario: Factura con pago parcial muestra Abonada

- GIVEN una factura con total pagado mayor a 0 y menor a su total
- WHEN se calcula su badge de estado
- THEN se muestra el badge Abonada

#### Scenario: Factura con NC total muestra Reverso Total

- GIVEN una factura con una nota de crédito de tipo TOTAL asociada
- WHEN se renderiza su fila en el listado
- THEN se muestra el badge Reverso Total

#### Scenario: Factura con NC parcial muestra Reverso Parcial

- GIVEN una factura con una nota de crédito de tipo PARCIAL asociada
- WHEN se renderiza su fila en el listado
- THEN se muestra el badge Reverso Parcial

#### Scenario: Badges combinados en factura abonada con reverso parcial

- GIVEN una factura Abonada que además tiene una NC PARCIAL asociada
- WHEN se renderiza su fila en el listado
- THEN se muestran ambos badges: Abonada y Reverso Parcial

### Requirement: Panel de detalle fiscal de la factura seleccionada

El panel derecho MUST permanecer vacío hasta que el cajero seleccione una factura del listado. Al seleccionar, MUST mostrar: tabla de artículos (cantidad, precio unitario en Bs y USD), subtotal, desglose de exento, base imponible, IVA por cada alícuota, total de la factura, IGTF si aplica, desglose de métodos de pago utilizados, y una sección que indica si esos pagos afectaron cuentas por cobrar. El desglose fiscal MUST reutilizar `buildReciboData`/`construirFilasTotales` — MUST NOT recalcular montos de forma independiente; el resultado MUST coincidir con el recibo oficial de esa venta.

> **Nota de deuda (archive `notas-credito-ui-pos`, 2026-09-04)**: la sección de "afectación a CxC" y el desglose de métodos de pago descritos en este requirement fueron OCULTADOS en Slice 5d (obs #2896/#2897) por una fuente de datos no confiable en el caso SAF-cruzado (pago repartido por FIFO entre dos facturas sin back-reference persistido). El fix real queda diferido a un change futuro de CxC. Ver `tasks.md` Slice 5d en el archivo de este change para el detalle — este texto de spec no fue actualizado retroactivamente para reflejar la ocultación (ver deuda registrada en el archive-report).

#### Scenario: Panel vacío sin selección

- GIVEN el modal recién abierto sin ninguna factura seleccionada
- WHEN el cajero observa el panel derecho
- THEN el panel no muestra datos de factura alguna

#### Scenario: Selección muestra el desglose fiscal completo

- GIVEN una factura seleccionada del listado
- WHEN el panel se renderiza
- THEN muestra artículos, subtotal, base imponible, IVA por alícuota, total y desglose de pagos, coincidiendo con `buildReciboData` de esa venta

#### Scenario: Factura con IGTF aplicado

- GIVEN una factura cuyo pago generó IGTF
- WHEN se selecciona en el listado
- THEN el panel muestra el monto de IGTF calculado por `buildReciboData`

#### Scenario: Factura con líneas exentas

- GIVEN una factura con al menos una línea exenta de IVA
- WHEN se selecciona en el listado
- THEN el panel muestra el desglose de exento separado de la base imponible gravada

#### Scenario: Indicación de afectación a CxC

- GIVEN una factura cuyos pagos afectaron el saldo de cuentas por cobrar del cliente, y otra cuyos pagos no lo afectaron
- WHEN cada una se selecciona en el listado
- THEN el panel indica explícitamente si hubo o no afectación a CxC para esa factura

### Requirement: Selección de tipo de nota de crédito (TOTAL o PARCIAL)

Al presionar "Nota de crédito" sobre una factura seleccionada, el sistema MUST solicitar al cajero elegir entre TOTAL o PARCIAL antes de continuar. TOTAL MUST invocar `crearNotaCredito()` con `tipo=TOTAL` sin alterar su contrato ni lógica interna. PARCIAL MUST habilitar una columna de cantidad a devolver por línea de la factura, con paso entero o decimal (0.001) según `unidades.es_decimal` del producto de cada línea. El sistema solo debe crear registros nuevos (`notas_credito`, `notas_credito_det`) — nunca editar ni borrar la venta original ni movimientos existentes.

> **Nota de deuda (archive `notas-credito-ui-pos`, 2026-09-04)**: QA posterior (Slices 5a–5g) refinó este requirement con lógica de gating por reverso acumulado (`puedeEmitirNcAdicional`/`puedeElegirTipoTotal`, tope por línea vía `calcularReversoPorLinea`), badges de reverso acumulado, y watermark consistente. Ver `tasks.md` (archivo de este change) para el detalle completo — este texto de spec MODIFIED original no fue reescrito retroactivamente para incorporar los fixes de QA.

#### Scenario: NC TOTAL reversa la factura completa

- GIVEN una factura seleccionada en el listado
- WHEN el cajero elige TOTAL
- THEN se invoca `crearNotaCredito` con `tipo=TOTAL` sobre la factura, sin modificar su implementación

#### Scenario: NC PARCIAL habilita selección de líneas

- GIVEN una factura seleccionada con varias líneas
- WHEN el cajero elige PARCIAL
- THEN cada línea muestra un campo de cantidad a devolver, inicialmente en 0

#### Scenario: Cantidad a devolver no puede exceder lo facturado

- GIVEN una línea facturada con cantidad X
- WHEN el cajero intenta ingresar una cantidad a devolver mayor a X
- THEN el sistema rechaza el valor y no permite continuar

#### Scenario: Cantidad respeta es_decimal de la unidad

- GIVEN una línea cuyo producto tiene `unidades.es_decimal=0`
- WHEN el cajero intenta ingresar una cantidad con decimales
- THEN el sistema rechaza el valor; solo acepta enteros

#### Scenario: Al menos una línea requerida en PARCIAL

- GIVEN el modo PARCIAL activo con todas las cantidades en 0
- WHEN el cajero intenta confirmar la NC
- THEN el sistema bloquea la confirmación hasta que al menos una línea tenga cantidad mayor a 0

### Requirement: Invariante de tasa histórica en montos de NC

Los montos en bolívares de toda NC generada desde el POS MUST derivarse de la tasa histórica de la factura original (`venta.tasa`), NUNCA de la tasa de cambio vigente al momento de emitir la NC. En TOTAL, el monto en Bs MUST ser `venta.total_bs` tal cual quedó registrado. En PARCIAL, el monto en Bs de cada línea MUST calcularse como `usdToBs(montoUsdLinea, venta.tasa)` usando la tasa histórica de esa venta. El tratamiento de IVA por línea en la NC MUST coincidir con el tratamiento que tuvo esa línea en la factura original (gravada o exenta).

#### Scenario: NC TOTAL no se recalcula con la tasa vigente

- GIVEN una factura creada con tasa histórica R1
- AND la tasa de cambio vigente del sistema ahora es R2, distinta de R1
- WHEN el cajero crea una NC TOTAL sobre esa factura
- THEN el `total_bs` de la NC es igual al `total_bs` original de la factura (calculado a R1), no un valor recalculado a R2

#### Scenario: NC PARCIAL usa la tasa histórica por línea

- GIVEN una factura creada con tasa histórica R1 y la tasa vigente ahora es R2 (R2 ≠ R1)
- WHEN el cajero crea una NC PARCIAL seleccionando una línea
- THEN el monto en Bs de esa línea en la NC se calcula con R1, no con R2

#### Scenario: El tratamiento de IVA de la línea se preserva

- GIVEN una línea facturada con IVA aplicado (o exenta)
- WHEN esa línea se incluye en una NC PARCIAL
- THEN la línea de la NC conserva el mismo tratamiento de IVA que tuvo en la factura original

### Requirement: Botón "Editar métodos de pago" como placeholder

El botón "Editar métodos de pago" MUST estar visible y sujeto al mismo gating de permiso/PIN que "Nota de crédito", pero MUST NOT ejecutar ninguna mutación de datos: es un placeholder pendiente de implementación.

#### Scenario: Click en el placeholder no realiza ninguna acción

- GIVEN un cajero con acceso ya habilitado (por permiso o PIN correcto)
- WHEN presiona "Editar métodos de pago"
- THEN el sistema muestra una indicación de función no implementada y no crea, edita ni borra ningún registro

### Requirement: Renombrar el botón de acceso a NC del POS

El botón del POS que abre el flujo de notas de crédito MUST renombrarse a un término corto que comunique "facturas de la sesión de caja activa" (candidato: "Facturas de caja"), reemplazando el rótulo previo "Nota de Crédito".

#### Scenario: El botón muestra el nuevo rótulo

- GIVEN el POS con una sesión de caja activa
- WHEN el cajero observa la barra de acciones
- THEN el botón muestra el nuevo rótulo corto y, al presionarlo, abre el mismo listado de facturas de la sesión activa
