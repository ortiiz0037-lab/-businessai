import Link from 'next/link'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { NoWorkforceAccess, WorkforceNav } from '@/components/workforce-nav'
import { workforcePage } from '@/lib/workforce/page'
import { wfMessage } from '@/lib/workforce/context'
import { featureAccess } from '@/lib/billing/features'
import { searchTerm } from '@/lib/search'
import { createEmployee } from '@/app/actions/workforce'

export const dynamic = 'force-dynamic'
const PAGE_SIZE = 25

/** Employee list (search, department, status, pages) and the hiring form. */
export default async function EmployeesPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; dept?: string; page?: string; error?: string }> }) {
  const params = await searchParams
  const { locale, tr, supabase, companyId, access, allowed } = await workforcePage()
  if (!allowed) return <NoWorkforceAccess tr={tr} unavailable={!access.available} />
  const q = searchTerm(params.q)
  const status = ['active', 'inactive', 'terminated', 'all'].includes(params.status ?? '') ? params.status! : 'active'
  const page = Math.max(1, Math.min(1000, Number.parseInt(params.page ?? '1', 10) || 1))
  const { data: deptData } = await supabase.from('departments').select('id, name').eq('company_id', companyId).is('archived_at', null).order('name')
  const depts = (deptData ?? []) as { id: string; name: string }[]
  const dept = depts.some((d) => d.id === params.dept) ? params.dept! : ''
  let query = supabase.from('employees').select('id, employee_number, first_name, last_name, email, department_id, position, status, user_id', { count: 'exact' })
    .eq('company_id', companyId)
  if (status !== 'all') query = query.eq('status', status)
  if (dept) query = query.eq('department_id', dept)
  if (q) query = query.or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,email.ilike.%${q}%,employee_number.ilike.%${q}%,position.ilike.%${q}%`)
  const from = (page - 1) * PAGE_SIZE
  const { data, count } = await query.order('first_name').order('id').range(from, from + PAGE_SIZE - 1)
  const rows = (data ?? []) as { id: string; employee_number: string | null; first_name: string; last_name: string; email: string | null; department_id: string | null; position: string | null; status: string; user_id: string | null }[]
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE))
  const deptName = new Map(depts.map((d) => [d.id, d.name]))
  const plan = access.manages ? await featureAccess(supabase, companyId, 'employees') : null
  const href = (n: number) => `/workforce/employees?${new URLSearchParams({ ...(q ? { q } : {}), ...(status !== 'active' ? { status } : {}), ...(dept ? { dept } : {}), ...(n > 1 ? { page: String(n) } : {}) })}`
  const statusLabel = (s: string) => ({ active: tr('Activo', 'Active'), inactive: tr('Inactivo', 'Inactive'), terminated: tr('Baja', 'Terminated') } as Record<string, string>)[s] ?? s

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Personal', 'Workforce')} title={tr('Empleados', 'Employees')}
        description={tr('Los empleados no usan usuarios de tu plan: ponchan con su propio acceso.', 'Employees do not use your plan\'s user seats: they punch with their own access.')} />
      <WorkforceNav tr={tr} current="/workforce/employees" manages={access.manages} />
      {params.error && <div role="alert" className="alert-danger p-4">{wfMessage(params.error, locale)}</div>}
      {plan && (
        <p className={plan.atLimit || !plan.available ? 'alert-warning p-4' : 'text-sm text-muted'}>
          {!plan.available ? tr('Tu plan no incluye empleados o la suscripción no está activa.', 'Your plan does not include employees or the subscription is not active.')
            : tr(`Empleados activos: ${plan.used} de ${plan.maxAllowed ?? '∞'} en tu plan.`, `Active employees: ${plan.used} of ${plan.maxAllowed ?? '∞'} on your plan.`)}
          {plan.atLimit && <> {' '}<Link href="/billing" className="underline">{tr('Mejorar plan', 'Upgrade plan')}</Link></>}
        </p>
      )}

      <div className={`grid grid-cols-1 gap-6 ${access.manages ? 'lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]' : ''}`}>
        <section className="card min-w-0 p-5" aria-labelledby="list-title">
          <h2 id="list-title" className="sr-only">{tr('Lista', 'List')}</h2>
          <form method="get" role="search" className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
            <input name="q" defaultValue={params.q ?? ''} maxLength={60} placeholder={tr('Buscar nombre, correo, número…', 'Search name, email, number…')} aria-label={tr('Buscar', 'Search')} className="field" />
            <select name="status" defaultValue={status} aria-label={tr('Estado', 'Status')} className="field">
              <option value="active">{tr('Activos', 'Active')}</option><option value="inactive">{tr('Inactivos', 'Inactive')}</option>
              <option value="terminated">{tr('Bajas', 'Terminated')}</option><option value="all">{tr('Todos', 'All')}</option>
            </select>
            <select name="dept" defaultValue={dept} aria-label={tr('Departamento', 'Department')} className="field">
              <option value="">{tr('Todos los departamentos', 'All departments')}</option>
              {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <button type="submit" className="btn-primary">{tr('Buscar', 'Search')}</button>
          </form>
          {rows.length === 0 ? <EmptyState icon="users" title={tr('No hay empleados con esos filtros.', 'No employees match those filters.')} /> : (
            <ul className="mt-4 divide-y divide-line">
              {rows.map((r) => (
                <li key={r.id}>
                  <Link href={`/workforce/employees/${r.id}`} className="flex items-center justify-between gap-3 py-3 hover:bg-electric/5">
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-fg">{r.first_name} {r.last_name}{r.employee_number ? ` · #${r.employee_number}` : ''}</span>
                      <span className="block truncate text-xs text-muted">{[r.position, r.department_id ? deptName.get(r.department_id) : null, r.email].filter(Boolean).join(' · ')}</span>
                    </span>
                    <span className="flex shrink-0 gap-2">
                      {r.user_id && <span className="badge-accent">{tr('Con acceso', 'Has access')}</span>}
                      <span className={r.status === 'active' ? 'badge-success' : 'badge-neutral'}>{statusLabel(r.status)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {pages > 1 && (
            <nav aria-label={tr('Páginas', 'Pages')} className="mt-3 flex items-center justify-between text-sm">
              {page > 1 ? <Link className="btn-secondary btn-sm" href={href(page - 1)}>{tr('← Anterior', '← Previous')}</Link> : <span />}
              <span className="text-muted">{tr(`Página ${page} de ${pages}`, `Page ${page} of ${pages}`)}</span>
              {page < pages ? <Link className="btn-secondary btn-sm" href={href(page + 1)}>{tr('Siguiente →', 'Next →')}</Link> : <span />}
            </nav>
          )}
        </section>

        {access.manages && (
          <section className="card p-5" aria-labelledby="new-title">
            <h2 id="new-title" className="font-display text-xl font-semibold text-fg">{tr('Nuevo empleado', 'New employee')}</h2>
            <form action={createEmployee} className="mt-4 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="field-label">{tr('Nombre *', 'First name *')}<input name="first_name" required maxLength={80} className="field mt-1" /></label>
                <label className="field-label">{tr('Apellidos *', 'Last name *')}<input name="last_name" required maxLength={80} className="field mt-1" /></label>
              </div>
              <label className="field-label">{tr('Correo (para su acceso al reloj)', 'Email (for time clock access)')}<input name="email" type="email" maxLength={254} className="field mt-1" /></label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="field-label">{tr('Número de empleado', 'Employee number')}<input name="employee_number" maxLength={30} className="field mt-1" /></label>
                <label className="field-label">{tr('Teléfono', 'Phone')}<input name="phone" maxLength={40} className="field mt-1" /></label>
                <label className="field-label">{tr('Puesto', 'Position')}<input name="position" maxLength={80} className="field mt-1" /></label>
                <label className="field-label">{tr('Departamento', 'Department')}
                  <select name="department_id" defaultValue="" className="field mt-1"><option value="">—</option>{depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
                </label>
                <label className="field-label">{tr('Fecha de ingreso', 'Hire date')}<input name="hire_date" type="date" className="field mt-1" /></label>
                <label className="field-label">{tr('Tarifa por hora ($)', 'Hourly rate ($)')}<input name="hourly_rate" inputMode="decimal" className="field mt-1" /></label>
              </div>
              <SubmitButton pendingLabel={tr('Guardando…', 'Saving…')}>{tr('Crear empleado', 'Create employee')}</SubmitButton>
              <p className="text-xs text-muted">{tr('La tarifa solo la ven el propietario y los administradores.', 'Only the owner and admins see the pay rate.')}</p>
            </form>
          </section>
        )}
      </div>
    </div>
  )
}
