# Producto — Back-cálculo de Costo Specification

## Purpose

Estima `costo_usd` desde margen + precio DETAL con costo vacío: cascada a mayor/especial, bloqueo de margen negativo, avisos discretos. Solo productos, no combos.

## Requirements

### Requirement: Condiciones de Disparo (solo en blur)

Back-calc MUST dispararse en `blur` (nunca por tecla) solo si TODAS se cumplen:

| # | Condición |
|---|-----------|
| 1 | `costoUsd.trim() === ''` (`'0'` NO es vacío) |
| 2 | Margen DETAL cargado |
| 3 | PVP DETAL o precio final DETAL cargado |
| 4 | Producto no es combo (`esComboLocal === false`) |

Si falta cualquiera, costo MUST permanecer sin cambios ni aviso. Servicios (`tipo === 'S'`) MUST mantener costo editable actual, sin cambios estructurales.

#### Scenario: Trigger válido
- GIVEN costo vacío, margen DETAL 50%, PVP DETAL 150, no combo
- WHEN blur en margen o PVP
- THEN se calcula `costo_usd`

#### Scenario: Condición ausente no dispara
- GIVEN costo `'0'`, margen vacío, PVP y final vacíos, o combo
- WHEN blur en margen o PVP
- THEN costo no cambia, sin aviso

#### Scenario: Keystroke no dispara
- GIVEN condiciones de trigger cumplidas
- WHEN el usuario escribe sin blur
- THEN costo no cambia hasta el blur

### Requirement: Cálculo, Cascada y Sincronización

MUST usar `decimal.js`, redondeo solo al final (2 decimales):

| Paso | Fórmula |
|------|---------|
| Costo desde PVP | `costo = pvp / (1 + margen/100)` (margen 0% ⇒ `costo = pvp`) |
| Costo desde final | `pvp = final / (1 + iva/100)`, luego aplicar fórmula anterior |
| Cascada mayor/especial | `precio = costo * (1 + margen_nivel/100)` si última fuente = margen; precio tipeado se preserva |
| Sync Bs | `costo_bs = costo_usd * tasa`; tasa `0`/ausente ⇒ omitir, sin dividir por cero |

Con margen `>= 0`, `precio_venta_usd >= costo_usd` se cumple en los 3 niveles.

#### Scenario: Ejemplo canónico completo
- GIVEN PVP detal 150, margen detal 50%, mayor 25%, especial 0.01%, tasa 40, costo vacío
- WHEN blur
- THEN costo `= 100.00`, Bs `= 4000.00`, mayor `= 125.00`, especial `= 100.01`; invariante cumple en los 3 niveles

#### Scenario: Desde precio final con IVA
- GIVEN precio final detal 174, IVA 16%, margen 50%, sin PVP tipeado, costo vacío
- WHEN blur en precio final
- THEN pvp intermedio `= 150.00`, costo `= 100.00`

#### Scenario: Precio tipeado se preserva; tasa inválida no rompe
- GIVEN mayor tipeado a mano en 130 (última fuente = precio); tasa `0`
- WHEN se fija el costo nuevo
- THEN mayor permanece `130.00`; Bs no se actualiza, sin error

### Requirement: Bloqueo de Margen Negativo

El sistema MUST impedir margen negativo en cualquier nivel (back-calc y flujo normal); MUST clamparse a `0` con aviso discreto no bloqueante.

#### Scenario: Margen negativo clampado con aviso
- GIVEN el usuario tipea `-10` en el margen de cualquier nivel
- WHEN el campo se procesa
- THEN el margen se fija en `0` y aparece el aviso de corrección

### Requirement: Aviso "costo recalculado por el sistema"

El aviso MUST aparecer solo si el back-cálculo auto-completó el costo; MUST NOT aparecer con costo ya presente; MUST NOT persistir tras corrección manual.

#### Scenario: Aviso tras auto-completar
- GIVEN el back-cálculo fija `costo_usd`
- WHEN el cálculo termina
- THEN se muestra "costo recalculado por el sistema"

#### Scenario: Sin aviso con costo presente
- GIVEN costo con valor no vacío
- WHEN el usuario edita margen o PVP DETAL
- THEN no aparece aviso de recálculo

#### Scenario: Corrección manual limpia el aviso
- GIVEN un costo auto-completado con aviso visible
- WHEN el usuario tipea un costo real
- THEN el flujo normal se reanuda y el aviso no persiste

## Out of Scope

Migrar handlers a `decimal.js` fuera del back-calc; parches Zod para `costo_usd` vs mayor/especial; back-calc desde mayor/especial; cambios a combos.
