import { describe, it, expect } from 'vitest'
import {
  draftKey,
  isDraftMeaningful,
  saveDraft,
  loadDraft,
  clearDraft,
  type ProductoFormDraft,
} from '../producto-form-draft'

/**
 * Storage en memoria que implementa la interfaz minima usada por los helpers
 * (getItem/setItem/removeItem), sin depender de localStorage real.
 */
function createMemoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
    removeItem: (key: string) => {
      map.delete(key)
    },
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size
    },
  } as Storage
}

function makeDraft(overrides: Partial<ProductoFormDraft> = {}): ProductoFormDraft {
  return {
    codigo: '',
    tipo: 'P',
    nombre: '',
    departamentoId: '',
    unidadBaseId: '',
    presentacion: '',
    stockMinimo: '',
    codigoBarras: '',
    isActive: true,
    duracionMin: null,
    costoUsd: '',
    precioVentaUsd: '',
    precioMayorUsd: '',
    precioEspecialUsd: '',
    margen: '',
    margenMayor: '',
    margenEspecial: '',
    tipoImpuesto: 'Exento',
    impuestoIvaId: '',
    ubicacion: '',
    manejaLotes: false,
    depositoId: '',
    stockInicial: '',
    activeTab: 'general',
    ...overrides,
  }
}

describe('draftKey', () => {
  it('genera una clave aislada por empresa', () => {
    expect(draftKey('emp-1')).toBe('producto-form-draft:emp-1')
    expect(draftKey('emp-2')).toBe('producto-form-draft:emp-2')
  })
})

describe('isDraftMeaningful', () => {
  it('retorna false para un borrador con solo valores por defecto', () => {
    expect(isDraftMeaningful(makeDraft())).toBe(false)
  })

  it('retorna true cuando hay nombre', () => {
    expect(isDraftMeaningful(makeDraft({ nombre: 'Crema' }))).toBe(true)
  })

  it('retorna true cuando hay codigo', () => {
    expect(isDraftMeaningful(makeDraft({ codigo: 'P-001' }))).toBe(true)
  })

  it('retorna true cuando hay costo cargado', () => {
    expect(isDraftMeaningful(makeDraft({ costoUsd: '10' }))).toBe(true)
  })

  it('ignora espacios en blanco como contenido', () => {
    expect(isDraftMeaningful(makeDraft({ nombre: '   ' }))).toBe(false)
  })
})

describe('saveDraft / loadDraft', () => {
  it('persiste y recupera un borrador con contenido', () => {
    const storage = createMemoryStorage()
    const draft = makeDraft({ nombre: 'Crema facial', codigo: 'P-100', costoUsd: '5.50' })
    saveDraft(storage, 'emp-1', draft)
    expect(loadDraft(storage, 'emp-1')).toEqual(draft)
  })

  it('no persiste un borrador vacio', () => {
    const storage = createMemoryStorage()
    saveDraft(storage, 'emp-1', makeDraft())
    expect(loadDraft(storage, 'emp-1')).toBeNull()
  })

  it('aisla los borradores por empresa', () => {
    const storage = createMemoryStorage()
    const draftA = makeDraft({ nombre: 'Producto A' })
    const draftB = makeDraft({ nombre: 'Producto B' })
    saveDraft(storage, 'emp-A', draftA)
    saveDraft(storage, 'emp-B', draftB)
    expect(loadDraft(storage, 'emp-A')).toEqual(draftA)
    expect(loadDraft(storage, 'emp-B')).toEqual(draftB)
  })

  it('limpia un borrador previo si el nuevo esta vacio', () => {
    const storage = createMemoryStorage()
    saveDraft(storage, 'emp-1', makeDraft({ nombre: 'Algo' }))
    saveDraft(storage, 'emp-1', makeDraft())
    expect(loadDraft(storage, 'emp-1')).toBeNull()
  })

  it('no persiste cuando empresaId esta vacio', () => {
    const storage = createMemoryStorage()
    saveDraft(storage, '', makeDraft({ nombre: 'Algo' }))
    expect(loadDraft(storage, '')).toBeNull()
  })
})

describe('loadDraft — datos invalidos', () => {
  it('retorna null cuando no existe borrador', () => {
    const storage = createMemoryStorage()
    expect(loadDraft(storage, 'emp-1')).toBeNull()
  })

  it('retorna null cuando el JSON esta corrupto', () => {
    const storage = createMemoryStorage()
    storage.setItem(draftKey('emp-1'), '{no es json valido')
    expect(loadDraft(storage, 'emp-1')).toBeNull()
  })

  it('retorna null cuando el JSON no es un objeto', () => {
    const storage = createMemoryStorage()
    storage.setItem(draftKey('emp-1'), '"un string"')
    expect(loadDraft(storage, 'emp-1')).toBeNull()
  })

  it('retorna null cuando el JSON es un array', () => {
    const storage = createMemoryStorage()
    storage.setItem(draftKey('emp-1'), '[1,2,3]')
    expect(loadDraft(storage, 'emp-1')).toBeNull()
  })
})

describe('clearDraft', () => {
  it('borra el borrador persistido', () => {
    const storage = createMemoryStorage()
    saveDraft(storage, 'emp-1', makeDraft({ nombre: 'Algo' }))
    clearDraft(storage, 'emp-1')
    expect(loadDraft(storage, 'emp-1')).toBeNull()
  })

  it('no afecta el borrador de otra empresa', () => {
    const storage = createMemoryStorage()
    saveDraft(storage, 'emp-1', makeDraft({ nombre: 'A' }))
    saveDraft(storage, 'emp-2', makeDraft({ nombre: 'B' }))
    clearDraft(storage, 'emp-1')
    expect(loadDraft(storage, 'emp-1')).toBeNull()
    expect(loadDraft(storage, 'emp-2')).not.toBeNull()
  })
})
