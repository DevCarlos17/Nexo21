import { ArrowClockwise, Sparkle } from '@phosphor-icons/react'
import { usePWAUpdate } from '@/hooks/use-pwa-update'

export function PWAUpdateBanner() {
  const { hayActualizacion, actualizar } = usePWAUpdate()

  if (!hayActualizacion) return null

  // Banner NO descartable: no hay boton de cerrar. La unica salida es actualizar.
  return (
    <div className="fixed top-4 left-4 right-4 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 sm:max-w-md z-[60] animate-in slide-in-from-top-4 duration-500">
      <div className="bg-gradient-to-r from-amber-500 to-orange-600 rounded-2xl shadow-2xl p-4 border border-amber-400/50">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 bg-white/20 rounded-lg flex items-center justify-center flex-shrink-0">
            <Sparkle className="w-5 h-5 text-white" weight="fill" />
          </div>

          <div className="flex-1">
            <h3 className="text-white font-bold text-sm mb-1">Nueva version disponible</h3>
            <p className="text-white/90 text-xs mb-3">
              Hay una actualizacion lista. Guarda lo que estes haciendo y actualiza para
              usar la ultima version.
            </p>

            <button
              onClick={actualizar}
              className="w-full bg-white text-orange-600 px-4 py-2 rounded-lg font-semibold text-sm hover:bg-orange-50 transition-colors flex items-center justify-center gap-2 active:scale-95"
            >
              <ArrowClockwise className="w-4 h-4" weight="bold" />
              Actualizar ahora
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
