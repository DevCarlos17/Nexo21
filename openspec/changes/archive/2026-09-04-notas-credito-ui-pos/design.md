# Design: Rediseño UI de Notas de Crédito en POS

> Nota de tamaño: excede deliberadamente el límite de 800 palabras de la guía
> de la skill — igual que `openspec/changes/notas-credito/design.md` — porque
> resuelve una pregunta abierta crítica (fuente de "afectación CxC") que
> requirió leer código fuente en profundidad, y define 3 funciones puras
> nuevas con su algoritmo exacto para permitir TDD estricto desde `sdd-tasks`.

## Technical Approach

Sigue el Approach 2 de la exploración (obs #2870): **componentes/funciones
puras compartidas, sin hook unificador de scopes**. `crearNotaCredito()` no se
toca. El modal `nota-credito-pos-modal.tsx` se redibuja para orquestar: (a) una
`useFacturasSesionActiva` extendida (badges + búsqueda), (b) un panel de
detalle que reutiliza `buildReciboData`/`construirFilasTotales` sin
recalcular fiscalidad, y (c) una selección de líneas PARCIAL que mapea a
`lineas: LineaNcSeleccionada[]` del contrato existente. Todo lo reusable para
Tradicional se extrae a `src/features/ventas/utils/notas-credito-ui.ts`
(funciones puras) y `src/features/ventas/components/` (componentes de
presentación), siguiendo el patrón ya establecido por
`notas-credito-fiscal.ts`/`recibo-pagos.ts`.

## Architecture Decisions

### Decisión 1 — Sin hook unificador (Approach 2)

| Opción | Tradeoff | Elegida |
|---|---|---|
| Hook `useNotaCreditoFlow({scope})` | Menos duplicación de wiring, pero mezcla dos scopes de query estructuralmente distintos (sesión vs. futura búsqueda libre) en un solo abstracto | No |
| Funciones/componentes puros compartidos + wiring propio por UI | Algo de duplicación de wiring PIN/loading en Tradicional (fuera de scope de este change), pero cero acoplamiento de scopes y sigue el patrón ya usado en el repo | **Sí** |

### Decisión 2 — Extender `useFacturasSesionActiva` (no crear query nueva)

La spec exige ver facturas reversadas en el listado; la query actual filtra
`v.status != 'ANULADA'` (bug respecto al nuevo requisito, no una feature a
preservar). Se **quita ese filtro** y se agregan campos vía subqueries
`EXISTS`, aditivo y sin N+1:

```sql
SELECT v.id, v.nro_factura, v.cliente_id, v.tasa, v.total_usd, v.total_bs,
       v.saldo_pend_usd, v.tipo, v.status, v.fecha,
       c.nombre as cliente_nombre, c.identificacion as cliente_identificacion,
       EXISTS(SELECT 1 FROM notas_credito nc WHERE nc.venta_id = v.id AND nc.tipo = 'TOTAL')   as tiene_reverso_total,
       EXISTS(SELECT 1 FROM notas_credito nc WHERE nc.venta_id = v.id AND nc.tipo = 'PARCIAL') as tiene_reverso_parcial
FROM ventas v JOIN clientes c ON v.cliente_id = c.id
WHERE v.empresa_id = ? AND v.sesion_caja_id = ?
ORDER BY v.fecha DESC
```

El buscador (nro/cliente/estado) filtra client-side sobre este array ya
cargado — la lista está escopeada a una sola sesión (tamaño acotado), no
justifica una query parametrizada nueva por cada tecleo.

### Decisión 3 — Extender `useDetalleFactura` (cxc) de forma aditiva

Se agregan `precio_unitario_bs` (columna ya persistida en `ventas_det`... **no
existe** — se computa vía `usdToBs(vd.precio_unitario_usd, v.tasa)` en el
SELECT, join a `ventas` para la tasa histórica) y `es_decimal` (join
`productos p ON vd.producto_id = p.id` → `unidades u ON p.unidad_base_id =
u.id`, campo `u.es_decimal`):

```sql
SELECT vd.id, vd.venta_id, vd.producto_id, vd.cantidad, vd.precio_unitario_usd,
       vd.subtotal_usd, vd.subtotal_bs, vd.tipo_impuesto, vd.impuesto_pct,
       p.nombre as producto_nombre, p.codigo as producto_codigo,
       u.es_decimal,
       ROUND(CAST(vd.precio_unitario_usd AS REAL) * CAST(v.tasa AS REAL), 2) as precio_unitario_bs
FROM ventas_det vd
JOIN productos p ON vd.producto_id = p.id
JOIN ventas v ON vd.venta_id = v.id
LEFT JOIN unidades u ON p.unidad_base_id = u.id
WHERE vd.venta_id = ?
```

**Consumidores actuales verificados** (todos solo desestructuran los campos
YA existentes, ninguno usa `SELECT *` ni falla con columnas nuevas):
`use-notas-credito.ts::useDetalleFactura` (re-exporta; usado por
`crear-ncr-modal.tsx`, `ventas-consultas-modal.tsx`),
`venta-exitosa-modal.tsx`, `factura-detalle-cxc.tsx`. Extensión 100%
aditiva — sin breaking change, sin smoke test adicional más allá de los
existentes.

### Decisión 4 — `derivarEstadoPago`: fuente de "total pagado"

`ventas.saldo_pend_usd` ya es el campo persistido y mantenido por
`aplicarPagoFacturaEnTx`/`crearNotaCredito` (Step A) — **no** se sume
`pagos.monto_usd` de forma independiente (evitaría doble fuente de verdad y
divergiría si algún pago está reversado). `pagado = total_usd - saldo_pend_usd`.

```ts
export type EstadoPago = 'CONTADO' | 'CREDITO' | 'ABONADA'
export function derivarEstadoPago(f: { total_usd: DecimalInput; saldo_pend_usd: DecimalInput }): EstadoPago {
  const total = new Decimal(f.total_usd)
  const saldo = new Decimal(f.saldo_pend_usd)
  if (saldo.lte('0.005')) return 'CONTADO'
  if (saldo.gte(total.minus('0.005'))) return 'CREDITO'
  return 'ABONADA'
}
```
Épsilon `0.005` consistente con el umbral ya usado en `vencimientos_cobrar`
(`nuevoSaldoVc.lte('0.005')`). Badges de reverso son lectura directa de
`tiene_reverso_total`/`tiene_reverso_parcial` (Decisión 2) — no requieren
función pura adicional, son booleanos ya resueltos por SQL.

### Decisión 5 — Panel de detalle: reuso estricto, sin adaptador nuevo

`FacturaDetallePanel` (componente de presentación, `notas-credito-ui.tsx`)
recibe `ReciboData` YA CONSTRUIDO por el llamador (igual que
`venta-exitosa-modal.tsx`) — no fetch propio, no llamado a `buildReciboData`
dentro del componente. El modal POS arma el input mapeando
`useDetalleFactura` → `ReciboLineaInput` (mismo mapeo exacto de
`venta-exitosa-modal.tsx:94-101`), con `discrepancy: null` (ver Decisión 6) y
`saldoPendUsd: factura.saldo_pend_usd`.

### Decisión 6 — "Afectación a CxC": RESUELTO, `recibo-pagos.ts` NO cubre el caso

**Hallazgo de código (bloqueante, verificado leyendo `recibo-pagos.ts` +
`cobro-modal.tsx` + `venta-exitosa-modal.tsx`)**: `construirCierreRecibo` /
`ReciboCierre.tipo` (`VUELTO`/`SAF`/`PROPINA`/`DIFERENCIAL_SOBRANTE`/`CREDITO`)
depende del parámetro `discrepancy: ReciboDiscrepancyInput | null`, que es
**estado efímero de React** (`discrepancyMode` en `cobro-modal.tsx`, calculado
en el momento del cobro y pasado una única vez a `VentaExitosaModal` justo
después de crear la venta). **No se persiste en ninguna tabla** — `ventas` no
tiene columna `discrepancy`/`cierre_tipo`. Para cualquier factura que no sea
la recién creada (el caso general del listado de sesión, con facturas de
minutos u horas atrás), `discrepancy` es irrecuperable: solo queda la rama
`saldoPendUsd > 0 → CREDITO` de `construirCierreRecibo`, que **no cubre** SAF
aplicado, vuelto entregado ni propina — confirma el riesgo "Afectación CxC
incompleta" del proposal.

**Decisión**: NO usar `construirCierreRecibo` para esta sección. Fuente
correcta y persistida: `movimientos_cuenta WHERE venta_id = ?` — cada fila es
un cambio real al ledger del cliente atado a esa venta (`PAG` = pago CxC
aplicado, `SAF` = saldo a favor aplicado a esa factura). Nueva función pura +
query mínima aditiva:

```sql
SELECT COUNT(*) as n FROM movimientos_cuenta WHERE venta_id = ? AND empresa_id = ?
```
```ts
export function huboAfectacionCxc(cantidadMovimientos: number): boolean {
  return cantidadMovimientos > 0
}
```
El panel muestra "Afectó cuentas por cobrar" / "No afectó cuentas por cobrar"
en base a este booleano — independiente de `ReciboData.cierre` (que sigue
mostrándose igual, solo que para facturas históricas normalmente será `null`
o `CREDITO`, nunca `SAF`/`VUELTO`; eso es correcto, no un bug).

### Decisión 7 — Selección PARCIAL: componente + función pura de mapeo

`SeleccionLineasNc` (componente) reutiliza el patrón de stepper de
`linea-items.tsx:88-137` (step `0.001`/`1` según `es_decimal`, bloqueo de
tecla decimal). El mapeo UI→contrato es una función pura testeable sin React:

```ts
export interface LineaFacturaParaNc {
  venta_det_id: string
  cantidadFacturada: number
  esDecimal: boolean
}
export interface DerivarLineasNcResult {
  lineas: LineaNcSeleccionada[]   // { venta_det_id, cantidadDevolver: string }
  errores: string[]               // vacío = válido para confirmar
}
export function derivarLineasNcParcial(
  facturaLineas: LineaFacturaParaNc[],
  cantidadesUi: Record<string, number>   // venta_det_id -> cantidad ingresada
): DerivarLineasNcResult
```
Reglas: cantidad `> 0` incluye la línea; `> cantidadFacturada` → error;
`!esDecimal && !Number.isInteger(cantidad)` → error; `toStorageString` al
convertir a `cantidadDevolver` (string, 3 decimales). El tope acumulado
cross-NC (`validarTopeDobleCredito`) sigue siendo responsabilidad exclusiva
del backend — la UI no necesita re-consultarlo, solo propaga el error del
`catch` de `crearNotaCredito` vía `toast`.

### Decisión 8 — Invariante de tasa histórica: preview reusa `buildReciboData`, cero fórmula nueva

Para TOTAL, el preview de Bs es directo: `factura.total_bs` (verbatim, sin
cálculo). Para PARCIAL, en vez de escribir una fórmula paralela (riesgo de
divergencia con `calcularDesgloseLineaNC`), el preview **reusa
`buildReciboData`** sobre el subconjunto de líneas seleccionadas:

```ts
const previewData = buildReciboData({
  ...datosFacturaBase, // emisor/cliente/nroFactura no importan para el preview
  lineas: lineasSeleccionadas.map((l) => ({ ...l, cantidad: cantidadesUi[l.venta_det_id] })),
  tasa: factura.tasa,       // SIEMPRE venta.tasa histórica — NUNCA la tasa vigente del sistema
  igtfUsd: null, pagos: [], discrepancy: null, saldoPendUsd: 0,
})
// preview = { usd: previewData.totales.totalFacturaUsd, bs: previewData.totales.totalFacturaBs }
```
Misma bucket-por-alícuota que `calcularDesgloseLineaNC` (ambas usan
`applyImpuesto` de `lib/currency.ts`) — estructuralmente imposible de divergir
del monto que `crearNotaCredito` calculará al confirmar. El componente
**nunca** lee la tasa vigente del sistema (`useTasaCambio`/similar) para este
cálculo — solo `factura.tasa` (columna ya persistida de `ventas`).

### Decisión 9 — PIN/permiso: extender gating existente, sin tocar PIN B

`handleConfirmarClick` actual (línea 129-138 de `nota-credito-pos-modal.tsx`)
se reusa **verbatim** para el botón "Nota de crédito"; se agrega un
`handleEditarPagosClick` idéntico que en vez de `emitirNc()` llama a un
no-op (`toast.info('Función no implementada')`). Ambos comparten el MISMO
`SupervisorPinDialog` de PIN A (mismo `requiredPermission`), pero
parametrizado por una acción pendiente (`accionPendiente: 'NC' | 'EDITAR_PAGOS'`)
para que `onAuthorized` dispare la función correcta. El PIN B
(`showPinDeposito`/`pinDepositoAutorizado`, líneas 66-69/247-273/332-339) **no
se toca** — sigue gateando únicamente el selector de depósito dentro del
flujo de NC, tal como hoy.

## Data Flow

```
Boton "Facturas de caja" (rename)
        │
        ▼
useFacturasSesionActiva (extendida, Decision 2)
        │  [badges: derivarEstadoPago + tiene_reverso_*]
        ▼
Lista + buscador (client-side filter)
        │  click factura
        ▼
useDetalleFactura (cxc, extendida, Decision 3) ──┬─→ buildReciboData ──→ FacturaDetallePanel
                                                   │                          │
COUNT movimientos_cuenta WHERE venta_id (Decision 6) ─────────────────→ "Afecto CxC: si/no"
        │
        ▼ click "Nota de credito"
Elegir TOTAL | PARCIAL
        │                              │
        ▼ TOTAL                       ▼ PARCIAL
crearNotaCredito(tipo=TOTAL)   SeleccionLineasNc (stepper es_decimal)
   [sin cambios]                       │
                              derivarLineasNcParcial (Decision 7)
                                       │
                          preview Bs = buildReciboData(subset) (Decision 8)
                                       │
                          crearNotaCredito(tipo=PARCIAL, lineas)
                                       │
                          [sin cambios en crearNotaCredito]
```

## File Changes

| Archivo | Acción | Slice |
|---|---|---|
| `src/features/ventas/hooks/use-facturas-sesion-activa.ts` | Modify — query Decision 2 | 1 |
| `src/features/cxc/hooks/use-cxc.ts` (`useDetalleFactura`) | Modify — join Decision 3 | 1 |
| `src/features/ventas/utils/notas-credito-ui.ts` | Create — `derivarEstadoPago`, `huboAfectacionCxc`, `derivarLineasNcParcial`, `previewMontoBsNc` (puras) | 1,3 |
| `src/features/ventas/components/factura-detalle-panel.tsx` | Create — `FacturaDetallePanel` (presentación) | 1 |
| `src/features/ventas/components/seleccion-lineas-nc.tsx` | Create — `SeleccionLineasNc` (presentación, stepper) | 3 |
| `src/features/ventas/components/nota-credito-pos-modal.tsx` | Modify — rediseño mayor (lista, badges, panel, PARCIAL, placeholder) | 2,3,4 |
| `src/features/ventas/components/pos-terminal.tsx` (o donde viva el botón) | Modify — rename botón | 2 |

## Interfaces / Contracts

```ts
// notas-credito-ui.ts
export type EstadoPago = 'CONTADO' | 'CREDITO' | 'ABONADA'
export function derivarEstadoPago(f: { total_usd: DecimalInput; saldo_pend_usd: DecimalInput }): EstadoPago

export function huboAfectacionCxc(cantidadMovimientosCuenta: number): boolean

export interface LineaFacturaParaNc { venta_det_id: string; cantidadFacturada: number; esDecimal: boolean }
export interface DerivarLineasNcResult { lineas: LineaNcSeleccionada[]; errores: string[] }
export function derivarLineasNcParcial(
  facturaLineas: LineaFacturaParaNc[],
  cantidadesUi: Record<string, number>
): DerivarLineasNcResult

export function previewMontoBsNc(input: {
  tipo: 'TOTAL' | 'PARCIAL'
  factura: { total_usd: number; total_bs: number; tasa: number }
  lineasSeleccionadas?: ReciboLineaInput[]   // subset ya filtrado por derivarLineasNcParcial
}): { totalUsd: number; totalBs: number }
```

## Slice Plan (troceo dependency-ordered, budget ~400 líneas/PR)

| # | Entrega | Tamaño aprox. | Depende de | Rollback |
|---|---|---|---|---|
| 1 | Queries extendidas (Decision 2/3) + funciones puras `derivarEstadoPago`/`huboAfectacionCxc` + `FacturaDetallePanel` (usa `buildReciboData` con datos mockeados en su propio test) | ~250-300 líneas | Change 1 (merged) | Revertible solo — el modal viejo no las consume aún |
| 2 | Lista rediseñada del modal (badges, buscador, rename botón) consumiendo Slice 1, SIN panel montado aún (placeholder) | ~200-250 líneas | Slice 1 | Modal cae de vuelta a la lista simple actual |
| 3 | Panel de detalle montado + selección PARCIAL (`SeleccionLineasNc`, `derivarLineasNcParcial`, `previewMontoBsNc`) + wiring a `crearNotaCredito(tipo=PARCIAL)` | ~350-400 líneas | Slice 1, 2 | Botón "Nota de crédito" cae a solo TOTAL (comportamiento actual) |
| 4 | Placeholder "Editar métodos de pago" + extensión de gating PIN A a ambas acciones | ~100-150 líneas | Slice 2 | Botón oculto sin romper NC TOTAL/PARCIAL |

## Testing Strategy

| Capa | Qué | Enfoque |
|---|---|---|
| Unit (RED-first) | `derivarEstadoPago` — tabla de verdad Contado/Crédito/Abonada + límites épsilon | Función pura, sin I/O, casos con `Decimal` string inputs |
| Unit (RED-first) | `derivarLineasNcParcial` — excede cantidad, rechaza decimal si `es_decimal=0`, cero líneas → error, mapeo correcto a `cantidadDevolver` string | Función pura |
| Unit (RED-first) | `previewMontoBsNc` — TOTAL usa `total_bs` verbatim; PARCIAL con tasa histórica ≠ tasa vigente da el monto de R1, no R2 | Función pura, reusa `buildReciboData` con fixture de líneas mixtas gravadas/exentas |
| Unit | `huboAfectacionCxc` | Trivial, un solo branch |
| Component | `FacturaDetallePanel` vacío sin selección / con IGTF / con exentos | Render con `ReciboData` fixture, sin fetch |
| Component | `SeleccionLineasNc` — botón confirmar deshabilitado con todas las líneas en 0 | Testing Library, interacción de stepper |
| Integration | Extensión de `useDetalleFactura` no rompe consumidores existentes | Smoke test de `venta-exitosa-modal.tsx`/`factura-detalle-cxc.tsx` ya existentes, sin cambios de aserciones |

## Migration / Rollout

No hay migración SQL — todos los campos nuevos (`es_decimal`, `precio_unitario_bs`,
`tiene_reverso_total`, `tiene_reverso_parcial`) se calculan en el `SELECT` vía
JOIN/EXISTS sobre columnas ya existentes (`unidades.es_decimal`,
`productos.unidad_base_id`, `notas_credito.tipo`). Deploy estándar: mergear
cada slice a `main` (auto-deploy Cloudflare Workers), sin coordinación con
Supabase SQL Editor.

## Open Questions

Ninguna bloqueante. La pregunta de "afectación CxC" quedó resuelta en
Decisión 6 (fuente: `movimientos_cuenta`, no `recibo-pagos.ts`). Diferido
explícitamente fuera de este change (ver proposal): construcción del mismo
flujo para Tradicional, selector de modalidad libre en Tradicional,
`RequirePermission` en la ruta Tradicional.
