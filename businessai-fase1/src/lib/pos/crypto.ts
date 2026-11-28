/**
 * Encryption of POS provider tokens (SERVER ONLY): AES-256-GCM, random 96-bit IV, the key id travels
 * with the ciphertext (rotation). Format "<keyId>.<iv>.<ciphertext>.<tag>" (base64url). The
 * associated data binds the ciphertext to the POS module, so a banking token cannot be swapped in.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { TokenKey } from '@/lib/banking/config'

const b64u = (b: Buffer) => b.toString('base64url')
const aad = (id: string) => Buffer.from(`ba-pos-token|${id}`, 'utf8')

export function encryptPosToken(plain: string, keys: TokenKey[]): { ciphertext: string; keyVersion: string } {
  const k = keys[0]
  if (!k) throw new Error('POS_TOKEN_KEY_MISSING')
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', k.key, iv)
  c.setAAD(aad(k.id))
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return { ciphertext: [k.id, b64u(iv), b64u(ct), b64u(c.getAuthTag())].join('.'), keyVersion: k.id }
}

export function decryptPosToken(ciphertext: string, keys: TokenKey[]): string {
  const parts = ciphertext.split('.')
  if (parts.length !== 4) throw new Error('POS_TOKEN_INVALID')
  const [id, iv, ct, tag] = parts
  const k = keys.find((x) => x.id === id)
  if (!k) throw new Error('POS_TOKEN_KEY_UNKNOWN')
  const d = createDecipheriv('aes-256-gcm', k.key, Buffer.from(iv, 'base64url'))
  d.setAAD(aad(k.id))
  d.setAuthTag(Buffer.from(tag, 'base64url'))
  try {
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8')
  } catch {
    throw new Error('POS_TOKEN_INVALID')
  }
}
