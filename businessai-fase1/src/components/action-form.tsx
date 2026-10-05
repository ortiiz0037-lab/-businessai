'use client'
import { useActionState } from 'react'
import { SubmitButton } from './submit-button'
import type { FormState } from '@/lib/validators'

type Field = { name: string; label: string; type?: string; autoComplete?: string }

export function ActionForm({ action, fields, submitLabel, hidden }: {
  action: (s: FormState, f: FormData) => Promise<FormState>
  fields: Field[]; submitLabel: string; hidden?: Record<string, string>
}) {
  const [state, formAction] = useActionState(action, {} as FormState)
  return (
    <form action={formAction} className="space-y-4" noValidate>
      {hidden && Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {fields.map((f) => (
        <div key={f.name}>
          <label htmlFor={f.name} className="block text-sm font-medium text-slate-700">{f.label}</label>
          <input id={f.name} name={f.name} type={f.type ?? 'text'} autoComplete={f.autoComplete} required
            aria-invalid={!!state.fieldErrors?.[f.name]}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900" />
          {state.fieldErrors?.[f.name] && <p className="mt-1 text-sm text-red-600">{state.fieldErrors[f.name]}</p>}
        </div>
      ))}
      {state.error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{state.error}</p>}
      {state.message && <p role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-800">{state.message}</p>}
      <SubmitButton>{submitLabel}</SubmitButton>
    </form>
  )
}
