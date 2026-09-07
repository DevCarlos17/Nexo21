# Design: Ruta Administrativa de Facturas Emitidas y Notas de Credito

## Technical Approach

Reusa el motor `crearNotaCredito` (ya soporta `entryPoint: 'TRADICIONAL'` +
`AJUSTE_CXC` sin cambios) y los componentes puros `FacturaDetallePanel`/
`SeleccionLineasNc` construidos en `notas-credito-ui-pos`. La pagina
`notas-credito-page.tsx` se reestructura en 2 tabs (shadcn `Tabs`, patron ya
usado en `traspasos.tsx`/`horarios-staff-page.tsx`/`gastos-dashboard.tsx` —
sin rutas anidadas, sin sincronizar tab con la URL). Se agrega un hook
empresa-wide (`useFacturasEmpresa`) hermano de `useFacturasSesionActiva`, y
`useNotasCredito` se extiende con filtros. `crear-ncr-modal.tsx` se reescribe
para reusar los componentes puros y agregar seleccion de lineas + el
placeholder de origen de reverso — **sin tocar** `nota-credito-pos-modal.tsx`
(ver Decision 2).

## Architecture Decisions

### Decision 1 — Tabs con estado local (shadcn), sin rutas anidadas ni URL

| Opcion | Tradeoff | Elegida |
|---|---|---|
| Rutas anidadas TanStack Router (`/ventas/notas-credito/facturas`, `/notas-credito/nc`) | Deep-linking gratis, pero ningun otro modulo del repo usa rutas anidadas para tabs (13+ consumidores de `Tabs` shadcn revisados) | No |
| `Tabs` shadcn + `useState` local, sin search param | Sin deep-link al tab activo, pero es el patron 100% consistente del repo (`traspasos.tsx`, `gastos-dashboard.tsx`, `horarios-staff-page.tsx`) | **Si** |

El path de la ruta (`/ventas/notas-credito`) no cambia — solo el label del
sidebar y el titulo de `PageHeader`.

### Decision 2 — Modal admin: wrapper delgado (Opcion b), NO generalizar `NotaCreditoPosModal`

| Opcion | Tradeoff | Elegida |
|---|---|---|
| (a) Generalizar `NotaCreditoPosModal` con flag `variant: 'POS' \| 'ADMIN'` | Menos duplicacion de wiring, pero ese componente (774 lineas) acumula >10 QA-fixes documentados en comentarios (Bugs A-F, Slices 5a-5g) sobre PIN A/B, `sesion` obligatoria, `useFacturasSesionActiva`/`useBadgesReversoSesion` hardcodeados, `MODALIDADES_POS`. Inyectar un modo ADMIN exigiria ramas condicionales en casi cada bloque de render y arriesga regresion en el flujo POS mas fragil del sistema | No |
| (b) Reescribir `crear-ncr-modal.tsx` como wrapper propio que reusa SOLO la capa pura (`FacturaDetallePanel`, `SeleccionLineasNc`, `derivarEstadoPago`, `calcularReversoPorLinea`, `puedeEmitirNcAdicional`, `puedeElegirTipoTotal`, `agruparReversosPorNc`) + `crearNotaCredito` | Duplica ~150-200 lineas de wiring (state, efectos, estructura de dialog) — mismo tradeoff que Decision 1 de `notas-credito-ui-pos/design.md` ("sin hook unificador... cero acoplamiento de scopes") | **Si** |

**Rationale**: el flujo admin es un subconjunto estricto y con reglas fijas
(sin PIN, sin sesion, una sola modalidad) frente al POS (2 PINs, sesion
obligatoria, 4 modalidades, placeholder propio "Editar metodos de pago").
Forzar ambos casos en un solo componente violaria la regla ya establecida en
el propio repo de preferir funciones/componentes puros compartidos sobre un
abstracto que mezcle dos scopes estructuralmente distintos. Cero riesgo de
regresion sobre `nota-credito-pos-modal.tsx`.

### Decision 3 — Hook empresa-wide con query-builder puro (RED-first)

`useFacturasEmpresa(filtros)` (nuevo archivo, hermano de
`use-facturas-sesion-activa.ts`) NO reutiliza `useFacturasSesionActiva`
(hard-filtra por `sesion_caja_id`) ni `useBuscarFacturaParaAnular` (LIKE
simple sobre `nro_factura`, sin rango de fecha). Delega la construccion del
SQL a una funcion pura extraida a un archivo nuevo, siguiendo el patron ya
usado en `use-ret-iva-compras.ts`/`use-ret-islr-compras.ts` (`buildDateRange`)
pero extendido a filtros opcionales combinables:

```ts
// notas-credito-admin-filters.ts (puro, sin I/O)
export interface FiltroFacturasEmpresa {
  empresaId: string
  fechaDesde: string // 'YYYY-MM-DD', default startOfMonth()
  fechaHasta: string // default todayStr()
  nroFactura?: string
  clienteNombre?: string
  clienteIdentificacion?: string
}
export function buildFacturasEmpresaFiltro(f: FiltroFacturasEmpresa): { sql: string; params: unknown[] }
```

Siempre filtra `v.empresa_id = ?` + rango de fecha; cada filtro opcional
agrega su propio `AND ... LIKE ?` con el parametro correspondiente (nunca
interpolacion de string). Retorna el mismo shape `FacturaParaAnular`
(reusa `tiene_reverso_total`/`tiene_reverso_parcial` via `EXISTS`, igual
patron que `use-facturas-sesion-activa.ts`).

### Decision 4 — Filtros de NC list con el mismo patron puro

`useNotasCredito(filtros?)` se extiende (no se reemplaza) para aceptar
`{ fechaDesde, fechaHasta, nroNcr?, tipo?, clienteNombre?, clienteIdentificacion? }`,
delegando a `buildNotasCreditoFiltro` en el mismo archivo de utils nuevo.
Default `fechaDesde/fechaHasta` = mes actual (cambio de comportamiento
intencional respecto al listado historico completo actual — mitigado con un
boton "Ver todo el historial" que limpia el rango sin tope maximo).

### Decision 5 — Placeholder "Devolver dinero" como shell visual puro

Dentro de `crear-ncr-modal.tsx`: dos botones tipo radio, "Credito a favor"
(seleccionado por defecto, unico habilitado) y "Devolver dinero"
(`disabled`, tooltip "Proximamente"). El estado de este selector **no**
alimenta `modalidad` — `modalidad: 'AJUSTE_CXC'` queda hardcodeado en la
llamada a `crearNotaCredito` sin importar la seleccion visual. Cero logica
condicional nueva, tal como exige el proposal.

### Decision 6 — Selector TOTAL/PARCIAL: duplicado, no extraido a componente compartido

Extraer el selector TOTAL/PARCIAL de `nota-credito-pos-modal.tsx` (lineas
560-593) a un componente compartido exigiria modificar ese archivo — mismo
riesgo que Decision 2. Se duplica el markup (~20 lineas) en `crear-ncr-modal.tsx`;
la logica de gating real (`puedeEmitirNcAdicional`/`puedeElegirTipoTotal`) SI
se reusa desde `notas-credito-ui.ts` sin cambios.

### Decision 7 — `useBuscarFacturaParaAnular` se elimina (dead code)

Unico consumidor: `notas-credito-page.tsx`, que desaparece con la
reestructuracion en tabs. `useFacturasEmpresa` cubre el mismo caso de uso
(buscar por `nro_factura`) con filtros adicionales — no hay reemplazo 1:1
necesario.

## Data Flow

```
Sidebar "Facturas emitidas" (SALES_VOID) ─▶ notas-credito.tsx (path sin cambios)
        │
        ▼
NotasCreditoPage (Tabs shadcn, estado local)
    ├─ Tab "Facturas" (nuevo, primario)
    │     useFacturasEmpresa(filtros) ──▶ buildFacturasEmpresaFiltro (puro)
    │     DataTable + boton "Aplicar nota de credito" por fila
    │
    └─ Tab "Notas de credito" (existente + filtros)
          useNotasCredito(filtros) ──▶ buildNotasCreditoFiltro (puro)

CrearNcrModal (reescrito, Decision 2 = opcion b)
    useDetalleFactura(cxc) + usePagosFactura + useCompany ──▶ buildReciboData ──▶ FacturaDetallePanel
    useReversosFactura ──▶ agruparReversosPorNc / calcularReversoPorLinea / puedeEmitirNcAdicional / puedeElegirTipoTotal
    Selector TOTAL/PARCIAL (duplicado, Decision 6)
        PARCIAL ──▶ SeleccionLineasNc ──▶ derivarLineasNcParcial (sin cambios)
    Selector "Devolver dinero" (disabled) / "Credito a favor" (fijo, Decision 5)
    ──▶ crearNotaCredito({ entryPoint:'TRADICIONAL', modalidad:'AJUSTE_CXC', tipo, lineas? })  [motor sin cambios]
```

## File Changes

| Archivo | Accion | Descripcion |
|---|---|---|
| `src/components/layout/sidebar.tsx:85` | Modify | title `'Nota de Credito'` → `'Facturas emitidas'` |
| `src/features/ventas/components/notas-credito-page.tsx` | Modify | `Tabs` shadcn, `PageHeader` renombrado, delega a los 2 tabs nuevos |
| `src/features/ventas/components/facturas-empresa-tab.tsx` | Create | Filtros + `DataTable` + boton "Aplicar nota de credito" |
| `src/features/ventas/components/notas-credito-tab.tsx` | Create | Extrae tabla NC existente + filtros nuevos |
| `src/features/ventas/hooks/use-facturas-empresa.ts` | Create | `useFacturasEmpresa(filtros)` |
| `src/features/ventas/utils/notas-credito-admin-filters.ts` | Create | `buildFacturasEmpresaFiltro`, `buildNotasCreditoFiltro` (puras) |
| `src/features/ventas/hooks/use-notas-credito.ts` | Modify | `useNotasCredito(filtros?)`; elimina `useBuscarFacturaParaAnular` |
| `src/features/ventas/components/crear-ncr-modal.tsx` | Modify | Reescritura completa (Decision 2/5/6) |
| `src/features/ventas/components/nota-credito-pos-modal.tsx` | Sin cambios | Ver Decision 2 |
| `src/features/ventas/hooks/use-notas-credito.ts` (`crearNotaCredito`) | Sin cambios | Motor ya soporta el camino usado |

## Testing Strategy

| Capa | Que | Enfoque |
|---|---|---|
| Unit (RED-first) | `buildFacturasEmpresaFiltro` — sin filtros (solo empresa+fecha), cada filtro opcional aislado, combinados, strings vacios/whitespace ignorados, params SIEMPRE parametrizados (nunca interpolados) | Funcion pura, sin DB |
| Unit (RED-first) | `buildNotasCreditoFiltro` — mismos casos + filtro `tipo` (TOTAL/PARCIAL/omitido) | Funcion pura, sin DB |
| Component | `CrearNcrModal` — toggle TOTAL/PARCIAL, "Devolver dinero" siempre disabled y nunca dispara `crearNotaCredito`, boton PARCIAL disabled con todas las lineas en 0 | Testing Library, reusa fixtures de `SeleccionLineasNc` ya existentes |
| Integration | `useNotasCredito(filtros?)` sin filtros preserva comportamiento actual para consumidores no migrados | Smoke test |
| Integration | `useFacturasEmpresa` retorna facturas de OTRAS sesiones/dias dentro del rango (a diferencia de `useFacturasSesionActiva`) | Fixture con 2+ sesiones distintas |

Reuso sin tests nuevos (ya cubiertas por `notas-credito-ui-pos`):
`derivarEstadoPago`, `calcularReversoPorLinea`, `puedeEmitirNcAdicional`,
`puedeElegirTipoTotal`, `agruparReversosPorNc`, `derivarLineasNcParcial`.

## Riesgos

| Riesgo | Prob. | Mitigacion |
|---|---|---|
| Query empresa-wide sin indice dedicado escala mal en empresas con mucho volumen | Med | Default mes actual acota el resultado; sin migracion en este change (constraint), medir en produccion antes de proponer indice en un change futuro |
| Reescribir `crear-ncr-modal.tsx` rompe el flujo Tradicional actual (TOTAL-only) durante el PR | Low | Mismo motor (`crearNotaCredito`) sin cambios; smoke test manual TOTAL antes de mergear |
| Placeholder "Devolver dinero" genera expectativa de funcionalidad real | Low | Disabled explicito + tooltip "Proximamente" |
| Cambiar el default de `useNotasCredito` a mes actual sorprende a usuarios acostumbrados al historico completo | Low | Boton "Ver todo el historial" sin tope de fecha |

## Migration / Rollout

No hay migracion SQL — decision fija del change (badge `via_administracion`
y columna `entry_point` se difieren). Deploy estandar (Cloudflare Workers,
sin coordinacion con Supabase SQL Editor).

## Costuras para el proximo change (cuadre/tesoreria)

- `crearNotaCredito` ya valida el tipo `REFUND_TESORERIA` y lanza el throw
  explicito — el proximo change solo agrega la rama de logica dentro de la
  funcion existente, sin tocar la firma de `CrearNotaCreditoParams`.
- El selector "Devolver dinero"/"Credito a favor" en `CrearNcrModal` ya
  existe como shell visual (Decision 5) — habilitarlo es cambiar `disabled`
  y mapear la seleccion a `modalidad` real (hoy hardcodeada).
- `FacturaParaAnular.status` ya es opcional en la interfaz compartida —
  agregar `entry_point`/`via_administracion` es sumar una columna opcional
  mas; `useFacturasEmpresa` y `useFacturasSesionActiva` devuelven el mismo
  shape.
- Las funciones de gating (`puedeEmitirNcAdicional`, `puedeElegirTipoTotal`,
  `calcularReversoPorLinea`) son agnosticas de `entryPoint` — reusables sin
  modificacion.
- `notas_credito.no_desembolso` ya persiste `true` para `AJUSTE_CXC` — el
  reporte de cuadre puede filtrar por esa columna existente sin migracion
  adicional.

## Open Questions

Ninguna bloqueante. Decisiones abiertas del proposal quedaron resueltas
como constraints fijas de este change (ver "RESOLVED DECISIONS"): sin
schema nuevo, gating solo `SALES_VOID`, "Devolver dinero" deshabilitado.
