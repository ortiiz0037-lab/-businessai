// Storage by role against the STAGING project: logos (Company-assets, public
// bucket, owner/admin manage) and signatures (Company-signatures, PRIVATE
// bucket). TEST-ONLY, temporary data (prefix `e3-storage`), removed afterwards.
//
// Expected (today's behaviour, unchanged by 0014a):
//   Company-assets     : owner/admin upload and list their company folder;
//                        member cannot; no overwrite; other companies nothing.
//   Company-signatures : owner/admin upload and delete; owner/admin/member read
//                        (documents show the signature); nobody overwrites
//                        (no update policy); other companies and anon nothing;
//                        only PNG/JPEG/WEBP up to 2 MB.
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildObjectPath, LOGO_BUCKET, SIGNATURE_BUCKET } from '@/lib/branding-assets'
import { createFixture, opts, png, stagingEnv, type Actor, type Company } from './staging-helpers'

const enabled = stagingEnv.enabled
const fx = enabled ? createFixture('e3-storage') : (null as unknown as ReturnType<typeof createFixture>)

let A: Company, B: Company, O: Actor, AD: Actor, M: Actor, OB: Actor
const path = (company: Company, kind: 'logo' | 'signature') =>
  buildObjectPath(company.id, kind, 'image/png', crypto.randomUUID())
const roles = () => [['owner', O], ['admin', AD], ['member', M]] as const
const exists = async (bucket: string, p: string) => {
  const [folder, name] = p.split('/')
  const r = await fx.admin.storage.from(bucket).list(folder, { search: name })
  return (r.data ?? []).some((f) => f.name === name)
}

beforeAll(async () => {
  if (!enabled) return
  A = await fx.makeCompany('a')
  B = await fx.makeCompany('b')
  O = A.owner
  OB = B.owner
  AD = await fx.addMember(A, 'a-admin', 'admin')
  M = await fx.addMember(A, 'a-member', 'member')
}, 120000)

afterAll(async () => {
  if (enabled) await fx.cleanup()
}, 120000)

describe.skipIf(!enabled)('Company-assets (logos) by role', () => {
  it('owner and admin upload into their company folder; member cannot', async () => {
    for (const [role, u] of roles()) {
      const p = path(A, 'logo')
      const r = await u.client.storage.from(LOGO_BUCKET).upload(p, png(), { upsert: false, contentType: 'image/png' })
      expect(r.error === null, role).toBe(role !== 'member')
      expect(await exists(LOGO_BUCKET, p), role).toBe(role !== 'member')
    }
  })

  it('owner and admin list the folder; member and another company see nothing', async () => {
    for (const [role, u] of roles()) {
      const listed = (await u.client.storage.from(LOGO_BUCKET).list(A.id)).data ?? []
      expect(listed.length > 0, role).toBe(role !== 'member')
    }
    expect((await OB.client.storage.from(LOGO_BUCKET).list(A.id)).data ?? []).toEqual([])
  })

  it('nobody overwrites or deletes a logo, and no one uploads into another company', async () => {
    const p = path(A, 'logo')
    expect((await O.client.storage.from(LOGO_BUCKET).upload(p, png(), { contentType: 'image/png' })).error).toBeNull()
    for (const [role, u] of [...roles(), ['other company', OB]] as const) {
      expect((await u.client.storage.from(LOGO_BUCKET).upload(p, png(), { upsert: true, contentType: 'image/png' })).error, role).not.toBeNull()
      await u.client.storage.from(LOGO_BUCKET).remove([p])
      expect(await exists(LOGO_BUCKET, p), role).toBe(true)
    }
    expect((await OB.client.storage.from(LOGO_BUCKET).upload(path(A, 'logo'), png(), { contentType: 'image/png' })).error).not.toBeNull()
  })
})

describe.skipIf(!enabled)('Company-signatures (private) by role', () => {
  it('the bucket is private and limited to images of at most 2 MB', async () => {
    const { data, error } = await fx.admin.storage.getBucket(SIGNATURE_BUCKET)
    expect(error).toBeNull()
    expect(data?.public).toBe(false)
    expect(Number(data?.file_size_limit)).toBe(2 * 1024 * 1024)
    expect([...(data?.allowed_mime_types ?? [])].sort()).toEqual(['image/jpeg', 'image/png', 'image/webp'])
  })

  it('owner and admin upload a signature; member cannot', async () => {
    for (const [role, u] of roles()) {
      const p = path(A, 'signature')
      const r = await u.client.storage.from(SIGNATURE_BUCKET).upload(p, png(), { upsert: false, contentType: 'image/png' })
      expect(r.error === null, role).toBe(role !== 'member')
      expect(await exists(SIGNATURE_BUCKET, p), role).toBe(role !== 'member')
    }
  })

  it('owner, admin and member read the signature (signed URL); another company and anon cannot', async () => {
    const p = path(A, 'signature')
    expect((await O.client.storage.from(SIGNATURE_BUCKET).upload(p, png(), { contentType: 'image/png' })).error).toBeNull()
    for (const [role, u] of roles()) {
      const signed = await u.client.storage.from(SIGNATURE_BUCKET).createSignedUrl(p, 60)
      expect(signed.error, role).toBeNull()
      expect((await u.client.storage.from(SIGNATURE_BUCKET).download(p)).error, role).toBeNull()
    }
    const anon = createClient(stagingEnv.enabled ? stagingEnv.url : '', stagingEnv.enabled ? stagingEnv.anonKey : '', opts)
    for (const [who, c] of [['other company', OB.client], ['anon', anon]] as const) {
      expect((await c.storage.from(SIGNATURE_BUCKET).createSignedUrl(p, 60)).error, who).not.toBeNull()
      expect((await c.storage.from(SIGNATURE_BUCKET).download(p)).error, who).not.toBeNull()
      expect((await c.storage.from(SIGNATURE_BUCKET).list(A.id)).data ?? [], who).toEqual([])
    }
    // Private bucket: the public URL does not serve the file.
    const publicUrl = anon.storage.from(SIGNATURE_BUCKET).getPublicUrl(p).data.publicUrl
    expect((await fetch(publicUrl)).ok).toBe(false)
  })

  it('nobody overwrites a signature; only owner and admin delete', async () => {
    for (const [role, u] of roles()) {
      const p = path(A, 'signature')
      expect((await O.client.storage.from(SIGNATURE_BUCKET).upload(p, png(), { contentType: 'image/png' })).error).toBeNull()
      expect((await u.client.storage.from(SIGNATURE_BUCKET).upload(p, png(), { upsert: true, contentType: 'image/png' })).error, role).not.toBeNull()
      await u.client.storage.from(SIGNATURE_BUCKET).remove([p])
      expect(await exists(SIGNATURE_BUCKET, p), role).toBe(role === 'member')
    }
  })

  it('another company cannot upload or delete in A; anon cannot upload', async () => {
    const p = path(A, 'signature')
    expect((await O.client.storage.from(SIGNATURE_BUCKET).upload(p, png(), { contentType: 'image/png' })).error).toBeNull()
    expect((await OB.client.storage.from(SIGNATURE_BUCKET).upload(path(A, 'signature'), png(), { contentType: 'image/png' })).error).not.toBeNull()
    await OB.client.storage.from(SIGNATURE_BUCKET).remove([p])
    expect(await exists(SIGNATURE_BUCKET, p)).toBe(true)
    const anon = createClient(stagingEnv.enabled ? stagingEnv.url : '', stagingEnv.enabled ? stagingEnv.anonKey : '', opts)
    expect((await anon.storage.from(SIGNATURE_BUCKET).upload(path(A, 'signature'), png(), { contentType: 'image/png' })).error).not.toBeNull()
  })

  it('uploads outside a company folder or of other types are refused', async () => {
    for (const p of [`root-${fx.stamp}.png`, `not-a-uuid/sig-${fx.stamp}.png`, path(B, 'signature')]) {
      expect((await O.client.storage.from(SIGNATURE_BUCKET).upload(p, png(), { contentType: 'image/png' })).error, p).not.toBeNull()
    }
    const html = new Blob(['<script>alert(1)</script>'], { type: 'text/html' })
    expect((await O.client.storage.from(SIGNATURE_BUCKET).upload(`${A.id}/x-${fx.stamp}.html`, html, { contentType: 'text/html' })).error).not.toBeNull()
    const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' })
    expect((await O.client.storage.from(SIGNATURE_BUCKET).upload(`${A.id}/x-${fx.stamp}.svg`, svg, { contentType: 'image/svg+xml' })).error).not.toBeNull()
    const big = new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: 'image/png' })
    expect((await O.client.storage.from(SIGNATURE_BUCKET).upload(path(A, 'signature'), big, { contentType: 'image/png' })).error).not.toBeNull()
  })
})
