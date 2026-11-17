/**
 * Onboarding of a new company (S9): ten steps whose state comes from real data, never from a flag
 * the user ticks. Each step links to the screen that already does it. Pure: tested in tests/s9.test.ts.
 */
export type OnboardingInput = {
  emailConfirmed: boolean
  profile: { legal_name?: string | null; display_name?: string | null; phone?: string | null; address?: string | null } | null
  branches: number
  members: number
  employees: number
  invitations: number
  subscriptionStatus: string | null
  localeChosen: boolean
}
export type Step = { key: string; done: boolean; href: string | null; es: string; en: string; hintEs?: string; hintEn?: string }

export function onboardingSteps(i: OnboardingInput): Step[] {
  const profileDone = !!((i.profile?.legal_name || i.profile?.display_name) && i.profile?.phone && i.profile?.address)
  return [
    { key: 'account', done: true, href: null, es: 'Crear la cuenta', en: 'Create the account' },
    { key: 'email', done: i.emailConfirmed, href: null, es: 'Verificar el correo', en: 'Verify the email', hintEs: 'Abre el enlace que te enviamos.', hintEn: 'Open the link we sent you.' },
    { key: 'company', done: true, href: null, es: 'Crear la empresa', en: 'Create the company' },
    { key: 'profile', done: profileDone, href: '/settings/company', es: 'Completar el perfil (nombre legal, teléfono, dirección, logo)', en: 'Complete the profile (legal name, phone, address, logo)' },
    { key: 'locale', done: true, href: null, es: 'Moneda y zona horaria: USD · hora de Puerto Rico (AST)', en: 'Currency and time zone: USD · Puerto Rico time (AST)',
      hintEs: 'Fijadas para todas las empresas en esta versión.', hintEn: 'Fixed for every company in this version.' },
    { key: 'branches', done: i.branches > 0, href: '/crm/settings', es: 'Configurar las sucursales', en: 'Set up the branches' },
    { key: 'team', done: i.members > 1 || i.employees > 0 || i.invitations > 0, href: '/settings/team', es: 'Invitar al equipo o añadir empleados', en: 'Invite the team or add employees',
      hintEs: 'Los empleados del reloj no ocupan asientos de administrador.', hintEn: 'Time-clock employees do not take admin seats.' },
    { key: 'plan', done: ['active', 'trialing'].includes(i.subscriptionStatus ?? ''), href: '/billing', es: 'Seleccionar el plan', en: 'Choose the plan' },
    { key: 'preferences', done: i.localeChosen, href: null, es: 'Elegir el idioma (menú superior)', en: 'Choose the language (top menu)' },
    { key: 'dashboard', done: true, href: '/dashboard', es: 'Entrar al panel', en: 'Open the dashboard' },
  ]
}
export const onboardingProgress = (s: Step[]) => ({ done: s.filter((x) => x.done).length, total: s.length })
