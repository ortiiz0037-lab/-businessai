'use client'
import { useFormStatus } from 'react-dom'

/** Submit button with pending state. `variant` picks the design-system button. */
export function SubmitButton({ children, variant = 'primary', pendingLabel = 'Un momento…', className = 'w-full' }: {
  children: React.ReactNode; variant?: 'primary' | 'gold'; pendingLabel?: string; className?: string
}) {
  const { pending } = useFormStatus()
  return (
    <button type="submit" disabled={pending} aria-busy={pending}
      className={`${variant === 'gold' ? 'btn-gold' : 'btn-primary'} btn-lg ${className}`}>
      {pending && <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />}
      {pending ? pendingLabel : children}
    </button>
  )
}
