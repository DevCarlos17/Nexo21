import { useRegisterSW } from 'virtual:pwa-register/react'

export function usePWAUpdate() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(swUrl, registration) {
      // Revisar si hay una version nueva cada 60s mientras la app esta abierta.
      // Un POS suele quedar abierto todo el dia sin recargar; sin este chequeo
      // el navegador solo busca updates al reabrir la pestana.
      if (!registration) return
      setInterval(() => {
        void registration.update()
      }, 60 * 1000)
    },
  })

  // updateServiceWorker(true) activa el SW en espera y recarga la pagina.
  // La factura en espera y el borrador viven en localStorage (persist de Zustand),
  // por lo que sobreviven el reload.
  const actualizar = () => {
    void updateServiceWorker(true)
  }

  return { hayActualizacion: needRefresh, actualizar }
}
