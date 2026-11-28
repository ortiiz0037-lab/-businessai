import type { PlanKey } from '@/lib/billing/catalog'

/**
 * Texts of the public home page (/) in Spanish and English.
 * Every feature mentioned exists in the app today; taxes (IVU) stay pending
 * confirmation and are never described as included.
 */
export type Locale = 'es' | 'en'

export function toLocale(value: unknown): Locale {
  return value === 'en' ? 'en' : 'es'
}

type Item = { title: string; text: string }

export type LandingCopy = {
  htmlLang: string
  nav: { features: string; pricing: string; login: string; signup: string; dashboard: string; switchTo: string; switchLabel: string }
  hero: { badge: string; title: string; subtitle: string; primary: string; secondary: string; note: string }
  preview: { title: string; client: string; status: string; paid: string; total: string; items: [string, string][] }
  features: { kicker: string; title: string; subtitle: string; items: Item[] }
  benefits: { title: string; items: Item[] }
  steps: { title: string; items: Item[] }
  pricing: {
    kicker: string; title: string; subtitle: string; perMonth: string; taxes: string; trial: string; recommended: string
    start: string; choose: string; haveAccount: string; login: string
    limits: { clients: (n: string) => string; documents: (n: string) => string; users: (n: string) => string; unlimitedClients: string; unlimitedDocuments: string }
    plans: Record<PlanKey, { name: string; tagline: string }>
    included: string; common: string[]; more: string
  }
  cta: { title: string; subtitle: string; primary: string; secondary: string }
  footer: { rights: string; pricing: string; terms: string; privacy: string; legalNote: string }
}

const es: LandingCopy = {
  htmlLang: 'es',
  nav: { features: 'Funciones', pricing: 'Precios', login: 'Iniciar sesión', signup: 'Crear cuenta', dashboard: 'Ir a mi panel', switchTo: 'EN', switchLabel: 'View in English' },
  hero: {
    badge: '7 días de prueba gratuita en todos los planes',
    title: 'Los documentos de tu negocio, con imagen profesional',
    subtitle: 'Gestiona clientes, prepara facturas, cotizaciones y órdenes de trabajo con el logo y la firma de tu empresa, y lleva el control de los pagos. Todo en un solo lugar.',
    primary: 'Empezar prueba gratuita',
    secondary: 'Ver planes y precios',
    note: 'Sin cobro durante la prueba · Cancela cuando quieras',
  },
  preview: {
    title: 'Factura', client: 'Cliente', status: 'Estado', paid: 'Pagada', total: 'Total',
    items: [['Servicio de instalación', '$450.00'], ['Materiales', '$180.00'], ['Mano de obra', '$220.00']],
  },
  features: {
    kicker: 'Funciones',
    title: 'Todo lo que necesitas para documentar y cobrar tu trabajo',
    subtitle: 'Herramientas sencillas para el día a día de tu negocio.',
    items: [
      { title: 'Clientes organizados', text: 'Guarda los datos de tus clientes y encuéntralos al instante cuando prepares un documento.' },
      { title: 'Facturas y cotizaciones', text: 'Crea facturas y cotizaciones con partidas, cantidades y totales calculados.' },
      { title: 'Más tipos de documento', text: 'Órdenes de trabajo, cartas y recordatorios de pago con el mismo formato profesional.' },
      { title: 'Tu marca en cada documento', text: 'Logo, datos de contacto y firma de tu empresa en todos tus documentos.' },
      { title: 'Listo para imprimir o PDF', text: 'Imprime tus documentos o guárdalos en PDF desde el navegador para enviarlos.' },
      { title: 'Control de pagos', text: 'Registra los pagos recibidos de cada documento y consulta su historial.' },
    ],
  },
  benefits: {
    title: 'Por qué BusinessAI',
    items: [
      { title: 'Imagen profesional', text: 'Documentos uniformes y con tu marca que transmiten confianza a tus clientes.' },
      { title: 'Tu información, protegida', text: 'Los datos de cada empresa están separados y solo los ven sus miembros. Las firmas se guardan en un almacenamiento privado.' },
      { title: 'Crece a tu ritmo', text: 'Empieza con el plan que necesitas y cambia de plan en cualquier momento.' },
    ],
  },
  steps: {
    title: 'Empieza en tres pasos',
    items: [
      { title: 'Crea tu cuenta', text: 'Regístrate y añade los datos de tu empresa.' },
      { title: 'Elige tu plan', text: 'Empieza tu prueba gratuita de 7 días. No se cobra nada durante la prueba.' },
      { title: 'Prepara tus documentos', text: 'Añade tus clientes y crea tu primer documento en minutos.' },
    ],
  },
  pricing: {
    kicker: 'Precios',
    title: 'Planes simples y transparentes',
    subtitle: 'Todos los planes incluyen 7 días de prueba gratuita. Se pide una tarjeta, pero no se cobra nada durante la prueba.',
    perMonth: '/ mes', taxes: 'USD · impuestos pendientes de confirmar', trial: '7 días gratis · sin cobro durante la prueba',
    recommended: 'Recomendado', start: 'Empezar prueba de 7 días', choose: 'Elegir', haveAccount: '¿Ya tienes cuenta?', login: 'Inicia sesión',
    limits: {
      clients: (n) => `${n} clientes`, documents: (n) => `${n} documentos al mes`, users: (n) => `${n} ${n === '1' ? 'usuario' : 'usuarios'}`,
      unlimitedClients: 'Clientes ilimitados', unlimitedDocuments: 'Documentos ilimitados',
    },
    plans: {
      basic: { name: 'Básico', tagline: 'Para profesionales que empiezan a facturar con orden.' },
      pro: { name: 'Pro', tagline: 'Para negocios en crecimiento con un equipo pequeño.' },
      premium: { name: 'Premium', tagline: 'Para empresas con más volumen y más usuarios.' },
    },
    included: 'Incluido en todos los planes',
    common: [
      'Clientes y documentos de tu empresa en un solo lugar',
      'Logo, datos y firma de tu empresa en los documentos',
      'Documentos listos para imprimir o guardar en PDF',
      'Registro de pagos de cada documento',
      'Cancela cuando quieras desde la propia aplicación',
    ],
    more: 'Ver preguntas frecuentes sobre planes',
  },
  cta: {
    title: 'Empieza hoy tu prueba gratuita',
    subtitle: '7 días para probar BusinessAI con tus propios clientes y documentos.',
    primary: 'Crear cuenta', secondary: 'Iniciar sesión',
  },
  footer: {
    rights: 'BusinessAI', pricing: 'Precios', terms: 'Términos y condiciones', privacy: 'Política de privacidad',
    legalNote: 'Los pagos se procesan con Stripe. BusinessAI no ve ni guarda los datos de tu tarjeta.',
  },
}

const en: LandingCopy = {
  htmlLang: 'en',
  nav: { features: 'Features', pricing: 'Pricing', login: 'Sign in', signup: 'Create account', dashboard: 'Go to dashboard', switchTo: 'ES', switchLabel: 'Ver en español' },
  hero: {
    badge: '7-day free trial on every plan',
    title: 'Your business documents, with a professional look',
    subtitle: 'Manage clients, prepare invoices, quotes and work orders with your company logo and signature, and keep track of payments. All in one place.',
    primary: 'Start free trial',
    secondary: 'See plans and pricing',
    note: 'No charge during the trial · Cancel anytime',
  },
  preview: {
    title: 'Invoice', client: 'Client', status: 'Status', paid: 'Paid', total: 'Total',
    items: [['Installation service', '$450.00'], ['Materials', '$180.00'], ['Labor', '$220.00']],
  },
  features: {
    kicker: 'Features',
    title: 'Everything you need to document and get paid for your work',
    subtitle: 'Simple tools for your business, every day.',
    items: [
      { title: 'Organized clients', text: 'Keep your clients’ details and find them instantly when you prepare a document.' },
      { title: 'Invoices and quotes', text: 'Create invoices and quotes with line items, quantities and calculated totals.' },
      { title: 'More document types', text: 'Work orders, letters and payment reminders with the same professional format.' },
      { title: 'Your brand on every document', text: 'Your company logo, contact details and signature on all your documents.' },
      { title: 'Ready to print or PDF', text: 'Print your documents or save them as PDF from your browser to send them.' },
      { title: 'Payment tracking', text: 'Record the payments received for each document and review their history.' },
    ],
  },
  benefits: {
    title: 'Why BusinessAI',
    items: [
      { title: 'Professional image', text: 'Consistent, branded documents that build trust with your clients.' },
      { title: 'Your data, protected', text: 'Each company’s data is kept separate and visible only to its members. Signatures are stored privately.' },
      { title: 'Grow at your pace', text: 'Start with the plan you need and change plans at any time.' },
    ],
  },
  steps: {
    title: 'Get started in three steps',
    items: [
      { title: 'Create your account', text: 'Sign up and add your company details.' },
      { title: 'Choose your plan', text: 'Start your 7-day free trial. Nothing is charged during the trial.' },
      { title: 'Prepare your documents', text: 'Add your clients and create your first document in minutes.' },
    ],
  },
  pricing: {
    kicker: 'Pricing',
    title: 'Simple, transparent plans',
    subtitle: 'Every plan includes a 7-day free trial. A card is required, but nothing is charged during the trial.',
    perMonth: '/ month', taxes: 'USD · taxes pending confirmation', trial: '7 days free · no charge during the trial',
    recommended: 'Recommended', start: 'Start 7-day trial', choose: 'Choose', haveAccount: 'Already have an account?', login: 'Sign in',
    limits: {
      clients: (n) => `${n} clients`, documents: (n) => `${n} documents per month`, users: (n) => `${n} ${n === '1' ? 'user' : 'users'}`,
      unlimitedClients: 'Unlimited clients', unlimitedDocuments: 'Unlimited documents',
    },
    plans: {
      basic: { name: 'Basic', tagline: 'For professionals getting their invoicing in order.' },
      pro: { name: 'Pro', tagline: 'For growing businesses with a small team.' },
      premium: { name: 'Premium', tagline: 'For companies with more volume and more users.' },
    },
    included: 'Included in every plan',
    common: [
      'Your company’s clients and documents in one place',
      'Your company logo, details and signature on documents',
      'Documents ready to print or save as PDF',
      'Payment records for each document',
      'Cancel anytime from within the app',
    ],
    more: 'Plan FAQ (in Spanish)',
  },
  cta: {
    title: 'Start your free trial today',
    subtitle: '7 days to try BusinessAI with your own clients and documents.',
    primary: 'Create account', secondary: 'Sign in',
  },
  footer: {
    rights: 'BusinessAI', pricing: 'Pricing', terms: 'Terms and conditions (Spanish)', privacy: 'Privacy policy (Spanish)',
    legalNote: 'Payments are processed by Stripe. BusinessAI never sees or stores your card details.',
  },
}

export const LANDING: Record<Locale, LandingCopy> = { es, en }
