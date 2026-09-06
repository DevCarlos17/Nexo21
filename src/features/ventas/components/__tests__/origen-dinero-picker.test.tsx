import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OrigenDineroPicker } from '../origen-dinero-picker'
import type { CuentaOrigenDineroOption } from '../../utils/origen-dinero-picker'

/**
 * Slice 4 (notas-credito-cuadre-origen-dinero): componente compartido de
 * multi-origen, usado por `nota-credito-pos-modal.tsx` (sin selector de
 * sesion — Decision 4 "carril protegido") y `crear-ncr-modal.tsx` (con
 * selector de sesion empresa-wide, una sola vez por NC — Decision 5).
 */

const cuentasSesion: CuentaOrigenDineroOption[] = [
  { tipo: 'SESION_EFECTIVO', cuentaId: 'metodo-usd', label: 'Efectivo USD', moneda: 'USD', saldoActual: '100.00' },
  { tipo: 'SESION_EFECTIVO', cuentaId: 'metodo-bs', label: 'Efectivo Bs', moneda: 'BS', saldoActual: '4000.00' },
]

const cuentasTesoreria: CuentaOrigenDineroOption[] = [
  { tipo: 'TESORERIA_EFECTIVO', cuentaId: 'caja-1', label: 'Caja Fuerte Principal', moneda: 'USD', saldoActual: '500.00' },
]

const cuentasBanco: CuentaOrigenDineroOption[] = [
  { tipo: 'BANCO', cuentaId: 'banco-1', label: 'Banesco', moneda: 'BS', saldoActual: '20000.00' },
]

function setup(overrides: Partial<React.ComponentProps<typeof OrigenDineroPicker>> = {}) {
  const onChange = vi.fn()
  const utils = render(
    <OrigenDineroPicker
      remanenteUsd="100.00"
      tasa="40"
      cuentasSesion={cuentasSesion}
      cuentasTesoreria={cuentasTesoreria}
      cuentasBanco={cuentasBanco}
      mostrarSelectorSesion={false}
      sesionesDisponibles={[]}
      onChange={onChange}
      {...overrides}
    />
  )
  return { onChange, ...utils }
}

describe('OrigenDineroPicker — filas dinamicas (add/remove)', () => {
  it('arranca sin filas y notifica invalido (no hay nada que cubrir)', () => {
    const { onChange } = setup()
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ valido: false }))
  })

  it('"Agregar origen" agrega una fila con selectores de tipo/cuenta/monto', async () => {
    const user = userEvent.setup()
    setup()

    await user.click(screen.getByRole('button', { name: /Agregar origen/i }))

    expect(screen.getAllByRole('combobox').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole('spinbutton')).toBeInTheDocument()
  })

  it('boton de eliminar fila la remueve del picker', async () => {
    const user = userEvent.setup()
    setup()

    await user.click(screen.getByRole('button', { name: /Agregar origen/i }))
    expect(screen.getByRole('spinbutton')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Eliminar origen/i }))
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
  })
})

describe('OrigenDineroPicker — seleccion de cuenta segun tipo', () => {
  it('elegir tipo "Efectivo de sesion" ofrece las cuentas de cuentasSesion', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole('button', { name: /Agregar origen/i }))

    const selects = screen.getAllByRole('combobox')
    const tipoSelect = selects[0]
    await user.selectOptions(tipoSelect, 'SESION_EFECTIVO')

    expect(screen.getByRole('option', { name: /Efectivo USD/i })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Efectivo Bs/i })).toBeInTheDocument()
  })

  it('elegir tipo "Banco" ofrece las cuentas de cuentasBanco', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole('button', { name: /Agregar origen/i }))

    const selects = screen.getAllByRole('combobox')
    await user.selectOptions(selects[0], 'BANCO')

    expect(screen.getByRole('option', { name: /Banesco/i })).toBeInTheDocument()
  })
})

describe('OrigenDineroPicker — total en vivo y credito a favor', () => {
  it('ingresar un monto por debajo del remanente muestra el hint de credito a favor con el monto correcto', async () => {
    const user = userEvent.setup()
    setup({ remanenteUsd: '100.00' })
    await user.click(screen.getByRole('button', { name: /Agregar origen/i }))

    const selects = screen.getAllByRole('combobox')
    await user.selectOptions(selects[0], 'SESION_EFECTIVO')
    await user.selectOptions(screen.getAllByRole('combobox')[1], 'metodo-usd')
    await user.type(screen.getByRole('spinbutton'), '60')

    expect(screen.getByText(/credito a favor/i)).toBeInTheDocument()
    expect(screen.getByText(/\$40\.00/)).toBeInTheDocument()
  })

  it('cubrir exactamente el remanente NO muestra hint de credito a favor', async () => {
    const user = userEvent.setup()
    setup({ remanenteUsd: '60.00' })
    await user.click(screen.getByRole('button', { name: /Agregar origen/i }))

    const selects = screen.getAllByRole('combobox')
    await user.selectOptions(selects[0], 'SESION_EFECTIVO')
    await user.selectOptions(screen.getAllByRole('combobox')[1], 'metodo-usd')
    await user.type(screen.getByRole('spinbutton'), '60')

    expect(screen.queryByText(/credito a favor/i)).not.toBeInTheDocument()
  })

  it('excede la disponibilidad de una cuenta de efectivo: muestra advertencia y notifica invalido', async () => {
    const { onChange } = setup({ remanenteUsd: '1000.00' })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Agregar origen/i }))

    const selects = screen.getAllByRole('combobox')
    await user.selectOptions(selects[0], 'SESION_EFECTIVO')
    await user.selectOptions(screen.getAllByRole('combobox')[1], 'metodo-usd')
    await user.type(screen.getByRole('spinbutton'), '500')

    expect(screen.getByText(/insuficiente/i)).toBeInTheDocument()
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ valido: false }))
  })
})

describe('OrigenDineroPicker — selector de sesion destino (Decision 5, solo TRADICIONAL)', () => {
  it('mostrarSelectorSesion=false (POS): nunca renderiza un selector de sesion', async () => {
    const user = userEvent.setup()
    setup({ mostrarSelectorSesion: false, sesionesDisponibles: [{ id: 's1', label: 'Caja 1 — Maria' }] })
    await user.click(screen.getByRole('button', { name: /Agregar origen/i }))
    await user.selectOptions(screen.getAllByRole('combobox')[0], 'SESION_EFECTIVO')

    expect(screen.queryByText(/sesion destino/i)).not.toBeInTheDocument()
  })

  it('mostrarSelectorSesion=true + una fila SESION_EFECTIVO: aparece UNA sola vez el selector de sesion', async () => {
    const user = userEvent.setup()
    setup({
      mostrarSelectorSesion: true,
      sesionesDisponibles: [{ id: 's1', label: 'Caja 1 — Maria' }, { id: 's2', label: 'Caja 2 — Juan' }],
    })
    await user.click(screen.getByRole('button', { name: /Agregar origen/i }))
    await user.selectOptions(screen.getAllByRole('combobox')[0], 'SESION_EFECTIVO')

    expect(screen.getByText(/sesion destino/i)).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Caja 1 — Maria/i })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Caja 2 — Juan/i })).toBeInTheDocument()
  })

  it('sin filas SESION_EFECTIVO (solo BANCO): el selector de sesion NO aparece aunque mostrarSelectorSesion=true', async () => {
    const user = userEvent.setup()
    setup({ mostrarSelectorSesion: true, sesionesDisponibles: [{ id: 's1', label: 'Caja 1' }] })
    await user.click(screen.getByRole('button', { name: /Agregar origen/i }))
    await user.selectOptions(screen.getAllByRole('combobox')[0], 'BANCO')

    expect(screen.queryByText(/sesion destino/i)).not.toBeInTheDocument()
  })

  it('eligiendo la sesion destino, el onChange resultante incluye sesionDestinoId', async () => {
    const user = userEvent.setup()
    const { onChange } = setup({
      mostrarSelectorSesion: true,
      sesionesDisponibles: [{ id: 's1', label: 'Caja 1 — Maria' }],
      remanenteUsd: '100.00',
    })
    await user.click(screen.getByRole('button', { name: /Agregar origen/i }))
    const selects = screen.getAllByRole('combobox')
    await user.selectOptions(selects[0], 'SESION_EFECTIVO')
    await user.selectOptions(screen.getAllByRole('combobox')[1], 'metodo-usd')
    await user.type(screen.getByRole('spinbutton'), '50')

    const sesionSelect = screen.getByLabelText(/sesion destino/i)
    await user.selectOptions(sesionSelect, 's1')

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ sesionDestinoId: 's1' }))
  })
})

describe('OrigenDineroPicker — payload final via onChange', () => {
  it('con una fila valida completa, onChange expone origenDinero con el contrato exacto {tipo, cuentaId, monto}', async () => {
    const user = userEvent.setup()
    const { onChange } = setup({ remanenteUsd: '100.00' })
    await user.click(screen.getByRole('button', { name: /Agregar origen/i }))
    const selects = screen.getAllByRole('combobox')
    await user.selectOptions(selects[0], 'BANCO')
    await user.selectOptions(screen.getAllByRole('combobox')[1], 'banco-1')
    await user.type(screen.getByRole('spinbutton'), '500')

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        valido: true,
        origenDinero: [{ tipo: 'BANCO', cuentaId: 'banco-1', monto: '500' }],
      })
    )
  })
})
