/**
 * Persistencia de borrador (draft) del formulario de producto.
 *
 * Regla de negocio: SOLO se persiste el borrador cuando se esta creando un
 * producto nuevo. En modo edicion (el modal se abre con un producto existente)
 * nunca se guarda ni se restaura nada.
 *
 * Se persisten unicamente los inputs primarios que tipea el usuario. Los valores
 * derivados (montos en Bs, proyecciones de precio) NO se guardan porque el
 * formulario los recalcula a partir de los primarios y la tasa vigente al abrir.
 *
 * Las funciones reciben el `Storage` por parametro para poder testearlas sin
 * depender de `localStorage` real (mismo patron que upload-retry-store).
 */

export interface ProductoFormDraft {
  codigo: string
  tipo: 'P' | 'S' | 'C'
  nombre: string
  departamentoId: string
  unidadBaseId: string
  presentacion: string
  stockMinimo: string
  codigoBarras: string
  isActive: boolean
  duracionMin: number | null
  costoUsd: string
  precioVentaUsd: string
  precioMayorUsd: string
  precioEspecialUsd: string
  margen: string
  margenMayor: string
  margenEspecial: string
  tipoImpuesto: 'Gravable' | 'Exento' | 'Exonerado'
  impuestoIvaId: string
  ubicacion: string
  manejaLotes: boolean
  depositoId: string
  stockInicial: string
  activeTab: string
}

const KEY_PREFIX = 'producto-form-draft'

/**
 * Genera la clave de storage aislada por empresa, para que el borrador de una
 * empresa nunca se mezcle con el de otra (multi-tenant).
 */
export function draftKey(empresaId: string): string {
  return `${KEY_PREFIX}:${empresaId}`
}

/**
 * Determina si un borrador tiene contenido util. Un borrador "vacio" (todos los
 * campos en su valor por defecto) no vale la pena persistir ni restaurar.
 */
export function isDraftMeaningful(draft: ProductoFormDraft): boolean {
  return Boolean(
    draft.codigo.trim() ||
      draft.nombre.trim() ||
      draft.departamentoId ||
      draft.costoUsd.trim() ||
      draft.precioVentaUsd.trim() ||
      draft.codigoBarras.trim() ||
      draft.presentacion.trim() ||
      draft.ubicacion.trim() ||
      draft.stockInicial.trim()
  )
}

/**
 * Guarda el borrador. Si no tiene contenido util, limpia cualquier borrador
 * previo en vez de persistir uno vacio.
 */
export function saveDraft(
  storage: Storage,
  empresaId: string,
  draft: ProductoFormDraft
): void {
  if (!empresaId) return
  if (!isDraftMeaningful(draft)) {
    clearDraft(storage, empresaId)
    return
  }
  try {
    storage.setItem(draftKey(empresaId), JSON.stringify(draft))
  } catch {
    // Storage lleno o no disponible: fallar en silencio, la persistencia es best-effort.
  }
}

/**
 * Carga el borrador persistido. Retorna null si no existe, esta corrupto o el
 * JSON no representa un objeto valido.
 */
export function loadDraft(
  storage: Storage,
  empresaId: string
): ProductoFormDraft | null {
  if (!empresaId) return null
  let raw: string | null
  try {
    raw = storage.getItem(draftKey(empresaId))
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as ProductoFormDraft
  } catch {
    return null
  }
}

/**
 * Borra el borrador persistido de la empresa.
 */
export function clearDraft(storage: Storage, empresaId: string): void {
  if (!empresaId) return
  try {
    storage.removeItem(draftKey(empresaId))
  } catch {
    // best-effort
  }
}
