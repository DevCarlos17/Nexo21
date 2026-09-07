# Tasks: notas-credito-ui-pos

Test runner (sdd-init cache, strict_tdd: true): `yarn test:run` (CI single-run,
Vitest), `yarn type-check` (app, `tsc --noEmit`), `yarn type-check:test`
(`tsc --noEmit --project tsconfig.test.json`). No ESLint instalado. Toda
función pura y toda pieza de mapeo cantidad→`lineas` es RED→GREEN antes de
tocar el componente que la consume — precedente: `notas-credito-fiscal.ts`,
`notas-credito-pin-gating.ts` (mismo patrón, mismo repo, Change 1 merged).

## Aggregate Review Workload Forecast (top-level)

| Field | Value |
|---|---|
| Total estimated changed lines (4 PRs) | ~900–1100 |
| Per-slice estimate | Slice 1: ~250–300 · Slice 2: ~200–250 · Slice 3: ~350–400 · Slice 4: ~100–150 |
| Slices exceeding 400 lines alone | None — Slice 3 is closest to budget (350–400), monitor, do not add scope |
| Chained PRs recommended | **Yes** |
| Recommended PR sequencing | 1 → 2 → 3 → 4 (strict dependency order — see Depende-de por slice) |
| Delivery strategy | ask-on-risk |
| Chain strategy | **pending** — not chosen this session. Orchestrator MUST ask the user (stacked-to-main vs feature-branch-chain) before `sdd-apply` starts Slice 1 |

```text
Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High
```

**Nota de troceo (Design §Slice Plan)**: Slice 1 es standalone y revertible
(nadie lo consume aún). Slice 2 depende de Slice 1 pero preserva el flujo de
confirmación TOTAL actual sin cambios (solo lista/buscador/badges/rename).
Slice 3 es la cirugía mayor — reemplaza el drill-down actual por el layout de
dos columnas (lista + `FacturaDetallePanel`) y agrega PARCIAL — es el slice
con mayor riesgo de tamaño, monitorear antes de abrir el PR. Slice 4 es el
más chico y el único sin dependencia de datos nuevos (solo UI + gating).

## Slice 1 — Queries extendidas + funciones puras + `FacturaDetallePanel` (Design §Decisión 2/3/4/5/6)

### Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~250–300 |
| 400-line budget risk | Low |
| Chained PRs | No — single PR, depende solo de Change 1 (merged) |
| Rollback | Revertible solo — el modal viejo no consume nada de este slice todavía |

- [x] 1.1 RED: nuevo `src/features/ventas/utils/__tests__/notas-credito-ui.test.ts` — tabla de verdad `derivarEstadoPago({total_usd, saldo_pend_usd})`: CONTADO (`saldo<=0.005`), CREDITO (`saldo>=total-0.005`), ABONADA (caso intermedio), casos límite exactos en el épsilon `0.005`. [Design §Decisión 4]
- [x] 1.2 GREEN: crear `src/features/ventas/utils/notas-credito-ui.ts` — `export type EstadoPago = 'CONTADO'|'CREDITO'|'ABONADA'` + `derivarEstadoPago` con la fórmula exacta del design (`pagado = total_usd - saldo_pend_usd`, Decimal, épsilon `0.005` — mismo umbral que `vencimientos_cobrar`). NUNCA suma `pagos.monto_usd` independientemente.
- [x] 1.3 RED: mismo archivo — `huboAfectacionCxc(cantidadMovimientos: number)`: `0` → `false`; `>0` → `true`. [Design §Decisión 6]
- [x] 1.4 GREEN: implementar `huboAfectacionCxc` en `notas-credito-ui.ts`.
- [x] 1.5 Modificar `src/features/ventas/hooks/use-facturas-sesion-activa.ts`: quitar el filtro `AND v.status != 'ANULADA'` (bug respecto a la spec, no comportamiento a preservar); agregar `v.status` y las subqueries `EXISTS(...) as tiene_reverso_total` / `tiene_reverso_parcial` del SQL exacto de Design §Decisión 2. Mantener filtro `empresa_id` + `sesion_caja_id`.
- [x] 1.6 RED primero: extender `src/features/ventas/hooks/__tests__/use-facturas-sesion-activa.test.ts` — una factura `status='ANULADA'` de la sesión activa YA NO se excluye del resultado; nuevas columnas `tiene_reverso_total`/`tiene_reverso_parcial` presentes y correctas para una venta con NC TOTAL vs PARCIAL vs sin NC. Confirmar RED antes de 1.5, GREEN después.
- [x] 1.7 Extender `FacturaParaAnular`/tipo de retorno del hook con `status: string`, `tiene_reverso_total: number`, `tiene_reverso_parcial: number` (PowerSync booleans-as-integer). **Deviación**: los 3 campos se agregaron como opcionales (`status?`, `tiene_reverso_total?`, `tiene_reverso_parcial?`) — `FacturaParaAnular` es un tipo COMPARTIDO con `useBuscarFacturaParaAnular` (Tradicional), que no trae estas columnas; marcarlos requeridos hubiera roto la compilación de los fixtures existentes en `crear-ncr-modal.test.tsx`/`nota-credito-pos-modal.test.tsx` (Slice 2/3, fuera de este slice). Ver apply-progress para detalle.
- [x] 1.8 Modificar `src/features/cxc/hooks/use-cxc.ts::useDetalleFactura` (líneas 227-240): JOIN `ventas v ON vd.venta_id = v.id` + `LEFT JOIN unidades u ON p.unidad_base_id = u.id`; agregar `u.es_decimal` y `ROUND(CAST(vd.precio_unitario_usd AS REAL) * CAST(v.tasa AS REAL), 2) as precio_unitario_bs` al SELECT (SQL exacto Design §Decisión 3). Extender `DetalleFacturaCxc` con `es_decimal: number | null` y `precio_unitario_bs: string`.
- [x] 1.9 Verificar que la extensión es 100% aditiva: `venta-exitosa-modal.tsx`, `factura-detalle-cxc.tsx`, y el re-export en `use-notas-credito.ts::useDetalleFactura` (consumido por `crear-ncr-modal.tsx`, `ventas-consultas-modal.tsx`) siguen pasando sin cambios de aserciones — correr sus test suites existentes y confirmar cero regresiones (smoke test, Design §Decisión 3 lista de consumidores verificados).
- [x] 1.10 RED: nuevo `src/features/ventas/components/__tests__/factura-detalle-panel.test.tsx` — sin `recibo` (null) el panel no muestra datos de factura; con un `ReciboData` fixture (via `buildReciboData` real, no mock) muestra artículos (cantidad, precio Bs/USD), subtotal, exento, base imponible, IVA por alícuota, total, IGTF cuando `igtfUsd` no es null, desglose de pagos; con `afectoCxc=true`/`false` muestra el texto correspondiente. [Spec notas-credito-pos: Panel de detalle fiscal — todos los scenarios]
- [x] 1.11 GREEN: crear `src/features/ventas/components/factura-detalle-panel.tsx` — `FacturaDetallePanel({ recibo: ReciboData | null, afectoCxc: boolean | null })`, componente de PRESENTACIÓN puro: recibe `ReciboData` ya construido (Design §Decisión 5, mismo patrón que `venta-exitosa-modal.tsx`) — MUST NOT llamar `buildReciboData` ni hacer fetch dentro. Usa `construirFilasTotales(recibo.totales, recibo.monedaPresentacion)` para la sección de totales (reuso, no reimplementación).
- [x] 1.12 Verify: `yarn test:run` + `yarn type-check` + `yarn type-check:test` verdes; grep diff en `venta-exitosa-modal.tsx`/`factura-detalle-cxc.tsx` confirma cero líneas cambiadas (solo se tocan `use-cxc.ts`, `use-facturas-sesion-activa.ts`, y los 2 archivos nuevos).

**Resultado real vs. forecast**: 468 líneas cambiadas (463 inserciones + 5 eliminaciones, `git diff --stat`) vs. forecast ~250-300 — excede el budget de 400. Ver apply-progress (`sdd/notas-credito-ui-pos/apply-progress`) para el desglose y la recomendación al orquestador.

## Slice 2 — Lista rediseñada del modal (badges, buscador, rename botón) (Spec notas-credito-pos: Alcance limitado a la sesión activa, Badges, Renombrar botón)

### Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~200–250 |
| 400-line budget risk | Low |
| Chained PRs | Yes — depende de Slice 1 |
| Rollback | Modal cae de vuelta a la lista simple actual (sin badges/buscador) |

**Límite explícito de este slice (Design §Slice Plan: "SIN panel montado aún")**: el drill-down actual de `nota-credito-pos-modal.tsx` (click factura → vista de confirmación con modalidad/depósito/motivo/PIN, líneas 200-339 del archivo actual) NO se toca ni se reemplaza todavía — sigue funcionando exactamente igual para NC TOTAL. Este slice solo interviene la VISTA DE LISTADO (líneas 168-199 actuales): agrega badges, buscador y renombra el botón de acceso. El layout de dos columnas y el montaje real de `FacturaDetallePanel` son Slice 3.

- [x] 2.1 RED: extender `src/features/ventas/components/__tests__/nota-credito-pos-modal.test.tsx` — el listado muestra badge Contado/Crédito/Abonada por fila (usando `derivarEstadoPago` sobre `facturas` mockeadas); una factura con `tiene_reverso_total=1` muestra badge "Reverso Total"; `tiene_reverso_parcial=1` muestra "Reverso Parcial"; una factura Abonada + `tiene_reverso_parcial=1` muestra AMBOS badges simultáneamente. [Spec: Badges — todos los scenarios]
- [x] 2.2 RED: mismo archivo — buscador filtra client-side por `nro_factura` (substring), por `cliente_nombre` (substring, case-insensitive), y por texto de badge/estado; sesión sin facturas muestra el estado vacío existente sin error; una factura `status='ANULADA'` (reversada) de la sesión sigue apareciendo en el listado con su badge. [Spec: Alcance limitado a la sesión activa — todos los scenarios de buscador]. **Extra (no forzado por tasks.md, TDD-consistente)**: se agregaron RED/GREEN dedicados para la función pura `facturaCoincideBusqueda` en `notas-credito-ui.test.ts`/`.ts` ANTES de wiring el componente (Extract-Before-Mock Rule) — incluye normalización de acentos (`normalizarBusqueda`) descubierta como necesaria durante TRIANGULATE (buscar "credito" sin tilde debe matchear el badge "Crédito").
- [x] 2.3 GREEN: `nota-credito-pos-modal.tsx` — agregar estado `searchQuery`, input de búsqueda sobre la vista de listado, y un filtro derivado (`useMemo`, sin nueva query) que usa `facturaCoincideBusqueda` (`notas-credito-ui.ts`) contra `searchQuery`.
- [x] 2.4 GREEN: renderizar badges por fila via nuevo componente `FacturaBadges` usando `derivarEstadoPago(f)` + `f.tiene_reverso_total`/`tiene_reverso_parcial` (shadcn `Badge`, variant outline con colores Tailwind, sin nueva dependencia de UI); fecha/hora via `formatDateTime` (ya importado).
- [x] 2.5 GREEN: `pos-terminal.tsx` — renombrado el botón desktop (hoy "Nota de Credito") a "Facturas de caja"; renombrado el botón mobile (hoy "NC") a "Fact.". Cero cambios de lógica: mismo `onClick={() => setShowNotaCreditoModal(true)}`, mismo estado `showNotaCreditoModal`. Comentarios inline actualizados. Triangulation skipped (tarea puramente estructural, sin archivo de test para `pos-terminal.tsx`, salida única posible). [Spec: Renombrar el botón de acceso a NC del POS]
- [x] 2.6 Verify: `yarn test:run` (951/951 verdes) + `yarn type-check` (ruido preexistente de vitest-globals que afecta a TODA la suite de tests bajo el tsconfig de la app —no 3 archivos puntuales—, cero errores nuevos introducidos por este change; `type-check:test` es la fuente autoritativa para archivos de test) + `yarn type-check:test` (limpio) verdes; flujo TOTAL existente (click factura → modalidad → motivo → confirmar → PIN si aplica) NO se toco — 0 cambios de logica en ese bloque JSX, solo se agrego `disabled`/badges/busqueda en el bloque de LISTADO que lo precede.

**WARNING #2 de Slice 1 (obs #2877) — RESUELTO en este slice**: las filas cuya `status === 'ANULADA'` (reverso TOTAL ya emitido) ahora quedan visualmente deshabilitadas (`opacity-60 cursor-not-allowed`, atributo `disabled`) y NO navegan al flujo de confirmación — el botón "Confirmar Anulacion" jamás se renderiza para esas facturas porque `onClick` nunca dispara sobre un `<button disabled>`. El badge "Reverso Total" sigue visible. Facturas con `tiene_reverso_parcial=1` pero `status` activo permanecen clickeables (pueden recibir otra NC parcial dentro del tope que valida el backend).

**Resultado real vs. forecast**: 314 inserciones + 39 eliminaciones = 353 líneas cambiadas (`git diff --stat` sobre los 5 archivos del slice) vs. forecast ~200-250 — por encima del estimado pero DENTRO del budget de 400 (clasificación "Low" del forecast se mantiene válida, a diferencia de Slice 1). Sin exception necesaria.

## Slice 3 — Panel de detalle montado + selección PARCIAL + wiring a `crearNotaCredito` (Design §Decisión 5/6/7/8, Spec notas-credito-pos: Panel de detalle fiscal, Selección TOTAL/PARCIAL, Invariante de tasa histórica)

### Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~350–400 |
| 400-line budget risk | **Medium — cerca del budget, no agregar scope** |
| Chained PRs | Yes — depende de Slice 1 y 2 |
| Rollback | Botón "Nota de crédito" cae a solo TOTAL (comportamiento pre-slice, ya reversible sin tocar `crearNotaCredito`) |

**BIMONETARY INVARIANT — tratamiento especial**: el preview de Bs en PARCIAL
MUST derivarse SIEMPRE de `factura.tasa` (histórica), NUNCA de la tasa
vigente del sistema. Esto tiene su propio test RED dedicado (3.5) antes de
cualquier wiring — no se implementa "de paso" dentro de otra tarea.

**Sub-troceo 3a/3b (obs `sdd/notas-credito-ui-pos/apply-progress`, precedente Change 1 Slice 5a-2a/5a-2b)**: Slice 3 se dividio en dos batches de apply — 3a (panel montado + funciones puras, este batch) y 3b (SeleccionLineasNc + wiring PARCIAL completo). `feat/notas-credito-ui-pos-s3a` → `feat/notas-credito-ui-pos-s2`; 3b encadenara sobre 3a.

- [x] 3.1 [3a] Reestructurar `nota-credito-pos-modal.tsx` a layout de dos columnas: lista (con búsqueda/badges de Slice 2) a la izquierda, `FacturaDetallePanel` (Slice 1) montado a la derecha — reemplaza el drill-down single-view actual. Ensanchar el `<dialog>` (`max-w-lg` → `max-w-4xl`). Al seleccionar una factura, el modal arma el `ReciboData` mapeando `useDetalleFactura` → `ReciboLineaInput` (mismo mapeo que `venta-exitosa-modal.tsx:94-101`, NO una fórmula nueva) y llama `buildReciboData(...)` con `discrepancy: null`, `saldoPendUsd: factura.saldo_pend_usd` (Design §Decisión 5). **Deviación aditiva**: se agregó `v.total_igtf_usd` al SELECT de `useFacturasSesionActiva` (+ campo opcional en `FacturaParaAnular`) — necesario para alimentar `igtfUsd` real del panel (spec "Factura con IGTF aplicado"), no estaba en el Design SQL original de Decision 2 pero es 100% aditivo sobre una columna ya persistida.
- [x] 3.2 [3a] Query mínima aditiva para "Afectación CxC": `SELECT COUNT(*) as n FROM movimientos_cuenta WHERE venta_id = ? AND empresa_id = ?` (Design §Decisión 6 — fuente correcta, NUNCA `construirCierreRecibo`/`discrepancy`), consumida por `huboAfectacionCxc(n)` (Slice 1) y pasada como prop `afectoCxc` a `FacturaDetallePanel`. Implementado como `useAfectacionCxc(ventaId, empresaId)` en `use-cxc.ts` (mismo archivo que `useDetalleFactura`, RED→GREEN con tests dedicados).
- [x] 3.3 [3a] RED: `nota-credito-pos-modal.test.tsx` — sin selección, el panel derecho no muestra datos (ya cubierto en 1.10, aquí se verifica integrado en el modal real); con selección, coincide con `buildReciboData` de esa venta (fixture con IGTF y con líneas exentas: linea gravada + linea exenta + `total_igtf_usd`). [Spec: Panel de detalle fiscal — scenarios de IGTF/exentos/selección]
- [x] 3.4 [3b] GREEN: botón "Nota de crédito" ahora pregunta TOTAL o PARCIAL antes de continuar (nuevo paso de UI, ej. dos botones o un toggle). TOTAL preserva la llamada EXACTA existente a `crearNotaCredito({ ..., tipo: TOTAL })` sin alterar el contrato. [Spec: Selección de tipo de NC — scenario "NC TOTAL reversa la factura completa"]
- [x] 3.5 [3a] RED (bimonetary invariant, test dedicado, ANTES del wiring): nuevo `previewMontoBsNc` en `src/features/ventas/utils/__tests__/notas-credito-ui.test.ts` — TOTAL usa `factura.total_bs` verbatim (sin cálculo); PARCIAL con `factura.tasa` (R1) distinta de una tasa vigente simulada R2 produce el monto calculado a R1, nunca a R2; fixture con líneas mixtas gravadas/exentas. [Design §Decisión 8, Spec: Invariante de tasa histórica — todos los scenarios]
- [x] 3.6 [3a] GREEN: implementar `previewMontoBsNc` en `notas-credito-ui.ts` — para PARCIAL, reusa `buildReciboData` sobre el subconjunto de líneas seleccionadas con `tasa: factura.tasa` (histórica, columna ya persistida) — CERO fórmula paralela nueva, estructuralmente igual a `calcularDesgloseLineaNC` del backend (misma `applyImpuesto`). El componente NUNCA lee la tasa vigente del sistema para este cálculo. [Design §Decisión 8, firma exacta en Design §Interfaces]
- [x] 3.7 [3a] RED: nuevo `src/features/ventas/utils/__tests__/notas-credito-ui.test.ts` (misma suite) — `derivarLineasNcParcial(facturaLineas, cantidadesUi)`: cantidad `>0` incluye la línea; cantidad `> cantidadFacturada` → error, línea excluida del resultado válido; `!esDecimal && !Number.isInteger(cantidad)` → error; todas las cantidades en 0 → `lineas: []` + al menos un error genérico ("selecciona al menos una línea"); mapeo correcto a `cantidadDevolver` como string. [Design §Decisión 7, firma exacta en Design §Interfaces; Spec: Selección TOTAL/PARCIAL — scenarios de tope/es_decimal/al-menos-una-línea]. **Deviación menor**: `cantidadDevolver` se formatea con `Decimal(cantidad).toFixed(3)` (3 decimales), no `toStorageString` (8 decimales) — consistente con el formato REAL usado en todo el resto del código de NC (`use-notas-credito.ts`, `notas-credito-fiscal.ts`, tests existentes: `"2.000"`), el texto literal del design ("toStorageString... 3 decimales") era auto-contradictorio.
- [x] 3.8 [3a] GREEN: implementar `derivarLineasNcParcial` en `notas-credito-ui.ts` con la firma exacta del design (`LineaFacturaParaNc`, `DerivarLineasNcResult`).
- [x] 3.9 [3b] RED (component): nuevo `src/features/ventas/components/__tests__/seleccion-lineas-nc.test.tsx` — botón "Confirmar" deshabilitado mientras todas las cantidades estén en 0; stepper respeta paso `0.001`/`1` según `es_decimal` de cada línea (mismo patrón que `linea-items.tsx:88-137`); no permite tecla decimal cuando `es_decimal=0`. [Spec: Selección TOTAL/PARCIAL — scenario "Cantidad respeta es_decimal"]
- [x] 3.10 [3b] GREEN: crear `src/features/ventas/components/seleccion-lineas-nc.tsx` — `SeleccionLineasNc`, componente de presentación, reusa el patrón de stepper de `linea-items.tsx` (no lo reimplementa desde cero — extraer el bloque de stepper a una función/sub-componente compartido si el reuso directo no es práctico, documentando la decisión inline).
- [x] 3.11 [3b] GREEN: wiring completo en `nota-credito-pos-modal.tsx` — PARCIAL elegido → muestra `SeleccionLineasNc` con las líneas de `useDetalleFactura`; cantidades ingresadas pasan por `derivarLineasNcParcial` (3.8, ya disponible); errores bloquean el botón "Confirmar"; preview de monto usa `previewMontoBsNc` (3.6, ya disponible); confirmar llama `crearNotaCredito({ ..., tipo: 'PARCIAL', lineas })` — el tope acumulado cross-NC (`validarTopeDobleCredito`) sigue siendo responsabilidad exclusiva del backend, la UI solo propaga el error del `catch` vía `toast` (Design §Decisión 7, última línea).
- [x] 3.12 [3b] Verify: `yarn test:run` + `yarn type-check` + `yarn type-check:test` verdes; confirmar `crearNotaCredito` (`use-notas-credito.ts`) tiene CERO líneas cambiadas (`git diff --stat` sobre ese archivo) — este slice solo llama la función existente, nunca la modifica.

**Resultado real 3a vs. forecast**: 798 líneas cambiadas (`git diff --stat`: 627 inserciones + 171 eliminaciones sobre 9 archivos) vs. forecast de sub-split ~300-350 — excede significativamente el budget de 400. Gran parte (272 líneas) es ruido de reindentación en `nota-credito-pos-modal.tsx` (el layout de 2 columnas añade un nivel de anidación que reindenta el bloque de listado existente sin cambiar su lógica — con `git diff --ignore-all-space` el total baja a 526 líneas). Ver apply-progress (`sdd/notas-credito-ui-pos/apply-progress`) para el desglose completo y la recomendación al orquestador. `crearNotaCredito` verificado en CERO líneas cambiadas.

**Resultado real 3b vs. forecast**: 587 líneas cambiadas (`git diff --stat`: 564 inserciones + 23 eliminaciones sobre 6 archivos; con `--ignore-all-space` baja a 557) vs. forecast de sub-split ~200-280 — excede el budget de 400. Desglose: `seleccion-lineas-nc.tsx` (181L, componente nuevo) + su test (122L) + wiring en `nota-credito-pos-modal.tsx` (147L, incluye el toggle Total/Parcial + memo de mapeo de líneas + refactor de `emitirNc`/gating PIN A para aceptar `lineasParcial`) + su test (95L) + guardrail de cantidad negativa en `derivarLineasNcParcial` (16L) + su test (26L). Sin scope creep — el exceso es 100% cobertura de test (RED-first, incluyendo el guard de cantidad negativa que 3a dejó pendiente) y presentación (tabla + stepper accesible), no lógica adicional no pedida. `crearNotaCredito` verificado en CERO líneas cambiadas (`git diff --stat` sobre `use-notas-credito.ts` vacío). Cierra el segmento [3] del ring — el flujo POS de NC queda funcional de punta a punta (TOTAL + PARCIAL).

## Slice 4 — Placeholder "Editar métodos de pago" + extensión de gating PIN A (Design §Decisión 9, Spec notas-credito-pos: Modelo de doble PIN, Botón placeholder)

### Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~100–150 |
| 400-line budget risk | Low |
| Chained PRs | Yes — depende de Slice 2 (botón/gating existente), independiente de Slice 3 |
| Rollback | Botón oculto/removido sin romper NC TOTAL/PARCIAL |

- [x] 4.1 RED: extender `nota-credito-pos-modal.test.tsx` — con permiso `PERMISSIONS.SALES_NOTA_CREDITO`, click en "Editar métodos de pago" dispara `toast.info` (función no implementada) y NUNCA llama `crearNotaCredito`; sin el permiso, click abre el MISMO `SupervisorPinDialog` de PIN A (mismo `requiredPermission`); tras autorizar, ejecuta la acción pendiente correcta y NO la de "Nota de crédito" (y viceversa — verificar que ambas acciones pendientes son independientes entre sí en la misma sesión del modal). [Spec: Modelo de doble PIN — "Permiso determina el PIN para ambas acciones"; Botón placeholder — scenario único]
- [x] 4.2 GREEN: `nota-credito-pos-modal.tsx` — agregar botón "Editar métodos de pago" junto a "Nota de crédito" (mismo estilo/ubicación); estado `accionPendiente: 'NC' | 'EDITAR_PAGOS' | null`; `handleConfirmarClick`/`handleConfirmarParcialClick` se generalizan para setear `accionPendiente` antes de decidir PIN-vs-directo; `handleEditarPagosClick` espeja la misma lógica pero su rama "autorizado/sin PIN necesario" llama `toast.info('Función "Editar métodos de pago" aún no implementada')` — CERO mutación de datos. [Design §Decisión 9]
- [x] 4.3 GREEN: el ÚNICO `SupervisorPinDialog` de PIN A existente pasa a un `onAuthorized` que despacha según `accionPendiente` (`emitirNc()` vs el no-op de 4.2). El `SupervisorPinDialog` de PIN B (`showPinDeposito`/`pinDepositoAutorizado`) NO se toca — sigue gateando únicamente el selector de depósito dentro del flujo de NC. [Design §Decisión 9, último párrafo]
- [x] 4.4 Verify: `yarn test:run` (985/985 verdes) + `yarn type-check:test` (limpio) verdes; confirmado que ningún test de Slice 1-3 quedó roto por el `accionPendiente` agregado (mismo comportamiento de emisión NC cuando `accionPendiente==='NC'`).

**Resultado real vs. forecast**: 103 líneas cambiadas (`git diff --stat`: 47 en `nota-credito-pos-modal.tsx` + 58 en su test, 2 archivos) vs. forecast ~100-150 — dentro del budget, sin exception. `crearNotaCredito` (`use-notas-credito.ts`) verificado en CERO líneas cambiadas. Placeholder confirmado sin mutación (jamás llama `crearNotaCredito`, solo `toast.info`). **CIERRA EL CHANGE** — los 4 slices de `notas-credito-ui-pos` están completos: listo para verify final combinado + archive.

## Cross-cutting invariants (aplican a los 4 slices)

- `crearNotaCredito` (`use-notas-credito.ts`) es CÓDIGO CONGELADO — ningún slice lo modifica; todos lo LLAMAN sin alterar su firma ni lógica interna.
- Toda query NUEVA filtra `empresa_id` (`use-facturas-sesion-activa.ts`, query de afectación CxC del Slice 3). EXCEPCIÓN documentada: `use-cxc.ts::useDetalleFactura` NO filtra `empresa_id` (solo `WHERE vd.venta_id = ?`) — gap PREEXISTENTE, no introducido por este change. Riesgo práctico bajo porque el `venta_id` siempre proviene de una lista ya escopeada por `empresa_id`. DEUDA: agregar el filtro como defensa en profundidad en un fix aparte (toca un hook compartido con CxC, fuera del scope de este change). Verificado en review de Slice 1 (obs #2877).
- decimal.js para todo cálculo monetario — nunca `float`/`Number` para montos. Épsilon `0.005` en `derivarEstadoPago` (mismo umbral que `vencimientos_cobrar`).
- Invariante bimonetaria: NC MUST usar `venta.tasa`/`venta.total_bs` histórica, NUNCA la tasa vigente del sistema — verificado con test dedicado (3.5) antes del wiring (3.6).
- `FacturaDetallePanel` es un componente de PRESENTACIÓN puro — recibe `ReciboData` ya construido, NUNCA llama `buildReciboData` ni hace fetch internamente (Design §Decisión 5).
- "Afectación a CxC" se deriva de `COUNT(*) FROM movimientos_cuenta WHERE venta_id = ?` — NUNCA de `construirCierreRecibo`/`discrepancy` de `recibo-pagos.ts` (estado efímero de React, no persistido; Design §Decisión 6, hallazgo bloqueante resuelto).
- Reuso obligatorio, no reescritura: `buildReciboData`/`construirFilasTotales` (`factura-export.ts`) para el panel y el preview PARCIAL; el patrón de stepper de `linea-items.tsx:88-137` para `SeleccionLineasNc`; `SupervisorPinDialog` + `PERMISSIONS.SALES_NOTA_CREDITO` (gating existente, solo extendido en Slice 4).
- Solo español en toda la UI. TypeScript estricto, sin `any`. `yarn` — nunca `npm`.
- `useDetalleFactura` (cxc) se extiende de forma 100% aditiva — verificar en Slice 1 que los 3 consumidores existentes no rompen antes de avanzar a Slice 2.

## Slice 5a (QA fix F1) — Facturas reversadas seleccionables + gating de acción + tope de remanente por línea

> QA manual del usuario tras el cierre del change (4 slices) encontró 7
> ajustes. Este batch cubre **solo F1** — el único con riesgo real de
> lógica de negocio (permitir sobre-reversar una línea ya acreditada) —
> aislado en su propia rama/PR para review enfocado. F2–F7 (colores de
> badges, desglose Bs fiscal, causa de kardex, cap decimal, UX de exceso de
> cantidad, overlay REVERSADA) quedan diferidos a batches 5b/5c.

### Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~300–350 |
| 400-line budget risk | Alto (real, ver resultado) |
| Chained PRs | `feature-branch-chain` — PR sobre `feat/notas-credito-ui-pos-s4` |
| Rollback | Revierte a: fila reversada deshabilitada (Slice 2), sin historial de reverso ni tope por línea |

**Requisito de negocio (QA)**: las facturas reversadas (TOTAL o PARCIAL)
deben quedar SELECCIONABLES en el listado (antes: `disabled`, ocultando el
detalle). El gating se mueve de la SELECCIÓN a la ACCIÓN: reversado TOTAL
bloquea cualquier NC adicional (vista de solo lectura); reversado PARCIAL
permite una NC adicional pero solo sobre el remanente por línea (facturado −
ya reversado), nunca sobre lo originalmente facturado.

- [x] 5a.1 RED→GREEN: `puedeEmitirNcAdicional(f)` y `puedeElegirTipoTotal(f)` (`notas-credito-ui.ts`) — tabla de verdad sin-reverso/total/parcial. Gating de ACCIÓN, no de selección.
- [x] 5a.2 RED→GREEN: `calcularReversoPorLinea(ventaDetId, cantidadFacturada, notasCreditoDet[])` (`notas-credito-ui.ts`) — mismo criterio de acumulación que el guard autoritativo del backend (`validarTopeDobleCredito`/`buildSumCantidadYaAcreditadaQuery`, `notas-credito-fiscal.ts`). Triangulado: sin NCs previas, con una NC previa, línea totalmente reversada (`restante=0`), filtra por `venta_det_id`, acumula múltiples NCs.
- [x] 5a.3 RED→GREEN: `agruparReversosPorNc(rows)` (`notas-credito-ui.ts`) — agrupa filas planas del historial en entradas por-NC para el panel de detalle (historial additivo).
- [x] 5a.4 RED→GREEN: `useReversosFactura(ventaId, empresaId)` (`use-notas-credito.ts`) — nuevo hook, JOIN `notas_credito`+`notas_credito_det`, filtra `empresa_id`. Alimenta 5a.2/5a.3.
- [x] 5a.5 RED→GREEN: `FacturaDetallePanel` — prop opcional `reversos?: ReversoAplicado[]` (default `[]`, 100% aditivo — cero cambio de asserts en tests pre-existentes), sección "Notas de crédito aplicadas" mostrada junto al detalle original (nunca lo reemplaza).
- [x] 5a.6 RED→GREEN: `SeleccionLineasNc` — prop opcional `cantidadDisponible?: number` en `LineaSeleccionNc` (default = `cantidadFacturada`, compat hacia atrás). El cap real (stepper, `max`, `derivarLineasNcParcial`) usa el remanente, no lo facturado; línea con remanente 0 deshabilita input+stepper.
- [x] 5a.7 GREEN (wiring): `nota-credito-pos-modal.tsx` — quita el `disabled`/`bloqueada` de la fila (factura reversada ahora SELECCIONABLE); al seleccionar, `tipoNc` por defecto usa `puedeElegirTipoTotal`; oculta el botón "Total" cuando `!puedeTotal`; vista de solo-lectura cuando `!puedeEmitirNc` (oculta Tipo de NC/Modalidad/Depósito/Motivo/confirmar); `lineasParaNc` alimenta `cantidadDisponible` vía `calcularReversoPorLinea`; panel recibe `reversos` vía `agruparReversosPorNc`.
- [x] 5a.8 Actualizado el test pre-existente "WARNING #2" (Slice 2) — su expectativa de fila `disabled` quedó reemplazada por: selección funciona + acción bloqueada + nota de solo-lectura. Actualizado también el test de `tiene_reverso_parcial=1` (defaultea a PARCIAL, no TOTAL).
- [x] 5a.9 Verify: `yarn test:run` (1011/1011 verdes) + `yarn type-check:test` (limpio) + `yarn type-check` (solo ruido preexistente de vitest-globals, cero errores nuevos); `crearNotaCredito` (`use-notas-credito.ts`) verificado en CERO líneas cambiadas (`git diff` — solo aditivo, nuevo hook `useReversosFactura`).

**Resultado real vs. forecast**: 664 inserciones + 60 eliminaciones = 724 líneas cambiadas (`git diff --stat` sobre 10 archivos) vs. forecast ~300-350 — excede significativamente el budget de 400, mismo patrón que Slices 1/3a/3b de este change (subestimación consistente del costo de TDD estricto con triangulación completa + wiring de gating cross-cutting). Desglose aproximado: `notas-credito-ui.ts` (+127, 3 funciones puras nuevas) + su test (+99, triangulación completa); `use-notas-credito.ts` (+35, un hook nuevo, 100% aditivo) + su test (+54); `nota-credito-pos-modal.tsx` (+122/-, wiring de gating + reindentación menor del bloque de listado) + su test (+85); `factura-detalle-panel.tsx` (+35, sección aditiva) + su test (+65); `seleccion-lineas-nc.tsx` (+56/-, cap por remanente) + su test (+46). Sin scope creep — el exceso es 100% cobertura RED-first + wiring necesario para la gating logic de mayor riesgo del change (el propio F1). `crearNotaCredito` verificado en CERO líneas cambiadas. **F2–F7 permanecen diferidos a batches 5b/5c.**

## Slice 5b (QA fixes F3, F7) — Bs en desglose fiscal + overlay REVERSADA

> Continuación del troceo de QA de Slice 5a. Solo F3 y F7 — ambos tocan
> exclusivamente `FacturaDetallePanel` (y, para F3, el helper compartido
> `construirFilasTotales`), display-only, sin riesgo de lógica de negocio.

### Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~120–190 |
| 400-line budget risk | Low |
| Chained PRs | `feature-branch-chain` — PR sobre `feat/notas-credito-ui-pos-s5a` |
| Rollback | Revierte a: desglose fiscal solo en moneda primaria (sin Bs en filas intermedias), sin overlay de reverso |

- [x] 5b.1 RED→GREEN (F3): `FilaTotal` (`factura-export.ts`) — nuevo campo `montoBs: string | null`; `montoBsSecundario(bs, monedaPresentacion)` retorna `formatBs(bs)` solo cuando `monedaPresentacion==='USD'` (si es `'BS'`, `monto` ya es Bs primario). Poblado en Monto Exento/Base Imponible/IVA%/IGTF (filas intermedias); `null` en las 2 filas finales bold (`formatMontoBimonetario`, ya bimonetarias). Actualizados los 14 `toEqual` pre-existentes del suite de `construirFilasTotales`/paridad PDF-texto para incluir el campo — CERO cambio de comportamiento para los consumidores existentes (PDF/texto/canvas siguen leyendo solo `.label`/`.monto`/`.bold`).
- [x] 5b.2 RED→GREEN (F3): `FacturaDetallePanel` — la fila de totales ahora renderiza `fila.montoBs` como segunda línea muted (mismo patrón visual que la tabla de artículos, USD arriba/Bs abajo) cuando no es `null`. Fuente: `recibo.totales`, ya calculado por `buildReciboData` con la tasa histórica de la factura (`venta.tasa` persistida) — nunca la tasa vigente del sistema (invariante bimonetario verificado, sin fetch nuevo).
- [x] 5b.3 RED→GREEN (F7): overlay diagonal decorativo en `FacturaDetallePanel` — "REVERSADA" cuando algún `reversos[].tipo === 'TOTAL'` (reverso TOTAL es único por regla de negocio F1, su sola presencia implica factura completa reversada); "REVERSO PARCIAL" cuando hay reversos pero ninguno TOTAL; ausente cuando `reversos` está vacío. Derivado 100% del prop `reversos` ya existente (Slice 5a) — sin prop nuevo, sin query nueva.
- [x] 5b.4 GREEN (F7): overlay implementado con `aria-hidden="true"` + `pointer-events-none` (MANDATORIOS — no debe re-bloquear la interactividad que F1 habilitó sobre facturas reversadas, ni contaminar el árbol de accesibilidad). Contenedor raíz del panel pasa a `relative` para anclar el overlay `absolute inset-0`.
- [x] 5b.5 Verify: `yarn test:run` (1017/1017 verdes) + `yarn type-check:test` (limpio) + `yarn type-check` (solo ruido preexistente de vitest-globals); `crearNotaCredito` (`use-notas-credito.ts`) verificado en CERO líneas cambiadas (`git diff --stat` vacío).

**Resultado real vs. forecast**: 157 inserciones + 17 eliminaciones = 174 líneas cambiadas (`git diff --stat` sobre 4 archivos: `factura-export.ts`, `factura-export.test.ts`, `factura-detalle-panel.tsx`, `factura-detalle-panel.test.tsx`) vs. forecast ~120-190 — dentro del budget, sin exception. `crearNotaCredito` verificado en CERO líneas cambiadas. **F2, F4, F5, F6 permanecen diferidos a batch 5c.**

## Slice 5c (QA fixes F2, F4, F5, F6) — colores de badges + causa NCR en kardex + tope de 3 decimales + UX de sobre-cantidad

> Último batch de QA de este change. F2 y F4 son parches visuales
> (display-only, sin lógica de negocio nueva); F5 y F6 tocan la validación de
> cantidad en `SeleccionLineasNc` — ambos con RED-first genuino.

### Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~190–290 |
| 400-line budget risk | Low |
| Chained PRs | `feature-branch-chain` — PR sobre `feat/notas-credito-ui-pos-s5b` |
| Rollback | Revierte a: badges de estado de pago compartiendo un solo gris, causa "—" en kardex para reintegros de NC, sin tope de 3 decimales, clampeo silencioso de cantidad sobre el tope |

- [x] 5c.1 GREEN (F2): `ESTADO_PAGO_BADGE_CLASS` en `nota-credito-pos-modal.tsx` — Contado (verde), Crédito (azul), Abonada (ámbar) — antes los tres compartían `border-slate-200`/`bg-slate-50` sin distinción visual. Reverso Total (rojo) y Reverso Parcial (naranja) sin cambios. Parche visual explícito pendiente de rediseño futuro — labels en español sin cambios.
- [x] 5c.2 GREEN (F4, DISPLAY-ONLY): `tipoSalidaBadge()` en `kardex-list.tsx` — nueva rama `origen === 'NCR'` → `NOTA_CREDITO` ('Nota de crédito'). `crearNotaCredito` ya insertaba `origen:'NCR'` en `movimientos_inventario` (verificado, CERO líneas cambiadas) — el gap era puramente de presentación (la columna "Causa" caía al fallback "—" porque `tipo_salida` es `null` para reintegros de NC y el mapeo previo solo cubría `origen==='VEN'`).
- [x] 5c.3 RED→GREEN (F5): tope de 3 decimales en el input de cantidad de `SeleccionLineasNc` para líneas `esDecimal=true` — un 4to decimal se rechaza (input controlado se congela en el último valor válido), consistente con la precisión `NUMERIC` de 3 decimales de `inventario_stock`. Líneas enteras (`esDecimal=false`) sin cambio — siguen bloqueando cualquier tecla decimal (comportamiento pre-existente).
- [x] 5c.4 RED→GREEN (F6): exceder el tope disponible (`cantidadDisponible` o, en su ausencia, `cantidadFacturada` — F1) ya NO se clampea en silencio — el valor excedido se rechaza (el input no lo escribe), el input pasa a estado de error visual (borde/texto rojo, `aria-invalid`) y se muestra "No puedes devolver más de la cantidad disponible." ANTES de que el usuario pueda confirmar. 3 tests pre-existentes de Slice 5a que asumían el clampeo silencioso (`toHaveValue(3)`/`toHaveValue(2)` tras escribir un exceso) actualizados a la nueva semántica de rechazo — sin regresión de intención, la aserción original ("el tope real es el remanente, no lo facturado") se preserva intacta.
- [x] 5c.5 GREEN (F6, reword): mensaje de `derivarLineasNcParcial` reescrito de "excede lo facturado (X)" a "excede la cantidad disponible (X)" — deuda de review de Slice 5a (obs `sdd/notas-credito-ui-pos/apply-progress`): el parámetro recibido como `cantidadFacturada` es en realidad el remanente cuando el caller ya lo capó vía F1, por lo que "lo facturado" era una etiqueta engañosa para una línea ya parcialmente reversada.
- [x] 5c.6 Verify: `yarn test:run` (1024/1024 verdes, +7 netos sobre 1017) + `yarn type-check:test` (limpio) + `yarn type-check` (solo ruido preexistente de vitest-globals); `crearNotaCredito` (`use-notas-credito.ts`) verificado en CERO líneas cambiadas (`git diff --stat` vacío).

**Resultado real vs. forecast**: 248 inserciones + 18 eliminaciones = 266 líneas cambiadas (`git diff --stat` sobre 8 archivos: `kardex-list.tsx`+test, `nota-credito-pos-modal.tsx`+test, `seleccion-lineas-nc.tsx`+test, `notas-credito-ui.ts`+test) vs. forecast ~190-290 — dentro del budget, sin exception. `crearNotaCredito` verificado en CERO líneas cambiadas. **Los 7 fixes de QA (F1–F7) quedan completos — pendiente re-verify combinado de todo el change (slices 1-5c) antes del merge final del chain a `develop`.**

## Slice 5d (ocultar sección CxC no confiable — pendiente change CxC) — QA manual 2.5/2.6

> Fix DISPLAY-ONLY, no toca `crearVenta`/`crearNotaCredito`. Root cause
> (obs #2896): cuando el excedente de un pago POS se abona por FIFO a OTRA
> factura del cliente (flujo SAF), `crearVenta` reparte el pago tendido
> entre dos `venta_id` distintos sin back-reference persistido hacia la
> venta origen — `usePagosFactura` trae el monto CAPEADO (no el tendido
> real) y `useAfectacionCxc` da 0 aunque sí hubo afectación CxC en la
> factura destino. Fix real requiere persistir ese back-reference en
> `crearVenta`/`aplicarPagoFacturaEnTx` (flujo financiero, DEFERRED a un
> change de CxC futuro, obs #2897). Para cerrar este change, se OCULTA la
> sección en vez de mostrar datos incorrectos.

### Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~40–80 |
| 400-line budget risk | Low |
| Chained PRs | `feature-branch-chain` — PR sobre `feat/notas-credito-ui-pos-s5c` |
| Rollback | Revierte a: panel mostrando desglose de métodos de pago (monto capeado, incorrecto en caso SAF-cruzado) y sección "afectó/no afectó cuentas por cobrar" (falso negativo en el mismo caso) |

- [x] 5d.1 `FacturaDetallePanel` (`factura-detalle-panel.tsx`): se ELIMINA el renderizado de la sección "afectación a cuentas por cobrar" (prop `afectoCxc` removida de `FacturaDetallePanelProps` — dead prop wiring limpiado del único caller, `nota-credito-pos-modal.tsx`) y del desglose de métodos de pago/abonos (`Metodos de pago` + `Total abonos`). Se mantiene intacto: desglose fiscal (subtotal/exento/base/IVA/IGTF/total con Bs de tasa histórica, F3), historial de reversos (F1) y overlay diagonal REVERSADA/REVERSO PARCIAL (F7). Comentario en español referenciando obs #2896/#2897 dejado en el JSX en el punto exacto donde antes vivían ambas secciones.
- [x] 5d.2 `nota-credito-pos-modal.tsx`: removida la llamada a `useAfectacionCxc` y el cómputo `afectoCxc = huboAfectacionCxc(...)` (dead wiring tras 5d.1) — `useAfectacionCxc` (hook, `use-cxc.ts`) y `huboAfectacionCxc` (util, `notas-credito-ui.ts`) se DEJAN definidos e intactos (siguen cubiertos por sus propios tests unitarios en `use-cxc.test.ts`/`notas-credito-ui.test.ts`); solo se retira su uso en este caller. `usePagosFactura`/`pagosFactura` se conservan sin cambios (siguen alimentando `ReciboData.pagos`, campo del tipo compartido usado también por el recibo oficial de venta).
- [x] 5d.3 Tests actualizados: `factura-detalle-panel.test.tsx` — removida la prop `afectoCxc` de todos los `render()`, eliminados los 2 tests que afirmaban el texto "afectó/no afectó CxC" y el test que afirmaba el desglose de pagos visible; agregado nuevo `describe` "Slice 5d" con 3 tests que confirman AUSENCIA de ambas secciones y que el resto del panel (líneas, totales fiscales) sigue visible. `nota-credito-pos-modal.test.tsx` — removidos el mock/import/const de `useAfectacionCxc` y sus 2 tests `afectoCxc=true/false`, reemplazados por 1 test que confirma que el texto de afectación CxC NUNCA aparece en el modal integrado.
- [x] 5d.4 Verify: `yarn test:run` (1023/1023 verdes) + `yarn type-check:test` (limpio) + `yarn type-check` (solo ruido preexistente de vitest-globals, sin errores nuevos en los 4 archivos tocados).

**Resultado real vs. forecast**: 52+19+53+9 = 133 líneas cambiadas (`git diff --stat` sobre 4 archivos: `factura-detalle-panel.tsx`+test, `nota-credito-pos-modal.tsx`+test) vs. forecast ~40-80 (algo por encima por el volumen de tests actualizados, sin exception — bien dentro del budget de 400). `crearVenta`/`crearNotaCredito` verificados en CERO líneas cambiadas (`git diff --stat` vacío). Display-only confirmado.

## Slice 5e (QA: badge acumulado, PIN efímero, depósito obligatorio) — CIERRA la fase de QA de este change

> Última tanda de QA manual (3 fixes) tras 5a-5d. Todos display/state-only —
> CERO cambio de lógica de datos. `crearNotaCredito`/`crearVenta`/
> `SupervisorPinDialog` FROZEN. 6.2 (PIN fallback Supabase) queda diferido a
> un change futuro dedicado a `SupervisorPinDialog` (obs
> `sdd/notas-credito-ui-pos/bug-pin-emision-6.2`).

### Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~200 (asignado por el orquestador) |
| 400-line budget risk | Alto (real, ver resultado) |
| Chained PRs | `feature-branch-chain` — PR sobre `feat/notas-credito-ui-pos-s5d` |
| Rollback | Revierte a: badge de reverso derivado de `nc.tipo` (no acumulado), autorización de PIN B persistente entre facturas, submit de NC permitido con depósito vacío (caía en silencio al riel automático) |

- [x] 5e.1 (QA fix 3.5) RED→GREEN: `calcularBadgesReversoPorVenta(lineasFacturas, notasCreditoDet)` (`notas-credito-ui.ts`) — reusa `calcularReversoPorLinea` (F1) línea por línea: "TOTAL" exige que TODAS las líneas de la factura tengan reversado >= facturado (acumulado, cualquier combinación de NCs PARCIALes); "PARCIAL" cuando alguna línea tiene reversado > 0 sin llegar todas al 100%; `null` sin ningún reverso. NUNCA lee `notas_credito.tipo` para esta decisión — reemplaza la lectura directa de `tiene_reverso_total`/`tiene_reverso_parcial` SOLO para el badge visual (esos flags siguen intocados y vigentes para el gating de ACCIÓN en `puedeEmitirNcAdicional`/`puedeElegirTipoTotal`).
- [x] 5e.2 (QA fix 3.5) RED→GREEN: nuevo hook `useBadgesReversoSesion(empresaId, sesionId)` (`use-facturas-sesion-activa.ts`) — dos queries planas escopeadas a `empresa_id` + `sesion_caja_id` (líneas de `ventas_det` + `notas_credito_det` de las NCs ya aplicadas), delega el cómputo 100% a `calcularBadgesReversoPorVenta` vía `useMemo`. `nota-credito-pos-modal.tsx` consume el hook y pasa `badgesPorVenta[f.id] ?? null` a `FacturaBadges`, que ahora renderiza el badge de reverso desde ese valor en vez de `f.tiene_reverso_total`/`tiene_reverso_parcial`.
- [x] 5e.3 (UX B) RED→GREEN: autorización de PIN EFÍMERA — nueva función `resetAutorizacionesPin()` (`nota-credito-pos-modal.tsx`) que limpia `showPin`/`showPinDeposito`/`pinDepositoAutorizado`/`depositoElegidoId`/`accionPendiente`/`lineasParcialPendientes`. Se invoca en: cierre del modal (ya existía, refactorizado a la función compartida), botón "Volver" (deseleccionar factura) y al hacer clic en CUALQUIER fila de factura del listado (seleccionar, incluso re-seleccionar). `SupervisorPinDialog` NO se toca — reingresar el mismo PIN para una acción nueva sigue siendo aceptable (obs #2902).
- [x] 5e.4 (UX C) RED→GREEN: `depositoInvalido = pinDepositoAutorizado && !depositoElegidoId` (`nota-credito-pos-modal.tsx`) — bloquea "Confirmar Anulación" (TOTAL, `disabled` + guard en `handleConfirmarClick`) y "Confirmar Nota de Crédito Parcial" (PARCIAL, nueva prop `depositoInvalido` en `SeleccionLineasNc` sumada a `puedeConfirmar` + guard en `handleConfirmarParcialClick`) mientras el selector de depósito esté desbloqueado (PIN B autorizado) y sin depósito elegido. Mensaje "Debes seleccionar el deposito de reingreso." visible en ambos flujos. Sin autorizar PIN B (riel automático, caso por defecto) nunca bloquea. Reemplaza el comportamiento previo (test actualizado) donde confirmar sin depósito elegido caía en silencio al riel automático.
- [x] 5e.5 Verify: `yarn test:run` (1041/1041 verdes, +18 netos sobre 1023) + `yarn type-check:test` (limpio) + `yarn type-check` (solo ruido preexistente de vitest-globals que afecta a TODA la suite bajo el tsconfig de la app, cero categorías nuevas de error fuera de ese ruido documentado); `crearNotaCredito`/`crearVenta`/`SupervisorPinDialog` verificados en CERO líneas cambiadas (`git diff --stat` vacío sobre `use-notas-credito.ts` y `supervisor-pin-dialog.tsx`).

**Resultado real vs. forecast**: 444 inserciones + 24 eliminaciones = 468 líneas cambiadas (`git diff --stat` sobre 7 archivos: `notas-credito-ui.ts`+test, `use-facturas-sesion-activa.ts`+test, `nota-credito-pos-modal.tsx`+test, `seleccion-lineas-nc.tsx`) vs. forecast ~200 asignado — excede el budget de 400, mismo patrón de subestimación de TDD estricto que slices anteriores de este change (1, 3a, 3b, 5a). Desglose aproximado no-test: `notas-credito-ui.ts` (+55), `use-facturas-sesion-activa.ts` (+51), `nota-credito-pos-modal.tsx` (+81/-), `seleccion-lineas-nc.tsx` (+21/-) = ~208 líneas de lógica/wiring; el resto (~260) es cobertura de test RED-first (incluyendo actualización de 3 tests pre-existentes cuya premisa quedó superada por los propios fixes: 2 asserts de badge por-flag ajustados a mockear el nuevo hook, 1 test de "PIN B sin depósito cae al riel automático" reescrito porque ESO es exactamente lo que UX C prohíbe ahora). Sin scope creep — las 3 fixes son exactamente las pedidas, ninguna lógica de `crearNotaCredito`/`crearVenta` tocada. **CIERRA la fase de QA de `notas-credito-ui-pos`** — pendiente re-verify combinado final de todo el change (slices 1-5e) antes del merge del chain completo a `develop`. El bug 6.2 (PIN fallback Supabase) queda diferido a un change futuro dedicado a `SupervisorPinDialog` (obs #2902) — fuera del alcance de este change.

## Slice 5f (consistencia badge/gating reverso acumulado) — fix del re-verify combinado final

> Nota 5e.1 quedó desactualizada por este slice: el comentario decía que
> `tiene_reverso_total`/`tiene_reverso_parcial` "siguen intocados y vigentes
> para el gating de ACCIÓN" — el re-verify combinado (obs
> `sdd/notas-credito-ui-pos/verify-combined-final-v2`) encontró que ESO
> exactamente causaba un MISMATCH: el badge (5e, acumulado) podía decir
> "Reverso Total" mientras el gating de acción (F1, flags crudos) seguía
> ofreciendo el formulario interactivo. Sin riesgo de datos (el tope
> por-línea del backend sigue vigente), pero inconsistencia real de UX que
> bloqueaba el merge.

- [x] 5f.1 RED→GREEN: `calcularEstadoReversoLineas(lineas, notasCreditoDet)` (`notas-credito-ui.ts`) — NÚCLEO COMPARTIDO de acumulación por-línea extraído del loop que antes vivía inline en `calcularBadgesReversoPorVenta`. Única fuente de verdad para `{ algunaConReverso, todasCompletas }`, reusa `calcularReversoPorLinea` (F1). `calcularBadgesReversoPorVenta` refactorizado para llamarlo (sin cambio de comportamiento, tests intactos).
- [x] 5f.2 RED→GREEN: `puedeEmitirNcAdicional`/`puedeElegirTipoTotal` (`notas-credito-ui.ts`) cambian de firma — de flags crudos (`FacturaReversoFlags`, tipo eliminado) a `(lineas: LineaConCantidadFacturada[], notasCreditoDet)`, derivando de `calcularEstadoReversoLineas` (MISMA fuente que el badge). Sin líneas cargadas todavía: permisivo por defecto (no bloquea antes de tener información real). Nuevo test dedicado: 2 NCs PARCIALes que juntas suman el 100% de cada línea → `puedeEmitirNcAdicional` bloquea igual que una NC TOTAL única, consistente con `calcularBadgesReversoPorVenta`.
- [x] 5f.3 `nota-credito-pos-modal.tsx`: gating rewired a `lineasFacturaParaReverso` (derivado de `detalle`, ya cargado por `useDetalleFactura`) + `reversos` (ya cargado por `useReversosFactura` para el historial/tope por-línea) — CERO query nueva. El guess inicial del tab TOTAL/PARCIAL al hacer click en una fila (`setTipoNc` en el listener de selección) se mantiene sobre los flags crudos YA disponibles sin gap async en el listado (`useFacturasSesionActiva`), documentado como heurística de default — el gating REAL (qué botones se muestran, si el formulario se ofrece) es 100% `puedeEmitirNc`/`puedeTotal` (acumulado).
- [x] 5f.4 Tests actualizados: `notas-credito-ui.test.ts` — los 2 `describe` de gating reescritos a la nueva firma (arrays de líneas + `notasCreditoDet`) con el caso 5f explícito. `nota-credito-pos-modal.test.tsx` — 2 tests pre-existentes (`tiene_reverso_total=1`, `tiene_reverso_parcial=1`) actualizados con mocks de `useDetalleFactura`/`useReversosFactura` reflejando el estado acumulado real (antes dependían solo del flag crudo, ahora inerte para el gating); 1 test nuevo reproduce el mismatch exacto del re-verify (badge dice "Reverso Total" via 2 NCs PARCIALes, gating debe bloquear).
- [x] 5f.5 Verify: `yarn test:run` (1044/1044 verdes, +3 netos sobre 1041) + `yarn type-check:test` (limpio) + `yarn type-check` (solo ruido preexistente de vitest-globals, sin categorías nuevas). `crearNotaCredito`/`crearVenta`/`SupervisorPinDialog` verificados en CERO líneas cambiadas.

**Resultado real vs. forecast**: 228 inserciones + 47 eliminaciones = ~181 líneas netas cambiadas (`git diff --stat` sobre 4 archivos: `notas-credito-ui.ts`+test, `nota-credito-pos-modal.tsx`+test) — dentro del budget de 400, sin `size:exception`. Sin scope creep: el tope por-línea (over-reversal guard) NUNCA se tocó, solo la fuente de la que lee el gating de acción. **Cierra el hallazgo del re-verify combinado final** — el change queda listo para el merge completo del chain (s1→s5f) a `develop` vía tracker.

## Slice 5g (BUG 3 / QA C — gap async en el callback `onAuthorized` de PIN A) — fix quirúrgico post-merge

> El chain s1→s5f quedó "listo para merge" (obs #2875), pero una revisión QA
> posterior encontró que el guard de UX C (`depositoInvalido`, Slice 5e) NO
> cubría los TRES caminos de emisión — solo `handleConfirmarClick` y
> `handleConfirmarParcialClick` (ambos síncronos) revalidaban
> `depositoInvalido`. El callback `onAuthorized` del diálogo de PIN A
> (`nota-credito-pos-modal.tsx`, único camino async: el usuario puede
> autorizar el PIN B — deposito — SIN elegir depósito mientras el PIN A
> sigue pendiente de autorización) llamaba `emitirNc(...)` directo, sin
> revisar `depositoInvalido` — permitiendo que la NC se emitiera igual y
> cayera en silencio al riel automático del backend, exactamente lo que UX C
> prohíbe.

- [x] 5g.1 (BUG 3 / QA C) RED→GREEN: nuevo test `nota-credito-pos-modal.test.tsx` (describe Slice 5a-2b) reproduce el gap — sin permiso de emisión, abre PIN A (síncrono, con el riel automático como default), autoriza PIN B SIN elegir depósito mientras PIN A sigue pendiente, y autoriza PIN A. Antes del fix: `crearNotaCredito` SI se llamaba (`depositoReingresoId: undefined`). Fix: guard `if (depositoInvalido) return` agregado al inicio de la rama `else` del `onAuthorized` de PIN A (`nota-credito-pos-modal.tsx`), mismo estilo/comentario que los guards ya existentes en `handleConfirmarClick`/`handleConfirmarParcialClick`. `handleConfirmarClick`, `handleConfirmarParcialClick`, `SupervisorPinDialog` y `crearNotaCredito`/`crearVenta` NUNCA tocados.
- [x] 5g.2 Verify: `yarn test:run` (1045/1045 verdes, +1 neto sobre 1044) + `yarn type-check:test` (limpio). `crearNotaCredito`/`crearVenta`/`SupervisorPinDialog` verificados en CERO líneas cambiadas.

**Resultado real vs. forecast**: 42 líneas cambiadas (`git diff --stat` sobre 2 archivos: `nota-credito-pos-modal.tsx` +6, `nota-credito-pos-modal.test.tsx` +37/-1) — fix quirúrgico de una sola línea de guard + su test dedicado, muy por debajo del budget de 400. Sin scope creep: cambio aislado al único camino de emisión que faltaba el guard.

### 5g.3 (BUG D — el badge de método de pago no se limpia en reverso total)

> `FacturaBadges` (`nota-credito-pos-modal.tsx`) renderizaba el badge de
> estado de pago (Contado/Crédito/Abonada) de forma INCONDICIONAL, sin
> importar `badgeReverso`. Una factura reversada al 100% (`badgeReverso ===
> 'TOTAL'`, ya sea vía una sola NC TOTAL o acumulando PARCIALes hasta el
> 100% — mismo criterio que `calcularBadgesReversoPorVenta`) combinaba a la
> vez "Contado"/"Crédito"/"Abonada" Y "Reverso Total", cuando el negocio
> exige que el reverso total DEJE SIN EFECTO cualquier badge previo (método
> de pago o "Reverso Parcial") y muestre ÚNICAMENTE "Reverso Total".

- [x] 5g.3.1 RED→GREEN: nueva función pura `resolverBadgesFactura(estadoPago, badgeReverso)` en `notas-credito-ui.ts` — dado el estado de pago derivado y el badge de reverso acumulado, decide qué badges renderizar: `badgeReverso === 'TOTAL'` → `{ estadoPago: null, reverso: 'TOTAL' }` (pago suprimido, nunca combina con "Reverso Parcial"); cualquier otro caso → `{ estadoPago, reverso: badgeReverso }` (pago se mantiene, comportamiento sin cambios). 3 tests nuevos en `notas-credito-ui.test.ts` (describe `resolverBadgesFactura`) cubren TOTAL/PARCIAL/null — RED confirmado (función no existía) antes de implementar.
- [x] 5g.3.2 REFACTOR: `FacturaBadges` reescrito como renderer delgado que consume `resolverBadgesFactura(derivarEstadoPago(f), badgeReverso)` — el badge de pago ahora es condicional (`{badges.estadoPago && <Badge>...}`) en vez de incondicional. Estilos/clases (`ESTADO_PAGO_BADGE_CLASS`, colores rojo/naranja de reverso) sin cambios. 3 tests pre-existentes de `nota-credito-pos-modal.test.tsx` (los dos escenarios `badgeReverso: 'TOTAL'` vía NC única y vía acumulación de PARCIALes, más el de `tiene_reverso_total=1`) reciben una aserción adicional `expect(screen.queryByText('Contado')).not.toBeInTheDocument()` — reproducen exactamente el bug (factura CONTADO + reverso TOTAL combinados) y confirman que ahora el badge de pago queda suprimido.
- [x] 5g.3.3 Verify: `yarn test:run` (1048/1048 verdes, +3 netos sobre 1045) + `yarn type-check:test` (limpio). `crearNotaCredito`/`crearVenta`/`SupervisorPinDialog` NUNCA tocados — cambio 100% acotado a `notas-credito-ui.ts` (función pura nueva) y al renderer de `FacturaBadges`.

**Resultado real vs. forecast (5g.3)**: `notas-credito-ui.ts` +29 líneas (función pura + tipo `BadgesFacturaVisibles`), `notas-credito-ui.test.ts` +14 líneas (describe nuevo, 3 tests), `nota-credito-pos-modal.tsx` ~+8/-6 líneas (rewire de `FacturaBadges`), `nota-credito-pos-modal.test.tsx` +9 líneas (3 aserciones nuevas en tests existentes) — muy por debajo del budget de 400. Ships junto con el batch 5g en la misma rama `feat/notas-credito-ui-pos-s5g`.

### 5g.4 (BUG E — el watermark del panel de detalle queda atascado en "REVERSO PARCIAL" en facturas 100% reversadas)

> `FacturaDetallePanel` (`factura-detalle-panel.tsx`) calculaba el estado
> del watermark diagonal LOCALMENTE a partir del tipo crudo de cada NC en
> `reversos`: `reversos.some(r => r.tipo === 'TOTAL') ? 'TOTAL' : 'PARCIAL'`.
> Cuando una factura llega al 100% de reverso por ACUMULACIÓN de varias NCs
> PARCIALes (ninguna individualmente 'TOTAL'), el watermark quedaba
> atascado en "REVERSO PARCIAL" en vez de "REVERSADA" — mismatch con el
> badge de la lista y el mensaje "reversada totalmente", que YA leen
> correctamente el estado acumulado (`badgesPorVenta`, de
> `useBadgesReversoSesion`/`calcularBadgesReversoPorVenta`) para ambos
> caminos (NC única TOTAL o PARCIALes acumuladas).

- [x] 5g.4.1 RED→GREEN: nuevo test en `factura-detalle-panel.test.tsx` (describe F7 QA fix) — renderiza el panel con `reversos` = dos registros PARCIAL y la nueva prop `badgeReverso="TOTAL"`, y confirma que el overlay muestra "REVERSADA" y NO "REVERSO PARCIAL". RED confirmado (la prop no existía; el overlay leía `reversos` crudo y mostraba "REVERSO PARCIAL"). Fix: nueva prop `badgeReverso?: BadgeReverso` (tipo importado de `notas-credito-ui.ts`) en `FacturaDetallePanelProps`; el overlay ahora lee `estadoReverso = badgeReverso` directamente, en vez de derivarlo de `reversos.some(...)`. La sección "Notas de crédito aplicadas" (historial) sigue leyendo `reversos` sin cambios. Call site (`nota-credito-pos-modal.tsx`) actualizado para pasar `badgeReverso={badgesPorVenta[facturaId ?? ''] ?? null}` (misma fuente que `FacturaBadges`, ya usada por el badge de la lista). Los 2 tests pre-existentes de NC única TOTAL/PARCIAL actualizados mínimamente para pasar el `badgeReverso` correspondiente, manteniendo sus aserciones intactas. `crearNotaCredito`, `crearVenta`, `SupervisorPinDialog` NUNCA tocados.
- [x] 5g.4.2 Verify: `yarn test:run` (1049/1049 verdes, +1 neto sobre 1048) + `yarn type-check:test` (limpio). `crearNotaCredito`/`crearVenta`/`SupervisorPinDialog` verificados en CERO líneas cambiadas.

**Resultado real vs. forecast (5g.4)**: `factura-detalle-panel.tsx` +16/-7 líneas (prop nueva + doc + rewire del overlay), `factura-detalle-panel.test.tsx` +23 líneas (1 test nuevo + 2 líneas de prop en tests existentes), `nota-credito-pos-modal.tsx` +5/-1 líneas (call site) — muy por debajo del budget de 400. Ships junto con el batch 5g en la misma rama `feat/notas-credito-ui-pos-s5g`.

### 5g.5 (CAMBIO DE COMPORTAMIENTO, no bugfix — el modal permanece abierto y se refresca en el lugar tras una emisión exitosa)

> Comportamiento anterior: `emitirNc` (`nota-credito-pos-modal.tsx`) llamaba
> `onClose()` tras el `toast.success(...)` de una emisión exitosa —
> `onClose()` era el ÚNICO mecanismo que limpiaba el estado transitorio
> post-emisión (vía el efecto de `isOpen`: reseteaba `facturaId`,
> `searchQuery`, `modalidad`, `motivo`, `tipoNc` y las autorizaciones de
> PIN). Nuevo comportamiento deseado: tras una emisión EXITOSA, el modal
> permanece ABIERTO sobre la MISMA factura para que el usuario vea el
> resultado y pueda seguir operando — el listado, los badges, el panel de
> detalle y el historial de reversos son TODOS live-queries de PowerSync
> (`useQuery`) que se refrescan solos cuando la transacción de
> `crearNotaCredito` hace commit, SIN invalidación manual ni re-selección
> manual de la factura (`facturas.find(...)` ya re-deriva de la lista viva).

- [x] 5g.5.1 RED→GREEN: 3 tests nuevos en `nota-credito-pos-modal.test.tsx` (describe Slice 5g.5) — (A) tras emisión TOTAL exitosa, `onClose` (mock real, no el no-op inline usado en el resto del archivo) NUNCA se llama y la factura sigue visible/seleccionada; (B) tras emisión PARCIAL exitosa, simulando el refresco de la live-query (`useReversosFactura` devolviendo el nuevo remanente en el siguiente render vía `rerender`), el input de cantidad de `SeleccionLineasNc` vuelve a estar vacío (prueba el remount, no un simple `setCantidad(0)`); (C) tras emisión exitosa, la autorización del PIN de depósito (PIN B) se limpia — el selector vuelve a "Automático" para la siguiente acción sobre la misma factura. Los 3 confirmados en RED (fallan hoy: `onClose()` SI se llama, no hay reset explícito de `pinDepositoAutorizado`/`depositoElegidoId`, `SeleccionLineasNc` no se remonta).
- [x] 5g.5.2 GREEN — fix: (1) se removió el `onClose()` de la rama de éxito de `emitirNc`; (2) se agregó reset explícito en su lugar: `resetAutorizacionesPin()`, `setMotivo('')`, `setModalidad('EFECTIVO_REAL')` — `facturaId`/`searchQuery`/`tipoNc` se preservan DELIBERADAMENTE (mantener la factura seleccionada y el tab TOTAL/PARCIAL activo permite seguir operando la misma factura, p. ej. varias NC PARCIALes consecutivas sobre líneas distintas); (3) nuevo estado `emisionGen` (contador) incrementado en cada emisión exitosa, usado como parte del `key` de `<SeleccionLineasNc key={`${facturaId}-${emisionGen}`}>` — como el modal ya no se cierra, `SeleccionLineasNc` NUNCA se desmonta entre una emisión PARCIAL y la siguiente, y su estado interno (`cantidades`/`excedidas`, uncontrolled) sobreviviría permitiendo re-enviar por accidente la MISMA cantidad ya acreditada (double-submit); el cambio de `key` fuerza un remount limpio. `crearNotaCredito`, `crearVenta`, `SupervisorPinDialog` NUNCA tocados — solo se agregaron/quitaron llamadas a setters de estado local ya existentes en el componente.
- [x] 5g.5.3 Verify: `yarn test:run` (1052/1052 verdes, +3 netos sobre 1049, 0 tests pre-existentes requirieron actualización — ninguno usaba un mock real de `onClose`) + `yarn type-check:test` (limpio). `crearNotaCredito`/`crearVenta`/`SupervisorPinDialog` verificados en CERO líneas cambiadas.

**Resultado real vs. forecast (5g.5)**: `nota-credito-pos-modal.tsx` +26/-1 líneas (estado `emisionGen`, reset explícito post-éxito, `key` en `SeleccionLineasNc`), `nota-credito-pos-modal.test.tsx` +73 líneas (1 describe nuevo, 3 tests) — muy por debajo del budget de 400. Ships junto con el batch 5g en la misma rama `feat/notas-credito-ui-pos-s5g`. Riesgo residual: `SeleccionLineasNc` sigue siendo un componente NO controlado por el padre para sus cantidades (`useState` interno) — el remount por `key` es la defensa elegida (mínima, sin refactor a estado controlado) contra el double-submit; si en el futuro se agregan más piezas de estado interno no controlado a ese componente, deberán quedar cubiertas por el mismo remount o requerirán su propio reset explícito.
