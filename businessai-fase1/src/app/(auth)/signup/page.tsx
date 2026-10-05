import Link from 'next/link'
import { ActionForm } from '@/components/action-form'
import { AuthCard } from '@/components/auth-card'
import { signUp } from '@/app/actions/auth'

export default function SignUpPage() {
  return (
    <AuthCard title="Crea tu cuenta" subtitle="Empieza en un minuto"
      footer={<>¿Ya tienes cuenta? <Link href="/login" className="font-medium text-slate-900 underline">Inicia sesión</Link></>}>
      <ActionForm action={signUp} submitLabel="Crear cuenta"
        fields={[
          { name: 'fullName', label: 'Nombre', autoComplete: 'name' },
          { name: 'email', label: 'Correo', type: 'email', autoComplete: 'email' },
          { name: 'password', label: 'Contraseña (mín. 8)', type: 'password', autoComplete: 'new-password' },
        ]} />
    </AuthCard>
  )
}
