# Proposal: Back-calcular Costo desde Margen y Precio

## Intent

Un usuario que crea/edita un producto a veces no recuerda el costo exacto (el costo real se actualiza normalmente vía compras). Hoy, si deja el campo costo vacío, el modal de precios queda inerte: los cambios de margen o PVP no producen nada porque todos los handlers usan guards `costo > 0`. Esto obliga a inventar un costo o abandonar la carga. Se agrega un camino de conveniencia: estimar el costo a partir de margen + precio para poder seguir trabajando, ajustable después. Debe ser discreto — la mayoría de usuarios no lo notará.

## Scope

### In Scope
- Back-calcular `costo_usd` cuando el campo está vacío (`costoUsd.trim() === ''`, no `'0'`) y hay margen DETAL + (PVP DETAL o precio final DETAL), y el producto no es combo.
- Fórmula: `pvp = final / (1 + iva/100)` (si viene de precio final) → `costo = pvp / (1 + margen/100)`.
- Cascada: recalcular mayor y especial desde el costo nuevo usando sus márgenes ya cargados.
- Aviso discreto no bloqueante: "costo recalculado por el sistema".
- Bloquear margen negativo en los tres niveles (detal, mayor, especial), no solo en back-calc.
- Usar `decimal.js` para la matemática del back-calc (isla nueva de código); redondeo solo al final de la cadena.

### Out of Scope
- Migrar los handlers existentes de float a `decimal.js` (cambio futuro separado).
- Parchear el schema Zod para validar `precio_mayor_usd >= costo_usd` o agregar validación a especial (gap preexistente, ver Riesgos) — solo si `sdd-design` determina que es necesario.
- Cambios a combos (`tipo === 'C'`, `esComboLocal`) o servicios (`tipo === 'S'`): su comportamiento actual no se toca.
- Back-calc desde mayor o especial (solo DETAL es fuente).

## Capabilities

### New Capabilities
- `producto-costo-backcalculo`: back-calcular el costo de un producto desde margen + precio DETAL cuando el costo está vacío, con cascada a mayor/especial y bloqueo de margen negativo.

### Modified Capabilities
None — no existe spec previa para el modal de precios de producto; este es el primer spec de esa área.

## Approach

- Nuevo predicado `costoUsd.trim() === ''` (hoy `''` y `'0'` colapsan en `parseFloat`; hay que distinguirlos explícitamente).
- Rama nueva dentro de los handlers de margen/PVP/precio-final DETAL: si el predicado de costo vacío se cumple, invertir la dirección de cálculo (precio → costo) en vez de la dirección actual (costo → precio).
- Tras fijar el costo, reutilizar la lógica existente de recálculo por margen para mayor y especial (mismo patrón que ya usa el formulario, aplicado al costo nuevo).
- Bloqueo de margen negativo: agregar el mismo guard a los tres handlers de margen (detal/mayor/especial), consistente con el patrón discreto (ver Preguntas Abiertas #3).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/features/inventario/components/productos/producto-form.tsx` | Modified | Nueva rama de back-calc en handlers de margen/PVP/final DETAL; guard de margen negativo en los 3 niveles; toast discreto |
| `src/features/inventario/lib/producto-precio-gating.ts` | Modified (posible) | Si el back-calc reutiliza/extiende `calcularPrecioPreservandoMargen` o `calcularViolacionCostoPvp` |
| `src/features/inventario/lib/producto-precio-gating.test.ts` | Modified | Casos nuevos para back-calc y bloqueo de margen negativo |
| `package.json` | No change | `decimal.js` ya es dependencia (`^10.6.0`) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Tocar handlers existentes (guard de margen negativo) rompe flujo normal con costo presente | Med | Cubrir con tests de regresión en `producto-precio-gating.test.ts` antes de tocar handlers; el guard solo bloquea `margen < 0`, no cambia matemática existente |
| Cascada mayor/especial pisa un PRECIO explícito que el usuario tipeó (no margen) | Med | Ver Pregunta Abierta #1 — resolución: cascada solo recalcula si el nivel usa margen como ancla; si el usuario tipeó precio mayor/especial directamente, no se sobrescribe |
| Gap preexistente: schema no valida `precio_mayor_usd >= costo_usd` ni nada en especial | Bajo (ya existe hoy) | Con márgenes >= 0 la cascada garantiza `costo <= precio` por construcción; no se requiere parche de schema en este cambio |
| Mezclar Decimal (isla nueva) con float (resto del form) en el mismo componente | Med | Aislar conversión a `Decimal` dentro de la función de back-calc; convertir a string/number en el borde antes de `setState` |

## Preguntas Abiertas (resueltas)

1. **¿Validar el costo resultante contra mayor/especial ya tipeados como PRECIO (no margen)?**
   Recomendación: la cascada solo recalcula mayor/especial si esos niveles fueron definidos vía margen (el patrón dominante en el formulario). Si el usuario tipeó un PRECIO mayor/especial explícito sin tocar el margen correspondiente, ese precio se deja intacto y no se fuerza a coincidir con el costo nuevo — evita sorprender al usuario sobrescribiendo un valor que escribió a mano. `sdd-design` debe confirmar cómo distinguir "margen fue la última fuente" en el estado actual del form.

2. **¿Back-calc en cada keystroke o en blur?**
   Recomendación: **blur**. Recalcular el costo en cada tecla mientras el usuario sigue escribiendo el margen o el precio produce un valor que "se mueve bajo los dedos" — friccionante y contrario al objetivo de ser discreto. Blur da una foto estable cuando el usuario termina de definir el dato ancla.

3. **¿Cómo se bloquea el margen negativo (clamp, error, disabled)?**
   Recomendación: **clamp silencioso a 0** en el propio handler de cambio de margen (consistente con "discreto, no bloqueante" del resto de la feature). No usar validación de schema con mensaje de error ni disabled — un margen negativo tipeado simplemente no se acepta como estado, el campo refleja 0 sin toast ni fricción adicional (el toast de "costo recalculado" queda reservado para el back-calc, no para el clamp de margen).

## Ejemplo de Aceptación (canónico)

```
detal: pvp 150, margen 50% → costo = 150 / 1.5 = 100
mayor: margen 25% → 100 * 1.25 = 125
especial: margen 0.01% → 100 * 1.0001 = 100.01

Con IVA 16%: precio final 174 → pvp = 174 / 1.16 = 150 → costo = 100 (mismo resultado)
```

## Rollback Plan

Cambio acotado a un componente (`producto-form.tsx`) y un módulo de lógica pura (`producto-precio-gating.ts`), sin migraciones de DB ni cambios de schema. Revertir el commit/PR restaura el comportamiento actual (costo vacío = handlers inertes). Sin dependencias externas nuevas.

## Dependencies

Ninguna — `decimal.js` ya está instalado.

## Success Criteria

- [ ] Costo vacío + margen DETAL + PVP o final DETAL → costo se calcula y coincide con el ejemplo canónico
- [ ] Cascada actualiza mayor/especial desde el costo nuevo usando sus márgenes, sin pisar precios tipeados a mano
- [ ] Toast "costo recalculado por el sistema" aparece, no bloqueante
- [ ] Margen negativo no es aceptable en ningún nivel (clamp a 0)
- [ ] Combos y servicios sin cambio de comportamiento (tests de regresión pasan)
- [ ] `costoUsd === '0'` (cero deliberado) NUNCA dispara back-calc
