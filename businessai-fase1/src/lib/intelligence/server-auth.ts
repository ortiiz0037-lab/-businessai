/**
 * Server authorization of the assistant's internal writes (SERVER ONLY).
 *
 * The server keeps acting with the USER'S Supabase session (auth.uid(),
 * RLS); in addition it signs quota / usage / audit / execution writes with
 * HMAC-SHA256. The database checks the signature (migration 0030), so a
 * user calling those functions through the REST API cannot forge them.
 *
 *   ASSISTANT_SERVER_KEYS="k2:<base64 ≥ 32 bytes>,k1:<base64>"
 * The first key signs; the others are accepted by the database until it
 * retires them (rotation). The same key must be registered in the database
 * by its owner: select public.assistant_set_server_key('k2', '<base64>').
 * Without a valid key the assistant stays closed.
 *
 * The canonical messages must match ba_private.* in 0030 byte for byte.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto'

export type ServerKey = { id: string; secret: Buffer }

export function parseServerKeys(raw: string | undefined): ServerKey[] {
  const keys: ServerKey[] = []
  for (const entry of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = entry.indexOf(':')
    if (i < 1) return []
    const id = entry.slice(0, i)
    const b64 = entry.slice(i + 1)
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return []
    const secret = Buffer.from(b64, 'base64')
    if (secret.length < 32 || secret.length > 128) return []
    keys.push({ id, secret })
  }
  return keys
}

export const shaHex = (text: string | null | undefined) => createHash('sha256').update(text ?? '', 'utf8').digest('hex')
export const nowSeconds = () => Math.floor(Date.now() / 1000)
const mac = (key: ServerKey, message: string) => createHmac('sha256', key.secret).update(message, 'utf8').digest('hex')

export class ServerSigner {
  constructor(private readonly key: ServerKey, private readonly userId: string) {}
  get keyId() { return this.key.id }
  private get uid() { return this.userId.toLowerCase() }

  begin(target: string, conv: string | null, userText: string) {
    const nonce = randomUUID(), ts = nowSeconds()
    return { key: this.key.id, nonce, ts, mac: mac(this.key, ['begin', 'v1', this.key.id, this.uid, target, conv ?? '', nonce, String(ts), shaHex(userText)].join('|')) }
  }
  finish(turn: string, payload: string) {
    return { key: this.key.id, mac: mac(this.key, ['finish', 'v1', this.key.id, this.uid, turn, shaHex(payload)].join('|')) }
  }
  claim(act: string) {
    const ts = nowSeconds()
    return { key: this.key.id, ts, mac: mac(this.key, ['claim', 'v1', this.key.id, this.uid, act, String(ts)].join('|')) }
  }
  progress(act: string, progress: string) {
    const ts = nowSeconds()
    return { key: this.key.id, ts, mac: mac(this.key, ['progress', 'v1', this.key.id, this.uid, act, String(ts), shaHex(progress)].join('|')) }
  }
  complete(act: string, ok: boolean, result: string | null, err: string | null) {
    const ts = nowSeconds()
    return { key: this.key.id, ts, mac: mac(this.key, ['complete', 'v1', this.key.id, this.uid, act, String(ok), String(ts), shaHex(result), shaHex(err)].join('|')) }
  }
}
