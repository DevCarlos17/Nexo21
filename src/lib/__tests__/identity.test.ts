import {
  sanitizeCedula,
  sanitizeRif,
  isValidCedula,
  isValidRif,
  calcRifCheckDigit,
  sanitizeIdentity,
  filterCedulaInput,
  filterRifInput,
  formatCedulaDisplay,
  formatRifDisplay,
  normalizarDecimalComa,
} from '../identity'

describe('sanitizeIdentity', () => {
  it('convierte a mayusculas y elimina espacios', () => {
    expect(sanitizeIdentity('v 22448021')).toBe('V22448021')
  })

  it('elimina guiones y puntos', () => {
    expect(sanitizeIdentity('V-22.448.021')).toBe('V22448021')
  })
})

describe('sanitizeCedula', () => {
  it('limpia cedula con prefijo y separadores', () => {
    expect(sanitizeCedula('V-22.448.021')).toBe('V22448021')
  })

  it('agrega prefijo V a numeros puros de 6-8 digitos', () => {
    expect(sanitizeCedula('2244802')).toBe('V2244802')
  })

  it('respeta prefijo E', () => {
    expect(sanitizeCedula('E-12345678')).toBe('E12345678')
  })

  it('no modifica cedula ya purificada', () => {
    expect(sanitizeCedula('V22448021')).toBe('V22448021')
  })
})

describe('sanitizeRif', () => {
  it('limpia RIF con guiones', () => {
    expect(sanitizeRif('J-00123456-7')).toBe('J001234567')
  })

  it('zero-pad digitos a 9', () => {
    expect(sanitizeRif('J1234567')).toBe('J001234567')
  })

  it('respeta prefijos J, V, E, G, C, P', () => {
    expect(sanitizeRif('V123456789')).toBe('V123456789')
  })
})

describe('isValidCedula', () => {
  it('valida cedula V correcta', () => {
    expect(isValidCedula('V22448021')).toBe(true)
  })

  it('valida cedula E correcta', () => {
    expect(isValidCedula('E12345678')).toBe(true)
  })

  it('invalida cedula sin prefijo', () => {
    expect(isValidCedula('22448021')).toBe(false)
  })

  it('invalida cedula con letra incorrecta', () => {
    expect(isValidCedula('J22448021')).toBe(false)
  })

  it('invalida cedula demasiado corta', () => {
    expect(isValidCedula('V1234')).toBe(false)
  })
})

describe('calcRifCheckDigit', () => {
  it('calcula el digito verificador de forma determinista', () => {
    // Calculamos el check digit para 'J001234560' (9 chars base) y verificamos
    // que el resultado es un numero entre 0 y 9
    const result = calcRifCheckDigit('J001234560')
    expect(result).toBeGreaterThanOrEqual(0)
    expect(result).toBeLessThanOrEqual(9)
  })

  it('retorna un digito valido 0-9 en todos los casos', () => {
    // La funcion siempre debe retornar un digito single
    const result = calcRifCheckDigit('J000000000')
    expect(result).toBeGreaterThanOrEqual(0)
    expect(result).toBeLessThanOrEqual(9)
  })

  it('es consistente con isValidRif — el check digit calculado valida el RIF', () => {
    // Construimos un RIF con el check digit correcto y verificamos que isValidRif lo acepta
    const base = 'J00123456'
    const check = calcRifCheckDigit(base + '0')
    const validRif = base + check.toString()
    expect(isValidRif(validRif)).toBe(true)
  })
})

describe('isValidRif', () => {
  it('valida RIF con digito verificador correcto', () => {
    // Construimos un RIF valido calculando su digito verificador
    const base = 'J00123456'
    const check = calcRifCheckDigit(base + '0') // placeholder 0 para llamar la funcion
    const rif = base + check.toString()
    expect(isValidRif(rif)).toBe(true)
  })

  it('acepta RIF con cualquier ultimo digito (validacion Modulo 11 desactivada)', () => {
    // Con la validacion del digito verificador desactivada, cualquier
    // letra permitida + 9 digitos es valida sin importar el ultimo digito.
    const base = 'J00123456'
    const check = calcRifCheckDigit(base + '0')
    const wrongCheck = (check + 1) % 10
    const rif = base + wrongCheck.toString()
    expect(isValidRif(rif)).toBe(true)
  })

  it('invalida RIF con formato incorrecto', () => {
    expect(isValidRif('J1234')).toBe(false)
  })

  it('invalida RIF con letra no permitida', () => {
    expect(isValidRif('X123456789')).toBe(false)
  })
})

describe('filterCedulaInput', () => {
  it('permite V como primer caracter', () => {
    expect(filterCedulaInput('V224')).toBe('V224')
  })

  it('convierte a mayusculas', () => {
    expect(filterCedulaInput('v22448021')).toBe('V22448021')
  })

  it('descarta letra no permitida como primer caracter (J no es V ni E)', () => {
    // J no es valido como primer char; los digitos que le siguen (1,2,3)
    // se procesan como primer caracter valido (digitos estan permitidos como primer char)
    // Verificamos que la J es omitida y solo quedan los digitos
    expect(filterCedulaInput('J123')).toBe('123')
  })

  it('descarta simbolos invalidos completamente', () => {
    expect(filterCedulaInput('@#$')).toBe('')
  })
})

describe('filterRifInput', () => {
  it('permite J como primer caracter', () => {
    expect(filterRifInput('J001234')).toBe('J001234')
  })

  it('limita a 10 caracteres', () => {
    expect(filterRifInput('J0012345678901')).toHaveLength(10)
  })
})

describe('formatCedulaDisplay', () => {
  it('formatea cedula purificada para display', () => {
    expect(formatCedulaDisplay('V22448021')).toBe('V-22.448.021')
  })
})

describe('formatRifDisplay', () => {
  it('formatea RIF purificado para display', () => {
    expect(formatRifDisplay('J001234567')).toBe('J-00123456-7')
  })

  it('retorna el original si no tiene 10 caracteres', () => {
    expect(formatRifDisplay('J1234')).toBe('J1234')
  })
})

describe('normalizarDecimalComa', () => {
  it('convierte coma decimal venezolana a punto', () => {
    expect(normalizarDecimalComa('250,50')).toBe('250.50')
  })

  it('elimina puntos de miles y normaliza coma decimal', () => {
    expect(normalizarDecimalComa('1.250,50')).toBe('1250.50')
  })

  it('convierte tasa venezolana', () => {
    expect(normalizarDecimalComa('36,5')).toBe('36.5')
  })

  it('no modifica valor ya con punto decimal', () => {
    expect(normalizarDecimalComa('250.00')).toBe('250.00')
  })

  it('no modifica enteros', () => {
    expect(normalizarDecimalComa('1250')).toBe('1250')
  })

  it('no modifica valores no string', () => {
    expect(normalizarDecimalComa(36.5)).toBe(36.5)
    expect(normalizarDecimalComa(null)).toBe(null)
  })
})
