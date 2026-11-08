'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  ALLOWED_IMAGE_TYPES,
  LOGO_BUCKET,
  SIGNATURE_BUCKET,
  SIGNATURE_URL_TTL_SECONDS,
  buildObjectPath,
  toSignatureRef,
  validateBrandingFile,
  type AllowedImageType,
  type BrandingKind,
} from '@/lib/branding-assets'

type CompanyBrandingProps = {
  companyId: string
  logoUrl: string | null
  /** Short-lived signed URL (or legacy public URL) created on the server. */
  signaturePreviewUrl: string | null
  /** The current signature still lives in the public bucket. */
  signatureIsLegacyPublic: boolean
}

const ACCEPT = Object.keys(ALLOWED_IMAGE_TYPES).join(',')

export default function CompanyBranding({
  companyId,
  logoUrl,
  signaturePreviewUrl,
  signatureIsLegacyPublic,
}: CompanyBrandingProps) {
  const supabase = createClient()

  const [logo, setLogo] = useState(logoUrl)
  const [signature, setSignature] = useState(signaturePreviewUrl)
  const [legacySignature, setLegacySignature] = useState(signatureIsLegacyPublic)
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

  async function subirArchivo(file: File | undefined, tipo: BrandingKind) {
    if (!file) return

    const invalid = validateBrandingFile(file, tipo)
    if (invalid) {
      setMessage(invalid)
      return
    }

    setLoading(true)
    setMessage('Subiendo imagen...')

    try {
      const type = file.type as AllowedImageType
      const path = buildObjectPath(companyId, tipo, type, crypto.randomUUID())
      const bucket = tipo === 'logo' ? LOGO_BUCKET : SIGNATURE_BUCKET

      // Unique path per upload: no overwrite (no update permission needed).
      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(path, file, { upsert: false, contentType: type })

      if (uploadError) {
        if (tipo === 'signature' && /bucket not found/i.test(uploadError.message)) {
          throw new Error(
            'El almacenamiento privado de firmas aún no está configurado. Contacta al administrador.'
          )
        }
        throw new Error(uploadError.message)
      }

      const logoPublicUrl =
        tipo === 'logo'
          ? supabase.storage.from(LOGO_BUCKET).getPublicUrl(path).data.publicUrl
          : null
      const updateData =
        tipo === 'logo'
          ? { logo_url: logoPublicUrl }
          : { signature_url: toSignatureRef(path) }

      const { data: updated, error: updateError } = await supabase
        .from('company_profiles')
        .update(updateData)
        .eq('company_id', companyId)
        .select('company_id')

      if (updateError) {
        throw new Error(
          `La imagen se subió, pero no se pudo guardar en el perfil: ${updateError.message}`
        )
      }
      if (!updated || updated.length === 0) {
        throw new Error(
          'Guarda primero los datos de la empresa (botón "Guardar") y vuelve a subir la imagen.'
        )
      }

      if (tipo === 'logo') {
        setLogo(logoPublicUrl)
        setMessage('Logo guardado correctamente.')
      } else {
        const { data: signed } = await supabase.storage
          .from(SIGNATURE_BUCKET)
          .createSignedUrl(path, SIGNATURE_URL_TTL_SECONDS)
        setSignature(signed?.signedUrl ?? null)
        setLegacySignature(false)
        setMessage('Firma guardada de forma privada.')
      }
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
          Sube el logo y la firma que aparecerán en tus documentos (PNG, JPG o WEBP).
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
        <p className="text-xs text-gray-500">
          El logo es público: lo verá cualquier persona que reciba tus documentos. Máximo 5 MB.
        </p>

        {logo && (
          <img
            src={logo}
            alt="Logo de la empresa"
            className="max-h-32 max-w-48 rounded border object-contain"
          />
        )}

        <input
          type="file"
          accept={ACCEPT}
          disabled={loading}
          onChange={(event) =>
            subirArchivo(event.target.files?.[0], 'logo')
          }
        />
      </div>

      <div className="space-y-3">
        <h3 className="font-medium">Firma para documentos</h3>
        <p className="text-xs text-gray-500">
          La firma se guarda de forma privada y solo se muestra a miembros de tu
          empresa mediante enlaces temporales. Máximo 2 MB.
        </p>

        {legacySignature && (
          <p role="alert" className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
            Tu firma actual se subió antes de este cambio y está en almacenamiento
            público. Vuelve a subirla para protegerla.
          </p>
        )}

        {signature && (
          <img
            src={signature}
            alt="Firma de la empresa"
            className="max-h-32 max-w-48 rounded border object-contain"
          />
        )}

        <input
          type="file"
          accept={ACCEPT}
          disabled={loading}
          onChange={(event) =>
            subirArchivo(event.target.files?.[0], 'signature')
          }
        />
      </div>
    </section>
  )
}
