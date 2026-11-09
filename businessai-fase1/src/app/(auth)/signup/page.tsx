import Link from 'next/link'
import { ActionForm } from '@/components/action-form'
import { AuthCard } from '@/components/auth-card'
import { signUp } from '@/app/actions/auth'
import { TRIAL_DAYS, catalogPlan, isPlanKey } from '@/lib/billing/catalog'

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
  const { plan } = await searchParams
  const chosen = isPlanKey(plan) ? catalogPlan(plan) : null
  return (
    <AuthCard title="Crea tu cuenta" subtitle="Empieza en un minuto"
      footer={
        <div className="space-y-3">
          <p>¿Ya tienes cuenta? <Link href="/login" className="font-medium text-slate-900 underline">Inicia sesión</Link></p>
          <p className="text-xs">
            Consulta los <Link href="/terminos" className="underline">Términos</Link>, la{' '}
            <Link href="/privacidad" className="underline">Privacidad</Link> y los{' '}
            <Link href="/precios" className="underline">Precios</Link>.
          </p>
        </div>
      }>
      {chosen && (
        <p role="status" className="mb-5 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
          Plan elegido: <strong>{chosen.name}</strong>, con {TRIAL_DAYS} días de prueba gratuita. Después de crear tu
          cuenta y tu empresa podrás confirmarlo.{' '}
          <Link href="/precios" className="font-semibold underline">Cambiar</Link>
        </p>
      )}
      <ActionForm action={signUp} submitLabel="Crear cuenta"
        hidden={chosen ? { plan: chosen.plan } : undefined}
        fields={[
          { name: 'fullName', label: 'Nombre', autoComplete: 'name' },
          { name: 'email', label: 'Correo', type: 'email', autoComplete: 'email' },
          { name: 'password', label: 'Contraseña (mín. 8)', type: 'password', autoComplete: 'new-password' },
        ]} />
    </AuthCard>
  )
}
