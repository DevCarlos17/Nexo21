/**
 * Utilidades de identidad fiscal venezolana
 * Cedula: [VE]\d{5,9}  (ej: V22448021)
 * RIF:    [VEJGCP]\d{9} (ej: J001234567)
 *
 * Almacenamiento siempre SIN guiones (formato purificado).
 */

const LETTER_VALUES: Record<string, number> = { V: 1, E: 2, J: 3, G: 4, C: 5, P: 6 }
const RIF_WEIGHTS = [4, 3, 2, 7, 6, 5, 4, 3, 2]

// ---------------------------------------------------------------------------
// Sanitizacion
// ---------------------------------------------------------------------------

/** Paso base: trim, uppercase, elimina espacios / puntos / guiones / barras */
export function sanitizeIdentity(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s.\-\/]/g, '')
}

/**
 * Sanitiza una cedula venezolana para almacenamiento purificado.
 * - "V-22.448.021"  → "V22448021"
 * - "22448021"      → "V22448021"  (auto-prepend V si son 6-8 digitos puros)
 */
export function sanitizeCedula(raw: string): string {
  const cleaned = sanitizeIdentity(raw)
  if (/^[VE]\d+$/.test(cleaned)) return cleaned
  if (/^\d{6,8}$/.test(cleaned)) return 'V' + cleaned
  return cleaned
}

/**
 * Sanitiza un RIF venezolano para almacenamiento purificado.
 * - "J-00123456-7"  → "J001234567"
 * - "J1234567"      → "J001234567"  (zero-pad a 9 digitos)
 * - Resultado siempre 10 caracteres si el formato base es correcto.
 */
export function sanitizeRif(raw: string): string {
  const cleaned = sanitizeIdentity(raw)
  const match = cleaned.match(/^([VEJGCP])(\d+)$/)
  if (!match) return cleaned
  const [, prefix, digits] = match
  return prefix + digits.padStart(9, '0')
}

// ---------------------------------------------------------------------------
// Validacion
// ---------------------------------------------------------------------------

/** Valida cedula purificada (sin guiones) */
export function isValidCedula(value: string): boolean {
  return /^[VE]\d{5,9}$/.test(value)
}

/**
 * Calcula el digito verificador Modulo 11 para un RIF.
 * Recibe los primeros 9 caracteres del RIF (letra + 8 digitos).
 */
export function calcRifCheckDigit(rif: string): number {
  const letterVal = LETTER_VALUES[rif[0]] ?? 0
  const values = [letterVal, ...rif.slice(1, 9).split('').map(Number)]
  const suma = values.reduce((acc, val, i) => acc + val * RIF_WEIGHTS[i], 0)
  const digito = 11 - (suma % 11)
  return digito >= 10 ? 0 : digito
}

/**
 * Valida RIF purificado (10 chars): letra permitida [VEJGCP] + 9 digitos.
 *
 * NOTA: validacion del digito verificador Modulo 11 desactivada temporalmente.
 * Solo se valida el formato (letra permitida + 9 digitos). Reactivar el bloque
 * comentado cuando se confirmen los valores de letra y se quiera exigir el
 * digito verificador de nuevo.
 */
export function isValidRif(value: string): boolean {
  return /^[VEJGCP]\d{9}$/.test(value)
  // --- Validacion Modulo 11 (desactivada) ---
  // Reactivar declarando: const RIF_CHECK_DIGIT_ENFORCED = new Set(['J', 'V', 'E'])
  // if (!/^[VEJGCP]\d{9}$/.test(value)) return false
  // if (!RIF_CHECK_DIGIT_ENFORCED.has(value[0])) return true
  // const expectedCheck = calcRifCheckDigit(value.slice(0, 9))
  // return expectedCheck.toString() === value[9]
}

// ---------------------------------------------------------------------------
// Filtrado de input en tiempo real
// ---------------------------------------------------------------------------

/**
 * Filtra el input de cedula en tiempo real.
 * Permite [VE] como primer caracter + solo digitos despues. Uppercase automatico.
 * Tambien acepta digito como primer caracter (para cedulas sin prefijo).
 */
export function filterCedulaInput(value: string): string {
  const upper = value.toUpperCase()
  let result = ''
  for (let i = 0; i < upper.length; i++) {
    const char = upper[i]
    if (result.length === 0) {
      if (/[VE\d]/.test(char)) result += char
    } else {
      if (/\d/.test(char)) result += char
    }
  }
  return result
}

/**
 * Filtra el input de RIF en tiempo real.
 * Permite [VEJGCP] como primer caracter + solo digitos despues. Uppercase automatico.
 * Longitud maxima: 10 caracteres.
 */
export function filterRifInput(value: string): string {
  const upper = value.toUpperCase()
  let result = ''
  for (let i = 0; i < upper.length; i++) {
    const char = upper[i]
    if (result.length === 0) {
      if (/[VEJGCP]/.test(char)) result += char
    } else {
      if (/\d/.test(char)) result += char
    }
    if (result.length >= 10) break
  }
  return result
}

// ---------------------------------------------------------------------------
// Display (formato legible para mostrar en pantalla)
// ---------------------------------------------------------------------------

/**
 * Formatea cedula purificada para display con separadores.
 * "V22448021" → "V-22.448.021"
 */
export function formatCedulaDisplay(purified: string): string {
  if (!purified || purified.length < 2) return purified
  const prefix = purified[0]
  const numStr = purified.slice(1)
  const formatted = numStr.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${prefix}-${formatted}`
}

/**
 * Formatea RIF purificado para display con guiones.
 * "J001234567" → "J-00123456-7"
 */
export function formatRifDisplay(purified: string): string {
  if (!purified || purified.length !== 10) return purified
  const prefix = purified[0]
  const body = purified.slice(1, 9)
  const check = purified[9]
  return `${prefix}-${body}-${check}`
}

// ---------------------------------------------------------------------------
// Normalizacion de decimales (separador venezolano: coma)
// ---------------------------------------------------------------------------

/**
 * Normaliza el separador decimal de coma a punto para procesamiento interno.
 * Acepta formato venezolano/europeo donde la coma es decimal y el punto es miles.
 *
 * Ejemplos:
 *   "250,50"    → "250.50"
 *   "1.250,50"  → "1250.50"
 *   "36,5"      → "36.5"
 *   "250.00"    → "250.00"  (ya correcto, pasa sin cambio)
 *   "1250"      → "1250"    (entero, pasa sin cambio)
 */
export function normalizarDecimalComa(v: unknown): unknown {
  if (typeof v !== 'string') return v
  const s = v.trim()
  // Patron: termina en ,d o ,dd (coma como separador decimal)
  const m = s.match(/^([\d.]+),(\d{1,4})$/)
  if (m) {
    const intPart = m[1].replace(/\./g, '') // eliminar puntos de miles
    return `${intPart}.${m[2]}`
  }
  return s
}
