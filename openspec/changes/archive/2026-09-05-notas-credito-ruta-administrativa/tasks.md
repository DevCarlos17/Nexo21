# Tasks: notas-credito-ruta-administrativa

Test runner (sdd-init cache, strict_tdd: true): `yarn test:run` (Vitest,
single-run), `yarn type-check` (app), `yarn type-check:test`
(`tsconfig.test.json`). `yarn` — nunca `npm`. Toda función pura es
RED→GREEN antes de tocar el componente/hook que la consume — precedente:
`notas-credito-ui.ts`, `notas-credito-fiscal.ts` (change `notas-credito-ui-pos`,
merged).

## Aggregate Review Workload Forecast (top-level)

| Field | Value |
|---|---|
| Total estimated changed lines (4 PRs) | ~1350–1650 |
| Per-slice estimate | A: ~250–320 · B: ~270–340 · C: ~450–550 · D: ~350–450 |
| Slices exceeding 400 lines alone | C y D — monitorear, no agregar scope; C es candidato a sub-split (C1 shell+sidebar, C2 tab Facturas, C3 tab NC+cleanup) si al aplicar excede significativamente, mismo patrón que Slice 3→3a/3b del change `notas-credito-ui-pos` |
| Chained PRs recommended | **Yes** |
| Recommended PR sequencing | A → B → C → D (dependencia estricta: C consume A+B; D consume A vía tipos compartidos y cierra el flujo con C) |
| Delivery strategy | ask-on-risk |
| Chain strategy | **feature-branch-chain** (cacheado en sesión) — tracker `feat/notas-credito-admin` (draft, sin merge); A → `feat/notas-credito-admin-s1` (base=tracker); B → `-s2` (base=s1); C → `-s3` (base=s2); D → `-s4` (base=s3) |

```text
Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High
```

**Nota de troceo**: A y B son standalone/bajo riesgo (funciones puras + un
hook nuevo, nadie los consume aún fuera de sus tests). C es la cirugía de UI
(sidebar + 2 tabs nuevos) — mayor riesgo de tamaño. D reescribe
`crear-ncr-modal.tsx` reusando la capa pura de `notas-credito-ui-pos`
(`FacturaDetallePanel`, `SeleccionLineasNc`) — **NO toca**
`nota-credito-pos-modal.tsx` ni `crearNotaCredito` (Design Decision 2,
FROZEN).

## Slice A — Filtros puros + rango de mes actual (Design §Decisión 3/4)

### Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~250–320 |
| 400-line budget risk | Low |
| Chained PRs | No — single PR, sin dependencias nuevas |
| Rollback | Revertible solo — nada lo consume todavía |

Capa: función pura, sin DB, sin UI.

- [x] A.1 RED: nuevo `src/features/ventas/utils/__tests__/notas-credito-admin-filters.test.ts` — `rangoMesActual()` retorna `{ fechaDesde: startOfMonth(), fechaHasta: todayStr() }` (fijar reloj con `vi.setSystemTime`). **RED confirmado**: `yarn test:run` sobre el archivo nuevo falló con `Failed to resolve import "../notas-credito-admin-filters"` (módulo aún no existía).
- [x] A.2 GREEN: crear `src/features/ventas/utils/notas-credito-admin-filters.ts` — `rangoMesActual()` compone `startOfMonth()`/`todayStr()` de `@/lib/dates` (reuso, sin fórmula paralela). **GREEN confirmado**: 21/21 tests del archivo pasan.
- [x] A.3 RED (mismo archivo): `buildFacturasEmpresaFiltro(f: FiltroFacturasEmpresa)` — sin filtros opcionales (solo `empresa_id`+rango fecha); cada filtro opcional (`nroFactura`/`clienteNombre`/`clienteIdentificacion`) aislado; combinados; strings vacíos/whitespace ignorados; `params` SIEMPRE parametrizados (nunca interpolación de string). [Design §Decisión 3] Escrito en el mismo ciclo RED que A.1 (mismo archivo, mismo comando falló por el mismo import faltante).
- [x] A.4 GREEN: implementar `buildFacturasEmpresaFiltro` — SQL exacto de Design §Decisión 3, mismo shape que `FacturaParaAnular` (incluye `status`, `tiene_reverso_total`/`tiene_reverso_parcial` vía `EXISTS`, `total_igtf_usd` — mismo patrón que `use-facturas-sesion-activa.ts`, sin filtro de sesión). Rango de fecha implementado con el patrón `datetime(col) >= datetime(? || 'T00:00:00' || VE_OFFSET)` de `kardex-sql.ts` (comparación robusta al offset guardado, no string directo).
- [x] A.5 RED: `buildNotasCreditoFiltro(f)` — mismos casos que A.3 + filtro `tipo` (`'TOTAL' | 'PARCIAL'` | omitido). [Design §Decisión 4] Mismo ciclo RED que A.1/A.3.
- [x] A.6 GREEN: implementar `buildNotasCreditoFiltro`. Preserva el JOIN/columnas exactas del `useNotasCredito()` sin filtros actual (comportamiento byte-a-byte para Slice B).
- [x] A.7 Verify: `yarn test:run` + `yarn type-check:test` verdes. Confirmado cero I/O en el archivo (funciones puras, sin `useQuery`/`db`).

**Resultado real vs forecast**: forecast ~250–320 líneas cambiadas, riesgo Low. Real: 1 archivo nuevo (`notas-credito-admin-filters.ts`, 148 líneas) + 1 archivo de test nuevo (`notas-credito-admin-filters.test.ts`, 21 tests, 205 líneas) = ~353 líneas totales (test incluido) / ~148 líneas de código de producción — dentro del rango esperado considerando que el forecast agrega tests+código. Sin desviaciones del Design. `yarn test:run` completo: 89 archivos / 1073 tests pasando (suite completa, no solo el archivo nuevo). `yarn type-check:test` limpio. Diff de los 4 archivos FROZEN (`use-notas-credito.ts`, `nota-credito-pos-modal.tsx`, `supervisor-pin-dialog.tsx`, `use-ventas.ts`) confirmado vacío (`git diff --stat` sin salida).

## Slice B — Hook empresa-wide + extensión de filtros en NC list (Design §Decisión 3/4)

### Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~270–340 |
| 400-line budget risk | Low–Medium |
| Chained PRs | Yes — depende de Slice A |
| Rollback | `useFacturasEmpresa` sin consumidores aún; `useNotasCredito` sigue 100% compatible sin filtros — revertible sin romper `notas-credito-page.tsx` actual |

Capa: hook (`useQuery` PowerSync). `useBuscarFacturaParaAnular` **NO** se
toca en este slice (sigue siendo el único consumidor de la vista actual
hasta que Slice C reemplace la página — Design §Decisión 7).

- [x] B.1 RED: nuevo `src/features/ventas/hooks/__tests__/use-facturas-empresa.test.ts` — retorna facturas de OTRAS sesiones/días dentro del rango (fixture 2+ sesiones distintas, a diferencia de `useFacturasSesionActiva`); sin `filtros`, usa `rangoMesActual()` por defecto; el SQL ejecutado siempre incluye `empresa_id = ?`. **RED confirmado**: `yarn test:run` sobre el archivo nuevo falló con `Failed to resolve import "../use-facturas-empresa"` (módulo aún no existía).
- [x] B.2 GREEN: crear `src/features/ventas/hooks/use-facturas-empresa.ts` — `useFacturasEmpresa(filtros?)`, hermano de `use-facturas-sesion-activa.ts`, delega SQL a `buildFacturasEmpresaFiltro` (Slice A), `empresaId` vía `useCurrentUser()`, default fecha = `rangoMesActual()` cuando se omite. **GREEN confirmado**: 7/7 tests del archivo pasan.
- [x] B.3 RED: extender `src/features/ventas/hooks/__tests__/use-notas-credito.test.ts` — `useNotasCredito()` (sin args) preserva el comportamiento actual byte-a-byte (smoke, consumidores no migrados); `useNotasCredito(filtros)` con fecha/`nroNcr`/`tipo`/cliente/RIF filtra correctamente; filtros combinables. [Design Testing Strategy] **RED confirmado**: 5/6 tests nuevos fallaron (params/sql sin el rango de fecha ni los filtros nuevos aplicados); el smoke test "sin args" ya pasaba (preserva comportamiento no migrado, correcto no-RED para ese caso puntual).
- [x] B.4 GREEN: extender `useNotasCredito(filtros?)` en `use-notas-credito.ts` — delega a `buildNotasCreditoFiltro` cuando `filtros` está presente; sin `filtros`, cae al query actual sin cambios. **GREEN confirmado**: 45/45 tests del archivo pasan (40 preexistentes + 5 nuevos, ninguno de los preexistentes se rompió).
- [x] B.5 Verify: `yarn test:run` + `yarn type-check` + `yarn type-check:test` verdes; `git diff --stat` sobre `crearNotaCredito` (mismo archivo) confirma CERO líneas cambiadas. **Verificado**: suite completa 90 archivos/1087 tests verdes; `yarn type-check:test` limpio; `yarn type-check` (app) solo reporta errores preexistentes no relacionados (archivos `src/lib/__tests__/*` y `traspasos.test.tsx` sin globals de test en el tsconfig de app — no tocados por este slice); `git diff` de `use-notas-credito.ts` confinado a `useNotasCredito` (grep de `crearNotaCredito` sobre el diff: 0 matches) — `crearNotaCredito` byte-idéntica.

**Resultado real vs forecast**: forecast ~270–340 líneas, riesgo Low–Medium. Real: 1 archivo nuevo (`use-facturas-empresa.ts`, 46 líneas) + 1 archivo de test nuevo (`use-facturas-empresa.test.ts`, 7 tests, 119 líneas) + extensión de `use-notas-credito.ts` (+51/-4 líneas) + extensión de su test (+79 líneas) ≈ 295 líneas — dentro del rango esperado. Sin desviaciones del Design (Decision 3/4 aplicadas tal cual). `useBuscarFacturaParaAnular` NO se tocó (confirmado, sigue siendo el único consumidor de `notas-credito-page.tsx` hasta Slice C). Diff FROZEN confirmado vacío para `nota-credito-pos-modal.tsx`, `supervisor-pin-dialog.tsx`, `use-ventas.ts` (`git diff --stat` sin salida).

## Slice C — Sidebar + 2 tabs + filtros UI (Design §Decisión 1, File Changes)

**Nota de troceo (aplicado al ejecutar)**: siguiendo el mismo patrón
preventivo que Slice 3→3a/3b en `notas-credito-ui-pos`, Slice C se dividió en
dos sub-slices al llegar a la fase apply, ANTES de que el riesgo de tamaño se
materializara:
- **C3a** (esta entrega): estructura — rename de sidebar, contenedor de
  pestañas (`Tabs` shadcn), extracción del contenido NC existente sin
  cambios de comportamiento, placeholder visual para Facturas. Ambas
  pestañas MONTADAS.
- **C3b** (próxima entrega): contenido real — `facturas-empresa-tab.tsx` con
  tabla `DataTable` + filtros sobre `useFacturasEmpresa`, filtros nuevos en
  `notas-credito-tab.tsx` sobre `useNotasCredito(filtros)`, botón "Ver todo
  el historial", eliminación de `useBuscarFacturaParaAnular` (dead code).

### Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~450–550 total (C3a real: ~395 líneas — ver "Resultado real" abajo) |
| 400-line budget risk | **High** (mitigado por el split C3a/C3b) |
| Chained PRs | Yes — depende de Slice A y B |
| Rollback | Sidebar/página caen a la versión actual (búsqueda simple + tabla NC, sin tabs); `crear-ncr-modal.tsx` viejo sigue siendo el único modal hasta Slice D |

Capa: component-integration, reusa hooks ya testeados de A/B — sin tests
dedicados nuevos más allá de smoke manual (Design Testing Strategy no pide
tests de componente para las tabs, solo para `CrearNcrModal` en Slice D).

### Sub-slice C3a — Estructura (rename + tabs + guard, contenido movido)

- [x] C3a.1 (=C.1) `src/components/layout/sidebar.tsx:85` — rename `'Nota de Credito'` → `'Facturas emitidas'` (label únicamente; `url`/`icon`/`requiredPermission: SALES_VOID` sin cambios). **Hecho**: solo el string cambió (1 línea).
- [x] C3a.2 RED: nuevo `src/features/ventas/components/__tests__/notas-credito-page.test.tsx` — mockea `../facturas-empresa-tab` y `../notas-credito-tab` (mismo patrón que `traspasos.test.tsx`), asserts: pestaña "Facturas" activa por defecto (`data-state="active"`), ambos triggers ("Facturas"/"Notas de credito") presentes, click en "Notas de credito" muestra su contenido mockeado y volver a "Facturas" no pierde acceso. **RED confirmado**: 2/2 tests fallaron con `Unable to find an accessible element with the role "tab"` (el componente viejo no tenia tabs todavia).
- [x] C3a.3 GREEN: crear `src/features/ventas/components/notas-credito-tab.tsx` (153 líneas) — contenido MOVIDO tal cual desde la vieja `NotasCreditoPage` (buscador de factura + tabla NC + `CrearNcrModal`), sin `PageHeader` (pasa al contenedor), sin cambios de comportamiento ni filtros nuevos (eso es C3b). Reusa `useNotasCredito()`/`useBuscarFacturaParaAnular` sin tocar sus hooks.
- [x] C3a.4 GREEN: crear `src/features/ventas/components/facturas-empresa-tab.tsx` (30 líneas) — placeholder visual (icono + texto "Proximamente"), SIN `useFacturasEmpresa` todavia (eso es C3b), sin `DataTable` todavia.
- [x] C3a.5 GREEN: reescribir `src/features/ventas/components/notas-credito-page.tsx` (171 líneas → shell de ~56 líneas) — `PageHeader` renombrado a "Facturas emitidas"; `Tabs` shadcn `defaultValue="facturas"` (patrón `traspasos.tsx`/`gastos-dashboard.tsx`, sin rutas anidadas ni search param); pestaña "Facturas" (primaria/default) delega a `FacturasEmpresaTab`; pestaña "Notas de credito" (secundaria) delega a `NotasCreditoTab`. **GREEN confirmado**: 2/2 tests del archivo nuevo pasan.
- [x] C3a.6 Verify: `yarn test:run` completo (91 archivos/1089 tests) verde; `yarn type-check:test` limpio; `yarn type-check` (app) solo con los mismos errores preexistentes no relacionados ya documentados en Slice B (`src/lib/__tests__/*`, `traspasos.test.tsx` — globals de test faltantes en tsconfig de app, no tocado por este slice); `src/routes/_app/ventas/notas-credito.tsx` SIN cambios (confirmado, el gate `SALES_VOID` ya envuelve `NotasCreditoPage` sin modificaciones); `useBuscarFacturaParaAnular` NO se toco (sigue siendo consumido por `notas-credito-tab.tsx`, se elimina recien en C3b cuando se reemplace por filtros nuevos).

**Resultado real vs forecast (C3a)**: forecast total de Slice C ~450–550 líneas; C3a (mitad estructural) real: `sidebar.tsx` (+1/-1) + `notas-credito-page.tsx` (+29/-144, reescritura neta de 171→~56 líneas activas) + 3 archivos nuevos (`notas-credito-tab.tsx` 153 líneas, `facturas-empresa-tab.tsx` 30 líneas, `notas-credito-page.test.tsx` 37 líneas) ≈ **395 líneas cambiadas** — dentro del presupuesto de 400 líneas por PR individual, confirmando que el split preventivo C3a/C3b fue la decisión correcta (evita que Slice C completo exceda 450–550 en un solo PR). Sin desviaciones del Design (Decision 1 aplicada tal cual — mismo patrón `Tabs` que `traspasos.tsx`). `useBuscarFacturaParaAnular` intacto. Diff FROZEN (`use-notas-credito.ts`, `nota-credito-pos-modal.tsx`, `supervisor-pin-dialog.tsx`, `use-ventas.ts`) confirmado vacío (`git diff --stat` sin salida).

### Sub-slice C3b — Contenido real (completo)

- [x] C3b.1 (=C.2) Extender `src/features/ventas/components/facturas-empresa-tab.tsx` — filtros (rango de fecha default mes actual, `nro_factura`, cliente, RIF) + `DataTable` genérico (`@/components/data-table/data-table.tsx`) sobre `useFacturasEmpresa(filtros)`; acción "Aplicar nota de crédito" por fila (abre modal, wiring real en Slice D — en este slice el botón puede quedar con estado local `facturaSeleccionada`/`modalOpen` sin montar aún `CrearNcrModal`); estado vacío sin error. [Spec: listado empresa-wide — todos los scenarios] **RED confirmado**: `src/features/ventas/components/__tests__/facturas-empresa-tab.test.tsx` (9 tests) falló 8/9 contra el placeholder de C3a (solo el mock-setup pasaba trivialmente). **GREEN confirmado**: 9/9 tests pasan tras reescribir el componente en 3 sub-componentes (`FacturasEmpresaFiltros` presentacional, `FacturasEmpresaTable` presentacional exportada, `FacturasEmpresaTab` contenedor con el estado de filtros + `useFacturasEmpresa`). El botón "Aplicar nota de credito" emite `onAplicarNc?.(factura)` (prop opcional, stub inofensivo sin handler — Slice D lo conecta a `CrearNcrModal`) y queda `disabled` cuando `tiene_reverso_total === 1`. **Desviación documentada**: el badge de reverso usa los flags crudos `tiene_reverso_total`/`tiene_reverso_parcial` YA presentes en la fila (Slice A `EXISTS`) en vez de `calcularBadgesReversoPorVenta` (que exige una query adicional de `ventas_det`+`notas_credito_det` no pedida por design.md para esta pestaña) — ver comentario en el archivo. **Residual risk documentado**: `DataTable` genérico (`@/components/data-table/data-table.tsx`) registra `useReactTable` solo con `getCoreRowModel` (sin `getFilteredRowModel`/`getPaginationRowModel`) — su toolbar/paginación interna caen al fallback de TanStack Table (listado completo sin truncar, cosméticamente presente pero no funcional). Se usa con `showToolbar={false}`/`showPagination={false}` porque el filtrado real ya lo hace el filtro-bar propio contra el SQL empresa-wide; se recomienda un change futuro dedicado a registrar esos row models en el componente compartido antes de que otro consumidor dependa de su paginación/búsqueda interna.
- [x] C3b.2 (=C.3) Extender `src/features/ventas/components/notas-credito-tab.tsx` — agregar filtros nuevos (fecha default mes actual, `nro` NC, `tipo`, cliente, RIF, vía `useNotasCredito(filtros)`) + botón "Ver todo el historial" que limpia el rango de fecha sin tope (`2000-01-01`–`2100-12-31`, escape hatch explícito del hook — Design §Riesgos). [Spec: pestaña Notas de crédito — todos los scenarios] **Deviación de alcance resuelta (documentada)**: el buscador de facturas (`useBuscarFacturaParaAnular` + dropdown + `CrearNcrModal`) NO se "preserva" como sugiere la redacción literal de spec.md ("conservar la tabla y el buscador ya existentes") — se RETIRA de esta pestaña, siguiendo Design §Decisión 7 + la instrucción explícita de C3b.3 de abajo. El buscador viejo seleccionaba una factura de `ventas` para reversar (nunca filtró el listado de `notas_credito`); ese caso de uso ahora lo cubre la pestaña "Facturas" (empresa-wide, botón "Aplicar nota de crédito" por fila) — la pestaña "Notas de crédito" queda como listado de solo lectura con filtros reales sobre su propia tabla. **RED confirmado**: `src/features/ventas/components/__tests__/notas-credito-tab.test.tsx` (8 tests) — 7/8 fallaron contra el componente de C3a (buscador viejo, sin filtros nuevos); el test de render básico pasaba trivialmente. **GREEN confirmado**: 8/8 tests pasan.
- [x] C3b.3 (=C.5) Eliminar `useBuscarFacturaParaAnular` (dead code, Design §Decisión 7) de `use-notas-credito.ts` — grep previo confirmó que `notas-credito-tab.tsx` (ya migrado a filtros nuevos en C3b.2) era el ÚNICO consumidor; grep posterior (`useBuscarFacturaParaAnular` en `**/*.ts*`) confirma CERO referencias de código restantes (solo menciones en comentarios/docs de otros archivos). No existía un bloque de test dedicado para esta función en `use-notas-credito.test.ts` (confirmado por grep antes de borrar) — nada que limpiar ahí.
- [x] C3b.4 (=C.6) Verify: `yarn test:run` (93 archivos/1106 tests) verde; `yarn type-check:test` limpio; `yarn type-check` (app) solo con los mismos errores preexistentes no relacionados ya documentados en Slices B/C3a (todo archivo `*.test.ts(x)` bajo el tsconfig de app carece de los globals de Vitest — confirmado que es un gap estructural del `tsconfig.json` de la app, no algo introducido por este slice: los archivos de test YA EXISTENTES de Slice B muestran el mismo patrón de errores). Smoke manual diferido (sin entorno de browser en esta sesión) — cubierto por los tests de RTL: filtros combinables en ambas pestañas (tests dedicados), "Ver todo el historial" funciona (test dedicado). El gate `SALES_VOID` no se tocó en este slice (ruta/sidebar ya validados en C3a).

**Resultado real vs forecast (C3b)**: forecast total de Slice C ~450–550 líneas (compartido con C3a, que ya consumió ~395). Real de C3b: `facturas-empresa-tab.tsx` (+269/-22, reescritura completa del placeholder de 30 líneas a 261 líneas reales) + `notas-credito-tab.tsx` (+201/-127 líneas, de 153 a 194 líneas) + `use-notas-credito.ts` (-28 líneas, eliminación de `useBuscarFacturaParaAnular`) + 2 archivos de test nuevos (`facturas-empresa-tab.test.tsx` 132 líneas/9 tests, `notas-credito-tab.test.tsx` 122 líneas/8 tests) ≈ **752 líneas cambiadas** (625 inserciones + 127 eliminaciones) — **excede el presupuesto de 400 líneas por PR individual**, incluso como slice ya sub-dividido de C. A diferencia de C3a (~395 líneas, dentro de presupuesto), C3b introduce DOS componentes de UI completos con filtros + tests de comportamiento reales (no placeholders), lo que explica el volumen mayor al estimado originalmente para "la mitad restante" de Slice C. **Nota para el orquestador**: dado que este slice se implementó como una única unidad autónoma en `feat/notas-credito-admin-s3b` (instrucción explícita del prompt de apply, sin autorización para crear sub-ramas adicionales), los cambios se organizan en 2 commits de work-unit reviimplables por separado (`facturas-empresa-tab` vs `notas-credito-tab`+cleanup) para facilitar un split de PR posterior si el revisor lo requiere — ver commits `feat(ventas): ...` de esta entrega. Sin desviaciones de Design más allá de las documentadas arriba (badge simplificado, retiro del buscador). `crearNotaCredito`, `nota-credito-pos-modal.tsx`, `supervisor-pin-dialog.tsx`, `use-ventas.ts` confirmados con diff vacío (`git diff --stat` sin salida).

## Slice C — Cierre

Ambos sub-slices (C3a + C3b) completos. Slice C queda TERMINADO: sidebar renombrado, 2 pestañas montadas con contenido real y filtros, `useBuscarFacturaParaAnular` eliminado. Pendiente exclusivamente Slice D (modal admin delgado + wiring del botón "Aplicar nota de crédito").

## Slice D — Modal admin delgado (rewrite) + wiring (Design §Decisión 2/5/6)

### Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~350–450 |
| 400-line budget risk | Medium–High |
| Chained PRs | Yes — depende de Slice A (tipos) y C (tab Facturas monta el modal) |
| Rollback | `crear-ncr-modal.tsx` cae a su versión pre-slice (TOTAL-only, sin selector de líneas ni placeholder) — `crearNotaCredito` intocado en todo momento |

Capa: component (Testing Library), reusa fixtures/patrones de
`nota-credito-pos-modal.test.tsx` y `seleccion-lineas-nc.test.tsx` (ya
existentes, sin tests nuevos para la capa pura reusada).

- [x] D.1 RED: reescribir `src/features/ventas/components/__tests__/crear-ncr-modal.test.tsx` — toggle TOTAL/PARCIAL (gating vía `puedeElegirTipoTotal`/`puedeEmitirNcAdicional`, mismos fixtures que POS); "Devolver dinero" SIEMPRE `disabled` con indicación "Proximamente" y NUNCA dispara `crearNotaCredito`; botón PARCIAL disabled con todas las líneas en 0; el modal NUNCA monta `SupervisorPinDialog` (mock existente, reforzado); confirmar TOTAL llama `crearNotaCredito({ entryPoint:'TRADICIONAL', modalidad:'AJUSTE_CXC', tipo:'TOTAL' })`; confirmar PARCIAL llama con `tipo:'PARCIAL'` + `lineas`. [Spec: Generación de NC + Selector placeholder — todos los scenarios] **RED confirmado**: 15/15 tests nuevos fallaron contra la implementación TOTAL-only vieja (`No "useDetalleFactura" export is defined on the mock` — el viejo componente ni siquiera importaba los hooks que el nuevo contrato mockea).
- [x] D.2 GREEN: reescrito `src/features/ventas/components/crear-ncr-modal.tsx` como wrapper delgado — reusa `FacturaDetallePanel`, `SeleccionLineasNc`, `useDetalleFactura`/`usePagosFactura` (cxc) + `useCompany` → `buildReciboData`, `useReversosFactura` → `agruparReversosPorNc`/`calcularReversoPorLinea`/`puedeEmitirNcAdicional`/`puedeElegirTipoTotal`; selector TOTAL/PARCIAL duplicado (Decision 6, ~25 líneas markup, gating reusado sin cambios); selector "Credito a favor" (fijo, único habilitado, `aria-pressed`) / "Devolver dinero" (`disabled`, shell visual con indicación "Proximamente", Decision 5) — su estado (`origenReverso`, seam para el change futuro) NUNCA alimenta `modalidad`; SIN PIN, selector de depósito libre (preserva UX del modal anterior); footer/`onConfirm` llaman `crearNotaCredito({ venta_id, motivo, usuario_id, empresa_id, entryPoint:'TRADICIONAL', modalidad:'AJUSTE_CXC', tipo:'TOTAL'|'PARCIAL', lineas?, depositoReingresoId })` — `tipo` SIEMPRE explícito en ambos casos (a diferencia de `nota-credito-pos-modal.tsx`, que lo omite para TOTAL por su contrato legacy byte-a-byte; este modal es reescritura completa, se siguió el criterio de aceptación literal de D.1). **GREEN confirmado**: 15/15 tests pasan en la primera implementación (sin iteraciones adicionales).
- [x] D.3 GREEN: wiring en `facturas-empresa-tab.tsx` (Slice C) — `FacturasEmpresaTab` ahora mantiene `facturaSeleccionada`/`modalOpen` y monta `CrearNcrModal` real; `handleAplicarNc` invoca el `onAplicarNc` externo opcional (retrocompatibilidad de tests/extensibilidad) ADEMÁS de abrir el modal, nunca en su lugar; cierre y refresco vía las live-queries de PowerSync sin invalidación manual. **RED→GREEN confirmado**: 3 tests nuevos en `facturas-empresa-tab.test.tsx` (mockeando `../crear-ncr-modal` — aislamiento necesario porque el modal real usa hooks de PowerSync/CXC no disponibles en ese entorno de test; su contrato real ya está cubierto por `crear-ncr-modal.test.tsx`), 12/12 tests del archivo (9 preexistentes + 3 nuevos) pasan.
- [x] D.4 Verify: `yarn test:run` (93 archivos/1118 tests, TODOS verdes) + `yarn type-check:test` (limpio) verdes; `git diff --stat feat/notas-credito-admin-s3b..HEAD` sobre `use-notas-credito.ts` (grep de `crearNotaCredito` sin matches), `nota-credito-pos-modal.tsx`, `supervisor-pin-dialog.tsx` y `use-ventas.ts` confirma CERO líneas cambiadas (diff vacío en los 3 comandos ejecutados); smoke TOTAL/PARCIAL cubierto exhaustivamente por los tests de `crear-ncr-modal.test.tsx` contra el payload real esperado por `crearNotaCredito` (mockeado en el test unitario, contrato de parámetros verificado).

**Resultado real vs forecast (Slice D)**: forecast ~350–450 líneas, riesgo Medium–High. Real: **~801 líneas cambiadas** (545 inserciones + 256 eliminaciones en 4 archivos: `crear-ncr-modal.tsx` reescrito completo de ~300 a ~350 líneas activas [483 líneas de diff], su test reescrito completo [15 tests, 229 líneas de diff], `facturas-empresa-tab.tsx` [+25/-0 líneas de wiring] y su test [+64 líneas, 3 tests nuevos]) — **excede el forecast y el presupuesto de 400 líneas**, principalmente porque `crear-ncr-modal.tsx` es una REESCRITURA COMPLETA (no un delta incremental sobre el componente TOTAL-only anterior) y su test se reescribió íntegramente para cubrir el nuevo contrato (TOTAL/PARCIAL + placeholder + gating + sin PIN). Es la última rebanada de la cadena `feature-branch-chain` ya decidida por el orquestador (D → `-s4`, base=s3b) — sin sub-split adicional (última entrega de la cadena), organizada en 2 commits de work-unit (modal+test; wiring+test) + 1 commit de docs, para que el maintainer pueda re-trocear en sub-PRs antes de merge si lo considera necesario. Sin desviaciones de Design más allá de la documentada arriba (`tipo` explícito vs `nota-credito-pos-modal.tsx`). `crearNotaCredito`, `nota-credito-pos-modal.tsx`, `supervisor-pin-dialog.tsx`, `use-ventas.ts` confirmados con diff vacío.

## Slice E — Refinamientos de QA del tester (post sdd-verify inicial)

Rama `feat/notas-credito-admin-s5` (base=s4). 5 refinamientos puntuales
sobre la UI/filtros/ruta ya construida en A-D, sin features nuevas. Modo
Strict TDD, RED→GREEN confirmado en cada archivo de test tocado.

### Review Workload

| Field | Value |
|---|---|
| Estimated changed lines (real) | ~812 total (route rename 58 · builders+hooks 410 · UI+dimmed rows 344) |
| 400-line budget risk | Medium — el commit de builders+hooks (410) excede el presupuesto por 10 líneas |
| Chained PRs | No — slice unica, aplicada completa en esta sesión (instrucción explícita del prompt) |
| Rollback | Cada uno de los 3 commits de trabajo es revertible independientemente sin romper los anteriores (ver "Commits" abajo) |

**Nota sobre el commit de builders+hooks (410 líneas, sobre el presupuesto
de 400 por 10 líneas)**: se mantuvo como una sola unidad porque `busqueda`
y `estado` se diseñaron y probaron juntos en cada builder puro (mismo ciclo
RED→GREEN por archivo, ver evidencia abajo) — partirlo habría dejado un
commit intermedio con un builder a medio migrar (tipos inconsistentes entre
`FiltroFacturasEmpresa` y `FiltroFacturasEmpresaHook`). Riesgo bajo: es
capa 100% pura/hooks sin UI, con 30+22 tests unitarios cubriendo cada rama.

### E.1 — Rename de ruta `/ventas/notas-credito` -> `/ventas/facturas-emitidas`

- [x] E.1.1 Mover `src/routes/_app/ventas/notas-credito.tsx` ->
  `facturas-emitidas.tsx`, `createFileRoute('/_app/ventas/facturas-emitidas')`.
  Guard `SALES_VOID` preservado sin cambios.
- [x] E.1.2 `src/components/layout/sidebar.tsx:85` — `url` actualizada a
  `/ventas/facturas-emitidas` (label "Facturas emitidas" sin cambios, ya
  renombrado en Slice C3a).
- [x] E.1.3 Regenerar `src/routeTree.gen.ts` via `yarn build` (TanStack
  Router plugin auto-codegen — no existe comando de codegen standalone en
  este repo). **Verificado**: build exitoso, chunk `facturas-emitidas-*.js`
  generado, `routeTree.gen.ts` referencia
  `/_app/ventas/facturas-emitidas` en las 13 ubicaciones esperadas (imports,
  tipos de ruta, registro de rutas).
- [x] E.1.4 Grep de `ventas/notas-credito` y `notas-credito.tsx` en todo
  `src/` — CERO referencias remanentes tras el rename.

**Resultado real vs forecast**: 58 líneas (21 inserciones + 37 eliminaciones,
3 archivos: sidebar, routeTree.gen.ts, delete+create de la ruta). Sin
desviaciones — cambio puramente mecánico de path.

### E.2 — Buscador unificado (patrón POS) en ambas pestañas

- [x] E.2.1 RED: extender
  `notas-credito-admin-filters.test.ts` con casos `busqueda` (OR sobre
  `nro_factura`/`nro_ncr` + `cliente_nombre` + `cliente_identificacion`,
  parametrizado 3 veces, vacío/whitespace ignorado, SQL-injection-safe) para
  ambos builders. **RED confirmado**: 14/30 tests fallaron contra los
  builders viejos (campos separados `nroFactura`/`clienteNombre`/etc. aún
  no existían como `busqueda`).
- [x] E.2.2 GREEN: `buildFacturasEmpresaFiltro`/`buildNotasCreditoFiltro`
  reemplazan los 3 campos separados por `busqueda?: string` — clausula
  `AND (col LIKE ? OR c.nombre LIKE ? OR c.identificacion LIKE ?)`, mismo
  término repetido 3 veces en `params` (nunca interpolado). **GREEN
  confirmado**: 30/30 tests del archivo pasan.
- [x] E.2.3 Hooks (`use-facturas-empresa.ts`, `use-notas-credito.ts`):
  `FiltroFacturasEmpresaHook`/`FiltroNotasCreditoHook` migrados a
  `busqueda?: string` (campos viejos removidos — grep confirmó que solo los
  2 tabs los consumían, ambos migrados en el mismo slice). RED→GREEN sobre
  `use-facturas-empresa.test.ts` (7/7) y `use-notas-credito.test.ts` (45/45).
- [x] E.2.4 UI: `facturas-empresa-tab.tsx`/`notas-credito-tab.tsx` — los 3
  inputs separados (nro/cliente/RIF) se reemplazan por UN input `Buscar`
  (icono `MagnifyingGlass` embebido, mismo patrón visual que
  `producto-buscador.tsx` del POS). Label visible asociado via `htmlFor`
  (no solo `placeholder` — accesibilidad, modern-web-guidance "forms"). RED
  confirmado en ambos archivos de test (inputs viejos ausentes, input nuevo
  ausente) antes de reescribir los componentes.

### E.3 — Filtro de Estado

- [x] E.3.1 RED+GREEN: `buildFacturasEmpresaFiltro` gana `estado?:
  'CONTADO' | 'CREDITO' | 'REVERSO_PARCIAL' | 'REVERSO_TOTAL'`. CONTADO/CREDITO
  usan `CAST(v.saldo_pend_usd AS REAL)` con el mismo épsilon 0.005 que
  `derivarEstadoPago` (comparación numérica sobre columna TEXT — mismo
  patrón `CAST(...AS REAL)` ya usado en `deposito-venta.ts` para stock).
  REVERSO_PARCIAL/REVERSO_TOTAL usan `EXISTS` sobre `notas_credito.tipo`
  (mismo criterio que las columnas `tiene_reverso_*` ya seleccionadas).
- [x] E.3.2 RED+GREEN: `buildNotasCreditoFiltro` gana `estado?:
  'REVERSO_PARCIAL' | 'REVERSO_TOTAL'` — reusa la MISMA columna
  `nc.tipo`/mismo valor TOTAL/PARCIAL que el viejo filtro `tipo` (Slice
  A/B), solo cambia el label expuesto en la UI ("Reverso Total"/"Reverso
  Parcial" en vez de "Total"/"Parcial").
- [x] E.3.3 UI: selector `NativeSelect` "Estado" en ambas pestañas.
  Facturas: 4 opciones (Contado/Crédito/Reverso Parcial/Reverso Total) +
  "Todos". NC: 2 opciones (Reverso Total/Reverso Parcial) + "Todos" — SIN
  Contado/Crédito (NC no tiene estado de pago propio). Confirmado via test
  de opciones exactas en ambos archivos.

### E.4 — Limpieza de la pestaña NC

- [x] E.4.1 Retirado el filtro "Tipo" (`NativeSelect` viejo,
  Total/Parcial/Todos) — reemplazado conceptualmente por el selector
  "Estado" de E.3.3 (misma columna `nc.tipo`, distinto label de negocio).
- [x] E.4.2 Retirado el botón "Ver todo el historial" + su handler
  `verTodoElHistorial` + las constantes `FECHA_MINIMA_HISTORIAL`/
  `FECHA_MAXIMA_HISTORIAL` (dead code tras el retiro del botón). **Confirmado**:
  el rango de fecha (`Desde`/`Hasta`, default `rangoMesActual()`) queda como
  el ÚNICO control de amplitud en la pestaña NC — no existe ningún escape
  hatch de historial completo (test dedicado: `queryByRole('button', {name:
  /ver todo el historial/i})` ausente).

### E.5 — Fila atenuada para facturas 100% reversadas

- [x] E.5.1 RED+GREEN: `filaFacturaAtenuada(f): boolean` — helper puro
  nuevo en `notas-credito-ui.ts` (mismo módulo compartido que
  `resolverBadgesFactura`/`derivarEstadoPago`), `f.tiene_reverso_total ===
  1`. 3 tests unitarios (true/false/undefined), 0 mocks.
- [x] E.5.2 `DataTable` genérico (`src/components/data-table/data-table.tsx`)
  extendido: `rowClassName` ahora acepta `string | ((row: TData) => string |
  undefined)` (retrocompatible — los demás consumidores del repo no usaban
  esta prop); nuevo prop opcional `rowProps?: (row: TData) => Record<string,
  string>` para atributos HTML extra por fila (usado para un marcador
  semántico `data-atenuada`, NO una clase CSS — ver nota de testing abajo).
- [x] E.5.3 `FacturasEmpresaTable` pasa `rowClassName={(f) =>
  filaFacturaAtenuada(f) ? 'text-muted-foreground/70' : undefined}` (color
  de texto HEREDABLE, nunca `opacity` — `opacity` atenuaría también el badge
  "Reverso Total", que debe conservar su color explícito) +
  `rowProps={(f) => filaFacturaAtenuada(f) ? {'data-atenuada':'true'} : {}}`.
  **Nota de testing (strict-tdd Assertion Quality Rules — "CSS class
  assertions are NEVER valid")**: el test de componente NO assert la clase
  Tailwind; assert el atributo semántico `data-atenuada="true"` en el `<tr>`
  (via `toHaveAttribute`, no `toHaveClass`) + que el badge "Reverso Total"
  sigue visible dentro de esa misma fila (`within(row)`).

**Resultado real vs forecast (E.2+E.3+E.4+E.5, UI layer)**: 344 líneas (204
inserciones + 140 eliminaciones, 7 archivos: `facturas-empresa-tab.tsx` +
test, `notas-credito-tab.tsx` + test, `notas-credito-ui.ts` + test,
`data-table.tsx`). Sin desviaciones de los criterios de aceptación del
prompt de apply. `empresa_id` confirmado SIEMPRE presente en los builders
extendidos (tests dedicados en ambos). Bimonetario/decimal intactos (Slice
E no toca montos). Español/TypeScript estricto preservados.

## Slice E.b — Corrección de tester QA sobre el filtro de Estado (E.3)

Rama `feat/notas-credito-admin-s5b` (base=s5, HEAD de Slice E). El tester
QA revisó el selector de Estado agregado en E.3 y pidió una corrección
puntual: en Facturas, el `<select>` separado se retira y el estado se
detecta como palabra clave DENTRO del input de búsqueda unificado (E.2);
en Notas de Crédito, el `<select>` de Estado simplemente se retira, sin
fold — NC no tenía un plan claro de "búsqueda por estado" en el pedido del
tester. Modo Strict TDD, RED→GREEN confirmado en los 5 archivos de test
tocados.

### Review Workload

| Field | Value |
|---|---|
| Estimated changed lines (real) | 425 (builders+hooks 317 · UI 108) |
| 400-line budget risk | Bajo — ambos commits de trabajo individualmente están debajo del presupuesto (317 y 108) |
| Chained PRs | No — corrección puntual de un batch ya aplicado, sin features nuevas |
| Rollback | Cada commit es revertible independientemente |

### E.b.1 — Facturas: estado FOLDED en la búsqueda (incluye "abonada", nuevo)

- [x] E.b.1.1 RED: `notas-credito-admin-filters.test.ts` — se retiran los 4
  tests del campo `estado` separado (CONTADO/CREDITO/REVERSO_PARCIAL/REVERSO_TOTAL)
  y se agregan 9 tests nuevos sobre `busqueda`: keywords "contado",
  "Crédito" (tilde+mayúscula), "abonada" (NUEVO — no existía en el select
  viejo), "reverso parcial", "REVERSO TOTAL" (mayúsculas); texto normal
  ("Maria") sin clausula de estado; "reverso" suelto (no es keyword exacto)
  sin clausula; busqueda vacía sin clausula; empresa_id siempre presente
  combinado con estado folded; `estado` como campo YA NO existe en el tipo
  (`@ts-expect-error`). **RED confirmado**: 12/108 tests fallaron contra el
  contrato viejo (campo `estado` separado).
- [x] E.b.1.2 GREEN: `EstadoFiltroFactura` gana `'ABONADA'` (universo
  completo: CONTADO/CREDITO/ABONADA/REVERSO_PARCIAL/REVERSO_TOTAL).
  `detectarEstadoFacturaEnBusqueda(busqueda)` — función pura privada,
  normaliza (trim+lowercase+strip-acentos) y matchea EXACTO contra un mapa
  de 5 palabras clave (nunca substring — "reverso" solo no dispara nada,
  preserva el hallazgo de un cliente literal "Reverso"). `busqueda`
  siempre agrega el OR de nro/cliente/RIF; cuando además detecta una
  keyword, agrega la clausula de estado como una rama MÁS del mismo OR
  (wide OR, nunca reemplaza — acceptance criteria del prompt: "nunca
  pierde resultados"). ABONADA implementada consistente con
  `derivarEstadoPago` (`notas-credito-ui.ts`): `saldo_pend_usd > 0.005 AND
  saldo_pend_usd < (total_usd - 0.005)`, mismo épsilon 0.005 que
  CONTADO/CREDITO. Campo `estado` RETIRADO de `FiltroFacturasEmpresa`
  (folded en `busqueda`, ya no es un parámetro independiente). **GREEN
  confirmado**: 30/30 tests del archivo.
- [x] E.b.1.3 Hooks: `FiltroFacturasEmpresaHook` pierde el campo `estado`
  (mecánico — el hook solo pasa `busqueda` al builder, la detección de
  keyword vive enteramente en la capa pura). RED→GREEN en
  `use-facturas-empresa.test.ts` (8/8, +1 test neto: se retira el test de
  `estado` directo y se agregan 2 — folding vía `busqueda` y campo
  `estado` inexistente).
- [x] E.b.1.4 UI: `facturas-empresa-tab.tsx` — `<select>` de Estado
  eliminado por completo (`NativeSelect` ahora sin consumidores en este
  archivo, import retirado). El input `Buscar` gana un placeholder que
  documenta las keywords disponibles ("Factura, cliente, RIF o estado
  (contado, crédito, abonada, reverso total/parcial)..."). RED→GREEN en
  `facturas-empresa-tab.test.tsx` (16/16 — se retiran los 2 tests del
  select viejo, se agregan 2: ausencia del select + `busqueda="abonada"`
  llega intacta al hook).

### E.b.2 — Notas de crédito: estado RETIRADO por completo (sin fold)

- [x] E.b.2.1 RED+GREEN: `buildNotasCreditoFiltro` pierde la rama
  `if (f.estado === ...)` — `nc.tipo` deja de ser filtrable desde esta
  pestaña. Grep confirmó que `EstadoFiltroNotaCredito` solo tenía 3
  consumidores (`FiltroNotasCredito.estado`, `FiltroNotasCreditoHook.estado`,
  `notas-credito-tab.tsx`) — los 3 se migran en este mismo slice, por lo
  que el tipo queda 100% muerto y se ELIMINA (no solo se deja de exportar).
  2 tests viejos de estado NC se retiran, se agregan 2 (nc.tipo nunca
  filtrable + campo `estado` inexistente).
- [x] E.b.2.2 Hook: `FiltroNotasCreditoHook` pierde `estado` +
  `EstadoFiltroNotaCredito` (import retirado de `use-notas-credito.ts`).
  Diff confinado a la interfaz/llamada de `buildNotasCreditoFiltro` dentro
  de `useNotasCredito()` (líneas ~208-256) — CERO líneas tocadas dentro de
  `crearNotaCredito` (línea 339+, FROZEN). RED→GREEN en
  `use-notas-credito.test.ts` (45/45 — 2 tests viejos de estado NC
  reemplazados por 2 nuevos).
- [x] E.b.2.3 UI: `notas-credito-tab.tsx` — `<select>` de Estado eliminado
  por completo (sin reemplazo, a diferencia de Facturas). Import de
  `NativeSelect`/`EstadoFiltroNotaCredito` retirado. RED→GREEN en
  `notas-credito-tab.test.tsx` (9/9 — se retiran los 2 tests del select
  viejo, se agrega 1: ausencia del select).

**Resultado real vs forecast**: 425 líneas (218 inserciones + 207
eliminaciones, 10 archivos) — 25 sobre el presupuesto de 400 en el TOTAL
combinado, pero repartidas en 2 commits de trabajo individualmente sanos
(builders+hooks 317, UI 108), cada uno revertible por separado. Sin
desviaciones de los criterios de aceptación del prompt de apply.
`empresa_id` confirmado SIEMPRE presente (tests dedicados). SQL
parametrizado en toda `busqueda` (ningún valor de usuario se interpola —
las constantes de estado, como `'PARCIAL'`/`0.005`, son literales internos,
no input de usuario, mismo patrón que el resto del builder). Verificado:
`yarn test:run` 93 archivos / 1136 tests verdes, `yarn type-check:test`
limpio. FROZEN confirmado sin cambios: `nota-credito-pos-modal.tsx` y
`supervisor-pin-dialog.tsx` con diff VACÍO; `use-notas-credito.ts` con diff
confinado a `FiltroNotasCreditoHook`/`useNotasCredito` (0 líneas de
`crearNotaCredito` en el diff).

## Deferred (fuera de alcance de Slice E, explícito)

- **Modal de consulta de detalle de factura** (ver una factura sin abrir el
  flujo de "Aplicar nota de crédito") — diferido a un change futuro.
- **Textos de reverso enriquecidos** (historial expandido, notas al detalle
  de una NC aplicada) — diferido hasta que las NC estén operativamente
  conectadas a cuadre/tesorería (ver design.md "Costuras para el próximo
  change").

## Estado final del change

**TODAS las 5 slices (A, B, C, D, E) completas.** El change queda
feature-complete a nivel de base visual/funcional (sidebar renombrado, ruta
en `/ventas/facturas-emitidas`, 2 pestañas con contenido real + búsqueda
unificada + filtro de estado, modal admin delgado reversando cualquier
factura de la empresa sin PIN, filas 100% reversadas atenuadas visualmente),
pendiente de la fase `sdd-verify` para la prueba formal contra
specs/design/tasks. Sin tareas remanentes en este archivo.

## Cross-cutting invariants (aplican a los 4 slices)

- `crearNotaCredito`, `nota-credito-pos-modal.tsx`, `SupervisorPinDialog` son CÓDIGO CONGELADO — ningún slice los modifica (Design Decision 2, FROZEN).
- Toda query NUEVA filtra `empresa_id` sin excepción (`useFacturasEmpresa`, filtros de `useNotasCredito`) — verificar en el `WHERE` real, no solo en el builder puro.
- No hay migración SQL en este change — sin columnas/tablas nuevas (constraint fijo, Design §Migration/Rollout).
- Inmutabilidad: la ruta admin solo AGREGA movimientos (kardex, CxC) vía `crearNotaCredito` existente — nunca edita/borra `ventas`/`movimientos_inventario` fuera de ese motor.
- Bimonetario: todo monto se muestra USD + Bs; `previewMontoBsNc`/`buildReciboData` SIEMPRE usan `factura.tasa` histórica, nunca la tasa vigente (invariante ya cubierta por tests de `notas-credito-ui-pos`, reusados sin cambios).
- decimal.js para todo cálculo monetario — nunca `float`/`Number` en lógica de negocio nueva (Slice A/B).
- "Devolver dinero" debe quedar verificablemente `disabled` en el DOM y su click NUNCA debe invocar `crearNotaCredito` — cubierto por test dedicado en D.1, no solo por inspección visual.
- Solo español en toda la UI. TypeScript estricto, sin `any`. `yarn` — nunca `npm`.
