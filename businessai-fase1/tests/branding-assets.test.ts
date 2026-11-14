import { describe, expect, it, vi } from 'vitest'
import {
  LOGO_BUCKET,
  SIGNATURE_BUCKET,
  SIGNATURE_URL_TTL_SECONDS,
  buildObjectPath,
  getSignatureDisplayUrl,
  isAllowedImageType,
  parseSignatureRef,
  toSignatureRef,
  validateBrandingFile,
} from '@/lib/branding-assets'

const CO = '6f1c2d3e-4a5b-4c6d-8e7f-001122334455'
const OTHER = '0a0b0c0d-1111-4222-8333-444455556666'
const RID = '9b8a7c6d-5e4f-4a3b-9c2d-1e0f0a0b0c0d'

describe('allowed file types', () => {
  it('accepts PNG, JPEG and WEBP only', () => {
    expect(['image/png', 'image/jpeg', 'image/webp'].every(isAllowedImageType)).toBe(true)
    for (const t of ['image/svg+xml', 'text/html', 'image/gif', 'application/pdf', '', 'image/PNG']) {
      expect(isAllowedImageType(t)).toBe(false)
    }
  })

  it('rejects SVG/HTML, empty and oversized files with a Spanish message', () => {
    expect(validateBrandingFile({ type: 'image/svg+xml', size: 10 }, 'logo')).toMatch(/Formato no permitido/)
    expect(validateBrandingFile({ type: 'text/html', size: 10 }, 'signature')).toMatch(/Formato no permitido/)
    expect(validateBrandingFile({ type: 'image/png', size: 0 }, 'logo')).toMatch(/vacío/)
    expect(validateBrandingFile({ type: 'image/png', size: 2 * 1024 * 1024 + 1 }, 'signature')).toMatch(/2 MB/)
    expect(validateBrandingFile({ type: 'image/png', size: 5 * 1024 * 1024 + 1 }, 'logo')).toMatch(/5 MB/)
    expect(validateBrandingFile({ type: 'image/webp', size: 1024 }, 'signature')).toBeNull()
    expect(validateBrandingFile({ type: 'image/jpeg', size: 5 * 1024 * 1024 }, 'logo')).toBeNull()
  })
})

describe('object paths', () => {
  it('puts files in the company folder with a random name and a MIME-derived extension', () => {
    expect(buildObjectPath(CO, 'signature', 'image/jpeg', RID)).toBe(`${CO}/signature-${RID}.jpg`)
    expect(buildObjectPath(CO, 'logo', 'image/webp', RID)).toBe(`${CO}/logo-${RID}.webp`)
  })

  it('refuses non-uuid company ids or random ids (no path tricks)', () => {
    expect(() => buildObjectPath('../x', 'logo', 'image/png', RID)).toThrow()
    expect(() => buildObjectPath(CO, 'logo', 'image/png', '123')).toThrow()
  })

  it('uses a public bucket for logos and a separate one for signatures', () => {
    expect(LOGO_BUCKET).toBe('Company-assets')
    expect(SIGNATURE_BUCKET).toBe('Company-signatures')
    expect(SIGNATURE_URL_TTL_SECONDS).toBeLessThanOrEqual(600)
  })
})

describe('signature references', () => {
  const path = `${CO}/signature-${RID}.png`

  it('round-trips a private reference', () => {
    expect(parseSignatureRef(toSignatureRef(path), CO)).toEqual({
      kind: 'private', bucket: 'Company-signatures', path,
    })
  })

  it('rejects references to another company, another bucket or odd paths', () => {
    expect(parseSignatureRef(toSignatureRef(path), OTHER)).toBeNull()
    expect(parseSignatureRef(`private:Company-assets/${path}`, CO)).toBeNull()
    expect(parseSignatureRef(`private:Company-signatures/${CO}/../${OTHER}/x.png`, CO)).toBeNull()
    expect(parseSignatureRef(`private:Company-signatures/${CO}/a/b.png`, CO)).toBeNull()
    expect(parseSignatureRef(`private:Company-signatures/${CO}/`, CO)).toBeNull()
    expect(parseSignatureRef('javascript:alert(1)', CO)).toBeNull()
    expect(parseSignatureRef('http://insecure.example/x.png', CO)).toBeNull()
    expect(parseSignatureRef('', CO)).toBeNull()
    expect(parseSignatureRef(null, CO)).toBeNull()
  })

  it('recognises signatures uploaded before the change (legacy public URL)', () => {
    const url = `https://x.supabase.co/storage/v1/object/public/Company-assets/${CO}/signature-1.png`
    expect(parseSignatureRef(url, CO)).toEqual({ kind: 'legacy-public', url })
  })
})

describe('getSignatureDisplayUrl', () => {
  function fakeClient(result: { data: { signedUrl: string } | null; error: { message: string } | null }) {
    const createSignedUrl = vi.fn().mockResolvedValue(result)
    const from = vi.fn().mockReturnValue({ createSignedUrl })
    return { client: { storage: { from } }, from, createSignedUrl }
  }
  const path = `${CO}/signature-${RID}.png`

  it('asks the private bucket for a short-lived signed URL', async () => {
    const f = fakeClient({ data: { signedUrl: 'https://signed.example/s?token=t' }, error: null })
    const r = await getSignatureDisplayUrl(f.client, toSignatureRef(path), CO)
    expect(r).toEqual({ url: 'https://signed.example/s?token=t', legacyPublic: false })
    expect(f.from).toHaveBeenCalledWith('Company-signatures')
    expect(f.createSignedUrl).toHaveBeenCalledWith(path, SIGNATURE_URL_TTL_SECONDS)
  })

  it('returns null (document still renders) when Storage denies or fails', async () => {
    const denied = fakeClient({ data: null, error: { message: 'Object not found' } })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await getSignatureDisplayUrl(denied.client, toSignatureRef(path), CO)).toBeNull()
    const throwing = { storage: { from: () => ({ createSignedUrl: () => Promise.reject(new Error('network')) }) } }
    expect(await getSignatureDisplayUrl(throwing, toSignatureRef(path), CO)).toBeNull()
    err.mockRestore()
  })

  it('never signs a path outside the company folder', async () => {
    const f = fakeClient({ data: { signedUrl: 'https://signed.example/x' }, error: null })
    expect(await getSignatureDisplayUrl(f.client, toSignatureRef(path), OTHER)).toBeNull()
    expect(f.createSignedUrl).not.toHaveBeenCalled()
  })

  it('keeps showing a legacy public signature and flags it', async () => {
    const f = fakeClient({ data: null, error: null })
    const url = `https://x.supabase.co/storage/v1/object/public/Company-assets/${CO}/signature-1.png`
    expect(await getSignatureDisplayUrl(f.client, url, CO)).toEqual({ url, legacyPublic: true })
    expect(f.createSignedUrl).not.toHaveBeenCalled()
  })

  it('returns null when there is no signature', async () => {
    const f = fakeClient({ data: null, error: null })
    expect(await getSignatureDisplayUrl(f.client, null, CO)).toBeNull()
  })
})
