import type { Locale } from '@/lib/i18n/landing'

/** Texts of the sign-in / sign-up screens (es / en). Server validation messages stay in Spanish. */
export type AuthCopy = {
  panel: { title: string; subtitle: string; points: { title: string; text: string }[]; footer: string }
  login: { title: string; subtitle: string; email: string; password: string; submit: string; noAccount: string; signup: string; confirmError: string; pricing: string; forgot: string }
  forgot: { title: string; subtitle: string; email: string; submit: string; back: string }
  reset: { title: string; subtitle: string; password: string; confirm: string; submit: string; expired: string; requestNew: string }
  signup: { title: string; subtitle: string; name: string; email: string; password: string; submit: string; haveAccount: string; login: string; chosen: (plan: string, days: number) => string; change: string; legal: [string, string, string, string] }
  switchTo: string
  switchLabel: string
  back: string
}

const es: AuthCopy = {
  panel: {
    title: 'La gestión de tu negocio, con la imagen que merece.',
    subtitle: 'Clientes, documentos y pagos en un espacio de trabajo profesional.',
    points: [
      { title: 'Tus datos, protegidos', text: 'Cada empresa solo ve su propia información.' },
      { title: 'Pagos con Stripe', text: 'BusinessAI no ve ni guarda los datos de tu tarjeta.' },
      { title: '7 días de prueba', text: 'Sin cobro durante la prueba. Cancela cuando quieras.' },
    ],
    footer: 'Hecho para negocios de Puerto Rico y Estados Unidos',
  },
  login: {
    title: 'Bienvenido de nuevo', subtitle: 'Inicia sesión en tu espacio de trabajo.',
    email: 'Correo electrónico', password: 'Contraseña', submit: 'Iniciar sesión',
    noAccount: '¿No tienes cuenta?', signup: 'Crea una gratis', confirmError: 'El enlace de confirmación no es válido o expiró.',
    pricing: 'Ver planes y precios', forgot: '¿Olvidaste tu contraseña?',
  },
  forgot: {
    title: 'Recupera tu acceso', subtitle: 'Te enviaremos un enlace para crear una nueva contraseña.',
    email: 'Correo electrónico', submit: 'Enviar enlace', back: 'Volver a iniciar sesión',
  },
  reset: {
    title: 'Nueva contraseña', subtitle: 'Elige una contraseña nueva para tu cuenta.',
    password: 'Nueva contraseña (mínimo 8 caracteres)', confirm: 'Repite la contraseña', submit: 'Guardar contraseña',
    expired: 'El enlace no es válido o expiró.', requestNew: 'Solicitar un enlace nuevo',
  },
  signup: {
    title: 'Crea tu cuenta', subtitle: 'Empieza en un minuto. Después eliges tu plan.',
    name: 'Nombre completo', email: 'Correo electrónico', password: 'Contraseña (mínimo 8 caracteres)', submit: 'Crear cuenta',
    haveAccount: '¿Ya tienes cuenta?', login: 'Inicia sesión',
    chosen: (plan, days) => `Plan elegido: ${plan}, con ${days} días de prueba gratuita. Lo confirmarás después de crear tu empresa.`,
    change: 'Cambiar',
    legal: ['Consulta los ', 'Términos', ' y la ', 'Política de privacidad'],
  },
  switchTo: 'EN', switchLabel: 'View in English', back: 'Volver al inicio',
}

const en: AuthCopy = {
  panel: {
    title: 'Run your business with the image it deserves.',
    subtitle: 'Clients, documents and payments in a professional workspace.',
    points: [
      { title: 'Your data, protected', text: 'Each company only sees its own information.' },
      { title: 'Payments by Stripe', text: 'BusinessAI never sees or stores your card details.' },
      { title: '7-day trial', text: 'No charge during the trial. Cancel anytime.' },
    ],
    footer: 'Built for businesses in Puerto Rico and the United States',
  },
  login: {
    title: 'Welcome back', subtitle: 'Sign in to your workspace.',
    email: 'Email', password: 'Password', submit: 'Sign in',
    noAccount: 'No account yet?', signup: 'Create one for free', confirmError: 'The confirmation link is invalid or has expired.',
    pricing: 'See plans and pricing', forgot: 'Forgot your password?',
  },
  forgot: {
    title: 'Recover your access', subtitle: 'We will email you a link to create a new password.',
    email: 'Email', submit: 'Send link', back: 'Back to sign in',
  },
  reset: {
    title: 'New password', subtitle: 'Choose a new password for your account.',
    password: 'New password (at least 8 characters)', confirm: 'Repeat the password', submit: 'Save password',
    expired: 'The link is invalid or has expired.', requestNew: 'Request a new link',
  },
  signup: {
    title: 'Create your account', subtitle: 'Get started in a minute. You choose your plan next.',
    name: 'Full name', email: 'Email', password: 'Password (at least 8 characters)', submit: 'Create account',
    haveAccount: 'Already have an account?', login: 'Sign in',
    chosen: (plan, days) => `Selected plan: ${plan}, with a ${days}-day free trial. You will confirm it after creating your company.`,
    change: 'Change',
    legal: ['See the ', 'Terms', ' and the ', 'Privacy policy'],
  },
  switchTo: 'ES', switchLabel: 'Ver en español', back: 'Back to home',
}

export const AUTH: Record<Locale, AuthCopy> = { es, en }
