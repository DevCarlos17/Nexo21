import { render, screen, within } from '@testing-library/react'
import { FacturaDetallePanel } from '../factura-detalle-panel'
import { buildReciboData, type ReciboData } from '../../utils/factura-export'

function baseRecibo(overrides: Partial<Parameters<typeof buildReciboData>[0]> = {}): ReciboData {
  return buildReciboData({
    nroFactura: 'C01-000001',
    fecha: '2026-01-01T10:00:00.000-04:00',
    emisor: { nombre: 'ClaraPOS Estetica C.A.', rif: 'J-12345678-9', direccion: null },
    cliente: { nombre: 'Maria Perez', identificacion: 'V-12345678', direccion: null },
    lineas: [
      {
        codigo: 'P001',
        nombre: 'Botox 50U',
        cantidad: '2',
        precioUnitarioUsd: '10.00',
        tipoImpuesto: 'Gravable',
        impuestoPct: 16,
      },
    ],
    tasa: 40,
    igtfUsd: null,
    pagos: [{ metodo_cobro_id: 'm1', metodo_nombre: 'Efectivo USD', moneda: 'USD', monto: 23.2 }],
    discrepancy: null,
    saldoPendUsd: 0,
    ...overrides,
  })
}

describe('FacturaDetallePanel (Spec notas-credito-pos: Panel de detalle fiscal de la factura seleccionada)', () => {
  it('sin recibo (null): el panel no muestra datos de factura', () => {
    render(<FacturaDetallePanel recibo={null} />)

    expect(screen.queryByText('C01-000001')).not.toBeInTheDocument()
    expect(screen.queryByText('Botox 50U')).not.toBeInTheDocument()
  })

  it('con recibo: muestra articulos (cantidad, precio Bs/USD), subtotal, base imponible, IVA por alicuota y total', () => {
    render(<FacturaDetallePanel recibo={baseRecibo()} />)

    expect(screen.getByText('Botox 50U')).toBeInTheDocument()
    expect(screen.getByText('$10.00')).toBeInTheDocument() // precio unitario USD
    expect(screen.getByText('Bs. 400,00')).toBeInTheDocument() // precio unitario Bs (10 * 40)
    expect(screen.getByText('Base Imponible')).toBeInTheDocument()
    expect(screen.getByText('IVA 16%')).toBeInTheDocument()
    expect(screen.getByText('TOTAL FACTURA')).toBeInTheDocument()
  })

  it('linea exenta: muestra el desglose de Monto Exento separado de la Base Imponible', () => {
    const recibo = baseRecibo({
      lineas: [
        {
          codigo: 'P002',
          nombre: 'Consulta',
          cantidad: '1',
          precioUnitarioUsd: '15.00',
          tipoImpuesto: 'Exento',
          impuestoPct: 0,
        },
      ],
    })

    render(<FacturaDetallePanel recibo={recibo} />)

    expect(screen.getByText('Monto Exento')).toBeInTheDocument()
    expect(screen.queryByText('Base Imponible')).not.toBeInTheDocument()
  })

  it('factura con IGTF aplicado: muestra el monto de IGTF calculado por buildReciboData', () => {
    const recibo = baseRecibo({ igtfUsd: 0.6 })

    render(<FacturaDetallePanel recibo={recibo} />)

    expect(screen.getByText('IGTF')).toBeInTheDocument()
    expect(screen.getByText('TOTAL + IGTF')).toBeInTheDocument()
  })

  it('sin IGTF: no muestra fila de IGTF', () => {
    render(<FacturaDetallePanel recibo={baseRecibo()} />)

    expect(screen.queryByText('IGTF')).not.toBeInTheDocument()
  })
})

// ─── Slice 5d (QA 2.5/2.6, obs #2896/#2897): el desglose de metodos de pago
// y la seccion de afectacion CxC se OCULTAN — dan datos incorrectos cuando
// el excedente de un pago se abono por FIFO a OTRA factura (flujo SAF),
// porque `crearVenta` no persiste back-reference hacia la venta origen. ────

describe('FacturaDetallePanel — Slice 5d (ocultar seccion CxC no confiable, pendiente change CxC)', () => {
  it('NUNCA muestra el desglose de metodos de pago, incluso con pagos presentes en el recibo', () => {
    render(<FacturaDetallePanel recibo={baseRecibo()} />)

    expect(screen.queryByText('Metodos de pago')).not.toBeInTheDocument()
    expect(screen.queryByText('Efectivo USD')).not.toBeInTheDocument()
    expect(screen.queryByText('Total abonos')).not.toBeInTheDocument()
  })

  it('NUNCA muestra la seccion de afectacion a cuentas por cobrar', () => {
    render(<FacturaDetallePanel recibo={baseRecibo()} />)

    expect(screen.queryByText(/afect(o|ó) cuentas por cobrar/i)).not.toBeInTheDocument()
  })

  it('el resto del panel (lineas, totales fiscales) sigue visible sin las secciones ocultas', () => {
    render(<FacturaDetallePanel recibo={baseRecibo()} />)

    expect(screen.getByText('Botox 50U')).toBeInTheDocument()
    expect(screen.getByText('TOTAL FACTURA')).toBeInTheDocument()
  })
})

// ─── F1 QA fix (Slice 5a): historial de reversos additivo — el panel SIEMPRE
// muestra la factura original completa y, si tiene NC(s) aplicadas, ADEMAS
// el historial de lo reversado (nunca reemplaza la vista original). ────

describe('FacturaDetallePanel — F1 QA fix (historial de reversos additivo, junto al detalle original)', () => {
  it('sin reversos (prop omitida o vacia): NO muestra la seccion de notas de credito aplicadas', () => {
    render(<FacturaDetallePanel recibo={baseRecibo()} />)

    expect(screen.queryByText(/Notas de credito aplicadas/i)).not.toBeInTheDocument()
  })

  it('con reversos: el detalle ORIGINAL sigue visible Y ademas se muestra cada NC con su numero/tipo y las lineas devueltas', () => {
    render(
      <FacturaDetallePanel
        recibo={baseRecibo()}
        reversos={[
          {
            notaCreditoId: 'nc-1',
            nroNcr: 'NCR-000001',
            tipo: 'PARCIAL',
            fecha: '2026-01-02T00:00:00Z',
            lineas: [{ descripcion: 'Botox 50U', cantidad: '1.000' }],
          },
        ]}
      />
    )

    // Original sigue completo (aditivo, no reemplazado).
    expect(screen.getAllByText('Botox 50U').length).toBeGreaterThan(0)
    // Historial de reverso agregado.
    expect(screen.getByText(/Notas de credito aplicadas/i)).toBeInTheDocument()
    expect(screen.getByText('NCR-000001')).toBeInTheDocument()
    expect(screen.getByText(/1\.000/)).toBeInTheDocument()
  })

  it('multiples NCs aplicadas: cada una se muestra en su propia entrada', () => {
    render(
      <FacturaDetallePanel
        recibo={baseRecibo()}
        reversos={[
          {
            notaCreditoId: 'nc-1',
            nroNcr: 'NCR-000001',
            tipo: 'PARCIAL',
            fecha: '2026-01-02T00:00:00Z',
            lineas: [{ descripcion: 'Botox 50U', cantidad: '1.000' }],
          },
          {
            notaCreditoId: 'nc-2',
            nroNcr: 'NCR-000002',
            tipo: 'TOTAL',
            fecha: '2026-01-03T00:00:00Z',
            lineas: [{ descripcion: 'Consulta', cantidad: '1.000' }],
          },
        ]}
      />
    )

    expect(screen.getByText('NCR-000001')).toBeInTheDocument()
    expect(screen.getByText('NCR-000002')).toBeInTheDocument()
  })
})

// ─── F3 QA fix (Slice 5b): el desglose fiscal del panel SIEMPRE muestra el
// monto en Bs (ademas del USD), a la tasa HISTORICA de la factura
// (`recibo.totales`, ya calculado por `buildReciboData` con la tasa
// persistida — nunca la tasa vigente del sistema). ────

describe('FacturaDetallePanel — F3 QA fix (Bs en el desglose fiscal, tasa historica)', () => {
  it('Base Imponible e IVA muestran tambien el monto en Bs (tasa=40 de la factura)', () => {
    render(<FacturaDetallePanel recibo={baseRecibo()} />)

    // Filas de totales escopeadas (no la tabla de lineas de arriba, que puede
    // coincidir en el monto cuando hay una unica linea).
    const baseRow = screen.getByText('Base Imponible').closest('div') as HTMLElement
    const ivaRow = screen.getByText('IVA 16%').closest('div') as HTMLElement

    // Botox 50U: 2 * $10.00 = $20.00 base imponible -> Bs. 800,00 (tasa 40)
    expect(within(baseRow).getByText('Bs. 800,00')).toBeInTheDocument()
    // IVA 16% de $20.00 = $3.20 -> Bs. 128,00
    expect(within(ivaRow).getByText('Bs. 128,00')).toBeInTheDocument()
  })

  it('Monto Exento tambien muestra su equivalente en Bs', () => {
    const recibo = baseRecibo({
      lineas: [
        {
          codigo: 'P002',
          nombre: 'Consulta',
          cantidad: '1',
          precioUnitarioUsd: '15.00',
          tipoImpuesto: 'Exento',
          impuestoPct: 0,
        },
      ],
    })

    render(<FacturaDetallePanel recibo={recibo} />)

    // $15.00 exento * tasa 40 = Bs. 600,00 — escopeado a la fila de totales
    const exentoRow = screen.getByText('Monto Exento').closest('div') as HTMLElement
    expect(within(exentoRow).getByText('Bs. 600,00')).toBeInTheDocument()
  })

  it('IGTF tambien muestra su equivalente en Bs', () => {
    const recibo = baseRecibo({ igtfUsd: 0.6 })

    render(<FacturaDetallePanel recibo={recibo} />)

    // $0.60 IGTF * tasa 40 = Bs. 24,00
    expect(screen.getByText('Bs. 24,00')).toBeInTheDocument()
  })
})

// ─── F7 QA fix (Slice 5b): overlay diagonal "REVERSADA"/"REVERSO PARCIAL" —
// puramente decorativo (`aria-hidden` + `pointer-events-none`) para no
// bloquear la interactividad que F1 habilito sobre facturas reversadas. ────

describe('FacturaDetallePanel — F7 QA fix (overlay diagonal REVERSADA)', () => {
  it('sin reversos: no muestra ningun overlay', () => {
    render(<FacturaDetallePanel recibo={baseRecibo()} />)

    expect(screen.queryByText('REVERSADA')).not.toBeInTheDocument()
    expect(screen.queryByText('REVERSO PARCIAL')).not.toBeInTheDocument()
  })

  it('con un reverso TOTAL: muestra overlay "REVERSADA", decorativo (aria-hidden + pointer-events-none)', () => {
    render(
      <FacturaDetallePanel
        recibo={baseRecibo()}
        badgeReverso="TOTAL"
        reversos={[
          { notaCreditoId: 'nc-1', nroNcr: 'NCR-000001', tipo: 'TOTAL', fecha: '2026-01-02T00:00:00Z', lineas: [] },
        ]}
      />
    )

    const overlay = screen.getByText('REVERSADA')
    expect(overlay.closest('[aria-hidden="true"]')).not.toBeNull()
    expect(overlay.closest('.pointer-events-none')).not.toBeNull()
  })

  it('con reverso(s) PARCIAL (sin ningun TOTAL): muestra overlay "REVERSO PARCIAL"', () => {
    render(
      <FacturaDetallePanel
        recibo={baseRecibo()}
        badgeReverso="PARCIAL"
        reversos={[
          { notaCreditoId: 'nc-1', nroNcr: 'NCR-000001', tipo: 'PARCIAL', fecha: '2026-01-02T00:00:00Z', lineas: [] },
        ]}
      />
    )

    expect(screen.getByText('REVERSO PARCIAL')).toBeInTheDocument()
    expect(screen.queryByText('REVERSADA')).not.toBeInTheDocument()
  })

  // BUG E: la factura alcanza el 100% de reverso por ACUMULACION de NCs
  // PARCIALes (ninguna individualmente 'TOTAL') — el overlay debe reflejar
  // el estado ACUMULADO (badgeReverso, misma fuente que el badge de la
  // lista y el mensaje "reversada totalmente"), NO el tipo crudo de cada
  // registro de `reversos` (que aqui son todos 'PARCIAL').
  it('reverso TOTAL alcanzado por PARCIALes acumulados: muestra overlay "REVERSADA", NO "REVERSO PARCIAL"', () => {
    render(
      <FacturaDetallePanel
        recibo={baseRecibo()}
        badgeReverso="TOTAL"
        reversos={[
          { notaCreditoId: 'nc-1', nroNcr: 'NCR-000001', tipo: 'PARCIAL', fecha: '2026-01-02T00:00:00Z', lineas: [] },
          { notaCreditoId: 'nc-2', nroNcr: 'NCR-000002', tipo: 'PARCIAL', fecha: '2026-01-03T00:00:00Z', lineas: [] },
        ]}
      />
    )

    expect(screen.getByText('REVERSADA')).toBeInTheDocument()
    expect(screen.queryByText('REVERSO PARCIAL')).not.toBeInTheDocument()
  })
})
