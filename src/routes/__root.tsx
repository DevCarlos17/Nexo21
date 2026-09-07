import { useEffect } from 'react'
import { Outlet, createRootRoute } from '@tanstack/react-router'
import { toast, Toaster } from 'sonner'
import { PWAInstallBanner } from '@/components/pwa/pwa-install-banner'
import { PWAUpdateBanner } from '@/components/pwa/pwa-update-banner'
import { connector } from '@/core/db/powersync/connector'
import type { UploadFailedInfo } from '@/core/db/powersync/connector'

export const Route = createRootRoute({
  component: RootComponent,
})

// Nombres legibles por módulo para los mensajes de error al usuario
const TABLE_LABELS: Record<string, string> = {
  facturas_compra:              'Factura de Compra',
  facturas_compra_det:          'Detalle de Factura de Compra',
  ventas:                       'Venta',
  ventas_det:                   'Detalle de Venta',
  pagos:                        'Pago',
  notas_credito:                'Nota de Crédito',
  notas_debito:                 'Nota de Débito',
  movimientos_inventario:       'Movimiento de Inventario',
  movimientos_cuenta:           'Movimiento de Cuenta',
  clientes:                     'Cliente',
  proveedores:                  'Proveedor',
  productos:                    'Producto',
  ajustes:                      'Ajuste de Inventario',
  sesiones_caja:                'Sesión de Caja',
  movimientos_bancarios:        'Movimiento Bancario',
  citas:                        'Cita',
  retenciones_iva_ventas:       'Retención IVA',
  retenciones_islr_ventas:      'Retención ISLR',
}

function buildUploadFailedMessage(info: UploadFailedInfo): {
  title: string
  description: string
} {
  const label = TABLE_LABELS[info.table] ?? info.table

  if (info.reason === 'max_retries') {
    return {
      title: `No se pudo sincronizar: ${label}`,
      description: `La operación falló ${5} veces seguidas por problemas de conexión y fue descartada. Verificá tu red y volvé a ingresar el dato si es necesario.`,
    }
  }

  if (info.reason === 'validation') {
    return {
      title: `Dato inválido descartado: ${label}`,
      description: info.message,
    }
  }

  // reason === 'db_error'
  const isConstraint = info.code.startsWith('23')
  const isTrigger    = info.code === 'P0001'
  const isRls        = info.code === '42501'

  let description: string
  if (isConstraint) {
    description = 'El servidor rechazó el registro porque viola una regla de datos (duplicado o valor inválido). Revisá los datos y volvé a ingresarlos.'
  } else if (isTrigger) {
    description = 'El servidor rechazó el registro por una regla de negocio. Revisá los datos con un supervisor.'
  } else if (isRls) {
    description = 'Sin permiso para guardar este registro. Contactá al administrador.'
  } else {
    description = `Error del servidor (código ${info.code}). Revisá los datos y volvé a intentarlo.`
  }

  return {
    title: `No se pudo sincronizar: ${label}`,
    description,
  }
}

function RootComponent() {
  useEffect(() => {
    // Suscribirse a fallos fatales de upload de PowerSync.
    // Estos ocurren cuando una operación registrada offline es rechazada por la DB
    // al volver la conexión. El registro existe en SQLite local pero NO en Supabase.
    const unsub = connector.registerListener({
      uploadFailed: (info: UploadFailedInfo) => {
        const { title, description } = buildUploadFailedMessage(info)
        toast.error(title, {
          description,
          duration: Infinity,   // No se cierra solo — el usuario debe leerlo y cerrarlo
          closeButton: true,
        })
      },
    })

    return () => { unsub?.() }
  }, [])

  return (
    <>
      <Outlet />
      <Toaster position="top-right" richColors duration={1500} />
      <PWAUpdateBanner />
      <PWAInstallBanner />
    </>
  )
}
