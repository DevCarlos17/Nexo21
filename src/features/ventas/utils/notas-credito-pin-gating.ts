/**
 * Modulo PURO (sin I/O, sin tx) para las decisiones de gating por PIN de
 * Notas de Credito. Escrito originalmente en Slice 5a para el modulo
 * Tradicional, pero CORREGIDO por la regla PIN definitiva (obs #2835): la
 * pantalla Tradicional dedicada NUNCA pide PIN (ya esta protegida a nivel de
 * ACCESO a la ruta) — este modulo queda RESERVADO para el entry point POS
 * (Slice 5a-2), donde el PIN transaccional SI aplica, exclusivamente cuando
 * el usuario que intenta la NC carece del permiso `ventas.nota_credito`.
 *
 * DOS autorizaciones SEPARADAS, NUNCA fusionadas (aplican al flujo POS):
 * - PIN A (emision): decide si el usuario actual puede emitir la NC sin
 *   pedir PIN de supervisor. El permiso `ventas.nota_credito`
 *   (`PERMISSIONS.SALES_NOTA_CREDITO`) decide, no un PIN fijo — usuario CON
 *   permiso, sin PIN; usuario SIN permiso, PIN de supervisor exigido (mismo
 *   slug via `SupervisorPinDialog`).
 * - PIN B (override de deposito): decide si el usuario puede reemplazar el
 *   deposito resuelto por riel (`resolveDepositoReingresoNcr`) por uno
 *   elegido explicitamente. SIEMPRE requiere un segundo PIN de supervisor,
 *   independiente del PIN A — friccion deliberada (Opcion B, obs #2802),
 *   vigente para el flujo POS (el Tradicional ya no usa ninguna de las dos).
 *
 * `resolverDepositoOverride` es el bridge puro hacia el futuro parametro
 * `depositoReingresoId` de `CrearNotaCreditoParams` (Design §Interfaces) —
 * ese parametro se threadea dentro de la tx de `crearNotaCredito` recien en
 * Slice 5a-2 (obs #2831, division explicita de slice 5). Aqui solo se
 * resuelve el VALOR que 5a-2 consumira: `null` si no hay override vigente
 * (el backend sigue el riel automatico sin cambios), o el id explicito
 * elegido cuando el segundo PIN ya autorizo el override.
 */

/** PIN A — true si el usuario actual NECESITA el PIN de supervisor para emitir la NC. */
export function requierePinEmisionNc(tienePermisoEmisionNc: boolean): boolean {
  return !tienePermisoEmisionNc;
}

/** PIN B — true si el selector de deposito explicito debe estar desbloqueado. */
export function puedeElegirDepositoExplicito(
  pinOverrideAutorizado: boolean,
): boolean {
  return pinOverrideAutorizado;
}

export interface ResolverDepositoOverrideInput {
  /** true solo cuando el segundo PIN de supervisor ya autorizo el override en esta sesion del modal. */
  pinOverrideAutorizado: boolean;
  /** Deposito elegido por el usuario en el selector (puede ser null aunque el PIN ya este autorizado, si todavia no eligio). */
  depositoElegidoId: string | null;
}

/** Resuelve el valor de override a exponer al llamador — null significa "sin override, riel automatico". */
export function resolverDepositoOverride(
  input: ResolverDepositoOverrideInput,
): string | null {
  if (!input.pinOverrideAutorizado) return null;
  return input.depositoElegidoId;
}
