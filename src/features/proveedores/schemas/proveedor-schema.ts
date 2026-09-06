import { z } from 'zod'
import { sanitizeRif, isValidRif } from '@/lib/identity'

export const proveedorSchema = z.object({
  razon_social: z.string().min(3, 'Minimo 3 caracteres'),
  rif: z
    .string()
    .min(3, 'Minimo 3 caracteres')
    .transform(sanitizeRif)
    .refine(isValidRif, 'RIF invalido. Formato: letra (V/E/J/G/C/P) + 9 digitos, ej: J001234567.'),
  nombre_comercial: z.string().optional().default(''),
  direccion_fiscal: z.string().optional().default(''),
  ciudad: z.string().optional().default(''),
  telefono: z.string().optional().default(''),
  email: z.string().email('Correo invalido').or(z.literal('')).optional().default(''),
  dias_credito: z.number().int().min(0).default(0),
  limite_credito_usd: z.number().min(0).default(0),
})

export type ProveedorFormData = z.infer<typeof proveedorSchema>
