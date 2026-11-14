'use client'

export default function PrintButton({ label = 'Imprimir / Guardar PDF' }: { label?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="print:hidden rounded-xl border border-line bg-card px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-white/[0.03]"
    >
      {label}
    </button>
  )
}
