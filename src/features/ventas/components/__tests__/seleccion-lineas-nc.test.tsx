import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SeleccionLineasNc, type LineaSeleccionNc } from '../seleccion-lineas-nc'

const facturaHistorica = { total_usd: 100, total_bs: 4000, tasa: 40 }

function lineaGravable(overrides: Partial<LineaSeleccionNc> = {}): LineaSeleccionNc {
  return {
    venta_det_id: 'vd-1',
    producto_nombre: 'Botox 50U',
    producto_codigo: 'P001',
    cantidadFacturada: 5,
    esDecimal: false,
    precioUnitarioUsd: 10,
    tipoImpuesto: 'Gravable',
    impuestoPct: 16,
    ...overrides,
  }
}

describe('SeleccionLineasNc (Design §Decision 7, Spec notas-credito-pos: Selección TOTAL/PARCIAL)', () => {
  it('boton Confirmar deshabilitado mientras todas las cantidades esten en 0', () => {
    render(<SeleccionLineasNc lineas={[lineaGravable()]} factura={facturaHistorica} onConfirm={vi.fn()} />)

    expect(screen.getByRole('button', { name: /Confirmar/i })).toBeDisabled()
  })

  it('al ingresar una cantidad valida > 0 habilita Confirmar; onConfirm recibe la linea mapeada al contrato de crearNotaCredito', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<SeleccionLineasNc lineas={[lineaGravable()]} factura={facturaHistorica} onConfirm={onConfirm} />)

    await user.type(screen.getByRole('spinbutton'), '2')

    const boton = screen.getByRole('button', { name: /Confirmar/i })
    expect(boton).not.toBeDisabled()

    await user.click(boton)

    expect(onConfirm).toHaveBeenCalledWith([{ venta_det_id: 'vd-1', cantidadDevolver: '2.000' }])
  })

  it('linea con esDecimal=false: el boton "+" incrementa el stepper exactamente en 1 (paso entero)', async () => {
    const user = userEvent.setup()
    render(
      <SeleccionLineasNc lineas={[lineaGravable({ esDecimal: false })]} factura={facturaHistorica} onConfirm={vi.fn()} />
    )

    await user.click(screen.getByRole('button', { name: /Incrementar cantidad/i }))

    expect(screen.getByRole('spinbutton')).toHaveValue(1)
  })

  it('linea con esDecimal=true: el boton "+" incrementa el stepper exactamente en 0.001 (paso decimal)', async () => {
    const user = userEvent.setup()
    render(
      <SeleccionLineasNc
        lineas={[lineaGravable({ esDecimal: true, cantidadFacturada: 2 })]}
        factura={facturaHistorica}
        onConfirm={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: /Incrementar cantidad/i }))

    expect(screen.getByRole('spinbutton')).toHaveValue(0.001)
  })

  it('linea con esDecimal=false: bloquea la tecla decimal (.) en el input de cantidad', async () => {
    const user = userEvent.setup()
    render(
      <SeleccionLineasNc
        lineas={[lineaGravable({ esDecimal: false, cantidadFacturada: 20 })]}
        factura={facturaHistorica}
        onConfirm={vi.fn()}
      />
    )

    const input = screen.getByRole('spinbutton')
    await user.type(input, '1.5')

    // El punto fue bloqueado por el guard de es_decimal=0 -> solo quedan los digitos "1" y "5" = 15
    expect(input).toHaveValue(15)
  })

  it('F6 QA fix: cantidad no puede exceder lo facturado — el input RECHAZA el valor excedido (no se escribe), Confirmar permanece deshabilitado y se muestra el mensaje de error', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(
      <SeleccionLineasNc
        lineas={[lineaGravable({ cantidadFacturada: 3, esDecimal: false })]}
        factura={facturaHistorica}
        onConfirm={onConfirm}
      />
    )

    await user.type(screen.getByRole('spinbutton'), '9')

    expect(screen.getByRole('spinbutton')).toHaveValue(null)
    expect(screen.getByRole('spinbutton')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText(/No puedes devolver más de la cantidad disponible/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Confirmar/i })).toBeDisabled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  // ─── F1 QA fix (Slice 5a): lineas parcialmente/totalmente reversadas ya
  // NO deben capar contra `cantidadFacturada` (cantidad ORIGINAL vendida)
  // sino contra `cantidadDisponible` (el remanente real tras NCs previas). ──

  it('F1+F6: cantidadDisponible menor a cantidadFacturada (linea ya parcialmente reversada) — el input RECHAZA cualquier valor por encima del REMANENTE, no de lo facturado', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(
      <SeleccionLineasNc
        lineas={[lineaGravable({ cantidadFacturada: 5, cantidadDisponible: 2, esDecimal: false })]}
        factura={facturaHistorica}
        onConfirm={onConfirm}
      />
    )

    await user.type(screen.getByRole('spinbutton'), '9')
    expect(screen.getByRole('spinbutton')).toHaveValue(null)
    expect(screen.getByText(/No puedes devolver más de la cantidad disponible/i)).toBeInTheDocument()

    await user.type(screen.getByRole('spinbutton'), '2')
    expect(screen.getByRole('spinbutton')).toHaveValue(2)
    expect(screen.queryByText(/No puedes devolver más de la cantidad disponible/i)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Confirmar/i }))
    expect(onConfirm).toHaveBeenCalledWith([{ venta_det_id: 'vd-1', cantidadDevolver: '2.000' }])
  })

  it('F1: FULLY-REVERSED GUARD — linea con cantidadDisponible=0 (ya reversada por completo): input y stepper quedan deshabilitados', () => {
    render(
      <SeleccionLineasNc
        lineas={[lineaGravable({ cantidadFacturada: 5, cantidadDisponible: 0 })]}
        factura={facturaHistorica}
        onConfirm={vi.fn()}
      />
    )

    expect(screen.getByRole('spinbutton')).toBeDisabled()
    expect(screen.getByRole('button', { name: /Incrementar cantidad/i })).toBeDisabled()
  })

  it('F1: sin cantidadDisponible especificado (compatibilidad hacia atras): el cap sigue siendo cantidadFacturada, rechaza cualquier valor por encima', async () => {
    const user = userEvent.setup()
    render(
      <SeleccionLineasNc lineas={[lineaGravable({ cantidadFacturada: 3, esDecimal: false })]} factura={facturaHistorica} onConfirm={vi.fn()} />
    )

    await user.type(screen.getByRole('spinbutton'), '9')
    expect(screen.getByRole('spinbutton')).toHaveValue(null)
  })

  // ─── F5 QA fix (Slice 5c): tope de 3 decimales en unidades decimales,
  // consistente con la precision de stock del proyecto (NUMERIC 3 decimales). ──

  it('F5: linea con esDecimal=true rechaza un 4to decimal — "1.2345" se detiene en "1.234" (tope 3 decimales)', async () => {
    const user = userEvent.setup()
    render(
      <SeleccionLineasNc
        lineas={[lineaGravable({ esDecimal: true, cantidadFacturada: 5 })]}
        factura={facturaHistorica}
        onConfirm={vi.fn()}
      />
    )

    const input = screen.getByRole('spinbutton')
    await user.type(input, '1.2345')

    expect(input).toHaveValue(1.234)
  })

  it('F5: linea con esDecimal=false sigue rechazando cualquier decimal (regresion — el cap de 3 decimales es exclusivo de unidades decimales)', async () => {
    const user = userEvent.setup()
    render(
      <SeleccionLineasNc
        lineas={[lineaGravable({ esDecimal: false, cantidadFacturada: 20 })]}
        factura={facturaHistorica}
        onConfirm={vi.fn()}
      />
    )

    const input = screen.getByRole('spinbutton')
    await user.type(input, '1.5')

    expect(input).toHaveValue(15)
  })

  it('muestra el preview de monto en Bs derivado de la tasa historica de la factura (nunca la tasa vigente)', async () => {
    const user = userEvent.setup()
    render(
      <SeleccionLineasNc
        lineas={[lineaGravable({ precioUnitarioUsd: 10, impuestoPct: 16, tipoImpuesto: 'Gravable' })]}
        factura={facturaHistorica}
        onConfirm={vi.fn()}
      />
    )

    await user.type(screen.getByRole('spinbutton'), '1')

    // 10 USD + 16% IVA = 11.60 USD a tasa historica 40 -> 464 Bs.
    expect(screen.getByText(/11[.,]60/)).toBeInTheDocument()
    expect(screen.getByText(/464/)).toBeInTheDocument()
  })
})
