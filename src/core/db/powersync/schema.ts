import { column, Schema, Table } from '@powersync/web'

// =============================================
// CATALOGOS GLOBALES (sin empresa_id)
// =============================================

const monedas = new Table(
  {
    codigo_iso: column.text,
    nombre: column.text,
    simbolo: column.text,
    decimales: column.integer,
    is_active: column.integer,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: {} }
)

const tipos_persona_ve = new Table(
  {
    codigo: column.text,
    nombre: column.text,
    es_entidad_legal: column.integer,
    aplica_sustraendo: column.integer,
    formato_regexp: column.text,
    is_active: column.integer,
  },
  { indexes: {} }
)

const islr_conceptos_ve = new Table(
  {
    codigo_seniat: column.text,
    descripcion: column.text,
    porcentaje_pj: column.text,
    porcentaje_pn: column.text,
    sustraendo_ut: column.text,
    monto_minimo_base: column.text,
    is_active: column.integer,
  },
  { indexes: {} }
)

const tipos_movimiento = new Table(
  {
    nombre: column.text,
    slug: column.text,
    operacion: column.text,
    requiere_doc: column.integer,
    is_active: column.integer,
    created_at: column.text,
  },
  { indexes: {} }
)

const permisos = new Table(
  {
    modulo: column.text,
    slug: column.text,
    nombre: column.text,
    descripcion: column.text,
    is_active: column.integer,
    created_at: column.text,
  },
  { indexes: {} }
)

// =============================================
// CORE: Empresa, usuarios, roles, permisos
// =============================================

const empresas = new Table(
  {
    tenant_id: column.text,
    nombre: column.text,
    rif: column.text,
    direccion: column.text,
    telefono: column.text,
    email: column.text,
    logo_url: column.text,
    timezone: column.text,
    moneda_base: column.text,
    config: column.text,
    is_active: column.integer,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: {} }
)

const empresas_fiscal_ve = new Table(
  {
    empresa_id: column.text,
    tipo_contribuyente: column.text,
    es_agente_retencion: column.integer,
    documento_identidad: column.text,
    tipo_documento: column.text,
    nro_providencia: column.text,
    porcentaje_retencion_iva: column.text,
    codigo_sucursal_seniat: column.text,
    usa_maquina_fiscal: column.integer,
    aplica_igtf: column.integer,
    created_at: column.text,
    updated_at: column.text,
    updated_by: column.text,
  },
  { indexes: {} }
)

const usuarios = new Table(
  {
    empresa_id: column.text,
    email: column.text,
    nombre: column.text,
    telefono: column.text,
    rol_id: column.text,
    pin_supervisor_hash: column.text,
    is_active: column.integer,
    created_at: column.text,
    updated_at: column.text,
    created_by: column.text,
    updated_by: column.text,
  },
  { indexes: {} }
)

const roles = new Table(
  {
    empresa_id: column.text,
    nombre: column.text,
    descripcion: column.text,
    is_system: column.integer,
    is_active: column.integer,
    created_at: column.text,
    updated_at: column.text,
    created_by: column.text,
    updated_by: column.text,
  },
  { indexes: {} }
)

const rol_permisos = new Table(
  {
    empresa_id: column.text,
    rol_id: column.text,
    permiso_id: column.text,
    granted_by: column.text,
    granted_at: column.text,
  },
  { indexes: {} }
)

const tenant_permisos = new Table(
  {
    empresa_id: column.text,
    tenant_id: column.text,
    permiso_id: column.text,
    habilitado: column.integer,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: {} }
)

// =============================================
// CONFIGURACION
// =============================================

const tasas_cambio = new Table(
  {
    empresa_id: column.text,
    moneda_id: column.text,
    valor: column.text,
    fecha: column.text,
    created_at: column.text,
    created_by: column.text,
  },
  { indexes: {} }
)

const metodos_cobro = new Table(
  {
    empresa_id: column.text,
    nombre: column.text,
    tipo: column.text,
    moneda_id: column.text,
    banco_empresa_id: column.text,
    requiere_referencia: column.integer,
    saldo_actual: column.text,
    is_active: column.integer,
    created_at: column.text,
    updated_at: column.text,
    created_by: column.text,
    // 0069: nuevos atributos operativos
    deposito_directo: column.integer,  // boolean 0/1
    comision_pct: column.text,         // NUMERIC(5,2) stored as string
    usa_pos: column.integer,           // boolean 0/1
    usa_cxc: column.integer,           // boolean 0/1
    usa_cxp: column.integer,           // boolean 0/1
    caja_fuerte_id: column.text,       // UUID nullable
    // 0079: consolidar lotes POS en un traspaso (1) o uno por lote (0)
    consolidar_lotes: column.integer,
  },
  { indexes: {} }
)

const bancos_empresa = new Table(
  {
    empresa_id: column.text,
    nombre_banco: column.text,
    nro_cuenta: column.text,
    tipo_cuenta: column.text,
    titular: column.text,
    titular_documento: column.text,
    moneda_id: column.text,
    saldo_actual: column.text,
    saldo_inicial: column.text,        // 0069: NUMERIC(18,4) stored as string
    cuenta_contable_id: column.text,
    cuenta_gasto_comision_id: column.text,  // 0080: default de cuenta de gasto para deducciones (bancaria, 6.2.06.01)
    cuenta_gasto_pasarela_id: column.text,  // 0081: cuenta base de comisión de pasarela de pago (6.1.25.01)
    is_active: column.integer,
    created_at: column.text,
    updated_at: column.text,
    created_by: column.text,
    updated_by: column.text,
  },
  { indexes: {} }
)

// 0080: N conceptos de deducción por método de cobro (comisión bancaria,
// retención ISLR de tarjetas de crédito, etc.). Reemplaza el campo único
// metodos_cobro.comision_pct (deprecado). Config editable, no ledger —
// soft-deactivate vía is_active, sin trigger anti-UPDATE/DELETE.
const metodo_cobro_deducciones = new Table(
  {
    empresa_id: column.text,
    metodo_cobro_id: column.text,
    cuenta_gasto_id: column.text,
    concepto: column.text,
    tipo: column.text,
    porcentaje: column.text,     // NUMERIC(5,2) stored as string
    orden: column.integer,
    is_active: column.integer,
    created_at: column.text,
    updated_at: column.text,
    created_by: column.text,
  },
  { indexes: {} }
)

const cajas = new Table(
  {
    empresa_id: column.text,
    nombre: column.text,
    ubicacion: column.text,
    deposito_id: column.text,
    nro_caja: column.integer,
    is_active: column.integer,
    created_at: column.text,
    updated_at: column.text,
    created_by: column.text,
    updated_by: column.text,
  },
  { indexes: {} }
)

// =============================================
// INVENTARIO
// =============================================

const departamentos = new Table(
  {
    empresa_id: column.text,
    codigo: column.text,
    nombre: column.text,
    parent_id: column.text,
    slug: column.text,
    descripcion: column.text,
    imagen_url: column.text,
    prioridad_visual: column.integer,
    is_active: column.integer,
    created_at: column.text,
    updated_at: column.text,
    created_by: column.text,
    updated_by: column.text,
  },
  { indexes: {} }
)

const marcas = new Table(
  {
    empresa_id: column.text,
    nombre: column.text,
    descripcion: column.text,
    logo_url: column.text,
    is_active: column.integer,
    created_at: column.text,
    updated_at: column.text,
    updated_by: column.text,
  },
  { indexes: {} }
)

const unidades = new Table(
  {
    empresa_id: column.text,
    nombre: column.text,
    abreviatura: column.text,
    es_decimal: column.integer,
    is_active: column.integer,
    created_at: column.text,
    updated_at: column.text,
    updated_by: column.text,
  },
  { indexes: {} }
)

const unidades_conversion = new Table(
  {
    empresa_id: column.text,
    unidad_mayor_id: column.text,
    unidad_menor_id: column.text,
    factor: column.text,
    is_active: column.integer,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: {} }
)

const depositos = new Table(
  {
    empresa_id: column.text,
    nombre: column.text,
    direccion: column.text,
    es_principal: column.integer,
    permite_venta: column.integer,
    is_active: column.integer,
    created_at: column.text,
    updated_at: column.text,
    created_by: column.text,
    updated_by: column.text,
  },
  { indexes: {} }
)

const productos = new Table(
  {
    empresa_id: column.text,
    codigo: column.text,
    tipo: column.text,
    nombre: column.text,
    departamento_id: column.text,
    marca_id: column.text,
    unidad_base_id: column.text,
    costo_usd: column.text,
    precio_venta_usd: column.text,
    precio_mayor_usd: column.text,
    precio_especial_usd: column.text,
    costo_promedio: column.text,
    costo_ultimo: column.text,
    stock: column.text,
    stock_minimo: column.text,
    tipo_impuesto: column.text,
    impuesto_iva_id: column.text,
    impuesto_igtf_id: column.text,
    maneja_lotes: column.integer,
    is_active: column.integer,
    created_at: column.text,
    updated_at: column.text,
    created_by: column.text,
    updated_by: column.text,
    ubicacion: column.text,
    presentacion: column.text,
    codigo_barras: column.text,
    duracion_min: column.integer,
    deposito_id: column.text,
  },
  { indexes: {} }
)

const inventario_stock = new Table(
  {
    empresa_id: column.text,
    producto_id: column.text,
    deposito_id: column.text,
    cantidad_actual: column.text,
    stock_reservado: column.text,
    updated_at: column.text,
    updated_by: column.text,
  },
  { indexes: {} }
)

const movimientos_inventario = new Table(
  {
    empresa_id: column.text,
    producto_id: column.text,
    deposito_id: column.text,
    tipo_movimiento_id: column.text,
    tipo: column.text,
    origen: column.text,
    cantidad: column.text,
    stock_anterior: column.text,
    stock_nuevo: column.text,
    costo_unitario: column.text,
    moneda_id: column.text,
    tasa_cambio: column.text,
    doc_origen_id: column.text,
    doc_origen_ref: column.text,
    lote_id: column.text,
    motivo: column.text,
    usuario_id: column.text,
    fecha: column.text,
    created_at: column.text,
    // 0068: tipo de salida tipificada (MERMA, EXTRAVIO, CONSUMO_INTERNO)
    tipo_salida: column.text,
  },
  { indexes: {} }
)

const recetas = new Table(
  {
    empresa_id: column.text,
    servicio_id: column.text,
    producto_id: column.text,
    cantidad: column.text,
    created_at: column.text,
  },
  { indexes: {} }
)

const ajuste_motivos = new Table(
  {
    empresa_id: column.text,
    nombre: column.text,
    es_sistema: column.integer,
    operacion_base: column.text,
    afecta_costo: column.integer,
    cuentas_config_clave: column.text,  // clave en cuentas_config para registro contable automático
    is_active: column.integer,
    created_at: column.text,
    updated_at: column.text,
    created_by: column.text,
    updated_by: column.text,
  },
  { indexes: {} }
)

const ajustes = new Table(
  {
    empresa_id: column.text,
    num_ajuste: column.text,
    motivo_id: column.text,
    fecha: column.text,
    observaciones: column.text,
    status: column.text,
    created_at: column.text,
    updated_at: column.text,
    created_by: column.text,
    updated_by: column.text,
  },
  { indexes: {} }
)

const ajustes_det = new Table(
  {
    empresa_id: column.text,
    ajuste_id: column.text,
    producto_id: column.text,
    deposito_id: column.text,
    cantidad: column.text,
    costo_unitario: column.text,
    lote_id: column.text,
    lote_nro: column.text,
    lote_fecha_fab: column.text,
    lote_fecha_venc: column.text,
    created_at: column.text,
    created_by: column.text,
  },
  { indexes: {} }
)

const lotes = new Table(
  {
    empresa_id: column.text,
    producto_id: column.text,
    deposito_id: column.text,
    nro_lote: column.text,
    fecha_fabricacion: column.text,
    fecha_vencimiento: column.text,
    cantidad_inicial: column.text,
    cantidad_actual: column.text,
    costo_unitario: column.text,
    factura_compra_id: column.text,
    status: column.text,
    created_at: column.text,
    updated_at: column.text,
    created_by: column.text,
  },
  { indexes: {} }
)

// Slice 3a (inventario-multideposito): traspasos entre depositos.
// Inmutable por RLS (SELECT+INSERT-only, sin trigger dedicado) — ver
// migrations/0084_traspasos_inventario.sql.
const traspasos_inventario = new Table(
  {
    empresa_id: column.text,
    deposito_origen_id: column.text,
    deposito_destino_id: column.text,
    usuario_id: column.text,
    fecha: column.text,
    observacion: column.text,
    autorizado_por: column.text,
    verificado_por: column.text,
    correlativo_usuario: column.integer,
    created_at: column.text,
    created_by: column.text,
  },
  { indexes: {} }
)

const traspasos_inventario_det = new Table(
  {
    empresa_id: column.text,
    traspaso_id: column.text,
    producto_id: column.text,
    cantidad: column.text,
    mov_salida_id: column.text,
    mov_entrada_id: column.text,
    created_at: column.text,
  },
  { indexes: {} }
)

// Plantillas de Traslado: sets reutilizables de productos (sin cantidad)
// para pre-llenar el formulario de traspasos — ver
// migrations/0085_traspaso_plantillas.sql. Editable (RLS SELECT+INSERT+
// UPDATE, patron `marcas`); det es membresia pura (SELECT+INSERT+DELETE,
// patron `recetas`).
const traspaso_plantillas = new Table(
  {
    empresa_id: column.text,
    nombre: column.text,
    descripcion: column.text,
    is_active: column.integer,
    created_at: column.text,
    updated_at: column.text,
    created_by: column.text,
    updated_by: column.text,
  },
  { indexes: {} }
)

const traspaso_plantillas_det = new Table(
  {
    empresa_id: column.text,
    plantilla_id: column.text,
    producto_id: column.text,
    created_at: column.text,
  },
  { indexes: {} }
)

// =============================================
// FISCAL: Impuestos por empresa
// =============================================

const impuestos_ve = new Table(
  {
    empresa_id: column.text,
    nombre: column.text,
    tipo_tributo: column.text,
    porcentaje: column.text,
    codigo_seniat: column.text,
    descripcion: column.text,
    is_active: column.integer,
    created_at: column.text,
    updated_at: column.text,
    updated_by: column.text,
  },
  { indexes: {} }
)

const niveles_precio = new Table(
  {
    empresa_id: column.text,
    nombre: column.text,
    orden: column.integer,
    porcentaje_defecto: column.text,
    is_active: column.integer,
    created_at: column.text,
    updated_at: column.text,
    created_by: column.text,
    updated_by: column.text,
  },
  { indexes: {} }
)

// =============================================
// CLIENTES / CXC
// =============================================

const clientes = new Table(
  {
    empresa_id: column.text,
    tipo_persona_id: column.text,
    identificacion: column.text,
    nombre: column.text,
    nombre_comercial: column.text,
    direccion: column.text,
    telefono: column.text,
    email: column.text,
    es_contribuyente_especial: column.integer,
    es_agente_retencion_iva: column.integer,
    es_agente_retencion_islr: column.integer,
    porcentaje_retencion_iva: column.text,
    limite_credito_usd: column.text,
    saldo_actual: column.text,
    is_active: column.integer,
    created_at: column.text,
    updated_at: column.text,
    created_by: column.text,
    updated_by: column.text,
  },
  { indexes: {} }
)

const movimientos_cuenta = new Table(
  {
    empresa_id: column.text,
    cliente_id: column.text,
    tipo: column.text,
    referencia: column.text,
    monto: column.text,
    saldo_anterior: column.text,
    saldo_nuevo: column.text,
    observacion: column.text,
    doc_origen_id: column.text,
    doc_origen_tipo: column.text,
    venta_id: column.text,
    fecha: column.text,
    created_at: column.text,
    created_by: column.text,
    moneda_pago: column.text,
    monto_moneda: column.text,
    tasa_pago: column.text,
    saf_origen_refs: column.text,
    sesion_caja_id: column.text,
  },
  { indexes: {} }
)

const vencimientos_cobrar = new Table(
  {
    empresa_id: column.text,
    venta_id: column.text,
    cliente_id: column.text,
    nro_cuota: column.integer,
    fecha_vencimiento: column.text,
    monto_original_usd: column.text,
    monto_pagado_usd: column.text,
    saldo_pendiente_usd: column.text,
    status: column.text,
    origen_fondos_tipo: column.text,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: {} }
)

// =============================================
// VENTAS
// =============================================

const ventas = new Table(
  {
    empresa_id: column.text,
    cliente_id: column.text,
    nro_factura: column.text,
    num_control: column.text,
    deposito_id: column.text,
    sesion_caja_id: column.text,
    moneda_id: column.text,
    tasa: column.text,
    total_exento_usd: column.text,
    total_base_usd: column.text,
    total_iva_usd: column.text,
    total_igtf_usd: column.text,
    total_usd: column.text,
    total_bs: column.text,
    descuento_usd: column.text,
    descuento_bs: column.text,
    saldo_pend_usd: column.text,
    tipo: column.text,
    status: column.text,
    usuario_id: column.text,
    fecha: column.text,
    created_at: column.text,
    created_by: column.text,
    // 0056: accounting observability
    contabilidad_ok: column.integer,
  },
  { indexes: {} }
)

const ventas_det = new Table(
  {
    empresa_id: column.text,
    venta_id: column.text,
    producto_id: column.text,
    deposito_id: column.text,
    cantidad: column.text,
    precio_unitario_usd: column.text,
    tipo_impuesto: column.text,
    impuesto_pct: column.text,
    subtotal_usd: column.text,
    subtotal_bs: column.text,
    lote_id: column.text,
    created_at: column.text,
  },
  { indexes: {} }
)

const pagos = new Table(
  {
    empresa_id: column.text,
    venta_id: column.text,
    cliente_id: column.text,
    metodo_cobro_id: column.text,
    moneda_id: column.text,
    tasa: column.text,
    monto: column.text,
    monto_usd: column.text,
    referencia: column.text,
    sesion_caja_id: column.text,
    banco_empresa_id: column.text,
    fecha: column.text,
    created_at: column.text,
    created_by: column.text,
    is_reversed: column.integer,
    reversed_at: column.text,
    reversed_by: column.text,
    reversed_reason: column.text,
    procesado_por_nombre: column.text,
    is_pos_saf_allocation: column.integer,
  },
  { indexes: {} }
)

const notas_credito = new Table(
  {
    empresa_id: column.text,
    nro_ncr: column.text,
    venta_id: column.text,
    cliente_id: column.text,
    tipo: column.text,
    motivo: column.text,
    moneda_id: column.text,
    tasa_historica: column.text,
    total_exento_usd: column.text,
    total_base_usd: column.text,
    total_iva_usd: column.text,
    total_usd: column.text,
    total_bs: column.text,
    afecta_inventario: column.integer,
    usuario_id: column.text,
    fecha: column.text,
    created_at: column.text,
    created_by: column.text,
    sesion_caja_id: column.text,
    liquidacion_modalidad: column.text,
    no_desembolso: column.integer,
  },
  { indexes: {} }
)

const notas_credito_det = new Table(
  {
    empresa_id: column.text,
    nota_credito_id: column.text,
    producto_id: column.text,
    deposito_id: column.text,
    cantidad: column.text,
    precio_unitario_usd: column.text,
    tipo_impuesto: column.text,
    impuesto_pct: column.text,
    subtotal_usd: column.text,
    afecta_inventario: column.integer,
    descripcion: column.text,
    lote_id: column.text,
    created_at: column.text,
    venta_det_id: column.text,
    subtotal_bs: column.text,
  },
  { indexes: {} }
)

const notas_debito = new Table(
  {
    empresa_id: column.text,
    nro_ndb: column.text,
    venta_id: column.text,
    cliente_id: column.text,
    motivo: column.text,
    moneda_id: column.text,
    tasa: column.text,
    total_exento_usd: column.text,
    total_base_usd: column.text,
    total_iva_usd: column.text,
    total_usd: column.text,
    total_bs: column.text,
    usuario_id: column.text,
    fecha: column.text,
    created_at: column.text,
  },
  { indexes: {} }
)

const notas_debito_det = new Table(
  {
    empresa_id: column.text,
    nota_debito_id: column.text,
    descripcion: column.text,
    cantidad: column.text,
    precio_unitario_usd: column.text,
    tipo_impuesto: column.text,
    impuesto_pct: column.text,
    subtotal_usd: column.text,
    created_at: column.text,
  },
  { indexes: {} }
)

// =============================================
// CAJA / TESORERIA
// =============================================

const sesiones_caja = new Table(
  {
    empresa_id: column.text,
    caja_id: column.text,
    usuario_apertura_id: column.text,
    fecha_apertura: column.text,
    monto_apertura_usd: column.text,
    monto_apertura_bs: column.text,
    usuario_cierre_id: column.text,
    fecha_cierre: column.text,
    monto_sistema_usd: column.text,
    monto_fisico_usd: column.text,
    diferencia_usd: column.text,
    // 0041: saldos VES independientes del USD
    monto_sistema_bs: column.text,
    monto_fisico_bs: column.text,
    diferencia_bs: column.text,
    observaciones_cierre: column.text,
    status: column.text,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: {} }
)

const sesiones_caja_detalle = new Table(
  {
    empresa_id: column.text,
    sesion_caja_id: column.text,
    metodo_cobro_id: column.text,
    moneda_id: column.text,
    total_sistema: column.text,
    total_fisico: column.text,
    diferencia: column.text,
    num_transacciones: column.integer,
    created_at: column.text,
  },
  { indexes: {} }
)

const movimientos_metodo_cobro = new Table(
  {
    empresa_id: column.text,
    metodo_cobro_id: column.text,
    tipo: column.text,
    origen: column.text,
    monto: column.text,
    saldo_anterior: column.text,
    saldo_nuevo: column.text,
    doc_origen_id: column.text,
    doc_origen_ref: column.text,
    concepto: column.text,
    sesion_caja_id: column.text,
    // 0041: trazabilidad para AVANCE y PRESTAMO
    autorizado_por_id: column.text,
    destinatario_id: column.text,
    referencia_pago_digital_id: column.text,
    fecha: column.text,
    created_at: column.text,
    created_by: column.text,
  },
  { indexes: {} }
)

const movimientos_bancarios = new Table(
  {
    empresa_id: column.text,
    banco_empresa_id: column.text,
    tipo: column.text,
    // DEPOSITO_CAJA | TRANSFERENCIA_CLIENTE | PAGO_PROVEEDOR | GASTO | MANUAL | TRASPASO | REVERSO | CIERRE_CONSOLIDACION
    origen: column.text,
    monto: column.text,
    saldo_anterior: column.text,
    saldo_nuevo: column.text,
    doc_origen_id: column.text,
    doc_origen_tipo: column.text,
    referencia: column.text,
    validado: column.integer,
    validado_por: column.text,
    validado_at: column.text,
    observacion: column.text,
    descripcion: column.text,
    reversado: column.integer,
    reverso_de: column.text,
    fecha: column.text,
    created_at: column.text,
    created_by: column.text,
  },
  { indexes: {} }
)

// =============================================
// CONCILIACION TESORERIA
// =============================================

const caja_fuerte = new Table(
  {
    empresa_id: column.text,
    nombre: column.text,
    moneda_id: column.text,
    saldo_actual: column.text,
    descripcion: column.text,
    is_active: column.integer,
    created_at: column.text,
    updated_at: column.text,
    created_by: column.text,
    updated_by: column.text,
  },
  { indexes: {} }
)

const mov_caja_fuerte = new Table(
  {
    empresa_id: column.text,
    caja_fuerte_id: column.text,
    tipo: column.text,
    origen: column.text,
    monto: column.text,
    saldo_anterior: column.text,
    saldo_nuevo: column.text,
    doc_origen_id: column.text,
    doc_origen_tipo: column.text,
    referencia: column.text,
    descripcion: column.text,
    validado: column.integer,
    validado_por: column.text,
    validado_at: column.text,
    reversado: column.integer,
    reverso_de: column.text,
    fecha: column.text,
    created_at: column.text,
    created_by: column.text,
  },
  { indexes: {} }
)

const traspasos_tesoreria = new Table(
  {
    empresa_id: column.text,
    cuenta_origen_tipo: column.text,
    cuenta_origen_id: column.text,
    mov_origen_id: column.text,
    cuenta_destino_tipo: column.text,
    cuenta_destino_id: column.text,
    mov_destino_id: column.text,
    monto_origen: column.text,
    moneda_origen_id: column.text,
    monto_destino: column.text,
    moneda_destino_id: column.text,
    tasa_cambio: column.text,
    reversado: column.integer,
    reversado_at: column.text,
    reversado_por: column.text,
    observacion: column.text,
    fecha: column.text,
    created_at: column.text,
    created_by: column.text,
    // pos-tesoreria-integration: link traspaso back to its originating session
    sesion_caja_id: column.text,
  },
  { indexes: {} }
)

// 0079: lotes de punto de venta cargados por el cajero antes de cerrar la
// sesión (dato de trabajo pre-cierre, no inmutable — ver migrations/0079).
const lotes_pos_cuadre = new Table(
  {
    empresa_id: column.text,
    sesion_caja_id: column.text,
    metodo_cobro_id: column.text,
    moneda_id: column.text,
    nro_lote: column.text,
    monto: column.text,        // NUMERIC(18,4) stored as string
    created_at: column.text,
    created_by: column.text,
    updated_at: column.text,
  },
  { indexes: {} }
)

// =============================================
// RETENCIONES VENTAS
// =============================================

const retenciones_iva_ventas = new Table(
  {
    empresa_id: column.text,
    venta_id: column.text,
    cliente_id: column.text,
    nro_comprobante: column.text,
    fecha_comprobante: column.text,
    periodo_fiscal: column.text,
    base_imponible: column.text,
    porcentaje_iva: column.text,
    monto_iva: column.text,
    porcentaje_retencion: column.text,
    monto_retenido: column.text,
    status: column.text,
    observaciones: column.text,
    created_at: column.text,
    created_by: column.text,
  },
  { indexes: {} }
)

const retenciones_islr_ventas = new Table(
  {
    empresa_id: column.text,
    venta_id: column.text,
    cliente_id: column.text,
    concepto_islr_id: column.text,
    nro_comprobante: column.text,
    fecha_comprobante: column.text,
    periodo_fiscal: column.text,
    base_imponible_bs: column.text,
    porcentaje_retencion: column.text,
    monto_retenido_bs: column.text,
    sustraendo_bs: column.text,
    status: column.text,
    observaciones: column.text,
    created_at: column.text,
    created_by: column.text,
  },
  { indexes: {} }
)

// =============================================
// PROVEEDORES / COMPRAS / CXP
// =============================================

const proveedores = new Table(
  {
    empresa_id: column.text,
    tipo_persona_id: column.text,
    rif: column.text,
    razon_social: column.text,
    nombre_comercial: column.text,
    direccion_fiscal: column.text,
    ciudad: column.text,
    telefono: column.text,
    email: column.text,
    tipo_contribuyente: column.text,
    retiene_iva: column.integer,
    retiene_islr: column.integer,
    concepto_islr_id: column.text,
    retencion_iva_pct: column.text,
    dias_credito: column.integer,
    limite_credito_usd: column.text,
    saldo_actual: column.text,
    is_active: column.integer,
    created_at: column.text,
    updated_at: column.text,
    created_by: column.text,
    updated_by: column.text,
  },
  { indexes: {} }
)

const proveedores_bancos = new Table(
  {
    empresa_id: column.text,
    proveedor_id: column.text,
    nombre_banco: column.text,
    nro_cuenta: column.text,
    tipo_cuenta: column.text,
    titular: column.text,
    titular_documento: column.text,
    moneda_id: column.text,
    is_active: column.integer,
    created_at: column.text,
  },
  { indexes: {} }
)

const facturas_compra = new Table(
  {
    empresa_id: column.text,
    proveedor_id: column.text,
    nro_factura: column.text,
    nro_control: column.text,
    deposito_id: column.text,
    moneda_id: column.text,
    tasa: column.text,
    tasa_costo: column.text,       // BCV/internal rate (tasa paralela)
    total_exento_usd: column.text,
    total_base_usd: column.text,
    total_iva_usd: column.text,
    total_igtf_usd: column.text,
    total_usd: column.text,
    total_bs: column.text,
    saldo_pend_usd: column.text,
    tipo: column.text,
    status: column.text,
    fecha_factura: column.text,
    fecha_recepcion: column.text,
    usuario_id: column.text,
    created_at: column.text,
    updated_at: column.text,
    created_by: column.text,
    // 0056: accounting observability
    contabilidad_ok: column.integer,
  },
  { indexes: {} }
)

const facturas_compra_det = new Table(
  {
    empresa_id: column.text,
    factura_compra_id: column.text,
    producto_id: column.text,
    deposito_id: column.text,
    cantidad: column.text,
    costo_unitario_usd: column.text,      // original invoice cost in USD
    costo_usd_sistema: column.text,       // BCV-adjusted cost (goes to inventory)
    tipo_impuesto: column.text,
    impuesto_pct: column.text,
    subtotal_usd: column.text,
    subtotal_bs: column.text,
    lote_id: column.text,
    created_at: column.text,
  },
  { indexes: {} }
)

const retenciones_iva = new Table(
  {
    empresa_id: column.text,
    factura_compra_id: column.text,
    proveedor_id: column.text,
    nro_comprobante: column.text,
    fecha_comprobante: column.text,
    periodo_fiscal: column.text,
    base_imponible: column.text,
    porcentaje_iva: column.text,
    monto_iva: column.text,
    porcentaje_retencion: column.text,
    monto_retenido: column.text,
    status: column.text,
    observaciones: column.text,
    created_at: column.text,
    created_by: column.text,
  },
  { indexes: {} }
)

const retenciones_islr = new Table(
  {
    empresa_id: column.text,
    factura_compra_id: column.text,
    proveedor_id: column.text,
    concepto_islr_id: column.text,
    nro_comprobante: column.text,
    fecha_comprobante: column.text,
    periodo_fiscal: column.text,
    base_imponible_bs: column.text,
    porcentaje_retencion: column.text,
    monto_retenido_bs: column.text,
    sustraendo_bs: column.text,
    status: column.text,
    observaciones: column.text,
    created_at: column.text,
    created_by: column.text,
  },
  { indexes: {} }
)

const notas_fiscales_compra = new Table(
  {
    empresa_id: column.text,
    proveedor_id: column.text,
    factura_compra_id: column.text,
    tipo: column.text,
    nro_documento: column.text,
    motivo: column.text,
    moneda_id: column.text,
    tasa: column.text,
    total_exento_usd: column.text,
    total_base_usd: column.text,
    total_iva_usd: column.text,
    total_usd: column.text,
    total_bs: column.text,
    afecta_inventario: column.integer,
    usuario_id: column.text,
    fecha: column.text,
    created_at: column.text,
  },
  { indexes: {} }
)

const notas_fiscales_compra_det = new Table(
  {
    empresa_id: column.text,
    nota_fiscal_compra_id: column.text,
    producto_id: column.text,
    descripcion: column.text,
    cantidad: column.text,
    precio_unitario_usd: column.text,
    tipo_impuesto: column.text,
    impuesto_pct: column.text,
    subtotal_usd: column.text,
    afecta_inventario: column.integer,
    lote_id: column.text,
    created_at: column.text,
  },
  { indexes: {} }
)

const movimientos_cuenta_proveedor = new Table(
  {
    empresa_id: column.text,
    proveedor_id: column.text,
    tipo: column.text,
    referencia: column.text,
    monto: column.text,
    saldo_anterior: column.text,
    saldo_nuevo: column.text,
    observacion: column.text,
    factura_compra_id: column.text,
    doc_origen_id: column.text,
    doc_origen_tipo: column.text,
    fecha: column.text,
    created_at: column.text,
    created_by: column.text,
    moneda_pago: column.text,          // 'USD' o 'BS'
    monto_moneda: column.text,         // importe en moneda original
    tasa_pago: column.text,            // tasa usada para este pago
    monto_usd_interno: column.text,    // USD a tasa interna/BCV (contabilidad)
  },
  { indexes: {} }
)

const vencimientos_pagar = new Table(
  {
    empresa_id: column.text,
    factura_compra_id: column.text,
    proveedor_id: column.text,
    nro_cuota: column.integer,
    fecha_vencimiento: column.text,
    monto_original_usd: column.text,
    monto_pagado_usd: column.text,
    saldo_pendiente_usd: column.text,
    status: column.text,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: {} }
)

// Auditoria de cambios de precio generados por facturas de compra
const historico_precios = new Table(
  {
    empresa_id: column.text,
    factura_compra_id: column.text,
    producto_id: column.text,
    usuario_id: column.text,
    costo_anterior: column.text,   // NUMERIC → text para preservar precision
    costo_nuevo: column.text,
    pvp_anterior: column.text,
    pvp_nuevo: column.text,
    created_at: column.text,
  },
  { indexes: {} }
)

// =============================================
// CONTABILIDAD
// =============================================

const plan_cuentas = new Table(
  {
    empresa_id: column.text,
    codigo: column.text,
    nombre: column.text,
    tipo: column.text,
    naturaleza: column.text,
    parent_id: column.text,
    nivel: column.integer,
    es_cuenta_detalle: column.integer,
    is_active: column.integer,
    created_at: column.text,
    updated_at: column.text,
    created_by: column.text,
    updated_by: column.text,
  },
  { indexes: {} }
)

const gastos = new Table(
  {
    empresa_id: column.text,
    nro_gasto: column.text,
    nro_factura: column.text,
    nro_control: column.text,
    cuenta_id: column.text,
    proveedor_id: column.text,
    descripcion: column.text,
    fecha: column.text,
    moneda_id: column.text,
    moneda_factura: column.text,       // 'USD' o 'BS'
    usa_tasa_paralela: column.integer, // 0/1
    tasa: column.text,                 // tasa interna (BCV/sistema) snapshot
    tasa_proveedor: column.text,       // tasa del proveedor (paralela)
    monto_factura: column.text,        // importe original en moneda_factura (= base antes de IVA)
    monto_usd: column.text,            // total contable USD = base + IVA
    tipo_impuesto: column.text,        // 'Gravable' | 'Exento' | 'Exonerado'
    porcentaje_iva: column.text,       // porcentaje IVA (ej: 16.00)
    base_imponible_usd: column.text,   // base imponible en USD (antes de IVA)
    monto_iva_usd: column.text,        // monto IVA en USD
    saldo_pendiente_usd: column.text,  // pendiente por pagar
    metodo_cobro_id: column.text,
    banco_empresa_id: column.text,
    referencia: column.text,
    observaciones: column.text,
    status: column.text,
    created_at: column.text,
    updated_at: column.text,
    created_by: column.text,
    // 0068: trazabilidad inversa hacia el documento que generó el gasto
    doc_origen_id: column.text,
    doc_origen_tipo: column.text,
  },
  { indexes: {} }
)

const cuentas_config = new Table(
  {
    empresa_id: column.text,
    clave: column.text,
    cuenta_contable_id: column.text,
    descripcion: column.text,
    created_at: column.text,
    updated_at: column.text,
    created_by: column.text,
    updated_by: column.text,
  },
  { indexes: {} }
)

const libro_contable = new Table(
  {
    empresa_id: column.text,
    nro_asiento: column.text,
    fecha_registro: column.text,
    modulo_origen: column.text,
    doc_origen_id: column.text,
    doc_origen_ref: column.text,
    cuenta_contable_id: column.text,
    banco_empresa_id: column.text,
    monto: column.text,
    detalle: column.text,
    estado: column.text,
    parent_id: column.text,
    usuario_id: column.text,
    created_at: column.text,
  },
  { indexes: {} }
)

const gasto_pagos = new Table(
  {
    empresa_id: column.text,
    gasto_id: column.text,
    metodo_cobro_id: column.text,
    banco_empresa_id: column.text,
    monto_usd: column.text,
    referencia: column.text,
    created_at: column.text,
  },
  { indexes: {} }
)

// =============================================
// OBSERVABILIDAD CONTABLE (0056)
// =============================================

const errores_contabilidad = new Table({
  empresa_id: column.text,
  tabla_origen: column.text,
  doc_origen_id: column.text,
  error_msg: column.text,
  created_at: column.text,
})

// =============================================
// AGENDA Y CITAS
// =============================================

const citas = new Table(
  {
    empresa_id: column.text,
    cliente_id: column.text,
    profesional_id: column.text,
    fecha_inicio: column.text,
    fecha_fin: column.text,
    duracion_min: column.integer,
    // Status dual
    cita_status: column.text,
    finance_status: column.text,
    checkout_tipo: column.text,
    total_usd: column.text,
    tasa: column.text,
    total_bs: column.text,
    venta_id: column.text,
    notas: column.text,
    observaciones: column.text,
    color: column.text,
    google_event_id: column.text,
    // Timestamps de ejecucion real
    timestamp_inicio: column.text,
    timestamp_fin: column.text,
    duracion_real_min: column.integer,
    desviacion_min: column.integer,
    // Control de ejecucion
    ejecucion_paralela: column.integer,
    prioridad_filtro: column.text,
    // Snapshot para rehidratacion (JSONB serializado)
    snapshot_en_progreso: column.text,
    created_at: column.text,
    updated_at: column.text,
    created_by: column.text,
    updated_by: column.text,
  },
  { indexes: {} }
)

const citas_servicios = new Table(
  {
    empresa_id: column.text,
    cita_id: column.text,
    producto_id: column.text,
    precio_usd: column.text,
    cantidad: column.text,
    duracion_min: column.integer,
    trabajador_id: column.text,
    created_at: column.text,
  },
  { indexes: {} }
)

const horarios_staff = new Table(
  {
    empresa_id: column.text,
    usuario_id: column.text,
    dia_semana: column.integer,
    hora_inicio: column.text,
    hora_fin: column.text,
    is_active: column.integer,
    tiempo_preparacion_min: column.integer,
    cruza_medianoche: column.integer,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: {} }
)

const cita_trabajadores = new Table(
  {
    empresa_id: column.text,
    cita_id: column.text,
    cita_servicio_id: column.text,
    usuario_id: column.text,
    rol_en_cita: column.text,
    created_at: column.text,
  },
  { indexes: {} }
)

const cita_log = new Table(
  {
    empresa_id: column.text,
    cita_id: column.text,
    usuario_id: column.text,
    accion: column.text,
    datos_anteriores: column.text,
    datos_nuevos: column.text,
    created_at: column.text,
  },
  { indexes: {} }
)

const cita_items_extras = new Table(
  {
    empresa_id: column.text,
    cita_id: column.text,
    producto_id: column.text,
    cantidad: column.text,
    precio_usd: column.text,
    status_cobro: column.text,
    venta_id: column.text,
    created_at: column.text,
    created_by: column.text,
  },
  { indexes: {} }
)

const horarios_descansos = new Table(
  {
    empresa_id: column.text,
    horario_staff_id: column.text,
    hora_inicio: column.text,
    hora_fin: column.text,
    tipo: column.text,
    created_at: column.text,
  },
  { indexes: {} }
)

const horarios_excepciones = new Table(
  {
    empresa_id: column.text,
    usuario_id: column.text,
    fecha: column.text,
    tipo: column.text,
    hora_inicio: column.text,
    hora_fin: column.text,
    motivo: column.text,
    created_at: column.text,
    created_by: column.text,
  },
  { indexes: {} }
)

const horarios_plantillas = new Table(
  {
    empresa_id: column.text,
    nombre: column.text,
    data: column.text,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: {} }
)

// =============================================
// SYSTEM SETTINGS (global, no empresa_id)
// =============================================

const system_settings = new Table(
  {
    key: column.text,
    value: column.text,
    description: column.text,
    updated_at: column.text,
  },
  { indexes: {} }
)

// =============================================
// SCHEMA EXPORT
// =============================================

export const AppSchema = new Schema({
  // Catalogos globales
  monedas,
  tipos_persona_ve,
  islr_conceptos_ve,
  tipos_movimiento,
  permisos,
  system_settings,
  // Core
  empresas,
  empresas_fiscal_ve,
  usuarios,
  roles,
  rol_permisos,
  tenant_permisos,
  // Configuracion
  tasas_cambio,
  metodos_cobro,
  bancos_empresa,
  metodo_cobro_deducciones,
  cajas,
  impuestos_ve,
  niveles_precio,
  // Inventario
  departamentos,
  marcas,
  unidades,
  unidades_conversion,
  depositos,
  productos,
  inventario_stock,
  movimientos_inventario,
  recetas,
  ajuste_motivos,
  ajustes,
  ajustes_det,
  lotes,
  traspasos_inventario,
  traspasos_inventario_det,
  traspaso_plantillas,
  traspaso_plantillas_det,
  // Clientes / CxC
  clientes,
  movimientos_cuenta,
  vencimientos_cobrar,
  // Ventas
  ventas,
  ventas_det,
  pagos,
  notas_credito,
  notas_credito_det,
  notas_debito,
  notas_debito_det,
  // Caja / Tesoreria
  sesiones_caja,
  sesiones_caja_detalle,
  movimientos_metodo_cobro,
  movimientos_bancarios,
  caja_fuerte,
  mov_caja_fuerte,
  traspasos_tesoreria,
  lotes_pos_cuadre,
  // Retenciones ventas
  retenciones_iva_ventas,
  retenciones_islr_ventas,
  // Proveedores / Compras / CxP
  proveedores,
  proveedores_bancos,
  facturas_compra,
  facturas_compra_det,
  retenciones_iva,
  retenciones_islr,
  notas_fiscales_compra,
  notas_fiscales_compra_det,
  movimientos_cuenta_proveedor,
  vencimientos_pagar,
  historico_precios,
  // Contabilidad
  plan_cuentas,
  gastos,
  gasto_pagos,
  cuentas_config,
  libro_contable,
  // Observabilidad contable (0056)
  errores_contabilidad,
  // Agenda y Citas
  citas,
  citas_servicios,
  horarios_staff,
  cita_trabajadores,
  cita_log,
  cita_items_extras,
  horarios_descansos,
  horarios_excepciones,
  horarios_plantillas,
})

export type Database = (typeof AppSchema)['types']
