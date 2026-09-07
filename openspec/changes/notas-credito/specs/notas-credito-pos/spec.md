# Notas de Crédito — Entrada POS Specification

## Purpose

Define el punto de entrada rápido de NC dentro de una sesión de caja activa: alcance de sesión, resolución de depósito por rieles, doble PIN, e impacto condicional en el cuadre (Regla de Oro). El entry Tradicional (cualquier factura, depósito explícito) está en el delta de `deposito-inactivo-guard`.

## Requirements

### Requirement: Alcance limitado a la sesión activa

La entrada POS de NC MUST listar y permitir emisión SOLO sobre facturas (`ventas`) creadas dentro de la `sesion_caja_id` actualmente activa del cajero.

#### Scenario: Factura de la sesión actual visible

- GIVEN una venta creada en la sesión activa
- WHEN el cajero abre el flujo de NC en el POS
- THEN esa venta aparece disponible para emitir NC

#### Scenario: Factura de sesión anterior no visible en POS

- GIVEN una venta de una sesión ya cerrada
- WHEN el cajero abre el flujo de NC en el POS
- THEN esa venta no aparece — debe usarse el módulo Tradicional

### Requirement: Resolución de depósito por rieles

En la entrada POS, el sistema MUST resolver el depósito de reingreso automáticamente: al `deposito_id` de origen de la venta si está activo, o al depósito `es_principal=1` si el de origen está inactivo — sin pedir elección al cajero, salvo que se use el segundo PIN de override.

#### Scenario: Reingreso automático por riel

- GIVEN una venta cuyo depósito de origen está activo (o inactivo)
- WHEN se emite la NC en POS sin override
- THEN el stock reingresa al depósito de origen si está activo, o al principal si no, sin prompt al cajero

### Requirement: Modelo de doble PIN

El sistema MUST distinguir dos PINs independientes: (a) PIN de emisión, requerido solo si el usuario NO tiene el permiso `ventas.nota_credito` (si lo tiene, no se pide PIN); (b) un SEGUNDO PIN de supervisor, independiente del anterior, requerido únicamente para desbloquear la elección explícita de depósito (salir del riel automático).

#### Scenario: Permiso de emisión determina el PIN

- GIVEN un cajero con el permiso `ventas.nota_credito`, y otro sin él
- WHEN cada uno intenta emitir una NC en POS
- THEN el primero no ve solicitud de PIN; el segundo debe ingresar el PIN de supervisor de emisión antes de continuar

#### Scenario: Segundo PIN desbloquea elección de depósito

- GIVEN un cajero que quiere elegir el depósito de reingreso manualmente
- WHEN ingresa el segundo PIN de supervisor (distinto al de emisión)
- THEN se le presenta el selector de depósito explícito; sin ese PIN, el depósito se resuelve por rieles sin selector visible

### Requirement: Impacto condicional en cuadre — Regla de Oro

El cuadre de la sesión activa MUST cambiar ÚNICAMENTE cuando la NC es emitida en POS, contra una factura de la sesión activa, Y liquidada con salida real de efectivo/tarjeta de ESA sesión. En todos los demás casos (SAFC, compensación, ajuste CxC, o cualquier NC del módulo Tradicional) el impacto sobre la sesión activa MUST ser `$0.00`.

#### Scenario: POS + efectivo real de esta sesión disminuye el cajón

- GIVEN una NC emitida en POS contra una factura de la sesión activa, liquidada con salida de efectivo
- WHEN se confirma
- THEN se inserta un `movimientos_metodo_cobro` tipo EGRESO con `sesion_caja_id` de la sesión activa, y el cuadre lo refleja como salida

#### Scenario: POS + saldo a favor no afecta el cajón

- GIVEN una NC emitida en POS contra una factura de la sesión activa, liquidada como `SALDO_FAVOR`
- WHEN se confirma
- THEN no se inserta ningún `movimientos_metodo_cobro`; el cuadre no cambia

#### Scenario: Tradicional sobre factura histórica es neutro

- GIVEN una NC emitida en el módulo Tradicional contra una factura de una sesión ya cerrada
- WHEN se confirma, cualquiera sea la modalidad
- THEN la sesión activa del POS no registra ningún cambio en su cuadre

#### Scenario: Sesión cerrada permanece inmutable

- GIVEN una NC contra una factura de una sesión ya cerrada
- WHEN se emite la NC
- THEN `sesiones_caja` y `sesiones_caja_detalle` de esa sesión histórica no se editan

### Requirement: Aislamiento multi-tenant

Toda query de facturas disponibles y depósitos candidatos en el flujo POS MUST filtrar por `empresa_id` del usuario actual.

#### Scenario: Facturas visibles solo de la empresa propia

- GIVEN dos empresas con sesiones activas simultáneas
- WHEN un cajero de la empresa A abre el flujo de NC en POS
- THEN solo ve facturas de su propia sesión/empresa
</content>
