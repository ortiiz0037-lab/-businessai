'use client'
import { useActionState } from 'react'
import { SubmitButton } from './submit-button'
import type { FormState } from '@/lib/validators'

type Field = { name: string; label: string; type?: string; autoComplete?: string; placeholder?: string }

export function ActionForm({ action, fields, submitLabel, hidden, variant = 'primary' }: {
  action: (s: FormState, f: FormData) => Promise<FormState>
  fields: Field[]; submitLabel: string; hidden?: Record<string, string>; variant?: 'primary' | 'gold'
}) {
  const [state, formAction] = useActionState(action, {} as FormState)
  return (
    <form action={formAction} className="space-y-5" noValidate>
      {hidden && Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {fields.map((f) => (
        <div key={f.name}>
          <label htmlFor={f.name} className="field-label">{f.label}</label>
          <input id={f.name} name={f.name} type={f.type ?? 'text'} autoComplete={f.autoComplete} placeholder={f.placeholder} required
            aria-invalid={!!state.fieldErrors?.[f.name]}
            aria-describedby={state.fieldErrors?.[f.name] ? `${f.name}-error` : undefined}
            className="field py-3.5" />
          {state.fieldErrors?.[f.name] && <p id={`${f.name}-error`} className="field-error">{state.fieldErrors[f.name]}</p>}
        </div>
      ))}
      {state.error && <p role="alert" className="alert-danger">{state.error}</p>}
      {state.message && <p role="status" className="alert-success">{state.message}</p>}
      <SubmitButton variant={variant}>{submitLabel}</SubmitButton>
    </form>
  )
}
