import { useEffect, useRef, useState, useCallback } from 'react'
import { useQuery } from '@powersync/react'
import { toast } from 'sonner'
import { v4 as uuidv4 } from 'uuid'
import Decimal from 'decimal.js'
import { productoSchema } from '@/features/inventario/schemas/producto-schema'
import {
  crearProducto,
  actualizarProducto,
  type Producto,
} from '@/features/inventario/hooks/use-productos'
import { useDepartamentosActivos } from '@/features/inventario/hooks/use-departamentos'
import { useUnidadesActivas } from '@/features/inventario/hooks/use-unidades'
import { useDepositosActivos } from '@/features/inventario/hooks/use-depositos'
import { useTasaActual } from '@/features/configuracion/hooks/use-tasas'
import { useImpuestosActivos } from '@/features/configuracion/hooks/use-impuestos'
import { useNivelesPrecioActivos, type NivelPrecio } from '@/features/configuracion/hooks/use-niveles-precio'
import { useCurrentUser } from '@/core/hooks/use-current-user'
import { db } from '@/core/db/powersync/db'
import { usdToBs, bsToUsd } from '@/lib/currency'
import { localNow } from '@/lib/dates'
import {
  calcularPrecioPreservandoMargen,
  calcularViolacionCostoPvp,
} from '@/features/inventario/lib/producto-precio-gating'
import { useCatalogoGlobal } from '@/features/inventario/hooks/use-catalogo-global'
import { upsertStockDeposito } from '@/features/inventario/lib/stock-deposito'
import { useDebounce } from '@/hooks/use-debounce'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'

// CSS para inputs numericos sin flechas y sin scroll
const noSpinner =
  '[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none'
const stopScroll = (e: React.WheelEvent<HTMLInputElement>) => e.currentTarget.blur()

// ============================================================
// SearchSelect — combobox con busqueda, reemplaza <select>
// ============================================================
interface SelectOption {
  value: string
  label: string
  sublabel?: string
}

function SearchSelect({
  id,
  options,
  value,
  onChange,
  placeholder = 'Seleccionar...',
  searchPlaceholder = 'Buscar...',
  error,
  disabled,
  container,
}: {
  id?: string
  options: SelectOption[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  searchPlaceholder?: string
  error?: string
  disabled?: boolean
  container?: HTMLElement | null
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [activeIdx, setActiveIdx] = useState(-1)
  const itemRefs = useRef<(HTMLDivElement | null)[]>([])

  const filtered = search.trim()
    ? options.filter(
        (opt) =>
          opt.label.toLowerCase().includes(search.toLowerCase()) ||
          (opt.sublabel?.toLowerCase().includes(search.toLowerCase()) ?? false)
      )
    : options

  const selected = options.find((opt) => opt.value === value)

  // Reset active index when search or filtered list changes
  useEffect(() => {
    setActiveIdx(-1)
    itemRefs.current = []
  }, [search, open])

  // Scroll active item into view
  useEffect(() => {
    if (activeIdx >= 0) {
      itemRefs.current[activeIdx]?.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIdx])

  const selectOption = useCallback((opt: SelectOption) => {
    onChange(opt.value)
    setSearch('')
    setOpen(false)
    setActiveIdx(-1)
  }, [onChange])

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || filtered.length === 0) return
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActiveIdx((prev) => (prev < filtered.length - 1 ? prev + 1 : 0))
        break
      case 'ArrowUp':
        e.preventDefault()
        setActiveIdx((prev) => (prev > 0 ? prev - 1 : filtered.length - 1))
        break
      case 'Enter':
        e.preventDefault()
        if (activeIdx >= 0 && filtered[activeIdx]) {
          selectOption(filtered[activeIdx])
        } else if (filtered.length > 0) {
          selectOption(filtered[0])
        }
        break
      case 'Escape':
        e.preventDefault()
        setOpen(false)
        setActiveIdx(-1)
        break
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) { setSearch(''); setActiveIdx(-1) }
      }}
    >
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          disabled={disabled}
          className={`w-full rounded-md border px-3 py-2 text-sm text-left flex items-center justify-between gap-2 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            disabled
              ? 'bg-gray-100 text-gray-500 cursor-not-allowed'
              : 'bg-white hover:bg-gray-50 cursor-pointer'
          } ${error ? 'border-red-500' : 'border-gray-300'}`}
        >
          <span className={`truncate ${selected ? 'text-gray-900' : 'text-gray-400'}`}>
            {selected ? selected.label : placeholder}
          </span>
          <svg
            className="w-4 h-4 text-gray-400 shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        side="bottom"
        avoidCollisions={false}
        className="p-0"
        style={{ width: 'var(--radix-popover-trigger-width, 280px)' }}
        container={container}
      >
        <div className="border-b border-gray-100 px-3 flex items-center gap-2">
          <svg
            className="w-3.5 h-3.5 text-gray-400 shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-4.35-4.35M11 19A8 8 0 1 0 11 3a8 8 0 0 0 0 16z"
            />
          </svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={searchPlaceholder}
            className="flex-1 py-2.5 text-sm outline-none bg-transparent placeholder:text-gray-400"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
          />
        </div>
        <Command shouldFilter={false}>
          <CommandList className="max-h-48 overflow-y-auto">
            <CommandGroup>
              {filtered.length === 0 ? (
                <div className="py-6 text-center text-xs text-gray-400">Sin resultados</div>
              ) : (
                filtered.map((opt, i) => (
                  <CommandItem
                    key={opt.value}
                    value={opt.value}
                    ref={(el) => { itemRefs.current[i] = el }}
                    onSelect={() => selectOption(opt)}
                    onMouseEnter={() => setActiveIdx(i)}
                    className={`flex items-center justify-between gap-2 cursor-pointer px-3 py-1.5 ${
                      i === activeIdx ? 'bg-blue-50 text-blue-900' : ''
                    }`}
                  >
                    <div className="flex flex-col min-w-0">
                      <span
                        className={`truncate text-sm ${
                          opt.value === value ? 'font-medium text-blue-600' : 'text-gray-800'
                        }`}
                      >
                        {opt.label}
                      </span>
                      {opt.sublabel && (
                        <span className="text-xs text-gray-400 truncate">{opt.sublabel}</span>
                      )}
                    </div>
                    {opt.value === value && (
                      <svg
                        className="w-4 h-4 text-blue-500 shrink-0"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                    )}
                  </CommandItem>
                ))
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ============================================================

/** Proyeccion de PVP (no aplicada aun) calculada al editar el Costo. */
interface ProyeccionPvp {
  pvpProyectado: number
  margenPct: number
  violado: boolean
}

/** Hint "PVP cambiaria a $X, margen Y%" con accion explicita "Aplicar". */
function ProyeccionPvpHint({
  proyeccion,
  onAplicar,
}: {
  proyeccion: ProyeccionPvp | null
  onAplicar: () => void
}) {
  if (!proyeccion) return null
  return (
    <div
      className={`mt-1 rounded px-1.5 py-1 text-[11px] leading-tight ${
        proyeccion.violado ? 'bg-red-50 text-red-700' : 'bg-blue-50 text-blue-700'
      }`}
    >
      <p>
        PVP cambiaria a ${proyeccion.pvpProyectado.toFixed(2)}, margen {proyeccion.margenPct.toFixed(1)}%
      </p>
      {proyeccion.violado && (
        <p className="font-medium">El costo iguala o supera el PVP actual</p>
      )}
      <button
        type="button"
        onClick={onAplicar}
        className="mt-0.5 font-medium underline hover:no-underline"
      >
        Aplicar
      </button>
    </div>
  )
}

type TabId = 'general' | 'precios' | 'inventario'

interface LoteRow {
  nro_lote: string
  fecha_vencimiento: string | null
  cantidad_actual: string
  status: string
}

interface ProductoFormProps {
  isOpen: boolean
  onClose: () => void
  producto?: Producto
}

export function ProductoForm({ isOpen, onClose, producto }: ProductoFormProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const isEditing = !!producto

  const { departamentos } = useDepartamentosActivos()
  const { unidades } = useUnidadesActivas()
  const { depositos } = useDepositosActivos()
  const { tasaValor } = useTasaActual()
  const { user } = useCurrentUser()
  const { impuestos: todosImpuestos } = useImpuestosActivos()
  const { niveles: nivelesActivos } = useNivelesPrecioActivos()

  // Fallback si la tabla aun no tiene datos sincronizados
  const NIVELES_DEFAULT: NivelPrecio[] = [
    { id: 'default-1', empresa_id: '', orden: 1, nombre: 'Detal', porcentaje_defecto: '0', is_active: 1, created_at: '', updated_at: '', created_by: null, updated_by: null },
    { id: 'default-2', empresa_id: '', orden: 2, nombre: 'Mayor', porcentaje_defecto: '0', is_active: 1, created_at: '', updated_at: '', created_by: null, updated_by: null },
    { id: 'default-3', empresa_id: '', orden: 3, nombre: 'Especial', porcentaje_defecto: '0', is_active: 1, created_at: '', updated_at: '', created_by: null, updated_by: null },
  ]
  const nivelesConfig = nivelesActivos.length > 0 ? nivelesActivos : NIVELES_DEFAULT

  const nivel1 = nivelesConfig.find((n) => n.orden === 1)
  const nivel2 = nivelesConfig.find((n) => n.orden === 2)
  const nivel3 = nivelesConfig.find((n) => n.orden === 3)

  const impuestosIva = todosImpuestos.filter((i) => i.tipo_tributo === 'IVA')

  // === STICKY HEADER: identidad primaria ===
  const [codigo, setCodigo] = useState('')
  const [tipo, setTipo] = useState<'P' | 'S' | 'C'>('P')
  const [nombre, setNombre] = useState('')

  // === TAB STATE ===
  const [activeTab, setActiveTab] = useState<TabId>('general')

  // === TAB A: Informacion General ===
  const [departamentoId, setDepartamentoId] = useState('')
  const [unidadBaseId, setUnidadBaseId] = useState('')
  const [presentacion, setPresentacion] = useState('')
  const [stockMinimo, setStockMinimo] = useState('')
  const [codigoBarras, setCodigoBarras] = useState('')
  const [isActive, setIsActive] = useState(true)

  // === TAB B: Precios y Fiscalidad ===
  const [costoUsd, setCostoUsd] = useState('')
  const [costoBs, setCostoBs] = useState('')
  const [margen, setMargen] = useState('')
  const [margenMayor, setMargenMayor] = useState('')
  const [margenEspecial, setMargenEspecial] = useState('')
  const [precioVentaUsd, setPrecioVentaUsd] = useState('')
  const [precioVentaBs, setPrecioVentaBs] = useState('')
  const [precioMayorUsd, setPrecioMayorUsd] = useState('')
  const [precioMayorBs, setPrecioMayorBs] = useState('')
  const [precioEspecialUsd, setPrecioEspecialUsd] = useState('')
  const [precioEspecialBs, setPrecioEspecialBs] = useState('')
  const [tipoImpuesto, setTipoImpuesto] = useState<'Gravable' | 'Exento' | 'Exonerado'>('Exento')
  const [impuestoIvaId, setImpuestoIvaId] = useState<string>('')

  // Proyeccion de PVP por nivel — calculada al editar el Costo, no comprometida
  // en los precios reales hasta que el usuario ejecuta "Aplicar" (ver spec
  // productos-edicion-precios).
  const [proyeccionDetal, setProyeccionDetal] = useState<ProyeccionPvp | null>(null)
  const [proyeccionMayor, setProyeccionMayor] = useState<ProyeccionPvp | null>(null)
  const [proyeccionEspecial, setProyeccionEspecial] = useState<ProyeccionPvp | null>(null)

  // === Duracion por defecto (solo Servicios) ===
  const [duracionMin, setDuracionMin] = useState<number | null>(null)

  // === TAB C: Ubicacion e Inventario ===
  const [ubicacion, setUbicacion] = useState('')
  const [manejaLotes, setManejaLotes] = useState(false)
  const [depositoId, setDepositoId] = useState('')
  const [stockInicial, setStockInicial] = useState('')

  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [popoverOpen, setPopoverOpen] = useState(false)

  const debouncedNombre = useDebounce(nombre, 300)
  const { sugerencias } = useCatalogoGlobal(isEditing ? '' : debouncedNombre)

  // Lotes read-only (Tab C, modo edicion, tipo P)
  const lotesProductoId = isEditing && tipo === 'P' && producto ? producto.id : ''
  const { data: lotesData } = useQuery(
    `SELECT nro_lote, fecha_vencimiento, cantidad_actual, status
     FROM lotes
     WHERE producto_id = ? AND empresa_id = ?
     ORDER BY fecha_vencimiento ASC
     LIMIT 20`,
    [lotesProductoId, user?.empresa_id ?? '']
  )
  const lotes = (lotesData ?? []) as LoteRow[]

  // Ultimo producto creado en la empresa (solo modo alta) — ayuda al vuelo para
  // elegir el siguiente codigo, independiente de la convencion (correlativo global
  // o por departamento). El scope por departamento queda como mejora futura.
  const empresaId = user?.empresa_id ?? ''
  const { data: ultimoProductoData } = useQuery(
    !isEditing && empresaId
      ? 'SELECT codigo, nombre FROM productos WHERE empresa_id = ? ORDER BY created_at DESC LIMIT 1'
      : '',
    !isEditing && empresaId ? [empresaId] : []
  )
  const ultimoProducto = (ultimoProductoData?.[0] ?? null) as { codigo: string; nombre: string } | null

  // === Reset form on open / populate on edit ===
  useEffect(() => {
    if (isOpen) {
      setActiveTab('general')
      if (producto) {
        setCodigo(producto.codigo)
        setTipo(producto.tipo as 'P' | 'S' | 'C')
        setNombre(producto.nombre)
        setDepartamentoId(producto.departamento_id)
        setUnidadBaseId(producto.unidad_base_id ?? '')
        setPresentacion(producto.presentacion ?? '')
        setStockMinimo(producto.stock_minimo)
        setCodigoBarras(producto.codigo_barras ?? '')
        setIsActive(producto.is_active === 1)
        setDuracionMin(producto.duracion_min ?? null)
        setCostoUsd(producto.costo_usd)
        setPrecioVentaUsd(producto.precio_venta_usd)
        setPrecioMayorUsd(producto.precio_mayor_usd ?? '')
        setPrecioEspecialUsd(producto.precio_especial_usd ?? '')
        setTipoImpuesto((producto.tipo_impuesto as 'Gravable' | 'Exento' | 'Exonerado') ?? 'Exento')
        setImpuestoIvaId(producto.impuesto_iva_id ?? '')
        setUbicacion(producto.ubicacion ?? '')
        setManejaLotes(producto.maneja_lotes === 1)
        setDepositoId(producto.deposito_id ?? '')
        setStockInicial('')
        if (tasaValor > 0) {
          const costoN = parseFloat(producto.costo_usd) || 0
          const ventaN = parseFloat(producto.precio_venta_usd) || 0
          const mayorN = parseFloat(producto.precio_mayor_usd ?? '') || 0
          const especN = parseFloat(producto.precio_especial_usd ?? '') || 0
          setCostoBs(costoN > 0 ? usdToBs(costoN, tasaValor).toFixed(2) : '')
          setPrecioVentaBs(ventaN > 0 ? usdToBs(ventaN, tasaValor).toFixed(2) : '')
          setPrecioMayorBs(mayorN > 0 ? usdToBs(mayorN, tasaValor).toFixed(2) : '')
          setPrecioEspecialBs(especN > 0 ? usdToBs(especN, tasaValor).toFixed(2) : '')
          setMargen(costoN > 0 && ventaN > 0 ? ((ventaN - costoN) / costoN * 100).toFixed(1) : '')
          setMargenMayor(costoN > 0 && mayorN > 0 ? ((mayorN - costoN) / costoN * 100).toFixed(1) : '')
          setMargenEspecial(costoN > 0 && especN > 0 ? ((especN - costoN) / costoN * 100).toFixed(1) : '')
        } else {
          setCostoBs('')
          setPrecioVentaBs('')
          setPrecioMayorBs('')
          setPrecioEspecialBs('')
          setMargen('')
          setMargenMayor('')
          setMargenEspecial('')
        }
      } else {
        setCodigo('')
        setTipo('P')
        setNombre('')
        setDepartamentoId('')
        setUnidadBaseId('')
        setPresentacion('')
        setStockMinimo('')
        setCodigoBarras('')
        setIsActive(true)
        setDuracionMin(null)
        setCostoUsd('')
        setCostoBs('')
        setPrecioVentaUsd('')
        setPrecioVentaBs('')
        setPrecioMayorUsd('')
        setPrecioMayorBs('')
        setPrecioEspecialUsd('')
        setPrecioEspecialBs('')
        const pct1 = nivel1 ? parseFloat(nivel1.porcentaje_defecto) : 0
        const pct2 = nivel2 ? parseFloat(nivel2.porcentaje_defecto) : 0
        const pct3 = nivel3 ? parseFloat(nivel3.porcentaje_defecto) : 0
        setMargen(pct1 > 0 ? pct1.toFixed(1) : '')
        setMargenMayor(pct2 > 0 ? pct2.toFixed(1) : '')
        setMargenEspecial(pct3 > 0 ? pct3.toFixed(1) : '')
        setTipoImpuesto('Exento')
        setImpuestoIvaId('')
        setUbicacion('')
        setManejaLotes(false)
        setDepositoId('')
        setStockInicial('')
      }
      setErrors({})
      setProyeccionDetal(null)
      setProyeccionMayor(null)
      setProyeccionEspecial(null)
      setPopoverOpen(false)
      dialogRef.current?.showModal()
    } else {
      dialogRef.current?.close()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, producto])

  // Sync Bs values when tasa changes while form is open
  useEffect(() => {
    if (!isOpen || tasaValor <= 0) return
    const costoN = parseFloat(costoUsd) || 0
    const ventaN = parseFloat(precioVentaUsd) || 0
    const mayorN = parseFloat(precioMayorUsd) || 0
    const especN = parseFloat(precioEspecialUsd) || 0
    if (costoN > 0) setCostoBs(usdToBs(costoN, tasaValor).toFixed(2))
    if (ventaN > 0) setPrecioVentaBs(usdToBs(ventaN, tasaValor).toFixed(2))
    if (mayorN > 0) setPrecioMayorBs(usdToBs(mayorN, tasaValor).toFixed(2))
    if (especN > 0) setPrecioEspecialBs(usdToBs(especN, tasaValor).toFixed(2))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasaValor])

  // === Handlers ===

  function handleTipoChange(nuevoTipo: 'P' | 'S' | 'C') {
    setTipo(nuevoTipo)
    if (nuevoTipo === 'S') {
      setUbicacion('')
      setPresentacion('')
      setStockMinimo('0')
      setUnidadBaseId('')
      setManejaLotes(false)
      setDepositoId('')
      setStockInicial('')
      if (activeTab === 'inventario') setActiveTab('general')
    }
    if (nuevoTipo === 'C') {
      setUbicacion('')
      setPresentacion('')
      setStockMinimo('0')
      setUnidadBaseId('')
      setManejaLotes(false)
      setDepositoId('')
      setStockInicial('')
      setCostoUsd('0')
      setCostoBs('0')
      setProyeccionDetal(null)
      setProyeccionMayor(null)
      setProyeccionEspecial(null)
    }
  }

  function handleTipoImpuestoChange(valor: 'Gravable' | 'Exento' | 'Exonerado') {
    setTipoImpuesto(valor)
    if (valor !== 'Gravable') setImpuestoIvaId('')
  }

  // --- Bidireccionales: Costo ---
  // Proyecta precios cuando cambia el costo, SIN mutar los precios reales
  // (regla: editar el Costo no debe alterar el PVP automaticamente).
  // Prioridad por nivel: si hay margen configurado → proyecta PVP preservando
  // ese margen (requiere accion explicita "Aplicar"); si no → recalcula el
  // margen desde el precio existente (esto no muta el PVP, solo el margen%).
  function applyPricesFromCosto(costoN: number) {
    if (costoN <= 0) {
      setProyeccionDetal(null)
      setProyeccionMayor(null)
      setProyeccionEspecial(null)
      return
    }

    const margenN = parseFloat(margen)
    const ventaN = parseFloat(precioVentaUsd) || 0
    if (!isNaN(margenN) && margenN !== 0) {
      setProyeccionDetal({
        pvpProyectado: calcularPrecioPreservandoMargen(costoN, margenN),
        margenPct: margenN,
        violado: ventaN > 0 && calcularViolacionCostoPvp(costoN, ventaN),
      })
    } else {
      setProyeccionDetal(null)
      if (ventaN > 0) {
        setMargen(((ventaN - costoN) / costoN * 100).toFixed(2))
      }
    }

    const margenMayorN = parseFloat(margenMayor)
    const mayorN = parseFloat(precioMayorUsd) || 0
    if (!isNaN(margenMayorN) && margenMayorN !== 0) {
      setProyeccionMayor({
        pvpProyectado: calcularPrecioPreservandoMargen(costoN, margenMayorN),
        margenPct: margenMayorN,
        violado: mayorN > 0 && calcularViolacionCostoPvp(costoN, mayorN),
      })
    } else {
      setProyeccionMayor(null)
      if (mayorN > 0) {
        setMargenMayor(((mayorN - costoN) / costoN * 100).toFixed(2))
      }
    }

    const margenEspecialN = parseFloat(margenEspecial)
    const especN = parseFloat(precioEspecialUsd) || 0
    if (!isNaN(margenEspecialN) && margenEspecialN !== 0) {
      setProyeccionEspecial({
        pvpProyectado: calcularPrecioPreservandoMargen(costoN, margenEspecialN),
        margenPct: margenEspecialN,
        violado: especN > 0 && calcularViolacionCostoPvp(costoN, especN),
      })
    } else {
      setProyeccionEspecial(null)
      if (especN > 0) {
        setMargenEspecial(((especN - costoN) / costoN * 100).toFixed(2))
      }
    }
  }

  /** Aplica la proyeccion de PVP Detal a los precios reales (accion explicita del usuario). */
  function aplicarProyeccionDetal() {
    if (!proyeccionDetal) return
    setPrecioVentaUsd(proyeccionDetal.pvpProyectado.toFixed(2))
    setMargen(proyeccionDetal.margenPct.toFixed(2))
    if (tasaValor > 0) setPrecioVentaBs(usdToBs(proyeccionDetal.pvpProyectado, tasaValor).toFixed(2))
    setProyeccionDetal(null)
  }

  /** Aplica la proyeccion de PVP Mayor a los precios reales (accion explicita del usuario). */
  function aplicarProyeccionMayor() {
    if (!proyeccionMayor) return
    setPrecioMayorUsd(proyeccionMayor.pvpProyectado.toFixed(2))
    setMargenMayor(proyeccionMayor.margenPct.toFixed(2))
    if (tasaValor > 0) setPrecioMayorBs(usdToBs(proyeccionMayor.pvpProyectado, tasaValor).toFixed(2))
    setProyeccionMayor(null)
  }

  /** Aplica la proyeccion de PVP Especial a los precios reales (accion explicita del usuario). */
  function aplicarProyeccionEspecial() {
    if (!proyeccionEspecial) return
    setPrecioEspecialUsd(proyeccionEspecial.pvpProyectado.toFixed(2))
    setMargenEspecial(proyeccionEspecial.margenPct.toFixed(2))
    if (tasaValor > 0) setPrecioEspecialBs(usdToBs(proyeccionEspecial.pvpProyectado, tasaValor).toFixed(2))
    setProyeccionEspecial(null)
  }

  function handleCostoUsdChange(val: string) {
    setCostoUsd(val)
    const num = parseFloat(val)
    if (!isNaN(num) && tasaValor > 0) setCostoBs(usdToBs(num, tasaValor).toFixed(2))
    applyPricesFromCosto(isNaN(num) ? 0 : num)
  }

  function handleCostoBsChange(val: string) {
    setCostoBs(val)
    const num = parseFloat(val)
    if (!isNaN(num) && tasaValor > 0) {
      const usd = bsToUsd(num, tasaValor)
      setCostoUsd(usd.toFixed(8))
      applyPricesFromCosto(usd.toNumber())
    }
  }

  // --- Bidireccionales: PVP Detal ---
  function handlePrecioVentaUsdChange(val: string) {
    setProyeccionDetal(null)
    setPrecioVentaUsd(val)
    const num = parseFloat(val)
    if (!isNaN(num) && tasaValor > 0) setPrecioVentaBs(usdToBs(num, tasaValor).toFixed(2))
    const costoN = esComboLocal ? 0 : (parseFloat(costoUsd) || 0)
    const ventaN = isNaN(num) ? 0 : num
    if (costoN > 0 && ventaN > 0) {
      setMargen(((ventaN - costoN) / costoN * 100).toFixed(2))
    }
  }

  function handlePrecioVentaBsChange(val: string) {
    setProyeccionDetal(null)
    setPrecioVentaBs(val)
    const num = parseFloat(val)
    if (!isNaN(num) && tasaValor > 0) {
      const usd = bsToUsd(num, tasaValor)
      const usdStr = usd.toFixed(8)
      setPrecioVentaUsd(usdStr)
      const costoN = esComboLocal ? 0 : (parseFloat(costoUsd) || 0)
      const usdN = usd.toNumber()
      if (costoN > 0 && usdN > 0) {
        setMargen(((usdN - costoN) / costoN * 100).toFixed(2))
      }
    }
  }

  // --- Margen Detal ---
  function handleMargenChange(val: string) {
    setProyeccionDetal(null)
    setMargen(val)
    const margenN = parseFloat(val)
    const costoN = esComboLocal ? 0 : (parseFloat(costoUsd) || 0)
    if (!isNaN(margenN) && costoN > 0) {
      const pvp = Math.max(0, costoN * (1 + margenN / 100))
      setPrecioVentaUsd(pvp.toFixed(2))
      if (tasaValor > 0) setPrecioVentaBs(usdToBs(pvp, tasaValor).toFixed(2))
    }
  }

  // --- Margen Mayor ---
  function handleMargenMayorChange(val: string) {
    setProyeccionMayor(null)
    setMargenMayor(val)
    const margenN = parseFloat(val)
    const costoN = esComboLocal ? 0 : (parseFloat(costoUsd) || 0)
    if (!isNaN(margenN) && costoN > 0) {
      const pvp = Math.max(0, costoN * (1 + margenN / 100))
      setPrecioMayorUsd(pvp.toFixed(2))
      if (tasaValor > 0) setPrecioMayorBs(usdToBs(pvp, tasaValor).toFixed(2))
    }
  }

  // --- Margen Especial ---
  function handleMargenEspecialChange(val: string) {
    setProyeccionEspecial(null)
    setMargenEspecial(val)
    const margenN = parseFloat(val)
    const costoN = esComboLocal ? 0 : (parseFloat(costoUsd) || 0)
    if (!isNaN(margenN) && costoN > 0) {
      const pvp = Math.max(0, costoN * (1 + margenN / 100))
      setPrecioEspecialUsd(pvp.toFixed(2))
      if (tasaValor > 0) setPrecioEspecialBs(usdToBs(pvp, tasaValor).toFixed(2))
    }
  }

  // --- Bidireccionales: PVP Mayor ---
  function handlePrecioMayorUsdChange(val: string) {
    setProyeccionMayor(null)
    setPrecioMayorUsd(val)
    const num = parseFloat(val)
    if (!isNaN(num) && tasaValor > 0) setPrecioMayorBs(usdToBs(num, tasaValor).toFixed(2))
    const costoN = esComboLocal ? 0 : (parseFloat(costoUsd) || 0)
    const mayorN = isNaN(num) ? 0 : num
    if (costoN > 0 && mayorN > 0) {
      setMargenMayor(((mayorN - costoN) / costoN * 100).toFixed(2))
    }
  }

  function handlePrecioMayorBsChange(val: string) {
    setProyeccionMayor(null)
    setPrecioMayorBs(val)
    const num = parseFloat(val)
    if (!isNaN(num) && tasaValor > 0) {
      const usd = bsToUsd(num, tasaValor)
      setPrecioMayorUsd(usd.toFixed(8))
      const costoN = esComboLocal ? 0 : (parseFloat(costoUsd) || 0)
      const usdN = usd.toNumber()
      if (costoN > 0 && usdN > 0) {
        setMargenMayor(((usdN - costoN) / costoN * 100).toFixed(2))
      }
    }
  }

  // --- Bidireccionales: PVP Especial ---
  function handlePrecioEspecialUsdChange(val: string) {
    setProyeccionEspecial(null)
    setPrecioEspecialUsd(val)
    const num = parseFloat(val)
    if (!isNaN(num) && tasaValor > 0) setPrecioEspecialBs(usdToBs(num, tasaValor).toFixed(2))
    const costoN = esComboLocal ? 0 : (parseFloat(costoUsd) || 0)
    const especN = isNaN(num) ? 0 : num
    if (costoN > 0 && especN > 0) {
      setMargenEspecial(((especN - costoN) / costoN * 100).toFixed(2))
    }
  }

  function handlePrecioEspecialBsChange(val: string) {
    setProyeccionEspecial(null)
    setPrecioEspecialBs(val)
    const num = parseFloat(val)
    if (!isNaN(num) && tasaValor > 0) {
      const usd = bsToUsd(num, tasaValor)
      setPrecioEspecialUsd(usd.toFixed(8))
      const costoN = esComboLocal ? 0 : (parseFloat(costoUsd) || 0)
      const usdN = usd.toNumber()
      if (costoN > 0 && usdN > 0) {
        setMargenEspecial(((usdN - costoN) / costoN * 100).toFixed(2))
      }
    }
  }

  // --- Precio Final Detal → back-calcula base imponible ---
  function handlePrecioFinalDetalUsdChange(val: string) {
    const pfN = parseFloat(val)
    if (isNaN(pfN) || pfN <= 0) return
    setProyeccionDetal(null)
    const factor = alicuota > 0 ? (1 + alicuota / 100) : 1
    const baseUsd = pfN / factor
    setPrecioVentaUsd(baseUsd.toFixed(2))
    if (tasaValor > 0) setPrecioVentaBs(usdToBs(baseUsd, tasaValor).toFixed(2))
    const costoN = esComboLocal ? 0 : (parseFloat(costoUsd) || 0)
    if (costoN > 0 && baseUsd > 0)
      setMargen(((baseUsd - costoN) / costoN * 100).toFixed(2))
  }

  function handlePrecioFinalDetalBsChange(val: string) {
    if (tasaValor <= 0) return
    const pfBsN = parseFloat(val)
    if (isNaN(pfBsN) || pfBsN <= 0) return
    setProyeccionDetal(null)
    const pfUsd = bsToUsd(pfBsN, tasaValor).toNumber()
    const factor = alicuota > 0 ? (1 + alicuota / 100) : 1
    const baseUsd = pfUsd / factor
    setPrecioVentaUsd(baseUsd.toFixed(8))
    setPrecioVentaBs(usdToBs(baseUsd, tasaValor).toFixed(2))
    const costoN = esComboLocal ? 0 : (parseFloat(costoUsd) || 0)
    if (costoN > 0 && baseUsd > 0)
      setMargen(((baseUsd - costoN) / costoN * 100).toFixed(2))
  }

  // --- Precio Final Mayor → back-calcula base imponible ---
  function handlePrecioFinalMayorUsdChange(val: string) {
    const pfN = parseFloat(val)
    if (isNaN(pfN) || pfN <= 0) return
    setProyeccionMayor(null)
    const factor = alicuota > 0 ? (1 + alicuota / 100) : 1
    const baseUsd = pfN / factor
    setPrecioMayorUsd(baseUsd.toFixed(2))
    if (tasaValor > 0) setPrecioMayorBs(usdToBs(baseUsd, tasaValor).toFixed(2))
    const costoN = esComboLocal ? 0 : (parseFloat(costoUsd) || 0)
    if (costoN > 0 && baseUsd > 0)
      setMargenMayor(((baseUsd - costoN) / costoN * 100).toFixed(2))
  }

  function handlePrecioFinalMayorBsChange(val: string) {
    if (tasaValor <= 0) return
    const pfBsN = parseFloat(val)
    if (isNaN(pfBsN) || pfBsN <= 0) return
    setProyeccionMayor(null)
    const pfUsd = bsToUsd(pfBsN, tasaValor).toNumber()
    const factor = alicuota > 0 ? (1 + alicuota / 100) : 1
    const baseUsd = pfUsd / factor
    setPrecioMayorUsd(baseUsd.toFixed(8))
    setPrecioMayorBs(usdToBs(baseUsd, tasaValor).toFixed(2))
    const costoN = esComboLocal ? 0 : (parseFloat(costoUsd) || 0)
    if (costoN > 0 && baseUsd > 0)
      setMargenMayor(((baseUsd - costoN) / costoN * 100).toFixed(2))
  }

  // --- Precio Final Especial → back-calcula base imponible ---
  function handlePrecioFinalEspecialUsdChange(val: string) {
    const pfN = parseFloat(val)
    if (isNaN(pfN) || pfN <= 0) return
    setProyeccionEspecial(null)
    const factor = alicuota > 0 ? (1 + alicuota / 100) : 1
    const baseUsd = pfN / factor
    setPrecioEspecialUsd(baseUsd.toFixed(2))
    if (tasaValor > 0) setPrecioEspecialBs(usdToBs(baseUsd, tasaValor).toFixed(2))
    const costoN = esComboLocal ? 0 : (parseFloat(costoUsd) || 0)
    if (costoN > 0 && baseUsd > 0)
      setMargenEspecial(((baseUsd - costoN) / costoN * 100).toFixed(2))
  }

  function handlePrecioFinalEspecialBsChange(val: string) {
    if (tasaValor <= 0) return
    const pfBsN = parseFloat(val)
    if (isNaN(pfBsN) || pfBsN <= 0) return
    setProyeccionEspecial(null)
    const pfUsd = bsToUsd(pfBsN, tasaValor).toNumber()
    const factor = alicuota > 0 ? (1 + alicuota / 100) : 1
    const baseUsd = pfUsd / factor
    setPrecioEspecialUsd(baseUsd.toFixed(8))
    setPrecioEspecialBs(usdToBs(baseUsd, tasaValor).toFixed(2))
    const costoN = esComboLocal ? 0 : (parseFloat(costoUsd) || 0)
    if (costoN > 0 && baseUsd > 0)
      setMargenEspecial(((baseUsd - costoN) / costoN * 100).toFixed(2))
  }

  function handleSugerenciaSelect(s: {
    nombre: string
    presentacion: string | null
    maneja_lotes: boolean
    tipo_impuesto: string
  }) {
    setNombre(s.nombre)
    if (tipo === 'P') {
      if (s.presentacion) setPresentacion(s.presentacion)
      setManejaLotes(s.maneja_lotes)
      setTipoImpuesto(s.tipo_impuesto as 'Gravable' | 'Exento' | 'Exonerado')
    }
    setPopoverOpen(false)
  }

  function parseNumOrZero(val: string): number {
    const n = parseFloat(val)
    return isNaN(n) ? 0 : n
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErrors({})

    const esCombo = tipo === 'C'
    const esServicioOCombo = tipo === 'S' || tipo === 'C'

    const newErrors: Record<string, string> = {}
    if (tipo === 'P' && !depositoId) {
      newErrors.deposito_id = 'Selecciona un deposito'
    }
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
      setActiveTab('inventario')
      return
    }

    const data = {
      codigo,
      tipo,
      nombre,
      departamento_id: departamentoId,
      costo_usd: esCombo ? 0 : parseNumOrZero(costoUsd),
      precio_venta_usd: parseNumOrZero(precioVentaUsd),
      precio_mayor_usd: nivel2 ? (precioMayorUsd.trim() === '' ? null : parseNumOrZero(precioMayorUsd)) : null,
      precio_especial_usd: nivel3 ? (precioEspecialUsd.trim() === '' ? null : parseNumOrZero(precioEspecialUsd)) : null,
      stock_minimo: esServicioOCombo ? 0 : parseNumOrZero(stockMinimo),
      tipo_impuesto: tipoImpuesto,
      impuesto_iva_id: tipoImpuesto === 'Gravable' && impuestoIvaId ? impuestoIvaId : null,
      is_active: isActive,
      ubicacion: esServicioOCombo ? '' : ubicacion,
      presentacion: esServicioOCombo ? '' : presentacion,
      codigo_barras: codigoBarras.trim(),
    }

    const parsed = productoSchema.safeParse(data)
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const field = issue.path[0]?.toString()
        if (field) fieldErrors[field] = issue.message
      }
      setErrors(fieldErrors)
      const precioFields = ['costo_usd', 'precio_venta_usd', 'precio_mayor_usd', 'precio_especial_usd', 'tipo_impuesto', 'impuesto_iva_id']
      const generalFields = ['departamento_id', 'stock_minimo']
      const hasPrecios = precioFields.some((f) => fieldErrors[f])
      const hasGeneral = generalFields.some((f) => fieldErrors[f])
      if (hasPrecios) setActiveTab('precios')
      else if (hasGeneral) setActiveTab('general')
      return
    }

    setSubmitting(true)
    try {
      if (isEditing && producto) {
        await actualizarProducto(producto.id, {
          nombre: parsed.data.nombre,
          departamento_id: parsed.data.departamento_id,
          costo_usd: esCombo ? 0 : parsed.data.costo_usd,
          precio_venta_usd: parsed.data.precio_venta_usd,
          precio_mayor_usd: parsed.data.precio_mayor_usd ?? null,
          precio_especial_usd: parsed.data.precio_especial_usd ?? null,
          stock_minimo: parsed.data.stock_minimo,
          tipo_impuesto: parsed.data.tipo_impuesto,
          impuesto_iva_id: parsed.data.impuesto_iva_id ?? null,
          is_active: parsed.data.is_active,
          tipo: parsed.data.tipo,
          ubicacion: esServicioOCombo ? null : (parsed.data.ubicacion || null),
          unidad_base_id: esServicioOCombo ? null : (unidadBaseId || null),
          maneja_lotes: esServicioOCombo ? false : manejaLotes,
          presentacion: esServicioOCombo ? null : (parsed.data.presentacion || null),
          codigo_barras: parsed.data.codigo_barras?.trim() || null,
          duracion_min: tipo === 'S' ? duracionMin : null,
          deposito_id: esServicioOCombo ? null : (depositoId || null),
        })
        toast.success('Producto actualizado correctamente')
      } else {
        const productoId = await crearProducto({
          codigo: parsed.data.codigo,
          tipo: parsed.data.tipo,
          nombre: parsed.data.nombre,
          departamento_id: parsed.data.departamento_id,
          costo_usd: esCombo ? 0 : parsed.data.costo_usd,
          precio_venta_usd: parsed.data.precio_venta_usd,
          precio_mayor_usd: parsed.data.precio_mayor_usd ?? null,
          precio_especial_usd: parsed.data.precio_especial_usd ?? null,
          stock_minimo: parsed.data.stock_minimo,
          tipo_impuesto: parsed.data.tipo_impuesto,
          impuesto_iva_id: parsed.data.impuesto_iva_id ?? null,
          empresa_id: user!.empresa_id!,
          ubicacion: esServicioOCombo ? undefined : (parsed.data.ubicacion || undefined),
          unidad_base_id: esServicioOCombo ? undefined : (unidadBaseId || undefined),
          maneja_lotes: esServicioOCombo ? false : manejaLotes,
          presentacion: esServicioOCombo ? undefined : (parsed.data.presentacion || undefined),
          codigo_barras: parsed.data.codigo_barras?.trim() || undefined,
          duracion_min: tipo === 'S' ? duracionMin : undefined,
          deposito_id: esServicioOCombo ? null : (depositoId || null),
        })

        const stockInicialNum = parseNumOrZero(stockInicial)
        if (tipo === 'P' && depositoId && stockInicialNum > 0) {
          const now = localNow()
          const fecha = now.split('T')[0] ?? now.substring(0, 10)
          await db.writeTransaction(async (tx) => {
            const movInicialId = uuidv4()
            await tx.execute(
              `INSERT INTO movimientos_inventario
               (id, empresa_id, producto_id, deposito_id, tipo, origen, cantidad,
                stock_anterior, stock_nuevo, motivo, usuario_id, fecha, created_at)
               VALUES (?, ?, ?, ?, 'E', 'MAN', ?, '0.000', ?, 'Stock inicial', ?, ?, ?)`,
              [
                movInicialId, user!.empresa_id!, productoId, depositoId,
                stockInicialNum.toFixed(3), stockInicialNum.toFixed(3),
                user!.id, fecha, now,
              ]
            )
            // inventario_stock (por deposito) + productos.stock (total) — un unico camino
            // de escritura compartido con compras/kardex/ajustes/ventas (stock-deposito.ts).
            // El producto recien creado arranca en 0, asi que el delta = stock inicial.
            await upsertStockDeposito(tx, {
              empresa_id: user!.empresa_id!,
              producto_id: productoId,
              deposito_id: depositoId,
              delta: new Decimal(stockInicialNum),
              usuario_id: user!.id,
              now,
              movimientoInventarioId: movInicialId,
            })
          })
        }
        toast.success('Producto creado correctamente')
      }
      onClose()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error inesperado'
      toast.error(message)
    } finally {
      setSubmitting(false)
    }
  }

  const esServicioOComboLocal = tipo === 'S' || tipo === 'C'
  const esComboLocal = tipo === 'C'

  function handleBackdropClick(e: React.MouseEvent<HTMLDialogElement>) {
    if (e.target === dialogRef.current) onClose()
  }

  // IVA config
  const selectedImpuesto = impuestosIva.find((i) => i.id === impuestoIvaId)
  const alicuota =
    tipoImpuesto === 'Gravable' && selectedImpuesto
      ? parseFloat(selectedImpuesto.porcentaje)
      : 0
  const showIvaCols = alicuota > 0

  // IVA y Precio Final por nivel
  const ivaDetalUsd = (parseFloat(precioVentaUsd) || 0) * alicuota / 100
  const pfDetalUsd = (parseFloat(precioVentaUsd) || 0) + ivaDetalUsd
  const pfDetalBs = tasaValor > 0 ? usdToBs(pfDetalUsd, tasaValor).toNumber() : 0

  const ivaMayorUsd = (parseFloat(precioMayorUsd) || 0) * alicuota / 100
  const pfMayorUsd = (parseFloat(precioMayorUsd) || 0) + ivaMayorUsd
  const pfMayorBs = tasaValor > 0 ? usdToBs(pfMayorUsd, tasaValor).toNumber() : 0

  const ivaEspecialUsd = (parseFloat(precioEspecialUsd) || 0) * alicuota / 100
  const pfEspecialUsd = (parseFloat(precioEspecialUsd) || 0) + ivaEspecialUsd
  const pfEspecialBs = tasaValor > 0 ? usdToBs(pfEspecialUsd, tasaValor).toNumber() : 0

  const mostrarPopover = popoverOpen && sugerencias.length > 0 && !isEditing

  const isSubmitDisabled =
    submitting ||
    !codigo.trim() ||
    !nombre.trim() ||
    (!esComboLocal && parseNumOrZero(costoUsd) === 0)

  const tabs: { id: TabId; label: string }[] = [
    { id: 'general', label: 'Informacion General' },
    { id: 'precios', label: 'Precios y Fiscalidad' },
    ...(tipo !== 'S' ? [{ id: 'inventario' as TabId, label: 'Inventario' }] : []),
  ]

  // Opciones para SearchSelect
  const deptOptions: SelectOption[] = departamentos.map((d) => ({ value: d.id, label: d.nombre }))
  const unidadOptions: SelectOption[] = [
    { value: '', label: 'Sin unidad' },
    ...unidades.map((u) => ({ value: u.id, label: `${u.nombre} (${u.abreviatura})` })),
  ]
  const tipoImpuestoOptions: SelectOption[] = [
    { value: 'Exento', label: 'Exento' },
    { value: 'Gravable', label: 'Gravable (IVA General)' },
    { value: 'Exonerado', label: 'Exonerado' },
  ]
  const tasaIvaOptions: SelectOption[] = [
    { value: '', label: 'Sin tasa especifica' },
    ...impuestosIva.map((imp) => ({
      value: imp.id,
      label: `${imp.nombre} (${parseFloat(imp.porcentaje).toFixed(2)}%)`,
    })),
  ]
  const depositoOptions: SelectOption[] = depositos.map((d) => ({ value: d.id, label: d.nombre }))

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={handleBackdropClick}
      className="backdrop:bg-black/50 rounded-xl p-0 w-full max-w-2xl shadow-2xl overflow-hidden"
    >
      <form onSubmit={handleSubmit} className="flex flex-col max-h-[90vh]">

        {/* ============================================================
            STICKY HEADER — Identidad primaria
        ============================================================ */}
        <div className="flex-none bg-white border-b border-gray-200 px-6 pt-5 pb-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">
              {isEditing ? 'Editar Producto' : 'Nuevo Producto'}
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 transition-colors p-1 rounded"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Codigo + Nombre */}
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label htmlFor="prod-codigo" className="block text-xs font-medium text-gray-600 mb-1">
                Codigo <span className="text-red-500">*</span>
              </label>
              <input
                id="prod-codigo"
                type="text"
                value={codigo}
                onChange={(e) => setCodigo(e.target.value.toUpperCase())}
                disabled={isEditing}
                placeholder="Ej: PROD-001"
                autoComplete="off"
                className={`w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  isEditing ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : 'bg-white'
                } ${errors.codigo ? 'border-red-500' : 'border-gray-300'}`}
              />
              {errors.codigo && <p className="text-red-500 text-xs mt-0.5">{errors.codigo}</p>}
              {isEditing && (
                <p className="text-gray-400 text-xs mt-0.5">El codigo no puede modificarse</p>
              )}
              {!isEditing && ultimoProducto && (
                <p className="text-gray-400 text-xs mt-0.5">
                  Último código creado:{' '}
                  <strong className="text-gray-500 font-medium">{ultimoProducto.codigo}</strong>
                  {' — '}
                  {ultimoProducto.nombre}
                </p>
              )}
            </div>
            <div>
              <label htmlFor="prod-nombre" className="block text-xs font-medium text-gray-600 mb-1">
                Nombre <span className="text-red-500">*</span>
              </label>
              <Popover
                open={mostrarPopover}
                onOpenChange={(open) => { if (!open) setPopoverOpen(false) }}
              >
                <PopoverAnchor asChild>
                  <input
                    id="prod-nombre"
                    type="text"
                    value={nombre}
                    onChange={(e) => {
                      setNombre(e.target.value.toUpperCase())
                      setPopoverOpen(true)
                    }}
                    onBlur={() => setTimeout(() => setPopoverOpen(false), 200)}
                    placeholder="Nombre del producto"
                    autoComplete="off"
                    className={`w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                      errors.nombre ? 'border-red-500' : 'border-gray-300'
                    }`}
                  />
                </PopoverAnchor>
                <PopoverContent
                  onOpenAutoFocus={(e) => e.preventDefault()}
                  align="start"
                  sideOffset={4}
                  className="p-0"
                  style={{ width: 'var(--radix-popover-anchor-width, 300px)' }}
                >
                  <Command shouldFilter={false}>
                    <CommandList>
                      <CommandGroup>
                        {sugerencias.map((s) => (
                          <CommandItem
                            key={s.id}
                            value={s.nombre}
                            onSelect={() => handleSugerenciaSelect(s)}
                            className="flex items-center justify-between gap-2 cursor-pointer"
                          >
                            <div className="flex flex-col min-w-0">
                              <span className="font-medium truncate">{s.nombre}</span>
                              {s.presentacion && (
                                <span className="text-xs text-gray-400 truncate">{s.presentacion}</span>
                              )}
                            </div>
                            <span className="shrink-0 text-xs font-medium text-blue-600 tabular-nums">
                              {Math.round(s.similitud * 100)}%
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              {errors.nombre && <p className="text-red-500 text-xs mt-0.5">{errors.nombre}</p>}
            </div>
          </div>

          {/* Tipo de Item */}
          <div className="flex flex-wrap gap-4">
            {(['P', 'S', 'C'] as const).map((t) => (
              <label key={t} className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="tipo"
                  value={t}
                  checked={tipo === t}
                  onChange={() => handleTipoChange(t)}
                  disabled={isEditing}
                  className={`h-4 w-4 focus:ring-2 ${
                    t === 'P'
                      ? 'text-blue-600 focus:ring-blue-500'
                      : t === 'S'
                      ? 'text-purple-600 focus:ring-purple-500'
                      : 'text-green-600 focus:ring-green-500'
                  }`}
                />
                <span className="text-sm font-medium text-gray-700">
                  {t === 'P' ? 'Producto' : t === 'S' ? 'Servicio' : 'Combo / Receta'}
                </span>
              </label>
            ))}
          </div>
          {errors.tipo && <p className="text-red-500 text-xs mt-1">{errors.tipo}</p>}
          {esComboLocal && (
            <p className="text-green-700 text-xs mt-2 bg-green-50 px-2 py-1 rounded">
              El costo se calcula automaticamente desde los ingredientes del combo
            </p>
          )}
        </div>

        {/* ============================================================
            TABS NAV
        ============================================================ */}
        <div className="flex-none bg-white border-b border-gray-200 px-6 overflow-x-auto">
          <div className="flex -mb-px">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                  activeTab === tab.id
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* ============================================================
            SCROLLABLE CONTENT
        ============================================================ */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-4">

          {/* ---- TAB A: Informacion General ---- */}
          {activeTab === 'general' && (
            <>
              {/* Departamento */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Departamento <span className="text-red-500">*</span>
                </label>
                <SearchSelect
                  id="prod-depto"
                  options={deptOptions}
                  value={departamentoId}
                  onChange={setDepartamentoId}
                  placeholder="Seleccionar departamento"
                  searchPlaceholder="Buscar departamento..."
                  error={errors.departamento_id}
                  container={dialogRef.current}
                />
                {errors.departamento_id && (
                  <p className="text-red-500 text-xs mt-1">{errors.departamento_id}</p>
                )}
              </div>

              {/* Duracion por defecto — solo Servicio */}
              {tipo === 'S' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Duracion por defecto
                  </label>
                  <div className="flex items-center gap-2">
                    <select
                      value={duracionMin !== null ? Math.floor(duracionMin / 60) : 0}
                      onChange={(e) => {
                        const horas = parseInt(e.target.value)
                        const mins = duracionMin !== null ? duracionMin % 60 : 0
                        const total = horas * 60 + mins
                        setDuracionMin(total === 0 ? null : total)
                      }}
                      className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      {Array.from({ length: 9 }, (_, i) => (
                        <option key={i} value={i}>{i}h</option>
                      ))}
                    </select>
                    <select
                      value={duracionMin !== null ? duracionMin % 60 : 0}
                      onChange={(e) => {
                        const minutos = parseInt(e.target.value)
                        const horas = duracionMin !== null ? Math.floor(duracionMin / 60) : 0
                        const total = horas * 60 + minutos
                        setDuracionMin(total === 0 ? null : total)
                      }}
                      className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value={0}>00 min</option>
                      <option value={15}>15 min</option>
                      <option value={30}>30 min</option>
                      <option value={45}>45 min</option>
                    </select>
                  </div>
                  <p className="text-xs text-gray-400 mt-1">
                    {duracionMin ? `Aprox. ${Math.floor(duracionMin / 60) > 0 ? `${Math.floor(duracionMin / 60)}h ` : ''}${duracionMin % 60 > 0 ? `${duracionMin % 60}min` : ''}` : 'Sin duracion por defecto (0h 00min)'}
                  </p>
                </div>
              )}

              {/* Unidad de Medida — solo Producto */}
              {!esServicioOComboLocal && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Unidad de Medida <span className="text-gray-400 font-normal">(Opcional)</span>
                  </label>
                  <SearchSelect
                    id="prod-unidad"
                    options={unidadOptions}
                    value={unidadBaseId}
                    onChange={setUnidadBaseId}
                    placeholder="Sin unidad"
                    searchPlaceholder="Buscar unidad..."
                    container={dialogRef.current}
                  />
                </div>
              )}

              {/* Presentacion — solo Producto */}
              {!esServicioOComboLocal && (
                <div>
                  <label htmlFor="prod-presentacion" className="block text-sm font-medium text-gray-700 mb-1">
                    Presentacion <span className="text-gray-400 font-normal">(Opcional)</span>
                  </label>
                  <input
                    id="prod-presentacion"
                    type="text"
                    value={presentacion}
                    onChange={(e) => setPresentacion(e.target.value.toUpperCase())}
                    placeholder="Ej: FRASCO 500ML, CAJA x12 UND"
                    autoComplete="off"
                    className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              )}

              {/* Stock Minimo — oculto para Servicio */}
              {tipo !== 'S' && (
                <div>
                  <label htmlFor="prod-stock-min" className="block text-sm font-medium text-gray-700 mb-1">
                    Stock Minimo
                    {tipo === 'C' && (
                      <span className="text-gray-400 font-normal ml-1">(Combos no aplica)</span>
                    )}
                  </label>
                  <input
                    id="prod-stock-min"
                    type="number"
                    inputMode="decimal"
                    step="0.001"
                    min="0"
                    value={esServicioOComboLocal ? '0' : stockMinimo}
                    onChange={(e) => setStockMinimo(e.target.value)}
                    onWheel={stopScroll}
                    disabled={esServicioOComboLocal}
                    placeholder="0"
                    className={`w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${noSpinner} ${
                      esServicioOComboLocal
                        ? 'bg-gray-100 text-gray-500 cursor-not-allowed'
                        : 'bg-white'
                    } ${errors.stock_minimo ? 'border-red-500' : 'border-gray-300'}`}
                  />
                  {errors.stock_minimo && (
                    <p className="text-red-500 text-xs mt-1">{errors.stock_minimo}</p>
                  )}
                </div>
              )}

              {/* Codigo de Barras */}
              <div>
                <label htmlFor="prod-codigo-barras" className="block text-sm font-medium text-gray-700 mb-1">
                  Codigo de Barras <span className="text-gray-400 font-normal">(Opcional)</span>
                </label>
                <input
                  id="prod-codigo-barras"
                  type="text"
                  value={codigoBarras}
                  onChange={(e) => setCodigoBarras(e.target.value)}
                  placeholder="Escanear o ingresar EAN-13, UPC, Code128..."
                  autoComplete="off"
                  className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="text-xs text-gray-400 mt-1">
                  Puede escanear directamente con un lector de codigo de barras
                </p>
              </div>

              {/* Activo — solo edicion */}
              {isEditing && (
                <div className="flex items-center gap-2">
                  <input
                    id="prod-activo"
                    type="checkbox"
                    checked={isActive}
                    onChange={(e) => setIsActive(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <label htmlFor="prod-activo" className="text-sm font-medium text-gray-700">
                    Activo
                  </label>
                </div>
              )}
            </>
          )}

          {/* ---- TAB B: Precios y Fiscalidad ---- */}
          {activeTab === 'precios' && (
            <div className="space-y-5">

              {/* Configuracion de IVA */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                  Configuracion de IVA
                </p>

                <div className="mb-3">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Tipo de Impuesto
                  </label>
                  <SearchSelect
                    id="prod-tipo-impuesto"
                    options={tipoImpuestoOptions}
                    value={tipoImpuesto}
                    onChange={(val) =>
                      handleTipoImpuestoChange(val as 'Gravable' | 'Exento' | 'Exonerado')
                    }
                    searchPlaceholder="Buscar tipo..."
                    error={errors.tipo_impuesto}
                    container={dialogRef.current}
                  />
                  {errors.tipo_impuesto && (
                    <p className="text-red-500 text-xs mt-1">{errors.tipo_impuesto}</p>
                  )}
                </div>

                {/* Tasa IVA % — solo si Gravable */}
                {tipoImpuesto === 'Gravable' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Tasa IVA (%)
                    </label>
                    <SearchSelect
                      id="prod-impuesto-iva"
                      options={tasaIvaOptions}
                      value={impuestoIvaId}
                      onChange={setImpuestoIvaId}
                      placeholder="Sin tasa especifica"
                      searchPlaceholder="Buscar tasa IVA..."
                      error={errors.impuesto_iva_id}
                      container={dialogRef.current}
                    />
                    {impuestosIva.length === 0 && (
                      <p className="text-amber-600 text-xs mt-1">
                        No hay tasas IVA configuradas. Agrega una en Configuracion &gt; Impuestos.
                      </p>
                    )}
                    {errors.impuesto_iva_id && (
                      <p className="text-red-500 text-xs mt-1">{errors.impuesto_iva_id}</p>
                    )}
                  </div>
                )}
              </div>

              {/* Costos */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  Costos
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="prod-costo" className="block text-xs font-medium text-gray-600 mb-1">
                      Costo (USD) <span className="text-red-500">*</span>
                    </label>
                    <input
                      id="prod-costo"
                      type="number"
                      inputMode="decimal"
                      step="any"
                      min="0"
                      value={esComboLocal ? '0' : costoUsd}
                      onChange={(e) => handleCostoUsdChange(e.target.value)}
                      onWheel={stopScroll}
                      disabled={esComboLocal}
                      placeholder="0.00"
                      className={`w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${noSpinner} ${
                        esComboLocal ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : 'bg-white'
                      } ${errors.costo_usd ? 'border-red-500' : 'border-gray-300'}`}
                    />
                    {errors.costo_usd && (
                      <p className="text-red-500 text-xs mt-0.5">{errors.costo_usd}</p>
                    )}
                    {esComboLocal && (
                      <p className="text-green-600 text-xs mt-0.5">Se calcula desde ingredientes</p>
                    )}
                  </div>
                  <div>
                    <label htmlFor="prod-costo-bs" className="block text-xs font-medium text-gray-600 mb-1">
                      Costo (Bs)
                    </label>
                    <input
                      id="prod-costo-bs"
                      type="number"
                      inputMode="decimal"
                      step="any"
                      min="0"
                      value={esComboLocal ? '0' : costoBs}
                      onChange={(e) => handleCostoBsChange(e.target.value)}
                      onWheel={stopScroll}
                      disabled={esComboLocal || tasaValor <= 0}
                      placeholder="0,00"
                      className={`w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${noSpinner} ${
                        esComboLocal || tasaValor <= 0
                          ? 'bg-gray-100 text-gray-500 cursor-not-allowed'
                          : 'bg-white'
                      } border-gray-300`}
                    />
                  </div>
                </div>
              </div>

              {/* Tabla de Precios por Nivel */}
              {!esComboLocal && (
                <div>
                  <div className="mb-2">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                      Esquema de Precios <span className="text-red-500 font-bold">v2</span>
                    </p>
                  </div>

                  <div className="border border-gray-200 rounded-md overflow-x-auto">
                    <table className="w-full text-sm min-w-max">
                      <thead className="bg-gray-50 border-b border-gray-200">
                        <tr>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 w-20">Precio</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">
                            Margen (%)
                          </th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Precio Venta $</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Precio Venta Bs</th>
                          {showIvaCols && (
                            <>
                              <th className="px-3 py-2 text-left text-xs font-medium text-blue-500">IVA $</th>
                              <th className="px-3 py-2 text-left text-xs font-medium text-blue-500">IVA Bs</th>
                              <th className="px-3 py-2 text-left text-xs font-medium text-green-600">Precio Final $</th>
                              <th className="px-3 py-2 text-left text-xs font-medium text-green-600">Precio Final Bs</th>
                            </>
                          )}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {/* Detal */}
                        <tr>
                          <td className="px-3 py-2 text-xs font-medium text-gray-700">
                            {nivel1?.nombre ?? 'Detal'}<span className="text-red-500">*</span>
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="number"
                              inputMode="decimal"
                              step="any"
                              value={margen}
                              onChange={(e) => handleMargenChange(e.target.value)}
                              onWheel={stopScroll}
                              placeholder="0"
                              className={`w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 ${noSpinner}`}
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              id="prod-venta"
                              type="number"
                              inputMode="decimal"
                              step="any"
                              min="0"
                              value={precioVentaUsd}
                              onChange={(e) => handlePrecioVentaUsdChange(e.target.value)}
                              onWheel={stopScroll}
                              placeholder="0.00"
                              className={`w-full rounded border px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white ${noSpinner} ${
                                errors.precio_venta_usd ? 'border-red-500' : 'border-gray-300'
                              }`}
                            />
                            {errors.precio_venta_usd && (
                              <p className="text-red-500 text-xs mt-0.5">{errors.precio_venta_usd}</p>
                            )}
                            <ProyeccionPvpHint proyeccion={proyeccionDetal} onAplicar={aplicarProyeccionDetal} />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="number"
                              inputMode="decimal"
                              step="any"
                              min="0"
                              value={precioVentaBs}
                              onChange={(e) => handlePrecioVentaBsChange(e.target.value)}
                              onWheel={stopScroll}
                              disabled={tasaValor <= 0}
                              placeholder="0,00"
                              className={`w-full rounded border px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 ${noSpinner} ${
                                tasaValor <= 0
                                  ? 'bg-gray-100 text-gray-500 cursor-not-allowed'
                                  : 'bg-white'
                              } border-gray-300`}
                            />
                          </td>
                          {showIvaCols && (
                            <>
                              <td className="px-2 py-1.5 bg-blue-50 text-xs text-blue-700 tabular-nums text-right whitespace-nowrap">
                                {ivaDetalUsd > 0 ? ivaDetalUsd.toFixed(2) : '—'}
                              </td>
                              <td className="px-2 py-1.5 bg-blue-50 text-xs text-blue-700 tabular-nums text-right whitespace-nowrap">
                                {tasaValor > 0 && ivaDetalUsd > 0 ? usdToBs(ivaDetalUsd, tasaValor).toFixed(2) : '—'}
                              </td>
                              <td className="px-2 py-1.5">
                                <input
                                  key={`pf-detal-usd-${pfDetalUsd.toFixed(4)}`}
                                  type="number"
                                  inputMode="decimal"
                                  step="any"
                                  min="0"
                                  defaultValue={pfDetalUsd > 0 ? pfDetalUsd.toFixed(2) : ''}
                                  onBlur={(e) => handlePrecioFinalDetalUsdChange(e.target.value)}
                                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                                  onWheel={stopScroll}
                                  placeholder="0.00"
                                  className={`w-full rounded border border-green-300 bg-white px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-green-500 ${noSpinner}`}
                                />
                              </td>
                              <td className="px-2 py-1.5">
                                <input
                                  key={`pf-detal-bs-${pfDetalBs.toFixed(4)}`}
                                  type="number"
                                  inputMode="decimal"
                                  step="any"
                                  min="0"
                                  defaultValue={pfDetalBs > 0 ? pfDetalBs.toFixed(2) : ''}
                                  onBlur={(e) => handlePrecioFinalDetalBsChange(e.target.value)}
                                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                                  onWheel={stopScroll}
                                  disabled={tasaValor <= 0}
                                  placeholder="0,00"
                                  className={`w-full rounded border px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-green-500 ${noSpinner} ${
                                    tasaValor <= 0 ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : 'border-green-300 bg-white'
                                  }`}
                                />
                              </td>
                            </>
                          )}
                        </tr>

                        {/* Mayor */}
                        {nivel2 && (
                        <tr>
                          <td className="px-3 py-2 text-xs text-gray-500">
                            {nivel2?.nombre ?? 'Mayor'}
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="number"
                              inputMode="decimal"
                              step="any"
                              value={margenMayor}
                              onChange={(e) => handleMargenMayorChange(e.target.value)}
                              onWheel={stopScroll}
                              placeholder="0"
                              className={`w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 ${noSpinner}`}
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              id="prod-mayor"
                              type="number"
                              inputMode="decimal"
                              step="any"
                              min="0"
                              value={precioMayorUsd}
                              onChange={(e) => handlePrecioMayorUsdChange(e.target.value)}
                              onWheel={stopScroll}
                              placeholder="0.00"
                              className={`w-full rounded border px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white ${noSpinner} ${
                                errors.precio_mayor_usd ? 'border-red-500' : 'border-gray-300'
                              }`}
                            />
                            {errors.precio_mayor_usd && (
                              <p className="text-red-500 text-xs mt-0.5">{errors.precio_mayor_usd}</p>
                            )}
                            <ProyeccionPvpHint proyeccion={proyeccionMayor} onAplicar={aplicarProyeccionMayor} />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="number"
                              inputMode="decimal"
                              step="any"
                              min="0"
                              value={precioMayorBs}
                              onChange={(e) => handlePrecioMayorBsChange(e.target.value)}
                              onWheel={stopScroll}
                              disabled={tasaValor <= 0}
                              placeholder="0,00"
                              className={`w-full rounded border px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 ${noSpinner} ${
                                tasaValor <= 0
                                  ? 'bg-gray-100 text-gray-500 cursor-not-allowed'
                                  : 'bg-white'
                              } border-gray-300`}
                            />
                          </td>
                          {showIvaCols && (
                            <>
                              <td className="px-2 py-1.5 bg-blue-50 text-xs text-blue-700 tabular-nums text-right whitespace-nowrap">
                                {ivaMayorUsd > 0 ? ivaMayorUsd.toFixed(2) : '—'}
                              </td>
                              <td className="px-2 py-1.5 bg-blue-50 text-xs text-blue-700 tabular-nums text-right whitespace-nowrap">
                                {tasaValor > 0 && ivaMayorUsd > 0 ? usdToBs(ivaMayorUsd, tasaValor).toFixed(2) : '—'}
                              </td>
                              <td className="px-2 py-1.5">
                                <input
                                  key={`pf-mayor-usd-${pfMayorUsd.toFixed(4)}`}
                                  type="number"
                                  inputMode="decimal"
                                  step="any"
                                  min="0"
                                  defaultValue={pfMayorUsd > 0 ? pfMayorUsd.toFixed(2) : ''}
                                  onBlur={(e) => handlePrecioFinalMayorUsdChange(e.target.value)}
                                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                                  onWheel={stopScroll}
                                  placeholder="0.00"
                                  className={`w-full rounded border border-green-300 bg-white px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-green-500 ${noSpinner}`}
                                />
                              </td>
                              <td className="px-2 py-1.5">
                                <input
                                  key={`pf-mayor-bs-${pfMayorBs.toFixed(4)}`}
                                  type="number"
                                  inputMode="decimal"
                                  step="any"
                                  min="0"
                                  defaultValue={pfMayorBs > 0 ? pfMayorBs.toFixed(2) : ''}
                                  onBlur={(e) => handlePrecioFinalMayorBsChange(e.target.value)}
                                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                                  onWheel={stopScroll}
                                  disabled={tasaValor <= 0}
                                  placeholder="0,00"
                                  className={`w-full rounded border px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-green-500 ${noSpinner} ${
                                    tasaValor <= 0 ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : 'border-green-300 bg-white'
                                  }`}
                                />
                              </td>
                            </>
                          )}
                        </tr>
                        )}

                        {/* Especial */}
                        {nivel3 && (
                        <tr>
                          <td className="px-3 py-2 text-xs text-gray-500">
                            {nivel3?.nombre ?? 'Especial'}
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="number"
                              inputMode="decimal"
                              step="any"
                              value={margenEspecial}
                              onChange={(e) => handleMargenEspecialChange(e.target.value)}
                              onWheel={stopScroll}
                              placeholder="0"
                              className={`w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 ${noSpinner}`}
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              id="prod-especial"
                              type="number"
                              inputMode="decimal"
                              step="any"
                              min="0"
                              value={precioEspecialUsd}
                              onChange={(e) => handlePrecioEspecialUsdChange(e.target.value)}
                              onWheel={stopScroll}
                              placeholder="0.00"
                              className={`w-full rounded border px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white ${noSpinner} ${
                                errors.precio_especial_usd ? 'border-red-500' : 'border-gray-300'
                              }`}
                            />
                            {errors.precio_especial_usd && (
                              <p className="text-red-500 text-xs mt-0.5">{errors.precio_especial_usd}</p>
                            )}
                            <ProyeccionPvpHint proyeccion={proyeccionEspecial} onAplicar={aplicarProyeccionEspecial} />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="number"
                              inputMode="decimal"
                              step="any"
                              min="0"
                              value={precioEspecialBs}
                              onChange={(e) => handlePrecioEspecialBsChange(e.target.value)}
                              onWheel={stopScroll}
                              disabled={tasaValor <= 0}
                              placeholder="0,00"
                              className={`w-full rounded border px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 ${noSpinner} ${
                                tasaValor <= 0
                                  ? 'bg-gray-100 text-gray-500 cursor-not-allowed'
                                  : 'bg-white'
                              } border-gray-300`}
                            />
                          </td>
                          {showIvaCols && (
                            <>
                              <td className="px-2 py-1.5 bg-blue-50 text-xs text-blue-700 tabular-nums text-right whitespace-nowrap">
                                {ivaEspecialUsd > 0 ? ivaEspecialUsd.toFixed(2) : '—'}
                              </td>
                              <td className="px-2 py-1.5 bg-blue-50 text-xs text-blue-700 tabular-nums text-right whitespace-nowrap">
                                {tasaValor > 0 && ivaEspecialUsd > 0 ? usdToBs(ivaEspecialUsd, tasaValor).toFixed(2) : '—'}
                              </td>
                              <td className="px-2 py-1.5">
                                <input
                                  key={`pf-especial-usd-${pfEspecialUsd.toFixed(4)}`}
                                  type="number"
                                  inputMode="decimal"
                                  step="any"
                                  min="0"
                                  defaultValue={pfEspecialUsd > 0 ? pfEspecialUsd.toFixed(2) : ''}
                                  onBlur={(e) => handlePrecioFinalEspecialUsdChange(e.target.value)}
                                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                                  onWheel={stopScroll}
                                  placeholder="0.00"
                                  className={`w-full rounded border border-green-300 bg-white px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-green-500 ${noSpinner}`}
                                />
                              </td>
                              <td className="px-2 py-1.5">
                                <input
                                  key={`pf-especial-bs-${pfEspecialBs.toFixed(4)}`}
                                  type="number"
                                  inputMode="decimal"
                                  step="any"
                                  min="0"
                                  defaultValue={pfEspecialBs > 0 ? pfEspecialBs.toFixed(2) : ''}
                                  onBlur={(e) => handlePrecioFinalEspecialBsChange(e.target.value)}
                                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                                  onWheel={stopScroll}
                                  disabled={tasaValor <= 0}
                                  placeholder="0,00"
                                  className={`w-full rounded border px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-green-500 ${noSpinner} ${
                                    tasaValor <= 0 ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : 'border-green-300 bg-white'
                                  }`}
                                />
                              </td>
                            </>
                          )}
                        </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

            </div>
          )}

          {/* ---- TAB C: Ubicacion e Inventario ---- */}
          {activeTab === 'inventario' && tipo !== 'S' && (
            <>
              {/* Inventario Inicial — solo creacion tipo P */}
              {!isEditing && tipo === 'P' && (
                <div className="border border-gray-200 rounded-md p-3 space-y-3 bg-gray-50">
                  <p className="text-xs font-medium text-gray-600">Inventario Inicial</p>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Deposito <span className="text-red-500">*</span>
                    </label>
                    <SearchSelect
                      id="prod-deposito"
                      options={depositoOptions}
                      value={depositoId}
                      onChange={setDepositoId}
                      placeholder="Seleccionar deposito"
                      searchPlaceholder="Buscar deposito..."
                      error={errors.deposito_id}
                      container={dialogRef.current}
                    />
                    {errors.deposito_id && (
                      <p className="text-red-500 text-xs mt-1">{errors.deposito_id}</p>
                    )}
                  </div>
                  <div>
                    <label htmlFor="prod-stock-inicial" className="block text-sm font-medium text-gray-700 mb-1">
                      Stock Inicial <span className="text-gray-400 font-normal">(Opcional)</span>
                    </label>
                    <input
                      id="prod-stock-inicial"
                      type="number"
                      inputMode="decimal"
                      step="0.001"
                      min="0"
                      value={stockInicial}
                      onChange={(e) => setStockInicial(e.target.value)}
                      onWheel={stopScroll}
                      placeholder="0.000"
                      className={`w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${noSpinner}`}
                    />
                    <p className="text-xs text-gray-400 mt-1">
                      Los movimientos posteriores se gestionan via Compras o Ajustes
                    </p>
                  </div>
                </div>
              )}

              {/* Deposito por Defecto — editable, solo edicion tipo P */}
              {isEditing && producto && tipo === 'P' && (
                <div className="border border-gray-200 rounded-md p-3 space-y-2 bg-gray-50">
                  <p className="text-xs font-medium text-gray-600">Deposito por Defecto</p>
                  <div>
                    <label htmlFor="prod-deposito-edit" className="block text-sm font-medium text-gray-700 mb-1">
                      Deposito <span className="text-red-500">*</span>
                    </label>
                    <SearchSelect
                      id="prod-deposito-edit"
                      options={depositoOptions}
                      value={depositoId}
                      onChange={setDepositoId}
                      placeholder="Seleccionar deposito"
                      searchPlaceholder="Buscar deposito..."
                      error={errors.deposito_id}
                      container={dialogRef.current}
                    />
                    {errors.deposito_id && (
                      <p className="text-red-500 text-xs mt-1">{errors.deposito_id}</p>
                    )}
                  </div>
                  <p className="text-xs text-gray-400">
                    Deposito donde ingresa stock nuevo por defecto (compras, kardex). Cambiarlo no mueve el stock existente.
                  </p>
                </div>
              )}

              {/* Stock actual — edicion tipo P */}
              {isEditing && producto && tipo === 'P' && (
                <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 rounded-md border border-gray-200">
                  <span className="text-sm text-gray-500">Stock actual:</span>
                  <span className="text-sm font-semibold text-gray-900">
                    {parseFloat(producto.stock).toFixed(3)}
                  </span>
                  <span className="text-xs text-gray-400">(modificar via Compras o Ajustes)</span>
                </div>
              )}

              {/* Ubicacion Fisica — solo Producto (no Combo) */}
              {tipo === 'P' && (
                <div>
                  <label htmlFor="prod-ubicacion" className="block text-sm font-medium text-gray-700 mb-1">
                    Ubicacion Fisica <span className="text-gray-400 font-normal">(Opcional)</span>
                  </label>
                  <input
                    id="prod-ubicacion"
                    type="text"
                    value={ubicacion}
                    onChange={(e) => setUbicacion(e.target.value.toUpperCase())}
                    placeholder="Ej: PASILLO 3, ESTANTE A"
                    autoComplete="off"
                    className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              )}

              {/* Manejo de Lotes */}
              <div className="flex items-center gap-2">
                <input
                  id="prod-maneja-lotes"
                  type="checkbox"
                  checked={manejaLotes}
                  onChange={(e) => setManejaLotes(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <label htmlFor="prod-maneja-lotes" className="text-sm font-medium text-gray-700">
                  Manejo de Lotes
                </label>
                <span className="text-xs text-gray-400">(Activa control FEFO)</span>
              </div>

              {/* Consulta de Lotes — solo edicion tipo P */}
              {isEditing && tipo === 'P' && (
                <div>
                  <p className="text-sm font-medium text-gray-700 mb-2">Lotes Existentes</p>
                  {lotes.length === 0 ? (
                    <p className="text-xs text-gray-400 italic py-2">Sin lotes registrados</p>
                  ) : (
                    <div className="overflow-x-auto border border-gray-200 rounded-md">
                      <table className="w-full text-xs">
                        <thead className="bg-gray-50 border-b border-gray-200">
                          <tr>
                            <th className="px-3 py-2 text-left font-medium text-gray-600">Nro. Lote</th>
                            <th className="px-3 py-2 text-left font-medium text-gray-600">Vencimiento</th>
                            <th className="px-3 py-2 text-right font-medium text-gray-600">Cantidad</th>
                            <th className="px-3 py-2 text-left font-medium text-gray-600">Estado</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {lotes.map((lote, idx) => (
                            <tr key={idx} className="hover:bg-gray-50">
                              <td className="px-3 py-2 font-mono">{lote.nro_lote}</td>
                              <td className="px-3 py-2">{lote.fecha_vencimiento ?? '—'}</td>
                              <td className="px-3 py-2 text-right tabular-nums">
                                {parseFloat(lote.cantidad_actual).toFixed(3)}
                              </td>
                              <td className="px-3 py-2">
                                <span
                                  className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${
                                    lote.status === 'ACTIVO'
                                      ? 'bg-green-100 text-green-700'
                                      : lote.status === 'AGOTADO'
                                      ? 'bg-gray-100 text-gray-600'
                                      : 'bg-red-100 text-red-700'
                                  }`}
                                >
                                  {lote.status}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* ============================================================
            STICKY FOOTER — Acciones
        ============================================================ */}
        <div className="flex-none bg-white border-t border-gray-200 px-6 py-4 flex items-center justify-between gap-3">
          <p className="text-xs text-gray-400">
            {!esComboLocal && parseNumOrZero(costoUsd) === 0 && (
              <span className="text-amber-600">Ingresa el costo para habilitar el guardado</span>
            )}
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200 transition-colors disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isSubmitDisabled}
              title={
                !codigo.trim()
                  ? 'Ingresa el codigo'
                  : !nombre.trim()
                  ? 'Ingresa el nombre'
                  : !esComboLocal && parseNumOrZero(costoUsd) === 0
                  ? 'El costo no puede ser 0'
                  : undefined
              }
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Guardando...' : isEditing ? 'Actualizar' : 'Crear'}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  )
}
