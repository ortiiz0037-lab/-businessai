'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type Props = {
  companyId: string
  logoUrl?: string | null
  signatureUrl?: string | null
}

export default function CompanyBranding({
  companyId,
  logoUrl = null,
  signatureUrl = null,
}: Props) {
  const [logo, setLogo] = useState(logoUrl)
  const [signature, setSignature] = useState(signatureUrl)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')

  async function upload(
    event: React.ChangeEvent<HTMLInputElement>,
    kind: 'logo' | 'signature'
  ) {
    const file = event.target.files?.[0]
    if (!file) return

    if (!file.type.startsWith('image/')) {
      setMessage('Selecciona una imagen válida.')
      return
    }

    if (file.size > 5 * 1024 * 1024) {
      setMessage('La imagen no puede superar 5 MB.')
      return
    }

    setLoading(true)
    setMessage('')

    try {
      const supabase = createClient()
      const extension = file.name.split('.').pop()?.toLowerCase() || 'png'
      const path = `${companyId}/${kind}-${Date.now()}.${extension}`

      const { error: uploadError } = await supabase.storage
        .from('company-assets')
        .upload(path, file, { upsert: true, contentType: file.type })

      if (uploadError) throw uploadError

      const { data } = supabase.storage
        .from('company-assets')
        .getPublicUrl(path)

      const url = data.publicUrl
      const column = kind === 'logo' ? 'logo_url' : 'signature_url'

      const { error: saveError } = await supabase
        .from('company_profiles')
        .update({ [column]: url })
        .eq('company_id', companyId)

      if (saveError) throw saveError

      if (kind === 'logo') setLogo(url)
      else setSignature(url)

      setMessage(kind === 'logo' ? 'Logo guardado.' : 'Firma guardada.')
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'No se pudo guardar. Verifica el bucket y los permisos de Supabase.'
      )
    } finally {
      setLoading(false)
      event.target.value = ''
    }
  }

  return (
    <section className="space-y-6 rounded-2xl border border-slate-200 p-5">
      <h2 className="text-lg font-semibold">Imagen de la empresa</h2>

      <div className="space-y-2">
        <label className="block font-medium">Logo de la empresa</label>
        {logo && (
          <img
            src={logo}
            alt="Logo de la empresa"
            className="h-24 max-w-48 rounded border object-contain p-2"
          />
        )}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          disabled={loading}
          onChange={(event) => upload(event, 'logo')}
          className="block w-full text-sm"
        />
      </div>

      <div className="space-y-2">
        <label className="block font-medium">Firma para documentos</label>
        {signature && (
          <img
            src={signature}
            alt="Firma de la empresa"
            className="h-20 max-w-48 rounded border object-contain p-2"
          />
        )}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={loading}
          onChange={(event) => upload(event, 'signature')}
          className="block w-full text-sm"
        />
      </div>

      {loading && <p>Guardando imagen…</p>}
      {message && <p role="status" className="text-sm">{message}</p>}
    </section>
  )
}
