/**
 * CRM (0035) — pure helpers shared by pages, actions and tests: labels,
 * the weighted pipeline value (integer cents, rounded once like the
 * database), overdue follow-ups and error messages.
 */
import type { Locale } from '@/lib/i18n/app'

export const LIFECYCLES = ['lead', 'prospect', 'customer', 'former'] as const
export type Lifecycle = (typeof LIFECYCLES)[number]
export const CLIENT_KINDS = ['individual', 'company'] as const
export const ACTIVITY_KINDS = ['call', 'email', 'meeting', 'task', 'note', 'reminder'] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]
export const ACTIVITY_STATUSES = ['pending', 'completed', 'cancelled'] as const
export const TAG_COLORS = ['blue', 'silver', 'green', 'amber', 'red', 'violet'] as const
export type TagColor = (typeof TAG_COLORS)[number]

const L: Record<string, [string, string]> = {
  lead: ['Prospecto nuevo', 'Lead'], prospect: ['Prospecto', 'Prospect'], customer: ['Cliente', 'Customer'], former: ['Ex cliente', 'Former customer'],
  individual: ['Persona', 'Individual'], company: ['Empresa', 'Company'],
  call: ['Llamada', 'Call'], email: ['Email registrado', 'Logged email'], meeting: ['Reunión', 'Meeting'], task: ['Tarea', 'Task'], note: ['Nota', 'Note'], reminder: ['Recordatorio', 'Reminder'],
  pending: ['Pendiente', 'Pending'], completed: ['Completada', 'Completed'], cancelled: ['Cancelada', 'Cancelled'],
  open: ['Abierta', 'Open'], won: ['Ganada', 'Won'], lost: ['Perdida', 'Lost'],
  inbound: ['Entrante', 'Inbound'], outbound: ['Saliente', 'Outbound'],
  email_reason: ['correo', 'email'], phone: ['teléfono', 'phone'], tax_id: ['identificación fiscal', 'tax ID'], name: ['nombre', 'name'],
}
export const crmLabel = (key: string | null | undefined, locale: Locale) => (key && L[key] ? L[key][locale === 'en' ? 1 : 0] : key ?? '—')
export const reasonLabel = (r: string, locale: Locale) => crmLabel(r === 'email' ? 'email_reason' : r, locale)

export const TAG_CLASS: Record<TagColor, string> = {
  blue: 'border-electric/50 bg-electric/15 text-blue-200', silver: 'border-slate-400/40 bg-slate-400/10 text-slate-200',
  green: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200', amber: 'border-amber-400/40 bg-amber-400/10 text-amber-200',
  red: 'border-rose-400/40 bg-rose-400/10 text-rose-200', violet: 'border-violet-400/40 bg-violet-400/10 text-violet-200',
}

/** Stage name in the reader's language. */
export const stageName = (s: { name_es: string; name_en: string }, locale: Locale) => (locale === 'en' ? s.name_en : s.name_es)

/** Half away from zero, integer arithmetic (same as round() on numeric in PostgreSQL). */
export function roundDiv(n: bigint, d: bigint): bigint {
  const q = n / d, r = n % d
  if (r === 0n) return q
  const twice = (r < 0n ? -r : r) * 2n
  if (twice >= (d < 0n ? -d : d)) return n < 0n !== d < 0n ? q - 1n : q + 1n
  return q
}

/** Weighted value of a set of opportunities: Σ(amount × probability) / 10 000, rounded once. */
export function weightedCents(rows: { amount_cents: string | number | bigint; probability_bp: number }[]): bigint {
  const total = rows.reduce((s, r) => s + BigInt(r.amount_cents) * BigInt(r.probability_bp), 0n)
  return roundDiv(total, 10000n)
}

/** Probability input in percent ("25", "12.5") → basis points; null when empty; NaN marker on invalid. */
export function parseProbability(input: string | null | undefined): number | null | 'invalid' {
  const s = (input ?? '').replace(',', '.').replace('%', '').trim()
  if (!s) return null
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return 'invalid'
  const bp = Math.round(Number(s) * 100)
  return bp >= 0 && bp <= 10000 ? bp : 'invalid'
}
export const percent = (bp: number) => `${(bp / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} %`

/** A pending activity whose due time has passed. */
export const isOverdue = (a: { status: string; due_at: string | null }, now = Date.now()) => a.status === 'pending' && !!a.due_at && Date.parse(a.due_at) < now

/** Local date-time input ("2026-11-20T09:30") in Puerto Rico (UTC−4, no DST) → ISO. */
export function prDateTime(input: string | null | undefined): string | null {
  const s = (input ?? '').trim()
  if (!s) return null
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?$/.exec(s)
  if (!m) return null
  const d = new Date(`${m[1]}T${m[2] ?? '09:00'}:00-04:00`)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
/** ISO → value for a datetime-local input in Puerto Rico time. */
export function toPrInput(iso: string | null | undefined): string {
  if (!iso) return ''
  return new Date(Date.parse(iso) - 4 * 3_600_000).toISOString().slice(0, 16)
}

const CODES = ['FORBIDDEN', 'CLIENT_NOT_FOUND', 'CONTACT_NOT_FOUND', 'CRM_OWNER_INVALID', 'CRM_BRANCH_INVALID', 'CRM_TAG_EXISTS', 'CRM_TAG_NOT_FOUND',
  'CRM_PROBABILITY_INVALID', 'CRM_STAGE_LIMIT', 'CRM_STAGE_NOT_FOUND', 'CRM_STAGE_FIXED', 'CRM_STAGE_IN_USE', 'BRANCH_CODE_INVALID', 'BRANCH_CODE_EXISTS',
  'BRANCH_NOT_FOUND', 'PLAN_LIMIT_BRANCHES', 'PLAN_FEATURE_UNAVAILABLE', 'CRM_AMOUNT_INVALID', 'CRM_IDEMPOTENCY_REQUIRED', 'CRM_OPPORTUNITY_NOT_FOUND', 'CRM_STALE',
  'CRM_OPPORTUNITY_CLOSED', 'CRM_LOST_REASON_REQUIRED', 'DOCUMENT_NOT_FOUND', 'CRM_DOCUMENT_OTHER_CLIENT', 'CRM_NOT_A_QUOTE', 'CRM_QUOTE_NOT_ACCEPTED',
  'CRM_QUOTE_WITHOUT_CLIENT', 'CRM_QUOTE_ALREADY_CONVERTED', 'CRM_DUE_DATE_INVALID', 'CRM_ACTIVITY_INVALID', 'CRM_DUE_REQUIRED', 'CRM_ACTIVITY_NOT_FOUND',
  'CLIENT_ARCHIVED', 'CLIENT_ARCHIVE_FORBIDDEN', 'CLIENT_HAS_HISTORY'] as const

/** Database error → short code for the URL (?error=…). */
export function crmErrorCode(error: { message?: string; code?: string } | null | undefined): string {
  const m = error?.message ?? ''
  for (const c of CODES) if (m.includes(c)) return c.toLowerCase()
  if (/PLAN_LIMIT|SUBSCRIPTION|BILLING/.test(m)) return 'plan_limit'
  if (/check constraint|violates/.test(m)) return 'invalid'
  if (error?.code === '42501') return 'forbidden'
  return 'save'
}

const MSG: Record<string, [string, string]> = {
  forbidden: ['No tienes permiso para esta acción.', 'You do not have permission for this action.'],
  client_not_found: ['No encontramos ese cliente.', 'We could not find that client.'],
  contact_not_found: ['No encontramos ese contacto.', 'We could not find that contact.'],
  crm_owner_invalid: ['El responsable debe ser miembro activo de la empresa.', 'The responsible person must be an active member of the company.'],
  crm_branch_invalid: ['Sucursal no válida o fuera de tus sucursales.', 'Invalid branch, or outside your branches.'],
  crm_tag_exists: ['Ya existe una etiqueta con ese nombre.', 'A tag with that name already exists.'],
  crm_tag_not_found: ['Etiqueta no encontrada.', 'Tag not found.'],
  crm_probability_invalid: ['La probabilidad debe estar entre 0 y 100 %.', 'Probability must be between 0 and 100 %.'],
  crm_stage_limit: ['Máximo 20 etapas.', 'At most 20 stages.'],
  crm_stage_not_found: ['Etapa no encontrada o inactiva.', 'Stage not found or inactive.'],
  crm_stage_fixed: ['Ganado y Perdido mantienen 100 % y 0 % y siempre están activos.', 'Won and Lost keep 100 % and 0 % and are always active.'],
  crm_stage_in_use: ['La etapa tiene oportunidades abiertas: muévelas antes de desactivarla.', 'The stage has open opportunities: move them before deactivating it.'],
  branch_code_invalid: ['Código de sucursal: 1–12 letras, números, guion o guion bajo.', 'Branch code: 1–12 letters, digits, dash or underscore.'],
  branch_code_exists: ['Ya existe una sucursal con ese código.', 'A branch with that code already exists.'],
  branch_not_found: ['Sucursal no encontrada.', 'Branch not found.'],
  plan_limit_branches: ['Tu plan no permite más sucursales activas.', 'Your plan allows no more active branches.'],
  plan_feature_unavailable: ['Tu plan no incluye sucursales.', 'Your plan does not include branches.'],
  plan_limit: ['Límite del plan o suscripción inactiva.', 'Plan limit reached or inactive subscription.'],
  crm_amount_invalid: ['Escribe un valor válido (0 o más).', 'Enter a valid value (0 or more).'],
  crm_idempotency_required: ['Solicitud incompleta: vuelve a intentarlo.', 'Incomplete request: try again.'],
  crm_opportunity_not_found: ['No encontramos esa oportunidad (o no tienes acceso).', 'We could not find that opportunity (or you have no access).'],
  crm_stale: ['Alguien cambió este registro mientras lo veías. Revisa los datos actuales y vuelve a intentarlo.', 'Someone changed this record while you were viewing it. Review the current data and try again.'],
  crm_opportunity_closed: ['La oportunidad está cerrada: reábrela moviéndola a una etapa abierta.', 'The opportunity is closed: reopen it by moving it to an open stage.'],
  crm_lost_reason_required: ['Indica el motivo de la pérdida (3–300 caracteres).', 'Give the reason it was lost (3–300 characters).'],
  document_not_found: ['No encontramos ese documento.', 'We could not find that document.'],
  crm_document_other_client: ['El documento es de otro cliente.', 'The document belongs to another client.'],
  crm_not_a_quote: ['Solo se convierten cotizaciones.', 'Only quotes can be converted.'],
  crm_quote_not_accepted: ['Solo una cotización aceptada se convierte en factura.', 'Only an accepted quote can be converted into an invoice.'],
  crm_quote_without_client: ['La cotización no tiene cliente.', 'The quote has no client.'],
  crm_quote_already_converted: ['Esta cotización ya tiene una factura vigente.', 'This quote already has a live invoice.'],
  crm_due_date_invalid: ['El vencimiento no puede estar en el pasado.', 'The due date cannot be in the past.'],
  crm_activity_invalid: ['Actividad no válida.', 'Invalid activity.'],
  crm_due_required: ['Las tareas y recordatorios necesitan fecha.', 'Tasks and reminders need a date.'],
  crm_activity_not_found: ['No encontramos esa actividad.', 'We could not find that activity.'],
  client_archived: ['El cliente está archivado: restáuralo para crear documentos nuevos.', 'The client is archived: restore it to create new documents.'],
  client_archive_forbidden: ['Solo propietario y administradores archivan clientes.', 'Only owners and admins archive clients.'],
  client_has_history: ['El cliente tiene documentos: archívalo en lugar de borrarlo.', 'The client has documents: archive it instead of deleting it.'],
  invalid: ['Hay datos no válidos. Revisa el formulario.', 'Some data is invalid. Check the form.'],
  required: ['Completa los campos obligatorios.', 'Fill in the required fields.'],
  save: ['No se pudo guardar. Inténtalo nuevamente.', 'Could not save. Please try again.'],
}
export const crmMessage = (code: string | null | undefined, locale: Locale) => {
  const m = MSG[code ?? ''] ?? MSG.save
  return m[locale === 'en' ? 1 : 0]
}
export const CRM_MESSAGE_CODES = Object.keys(MSG)
