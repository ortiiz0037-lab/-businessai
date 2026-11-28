/**
 * Encryption of the provider access token (SERVER ONLY). AES-256-GCM with a
 * random 96-bit IV; the key id travels with the ciphertext so keys can rotate.
 * Format: "<keyId>.<iv b64url>.<ciphertext b64url>.<tag b64url>".
 * The plaintext token never leaves the server and is never logged.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { TokenKey } from '@/lib/banking/config'

const b64u = (b: Buffer) => b.toString('base64url')

export function encryptToken(plain: string, keys: TokenKey[]): { ciphertext: string; keyVersion: string } {
  const k = keys[0]
  if (!k) throw new Error('BANK_TOKEN_KEY_MISSING')
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', k.key, iv)
  c.setAAD(Buffer.from(`ba-bank-token|${k.id}`, 'utf8'))
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return { ciphertext: [k.id, b64u(iv), b64u(ct), b64u(c.getAuthTag())].join('.'), keyVersion: k.id }
}

export function decryptToken(ciphertext: string, keys: TokenKey[]): string {
  const parts = ciphertext.split('.')
  if (parts.length !== 4) throw new Error('BANK_TOKEN_INVALID')
  const [id, iv, ct, tag] = parts
  const k = keys.find((x) => x.id === id)
  if (!k) throw new Error('BANK_TOKEN_KEY_UNKNOWN')
  const d = createDecipheriv('aes-256-gcm', k.key, Buffer.from(iv, 'base64url'))
  d.setAAD(Buffer.from(`ba-bank-token|${k.id}`, 'utf8'))
  d.setAuthTag(Buffer.from(tag, 'base64url'))
  try {
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8')
  } catch {
    throw new Error('BANK_TOKEN_INVALID')
  }
}
