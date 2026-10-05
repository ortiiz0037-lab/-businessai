import Link from 'next/link'
import { ActionForm } from '@/components/action-form'
import { AuthCard } from '@/components/auth-card'
import { signIn } from '@/app/actions/auth'
import { safeNext } from '@/lib/validators'

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams
  return (
    <AuthCard title="Iniciar sesión" subtitle="Accede a tu cuenta de BusinessAI"
      footer={<>¿No tienes cuenta? <Link href="/signup" className="font-medium text-slate-900 underline">Regístrate</Link></>}>
      {error === 'confirm' && (
        <p role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">El enlace de confirmación no es válido o expiró.</p>
      )}
      <ActionForm action={signIn} submitLabel="Entrar" hidden={{ next: safeNext(next) }}
        fields={[
          { name: 'email', label: 'Correo', type: 'email', autoComplete: 'email' },
          { name: 'password', label: 'Contraseña', type: 'password', autoComplete: 'current-password' },
        ]} />
    </AuthCard>
  )
}
