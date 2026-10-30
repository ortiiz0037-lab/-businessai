
'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type CompanyBrandingProps = {
  companyId: string
  logoUrl: string | null
  signatureUrl: string | null
}

const BUCKET = 'Company-assets'

export default function CompanyBranding({
  companyId,
  logoUrl,
  signatureUrl,
}: CompanyBrandingProps) {
  const supabase = createClient()

  const [logo, setLogo] = useState(logoUrl)
  const [signature, setSignature] = useState(signatureUrl)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)

  async function diagnosticarStorage() {
    setLoading(true)
    setMessage('Comprobando conexión con Storage...')

    const { data, error } = await supabase.storage.listBuckets()

    if (error) {
      setMessage(`Error de conexión: ${error.message}`)
    } else {
      const names = data.map((bucket) => bucket.name)
      setMessage(
        `Buckets encontrados: ${names.join(', ') || 'ninguno visible'}`
      )
    }

    setLoading(false)
  }

  async function subirArchivo(
    file: File | undefined,
    tipo: 'logo' | 'signature'
  ) {
    if (!file) return

    if (!file.type.startsWith('image/')) {
      setMessage('Selecciona un archivo de imagen.')
      return
    }

    if (file.size > 5 * 1024 * 1024) {
      setMessage('La imagen debe pesar menos de 5 MB.')
      return
    }

    setLoading(true)
    setMessage('Subiendo imagen...')

    try {
      const extension = file.name.split('.').pop()?.toLowerCase() || 'png'
      const path = `${companyId}/${tipo}-${Date.now()}.${extension}`

      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(path, file, {
          upsert: true,
          contentType: file.type,
        })

      if (uploadError) {
        throw new Error(uploadError.message)
      }

      const { data } = supabase.storage
        .from(BUCKET)
        .getPublicUrl(path)

      const publicUrl = data.publicUrl

      const updateData =
        tipo === 'logo'
          ? { logo_url: publicUrl }
          : { signature_url: publicUrl }

      const { error: updateError } = await supabase
        .from('company_profiles')
        .update(updateData)
        .eq('company_id', companyId)

      if (updateError) {
        throw new Error(
          `La imagen se subió, pero no se pudo guardar en el perfil: ${updateError.message}`
        )
      }

      if (tipo === 'logo') {
        setLogo(publicUrl)
      } else {
        setSignature(publicUrl)
      }

      setMessage(
        tipo === 'logo'
          ? 'Logo guardado correctamente.'
          : 'Firma guardada correctamente.'
      )
    } catch (error) {
      setMessage(
        error instanceof Error
          ? `Error: ${error.message}`
          : 'Ocurrió un error al subir la imagen.'
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Imagen de la empresa</h2>
        <p className="text-sm text-gray-500">
          Sube el logo y la firma que aparecerán en tus documentos.
        </p>
      </div>

      <button
        type="button"
        onClick={diagnosticarStorage}
        disabled={loading}
        className="rounded border px-4 py-2 text-sm disabled:opacity-50"
      >
        Diagnosticar conexión de Storage
      </button>

      {message && (
        <p role="status" className="break-words text-sm">
          {message}
        </p>
      )}

      <div className="space-y-3">
        <h3 className="font-medium">Logo de la empresa</h3>

        {logo && (
          <img
            src={logo}
            alt="Logo de la empresa"
            className="max-h-32 max-w-48 rounded border object-contain"
          />
        )}

        <input
          type="file"
          accept="image/*"
          disabled={loading}
          onChange={(event) =>
            subirArchivo(event.target.files?.[0], 'logo')
          }
        />
      </div>

      <div className="space-y-3">
        <h3 className="font-medium">Firma para documentos</h3>

        {signature && (
          <img
            src={signature}
            alt="Firma de la empresa"
            className="max-h-32 max-w-48 rounded border object-contain"
          />
        )}

        <input
          type="file"
          accept="image/*"
          disabled={loading}
          onChange={(event) =>
            subirArchivo(event.target.files?.[0], 'signature')
          }
        />
      </div>
    </section>
  )
}
