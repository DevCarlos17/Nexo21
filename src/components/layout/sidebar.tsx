import { useRef, useCallback, useEffect, useState } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import {
  SquaresFour,
  Package,
  Folders,
  ShoppingBag,
  ArrowsLeftRight,
  BookOpen,
  Users,
  ShoppingCart,
  CreditCard,
  FileX,
  ChartBar,
  Heart,
  Gear,
  CurrencyDollar,
  SignOut,
  CaretDown,
  Truck,
  Buildings,
  UserGear,
  Bank,
  Wallet,
  Receipt,
  ClipboardText,
  Calculator,
  Tag,
  Ruler,
  Warehouse,
  Stack,
  ArrowsClockwise,
  Monitor,
  ArrowsDownUp,
  FileXls,

  Vault,

  TrendUp,
  Handshake,
  ListNumbers,
  CalendarDots,
  Kanban,
  Clock,
  UserCircle,
} from '@phosphor-icons/react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import { useSidebarStore } from '@/stores/sidebar-store'
import { useAuth } from '@/core/auth/auth-provider'
import { useCurrentUser } from '@/core/hooks/use-current-user'
import { usePermissions, PERMISSIONS, type PermissionKey } from '@/core/hooks/use-permissions'
import { useSesionesActivas } from '@/features/caja/hooks/use-sesiones-caja'
import { useAgendaConfig } from '@/features/citas/hooks/use-agenda-config'
import { toast } from 'sonner'

interface SidebarProps {
  isOpen: boolean
  onClose: () => void
}

interface ChildMenuItem {
  title: string
  url: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  requiredPermission?: PermissionKey
}

interface MenuItem {
  title: string
  url?: string
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>
  disabled?: boolean
  requiredPermission?: PermissionKey
  children?: ChildMenuItem[]
}

const menuItems: MenuItem[] = [
  { title: 'Dashboard', url: '/dashboard', icon: SquaresFour },
  {
    title: 'Ventas',
    icon: ShoppingCart,
    children: [
      { title: 'Nueva Venta', url: '/ventas/nueva', icon: ShoppingCart, requiredPermission: PERMISSIONS.SALES_CREATE },
      { title: 'Facturas emitidas', url: '/ventas/facturas-emitidas', icon: FileX, requiredPermission: PERMISSIONS.SALES_VOID },
      { title: 'Dashboard de Ventas', url: '/ventas/reportes', icon: ChartBar, requiredPermission: PERMISSIONS.REPORTS_VIEW },
      { title: 'Cuadre de Caja', url: '/ventas/cuadre-de-caja', icon: Receipt, requiredPermission: PERMISSIONS.REPORTS_CASHCLOSE },
      { title: 'Prestamos', url: '/ventas/prestamos', icon: Handshake, requiredPermission: PERMISSIONS.CLIENTS_CREDIT },
    ],
  },
  {
    title: 'Caja',
    icon: Wallet,
    children: [
      { title: 'Sesiones', url: '/caja/sesiones', icon: Monitor, requiredPermission: PERMISSIONS.CAJA_ACCESS },
      { title: 'Movimientos', url: '/caja/movimientos', icon: ArrowsDownUp, requiredPermission: PERMISSIONS.CAJA_ACCESS },
      { title: 'Rendimiento', url: '/caja/rendimiento', icon: ChartBar, requiredPermission: PERMISSIONS.CONFIG_RATES },
      { title: 'Cajas', url: '/configuracion/cajas', icon: Monitor, requiredPermission: PERMISSIONS.CONFIG_RATES },
    ],
  },
  {
    title: 'Inventario',
    icon: Package,
    children: [
      { title: 'Departamentos', url: '/inventario/departamentos', icon: Folders, requiredPermission: PERMISSIONS.INVENTORY_VIEW },
      { title: 'Productos / Servicios', url: '/inventario/productos', icon: ShoppingBag, requiredPermission: PERMISSIONS.INVENTORY_VIEW },
      { title: 'Kardex', url: '/inventario/kardex', icon: ArrowsLeftRight, requiredPermission: PERMISSIONS.INVENTORY_VIEW },
      { title: 'Servicios y Recetas', url: '/inventario/recetas', icon: BookOpen, requiredPermission: PERMISSIONS.INVENTORY_VIEW },
      { title: 'Reportes de Inventario', url: '/inventario/reportes', icon: ChartBar, requiredPermission: PERMISSIONS.INVENTORY_VIEW },
      { title: 'Marcas', url: '/inventario/marcas', icon: Tag, requiredPermission: PERMISSIONS.INVENTORY_VIEW },
      { title: 'Unidades', url: '/inventario/unidades', icon: Ruler, requiredPermission: PERMISSIONS.INVENTORY_VIEW },
      { title: 'Depositos', url: '/inventario/depositos', icon: Warehouse, requiredPermission: PERMISSIONS.INVENTORY_VIEW },
      { title: 'Traspasos', url: '/inventario/traspasos', icon: ArrowsClockwise, requiredPermission: PERMISSIONS.INVENTORY_ADJUST },
      { title: 'Lotes', url: '/inventario/lotes', icon: Stack, requiredPermission: PERMISSIONS.INVENTORY_VIEW },
    ],
  },
  {
    title: 'Compras y Gastos',
    icon: ClipboardText,
    children: [
      { title: 'Compras', url: '/compras/facturas', icon: FileXls, requiredPermission: PERMISSIONS.PURCHASES_VIEW },
      { title: 'Gastos', url: '/compras/gastos-dashboard', icon: ChartBar, requiredPermission: PERMISSIONS.PURCHASES_VIEW },
      { title: 'Cuentas por Pagar', url: '/compras/cxp', icon: CreditCard, requiredPermission: PERMISSIONS.PURCHASES_VIEW },
      { title: 'Proveedor', url: '/proveedores/gestion', icon: Truck, requiredPermission: PERMISSIONS.INVENTORY_ADJUST },
    ],
  },
  {
    title: 'Clientes',
    icon: Users,
    children: [
      { title: 'Gestion de Clientes', url: '/clientes/gestion', icon: Users, requiredPermission: PERMISSIONS.CLIENTS_MANAGE },
      { title: 'Cuentas por Cobrar', url: '/clientes/cuentas-por-cobrar', icon: CreditCard, requiredPermission: PERMISSIONS.CLIENTS_CREDIT },
      { title: 'Reportes de CxC', url: '/clientes/reportes', icon: ChartBar, requiredPermission: PERMISSIONS.CLIENTS_CREDIT },
    ],
  },
  {
    title: 'Agenda y Citas',
    icon: CalendarDots,
    children: [
      { title: 'Calendario', url: '/citas/calendario', icon: CalendarDots, requiredPermission: PERMISSIONS.CITAS_VIEW },
      { title: 'Panel de Trabajo', url: '/citas/panel', icon: Kanban, requiredPermission: PERMISSIONS.CITAS_VIEW },
      { title: 'Horarios de Staff', url: '/citas/horarios-staff', icon: Clock, requiredPermission: PERMISSIONS.CITAS_HORARIOS },
    ],
  },
  {
    title: 'Configuracion',
    icon: Gear,
    children: [
      { title: 'Datos Empresa', url: '/configuracion/datos-empresa', icon: Buildings, requiredPermission: PERMISSIONS.CONFIG_RATES },
      { title: 'Tasa de Cambio', url: '/configuracion/tasa-cambio', icon: CurrencyDollar, requiredPermission: PERMISSIONS.CONFIG_RATES },
      { title: 'Usuarios y Perfiles', url: '/configuracion/usuarios', icon: UserGear, requiredPermission: PERMISSIONS.CONFIG_USERS },
      { title: 'Impuestos', url: '/configuracion/impuestos', icon: Calculator, requiredPermission: PERMISSIONS.CONFIG_RATES },
      { title: 'Niveles de Precio', url: '/configuracion/niveles-precio', icon: ListNumbers, requiredPermission: PERMISSIONS.CONFIG_RATES },
    ],
  },
  {
    title: 'Informacion Bancaria',
    icon: Bank,
    children: [
      { title: 'Bancos', url: '/configuracion/bancos', icon: Bank, requiredPermission: PERMISSIONS.CONFIG_RATES },
      { title: 'Tesoreria', url: '/tesoreria', icon: Vault, requiredPermission: PERMISSIONS.CONFIG_RATES },
      { title: 'Diferencial Cambiario', url: '/bancos/diferencial-cambiario', icon: TrendUp, requiredPermission: PERMISSIONS.ACCOUNTING_VIEW },
    ],
  },
  { title: 'Clinica', url: '/clinica', icon: Heart, requiredPermission: PERMISSIONS.CLINIC_ACCESS },
  { title: 'Mi Perfil', url: '/perfil', icon: UserCircle },
]

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const { isHovered, setHovered, isMobile, setMobile, setOpen } = useSidebarStore()
  const router = useRouterState()
  const currentPath = router.location.pathname
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [mounted, setMounted] = useState(false)
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})

  const { signOut } = useAuth()
  const { user } = useCurrentUser()
  const { hasPermission } = usePermissions()
  const { sesiones: sesionesActivas } = useSesionesActivas()
  const haySesionAbierta = sesionesActivas.length > 0
  const { mostrarAgenda } = useAgendaConfig()

  // Funnel menu items based on permissions and feature flags
  const filteredMenuItems = menuItems
    .filter((item) => {
      if (item.title === 'Agenda y Citas' && !mostrarAgenda) return false
      if (item.requiredPermission && !hasPermission(item.requiredPermission)) return false
      if (item.children) {
        return item.children.some((child) => !child.requiredPermission || hasPermission(child.requiredPermission))
      }
      return true
    })
    .map((item) => {
      if (!item.children) return item
      return {
        ...item,
        children: item.children.filter((child) => !child.requiredPermission || hasPermission(child.requiredPermission)),
      }
    })

  const isActive = (path: string) => {
    if (currentPath === path) return true
    if (path !== '/' && currentPath.startsWith(path + '/')) return true
    return false
  }

  const isGroupActive = (children: { url: string }[]) => {
    return children.some((child) => isActive(child.url))
  }

  const toggleGroup = (title: string) => {
    setExpandedGroups((prev) => ({ [title]: !prev[title] }))
  }

  const handleLogout = async () => {
    try {
      await signOut()
      toast.success('Sesion cerrada')
      window.location.href = '/login'
    } catch {
      toast.error('Error al cerrar sesion')
    }
  }

  const clearHoverTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  const handleMouseEnter = useCallback(() => {
    if (!isMobile) {
      clearHoverTimeout()
      setHovered(true)
    }
  }, [isMobile, setHovered, clearHoverTimeout])

  const handleMouseLeave = useCallback(() => {
    if (!isMobile) {
      clearHoverTimeout()
      timeoutRef.current = setTimeout(() => {
        setHovered(false)
        timeoutRef.current = null
      }, 100)
    }
  }, [isMobile, setHovered, clearHoverTimeout])

  useEffect(() => {
    setMounted(true)
    const checkMobile = () => {
      const isMobileView = window.innerWidth < 1024
      setMobile(isMobileView)
      if (!isMobileView && isOpen) setOpen(false)
    }
    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => {
      window.removeEventListener('resize', checkMobile)
      clearHoverTimeout()
    }
  }, [clearHoverTimeout, setMobile, isOpen, setOpen])

  // Auto-expand groups that have active children
  useEffect(() => {
    const newExpanded: Record<string, boolean> = {}
    for (const item of filteredMenuItems) {
      if (item.children && isGroupActive(item.children)) {
        newExpanded[item.title] = true
      }
    }
    setExpandedGroups(newExpanded)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath])

  const handleLinkClick = () => {
    if (isMobile && isOpen) onClose()
  }

  if (!mounted) return null

  const renderMenuItem = (item: MenuItem, expanded: boolean) => {
    if (item.children) {
      const groupExpanded = expandedGroups[item.title] || false
      const groupIsActive = isGroupActive(item.children)

      return (
        <div key={item.title}>
          <button
            onClick={() => toggleGroup(item.title)}
            className={cn(
              'flex items-center w-full gap-3 px-4 py-3 rounded-xl transition-all duration-200 active:scale-[0.98] cursor-pointer',
              groupIsActive
                ? 'text-[var(--color-sidebar-fg)] font-medium'
                : 'text-[var(--color-sidebar-muted-fg)] hover:text-[var(--color-sidebar-fg)] hover:bg-[var(--color-sidebar-hover)]'
            )}
          >
            <div className="relative shrink-0">
              <item.icon size={20} />
              {item.title === 'Caja' && haySesionAbierta && (
                <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-amber-500" />
              )}
            </div>
            {expanded && (
              <>
                <span className="text-sm font-medium flex-1 text-left">{item.title}</span>
                <CaretDown
                  size={16}
                  className={cn('transition-transform duration-200', groupExpanded && 'rotate-180')}
                />
              </>
            )}
          </button>
          <AnimatePresence initial={false}>
            {expanded && groupExpanded && (
              <motion.div
                key={item.title}
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
                className="overflow-hidden"
              >
                <div className="ml-4 pl-4 border-l border-primary/30 space-y-1 mt-1">
                  {item.children.map((child) => {
                    const childActive = isActive(child.url)
                    return (
                      <Link
                        key={child.url}
                        to={child.url as any}
                        onClick={handleLinkClick}
                        className={cn(
                          'flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-200 text-sm',
                          childActive
                            ? 'bg-[var(--color-sidebar-active-bg)] text-[var(--color-sidebar-accent)] font-medium'
                            : 'text-[var(--color-sidebar-muted-fg)] hover:text-[var(--color-sidebar-fg)] hover:bg-[var(--color-sidebar-hover)]'
                        )}
                      >
                        <child.icon size={16} />
                        <span>{child.title}</span>
                      </Link>
                    )
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )
    }

    if (item.disabled) {
      return (
        <div
          key={item.title}
          className="flex items-center gap-3 px-4 py-3 rounded-xl text-muted-foreground/50 cursor-not-allowed"
        >
          <item.icon size={20} />
          {expanded && <span className="text-sm">{item.title}</span>}
        </div>
      )
    }

    const isActiveRoute = isActive(item.url!)
    return (
      <Link
        key={item.url}
        to={item.url! as any}
        onClick={handleLinkClick}
        className={cn(
          'flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 active:scale-[0.98]',
          isActiveRoute
            ? 'bg-[var(--color-sidebar-active-bg)] text-[var(--color-sidebar-accent)] shadow-sm'
            : 'text-[var(--color-sidebar-muted-fg)] hover:text-[var(--color-sidebar-fg)] hover:bg-[var(--color-sidebar-hover)]'
        )}
      >
        <item.icon size={20} />
        {expanded && <span className="text-sm font-medium">{item.title}</span>}
      </Link>
    )
  }

  // Mobile drawer
  if (isMobile) {
    return (
      <>
        {isOpen && (
          <div className="fixed inset-0 bg-black/50 z-60 backdrop-blur-sm" onClick={onClose} />
        )}
        <div
          className={cn(
            'fixed left-0 top-0 h-full w-72 bg-sidebar z-70 shadow-2xl transition-transform duration-300 ease-out',
            isOpen ? 'translate-x-0' : '-translate-x-full'
          )}
        >
          <div className="flex flex-col h-full py-6 px-4">
            <Link to="/dashboard" className="flex items-center gap-3 mb-8" onClick={handleLinkClick}>
              <span className="text-2xl font-bold text-primary">CP</span>
              <span className="font-bold text-xl text-[var(--color-sidebar-fg)]">ClaraPOS</span>
            </Link>

            <nav className="flex-1 space-y-1 overflow-y-auto">
              {filteredMenuItems.map((item) => renderMenuItem(item, true))}
            </nav>

            <div className="mt-4 pt-4 border-t border-border">
              <div className="flex items-center gap-3 mb-3 p-3 rounded-xl bg-[var(--color-sidebar-hover)]">
                <div className="w-10 h-10 bg-primary rounded-full flex items-center justify-center">
                  <span className="text-primary-foreground text-sm font-semibold">
                    {user?.nombre?.[0]?.toUpperCase() ?? 'U'}
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-[var(--color-sidebar-fg)]">{user?.nombre ?? 'Usuario'}</span>
                  <span className="text-xs text-[var(--color-sidebar-muted-fg)]">{user?.rol_nombre ?? 'Usuario'}</span>
                </div>
              </div>

              <button
                onClick={handleLogout}
                className="flex items-center w-full gap-3 p-3 rounded-xl text-destructive hover:bg-destructive/10 transition-all duration-200 active:scale-[0.98] cursor-pointer"
              >
                <SignOut size={20} />
                <span className="text-sm font-medium">Cerrar Sesion</span>
              </button>
            </div>
          </div>
        </div>
      </>
    )
  }

  // Desktop hover-expand
  return (
    <div
      className="fixed left-3 top-3 bottom-3 z-50"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div
        className={cn(
          'flex flex-col h-full py-6 relative transition-all duration-300 ease-out rounded-2xl shadow-xl border border-border/20 overflow-hidden',
          isHovered ? 'w-60 bg-sidebar' : 'w-[68px] bg-sidebar'
        )}
      >
        {/* Logo */}
        <div className={cn('flex items-center mb-10 transition-all duration-300', isHovered ? 'px-6' : 'justify-center px-0')}>
          <Link to="/dashboard" className="shrink-0 transition-transform duration-300 hover:scale-105">
            <span className="text-xl font-bold text-primary">CP</span>
          </Link>
          <span
            className={cn(
              'font-bold tracking-tight text-xl text-[var(--color-sidebar-fg)] whitespace-nowrap transition-all duration-300',
              isHovered ? 'opacity-100 translate-x-0 ml-3' : 'opacity-0 -translate-x-4 w-0 h-0'
            )}
          >
            ClaraPOS
          </span>
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-1 px-3 overflow-y-auto">
          {filteredMenuItems.map((item) => {
            if (item.children) {
              const groupIsActive = isGroupActive(item.children)
              if (!isHovered) {
                // Collapsed: just show icon, active if any child is active
                return (
                  <div key={item.title} className={cn('relative flex items-center justify-center h-11 w-11 mx-auto rounded-2xl', groupIsActive ? 'text-[var(--color-sidebar-accent)]' : 'text-[var(--color-sidebar-muted-fg)]')}>
                    <item.icon size={20} strokeWidth={groupIsActive ? 2.5 : 2} />
                    {item.title === 'Caja' && haySesionAbierta && (
                      <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-amber-500" />
                    )}
                  </div>
                )
              }
              return renderMenuItem(item, true)
            }

            if (item.disabled) {
              return (
                <div
                  key={item.title}
                  className={cn('flex items-center h-11 rounded-2xl transition-all duration-300 text-[var(--color-sidebar-muted-fg)] opacity-40', isHovered ? 'px-3' : 'justify-center w-11 mx-auto')}
                >
                  <div className="shrink-0 w-10 flex justify-center">
                    <item.icon size={20} />
                  </div>
                  {isHovered && <span className="text-sm ml-3 whitespace-nowrap">{item.title}</span>}
                </div>
              )
            }

            const isActiveRoute = isActive(item.url!)
            return (
              <Link
                key={item.url}
                to={item.url! as any}
                className={cn(
                  'flex items-center h-11 rounded-2xl transition-all duration-300 group relative active:scale-[0.98] overflow-visible',
                  isHovered ? 'px-3' : 'justify-center w-11 mx-auto',
                  isActiveRoute ? 'text-[var(--color-sidebar-accent)] font-bold' : 'text-[var(--color-sidebar-muted-fg)] hover:text-[var(--color-sidebar-fg)]'
                )}
              >
                {isActiveRoute && (
                  <motion.div
                    layoutId="sidebar-active-pill"
                    className="absolute left-[-8px] w-[3px] h-6 bg-[var(--color-sidebar-accent)] rounded-full z-20"
                    transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                  />
                )}
                <div className="shrink-0 w-10 flex justify-center z-10">
                  <item.icon
                    className="transition-colors duration-300"
                    size={20}
                    strokeWidth={isActiveRoute ? 2.5 : 2}
                  />
                </div>
                <span
                  className={cn(
                    'text-[14px] font-medium tracking-tight transition-all duration-300 whitespace-nowrap z-10',
                    isHovered ? 'opacity-100 translate-x-0 ml-3' : 'opacity-0 -translate-x-4 w-0 h-0 overflow-hidden'
                  )}
                >
                  {item.title}
                </span>
              </Link>
            )
          })}
        </nav>

        {/* Bottom section */}
        <div className="mt-auto flex flex-col gap-4 pt-6 border-t border-border px-3">
          <div className={cn('flex items-center rounded-xl hover:bg-[var(--color-sidebar-hover)] transition-all duration-300 group active:scale-[0.98] overflow-hidden p-1.5', isHovered ? 'w-full' : 'justify-center w-11 mx-auto')}>
            <div className="w-9 h-9 bg-muted text-primary border border-border/10 rounded-full flex items-center justify-center shrink-0">
              <span className="text-xs font-bold uppercase tracking-wider">
                {user?.nombre?.[0]?.toUpperCase() ?? 'U'}
              </span>
            </div>
            <div className={cn('flex flex-col transition-all duration-300 overflow-hidden', isHovered ? 'opacity-100 translate-x-0 ml-3.5' : 'opacity-0 -translate-x-4 w-0 h-0')}>
              <span className="text-[14px] font-bold text-[var(--color-sidebar-fg)] truncate tracking-tight">{user?.nombre ?? 'Usuario'}</span>
              <span className="text-[11px] font-medium text-[var(--color-sidebar-muted-fg)] truncate uppercase tracking-widest leading-none mt-1">{user?.rol_nombre ?? 'Usuario'}</span>
            </div>
          </div>

          <button
            onClick={handleLogout}
            className={cn(
              'flex items-center h-10 rounded-xl text-[var(--color-sidebar-muted-fg)] hover:text-destructive hover:bg-destructive/10 transition-all duration-300 group active:scale-[0.98] overflow-hidden cursor-pointer',
              isHovered ? 'px-3 w-full' : 'justify-center w-11 mx-auto'
            )}
            title="Cerrar sesion"
          >
            <div className="shrink-0 w-6 flex justify-center">
              <SignOut size={20} strokeWidth={2} />
            </div>
            <span
              className={cn(
                'text-[15px] font-medium transition-all duration-300 whitespace-nowrap',
                isHovered ? 'opacity-100 translate-x-0 ml-4' : 'opacity-0 -translate-x-4'
              )}
            >
              Cerrar Sesion
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}
