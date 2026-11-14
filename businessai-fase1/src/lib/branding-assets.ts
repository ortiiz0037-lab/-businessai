/**
 * Company branding files (logo and signature).
 *
 * - Logos stay in the PUBLIC bucket `Company-assets`: they are meant to be
 *   seen by anyone who receives a document.
 * - Signatures go to the PRIVATE bucket `Company-signatures` and are only
 *   shown through short-lived signed URLs created for a signed-in member.
 *
 * `company_profiles.signature_url` keeps its name (no schema change). It now
 * holds either a private reference `private:<bucket>/<path>` (new uploads)
 * or, for signatures uploaded before this change, a legacy public URL.
 */

export const LOGO_BUCKET = 'Company-assets'
export const SIGNATURE_BUCKET = 'Company-signatures'

/** Signed URLs for signatures expire after 5 minutes. */
export const SIGNATURE_URL_TTL_SECONDS = 300

/** Only raster images. SVG is excluded on purpose (it can carry scripts). */
export const ALLOWED_IMAGE_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
} as const

export type AllowedImageType = keyof typeof ALLOWED_IMAGE_TYPES
export type BrandingKind = 'logo' | 'signature'

export const MAX_BYTES: Record<BrandingKind, number> = {
  logo: 5 * 1024 * 1024,
  signature: 2 * 1024 * 1024,
}

const PRIVATE_PREFIX = 'private:'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isAllowedImageType(type: string): type is AllowedImageType {
  return Object.prototype.hasOwnProperty.call(ALLOWED_IMAGE_TYPES, type)
}

/** Returns an error message in Spanish, or null when the file is acceptable. */
export function validateBrandingFile(
  file: { type: string; size: number },
  kind: BrandingKind
): string | null {
  if (!isAllowedImageType(file.type)) {
    return 'Formato no permitido. Usa una imagen PNG, JPG o WEBP.'
  }
  if (file.size <= 0) return 'El archivo está vacío.'
  if (file.size > MAX_BYTES[kind]) {
    return `La imagen debe pesar menos de ${MAX_BYTES[kind] / (1024 * 1024)} MB.`
  }
  return null
}

/**
 * `<company_id>/<kind>-<random uuid>.<ext>` — the company folder is what the
 * storage policies check; the random part makes paths unguessable.
 * The extension comes from the validated MIME type, never from the file name.
 */
export function buildObjectPath(
  companyId: string,
  kind: BrandingKind,
  type: AllowedImageType,
  randomId: string
): string {
  if (!UUID.test(companyId)) throw new Error('Invalid company id')
  if (!UUID.test(randomId)) throw new Error('Invalid random id')
  return `${companyId}/${kind}-${randomId.toLowerCase()}.${ALLOWED_IMAGE_TYPES[type]}`
}

export function toSignatureRef(path: string): string {
  return `${PRIVATE_PREFIX}${SIGNATURE_BUCKET}/${path}`
}

export type SignatureRef =
  | { kind: 'private'; bucket: string; path: string }
  | { kind: 'legacy-public'; url: string }

/**
 * Parses the stored value. A private reference is accepted only when it is in
 * the signatures bucket and inside the given company's folder, so a profile
 * can never point at another company's file.
 */
export function parseSignatureRef(
  value: string | null | undefined,
  companyId: string
): SignatureRef | null {
  if (!value) return null

  if (value.startsWith(PRIVATE_PREFIX)) {
    const rest = value.slice(PRIVATE_PREFIX.length)
    const bucketPrefix = `${SIGNATURE_BUCKET}/`
    if (!rest.startsWith(bucketPrefix)) return null
    const path = rest.slice(bucketPrefix.length)
    const segments = path.split('/')
    if (segments.length !== 2 || segments[0] !== companyId || !segments[1]) return null
    if (segments.some((s) => s === '.' || s === '..')) return null
    return { kind: 'private', bucket: SIGNATURE_BUCKET, path }
  }

  if (/^https:\/\//i.test(value)) return { kind: 'legacy-public', url: value }
  return null
}

type SignedUrlClient = {
  storage: {
    from(bucket: string): {
      createSignedUrl(
        path: string,
        expiresIn: number
      ): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>
    }
  }
}

export type SignatureDisplay = {
  url: string
  /** true when the signature still lives in the public bucket. */
  legacyPublic: boolean
} | null

/**
 * URL to display a company's signature right now. For private signatures
 * this asks Storage for a signed URL with the caller's session, so storage
 * policies decide (only members of that company). Never throws.
 */
export async function getSignatureDisplayUrl(
  supabase: SignedUrlClient,
  value: string | null | undefined,
  companyId: string
): Promise<SignatureDisplay> {
  const ref = parseSignatureRef(value, companyId)
  if (!ref) return null
  if (ref.kind === 'legacy-public') return { url: ref.url, legacyPublic: true }

  try {
    const { data, error } = await supabase.storage
      .from(ref.bucket)
      .createSignedUrl(ref.path, SIGNATURE_URL_TTL_SECONDS)
    if (error || !data?.signedUrl) {
      console.error('SIGNATURE_SIGNED_URL_ERROR', { message: error?.message })
      return null
    }
    return { url: data.signedUrl, legacyPublic: false }
  } catch (error) {
    console.error('SIGNATURE_SIGNED_URL_ERROR', {
      message: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
