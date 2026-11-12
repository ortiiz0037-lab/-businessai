import type { Locale } from '@/lib/i18n/landing'

export type { Locale }
export const LOCALE_COOKIE = 'ba_locale'
export const LOCALES: Locale[] = ['es', 'en']

/** BCP 47 tag used for numbers and dates. Puerto Rico Spanish / US English. */
export const intlTag = (locale: Locale) => (locale === 'en' ? 'en-US' : 'es-PR')

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function formatters(locale: Locale, currency = 'USD', timeZone = 'America/Puerto_Rico') {
  const tag = intlTag(locale)
  const money = new Intl.NumberFormat(tag, { style: 'currency', currency })
  const compact = new Intl.NumberFormat(tag, { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 })
  const integer = new Intl.NumberFormat(tag)
  const day = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short', year: 'numeric', timeZone })
  const dayTime = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone })
  const monthShort = new Intl.DateTimeFormat(tag, { month: 'short', timeZone: 'UTC' })
  const monthLong = new Intl.DateTimeFormat(tag, { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const dateOnly = (iso: string) => new Date(`${iso}T12:00:00Z`)
  return {
    money: (n: number) => money.format(n),
    compactMoney: (n: number) => compact.format(n),
    integer: (n: number) => integer.format(n),
    pct: (n: number) => `${n > 0 ? '+' : ''}${new Intl.NumberFormat(tag, { maximumFractionDigits: 1 }).format(n)}${locale === 'en' ? '%' : ' %'}`,
    /** 'YYYY-MM-DD' (date-only) or an ISO timestamp. */
    date: (v: string) => day.format(/^\d{4}-\d{2}-\d{2}$/.test(v) ? dateOnly(v) : new Date(v)),
    dateTime: (v: string) => dayTime.format(new Date(v)),
    /** 'YYYY-MM' → 'nov' / 'Nov'. */
    month: (key: string) => cap(monthShort.format(new Date(`${key}-15T12:00:00Z`)).replace('.', '')),
    /** 'noviembre de 2026' → 'Noviembre de 2026' (only the first letter). */
    monthLong: (key: string) => cap(monthLong.format(new Date(`${key}-15T12:00:00Z`))),
  }
}

export type TopBarCopy = {
  search: string; searchPlaceholder: string; searchHint: string; noResults: string; pages: string; actions: string
  notifications: string; noNotifications: string; profile: string; account: string
  quick: { invoice: string; quote: string; receipt: string; workOrder: string; client: string; payment: string; paymentHint: string }
}

export type AppCopy = {
  nav: { dashboard: string; clients: string; documents: string; payments: string; company: string; team: string; workforce: string; bank: string; receivables: string; payables: string; accounting: string; plan: string; more: string; menu: string; openMenu: string; closeMenu: string; mainMenu: string }
  shell: { env: (env: string) => string; seePlan: string; terms: string; privacy: string; legal: string; signOut: string; myCompany: string; language: string; languageNames: Record<Locale, string>; company: string; switchCompany: string; newCompany: string; current: string; roles: Record<string, string>; top: TopBarCopy }
  docType: Record<string, string>
  docStatus: Record<string, string>
  dashboard: {
    eyebrow: string
    greeting: (name: string | null) => string
    subtitle: (date: string) => string
    newDocument: string
    newClient: string
    noCompanyTitle: string
    noCompanyText: string
    createCompany: string
    emptyTitle: string
    emptyText: string
    kpi: {
      collected: string; invoiced: string; receivable: string; overdue: string; quotes: string; clients: string
      vsLast: (pct: string) => string; noPrevious: string; invoicesOpen: (n: number) => string
      overdueCount: (n: number) => string; quotesOpen: (n: number) => string; newClients: (n: number) => string
    }
    chart: { title: string; subtitle: string; invoiced: string; collected: string; month: string; showTable: string; showChart: string; empty: string; summary: (inv: string, col: string) => string }
    receivables: { title: string; current: string; dueSoon: string; overdue: string; empty: string }
    top: { title: string; subtitle: string; empty: string; unknown: string }
    activity: {
      title: string; empty: string; seeAll: string
      client: (name: string) => string; document: (type: string, number: string) => string; payment: (amount: string, number: string | null) => string
    }
    alerts: {
      title: string; none: string
      overdue: (n: number, total: string) => string; overdueAction: string
      dueSoon: (n: number, total: string) => string
      staleQuotes: (n: number) => string; quotesAction: string
      upgrade: string; payment: string
    }
    overdueList: { title: string; days: (n: number) => string; flagged: string; due: (d: string) => string }
  }
}

const es: AppCopy = {
  nav: { dashboard: 'Inicio', clients: 'Clientes', documents: 'Documentos', payments: 'Pagos', company: 'Mi empresa', team: 'Equipo', workforce: 'Personal', bank: 'Bancos', receivables: 'Por cobrar', payables: 'Gastos', accounting: 'Contabilidad', plan: 'Plan', more: 'Más', menu: 'Menú', openMenu: 'Abrir menú', closeMenu: 'Cerrar menú', mainMenu: 'Menú principal' },
  shell: {
    env: (env) => `Entorno: ${env} — pagos en modo test`, seePlan: 'Ver plan', terms: 'Términos', privacy: 'Privacidad', legal: 'Enlaces legales',
    signOut: 'Cerrar sesión', myCompany: 'Mi empresa', language: 'Idioma', languageNames: { es: 'Español', en: 'English' },
    company: 'Empresa', switchCompany: 'Cambiar de empresa', newCompany: 'Crear otra empresa', current: 'Actual',
    roles: { owner: 'Propietario', admin: 'Administrador', member: 'Miembro' },
    top: {
      search: 'Buscar', searchPlaceholder: 'Buscar secciones y acciones…', searchHint: 'Ir a una sección o crear algo nuevo',
      noResults: 'Sin resultados', pages: 'Secciones', actions: 'Acciones rápidas',
      notifications: 'Notificaciones', noNotifications: 'No tienes notificaciones.', profile: 'Perfil', account: 'Cuenta',
      quick: { invoice: 'Nueva factura', quote: 'Nueva cotización', receipt: 'Nuevo recibo', workOrder: 'Nueva orden de trabajo', client: 'Nuevo cliente', payment: 'Registrar pago', paymentHint: 'Desde una factura' },
    },
  },
  docType: { invoice: 'Factura', quote: 'Cotización', receipt: 'Recibo', work_order: 'Orden de trabajo', letter: 'Carta', payment_reminder: 'Recordatorio de pago', contract: 'Contrato', report: 'Reporte' },
  docStatus: { draft: 'Borrador', sent: 'Enviado', paid: 'Pagado', overdue: 'Vencido', cancelled: 'Cancelado' },
  dashboard: {
    eyebrow: 'Panel ejecutivo',
    greeting: (name) => (name ? `Hola, ${name}` : 'Hola'),
    subtitle: (date) => `Resumen de tu negocio · ${date}`,
    newDocument: 'Nuevo documento',
    newClient: 'Nuevo cliente',
    noCompanyTitle: 'Crea tu empresa para empezar',
    noCompanyText: 'El panel muestra las métricas de tu empresa en cuanto registres clientes, documentos y pagos.',
    createCompany: 'Crear empresa',
    emptyTitle: 'Tu panel se llenará con datos reales',
    emptyText: 'Aún no hay clientes, documentos ni pagos en esta empresa. Cuando los registres, aquí verás ingresos, cobros pendientes y alertas.',
    kpi: {
      collected: 'Cobrado este mes', invoiced: 'Facturado este mes', receivable: 'Por cobrar', overdue: 'Vencido', quotes: 'Cotizaciones abiertas', clients: 'Clientes',
      vsLast: (pct) => `${pct} vs. mes anterior`, noPrevious: 'Sin datos del mes anterior',
      invoicesOpen: (n) => (n === 1 ? '1 factura abierta' : `${n} facturas abiertas`),
      overdueCount: (n) => (n === 1 ? '1 factura vencida' : `${n} facturas vencidas`),
      quotesOpen: (n) => (n === 1 ? '1 enviada sin respuesta' : `${n} enviadas sin respuesta`),
      newClients: (n) => (n === 1 ? '1 nuevo este mes' : `${n} nuevos este mes`),
    },
    chart: {
      title: 'Facturado y cobrado', subtitle: 'Últimos 12 meses', invoiced: 'Facturado', collected: 'Cobrado', month: 'Mes',
      showTable: 'Ver tabla', showChart: 'Ver gráfico', empty: 'Aún no hay facturas ni pagos en los últimos 12 meses.',
      summary: (inv, col) => `En 12 meses: ${inv} facturado, ${col} cobrado.`,
    },
    receivables: { title: 'Cuentas por cobrar', current: 'Al día', dueSoon: 'Vence en 7 días', overdue: 'Vencido', empty: 'No hay facturas pendientes de cobro.' },
    top: { title: 'Principales clientes', subtitle: 'Facturado en 12 meses', empty: 'Aún no hay facturas asociadas a clientes.', unknown: 'Cliente sin nombre' },
    activity: {
      title: 'Actividad reciente', empty: 'Todavía no hay actividad.', seeAll: 'Ver documentos',
      client: (name) => `Nuevo cliente: ${name}`,
      document: (type, number) => `Nuevo: ${type} ${number}`,
      payment: (amount, number) => (number ? `Pago de ${amount} · ${number}` : `Pago de ${amount}`),
    },
    alerts: {
      title: 'Alertas', none: 'Todo en orden: no hay alertas.',
      overdue: (n, total) => (n === 1 ? `1 factura vencida por ${total}` : `${n} facturas vencidas por ${total}`),
      overdueAction: 'Revisar',
      dueSoon: (n, total) => (n === 1 ? `1 factura vence en 7 días (${total})` : `${n} facturas vencen en 7 días (${total})`),
      staleQuotes: (n) => (n === 1 ? '1 cotización enviada hace más de 14 días sin respuesta' : `${n} cotizaciones enviadas hace más de 14 días sin respuesta`),
      quotesAction: 'Ver cotizaciones',
      upgrade: 'Mejorar plan', payment: 'Ir a facturación',
    },
    overdueList: { title: 'Facturas vencidas', days: (n) => (n === 1 ? '1 día' : `${n} días`), flagged: 'Marcada vencida', due: (d) => `Vence ${d}` },
  },
}

const en: AppCopy = {
  nav: { dashboard: 'Home', clients: 'Clients', documents: 'Documents', payments: 'Payments', company: 'My company', team: 'Team', workforce: 'Workforce', bank: 'Banking', receivables: 'Receivables', payables: 'Expenses', accounting: 'Accounting', plan: 'Plan', more: 'More', menu: 'Menu', openMenu: 'Open menu', closeMenu: 'Close menu', mainMenu: 'Main menu' },
  shell: {
    env: (env) => `Environment: ${env} — payments in test mode`, seePlan: 'See plan', terms: 'Terms', privacy: 'Privacy', legal: 'Legal links',
    signOut: 'Sign out', myCompany: 'My company', language: 'Language', languageNames: { es: 'Español', en: 'English' },
    company: 'Company', switchCompany: 'Switch company', newCompany: 'Create another company', current: 'Current',
    roles: { owner: 'Owner', admin: 'Admin', member: 'Member' },
    top: {
      search: 'Search', searchPlaceholder: 'Search sections and actions…', searchHint: 'Go to a section or create something new',
      noResults: 'No results', pages: 'Sections', actions: 'Quick actions',
      notifications: 'Notifications', noNotifications: 'You have no notifications.', profile: 'Profile', account: 'Account',
      quick: { invoice: 'New invoice', quote: 'New quote', receipt: 'New receipt', workOrder: 'New work order', client: 'New client', payment: 'Record payment', paymentHint: 'From an invoice' },
    },
  },
  docType: { invoice: 'Invoice', quote: 'Quote', receipt: 'Receipt', work_order: 'Work order', letter: 'Letter', payment_reminder: 'Payment reminder', contract: 'Contract', report: 'Report' },
  docStatus: { draft: 'Draft', sent: 'Sent', paid: 'Paid', overdue: 'Overdue', cancelled: 'Cancelled' },
  dashboard: {
    eyebrow: 'Executive dashboard',
    greeting: (name) => (name ? `Hello, ${name}` : 'Hello'),
    subtitle: (date) => `Your business at a glance · ${date}`,
    newDocument: 'New document',
    newClient: 'New client',
    noCompanyTitle: 'Create your company to get started',
    noCompanyText: 'The dashboard shows your company metrics as soon as you record clients, documents and payments.',
    createCompany: 'Create company',
    emptyTitle: 'Your dashboard will fill with real data',
    emptyText: 'There are no clients, documents or payments in this company yet. Once you record them, you will see revenue, receivables and alerts here.',
    kpi: {
      collected: 'Collected this month', invoiced: 'Invoiced this month', receivable: 'Receivable', overdue: 'Overdue', quotes: 'Open quotes', clients: 'Clients',
      vsLast: (pct) => `${pct} vs. last month`, noPrevious: 'No data for last month',
      invoicesOpen: (n) => (n === 1 ? '1 open invoice' : `${n} open invoices`),
      overdueCount: (n) => (n === 1 ? '1 overdue invoice' : `${n} overdue invoices`),
      quotesOpen: (n) => (n === 1 ? '1 sent, awaiting reply' : `${n} sent, awaiting reply`),
      newClients: (n) => (n === 1 ? '1 new this month' : `${n} new this month`),
    },
    chart: {
      title: 'Invoiced and collected', subtitle: 'Last 12 months', invoiced: 'Invoiced', collected: 'Collected', month: 'Month',
      showTable: 'Show table', showChart: 'Show chart', empty: 'No invoices or payments in the last 12 months yet.',
      summary: (inv, col) => `Last 12 months: ${inv} invoiced, ${col} collected.`,
    },
    receivables: { title: 'Accounts receivable', current: 'Current', dueSoon: 'Due in 7 days', overdue: 'Overdue', empty: 'No invoices waiting for payment.' },
    top: { title: 'Top clients', subtitle: 'Invoiced in 12 months', empty: 'No invoices linked to clients yet.', unknown: 'Unnamed client' },
    activity: {
      title: 'Recent activity', empty: 'No activity yet.', seeAll: 'See documents',
      client: (name) => `New client: ${name}`,
      document: (type, number) => `${type} ${number} created`,
      payment: (amount, number) => (number ? `Payment of ${amount} · ${number}` : `Payment of ${amount}`),
    },
    alerts: {
      title: 'Alerts', none: 'All clear: no alerts.',
      overdue: (n, total) => (n === 1 ? `1 overdue invoice for ${total}` : `${n} overdue invoices for ${total}`),
      overdueAction: 'Review',
      dueSoon: (n, total) => (n === 1 ? `1 invoice due within 7 days (${total})` : `${n} invoices due within 7 days (${total})`),
      staleQuotes: (n) => (n === 1 ? '1 quote sent over 14 days ago without a reply' : `${n} quotes sent over 14 days ago without a reply`),
      quotesAction: 'See quotes',
      upgrade: 'Upgrade plan', payment: 'Go to billing',
    },
    overdueList: { title: 'Overdue invoices', days: (n) => (n === 1 ? '1 day' : `${n} days`), flagged: 'Marked overdue', due: (d) => `Due ${d}` },
  },
}

export const APP: Record<Locale, AppCopy> = { es, en }

/** Plain-text labels for the client-side shell (functions cannot cross to Client Components). */
export type ShellLabels = { nav: AppCopy['nav']; shell: Omit<AppCopy['shell'], 'env'> }
export function shellLabels(copy: AppCopy): ShellLabels {
  const { env: _env, ...shell } = copy.shell
  void _env
  return { nav: copy.nav, shell }
}
