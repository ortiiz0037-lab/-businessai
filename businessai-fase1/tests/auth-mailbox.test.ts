import { describe, expect, it } from 'vitest'
import { parseMailbox } from '../scripts/staging/auth-mailbox.mjs'

describe('staging Auth test mailbox', () => {
  it('accepts a real address and keeps its parts (a +tag is dropped from the address)', () => {
    expect(parseMailbox('ana.perez@gmail.com')).toEqual({ local: 'ana.perez', domain: 'gmail.com', address: 'ana.perez@gmail.com' })
    expect(parseMailbox(' qa+x@empresa.pr ')).toEqual({ local: 'qa', domain: 'empresa.pr', address: 'qa@empresa.pr' })
  })
  it('refuses placeholder and reserved domains (never @example.com)', () => {
    for (const v of ['a@example.com', 'a@example.org', 'a@example.net', 'a@x.test', 'a@foo.invalid', 'a@b.example', 'a@host.localhost']) expect(parseMailbox(v)).toBeNull()
  })
  it('refuses empty or malformed values', () => {
    for (const v of [undefined, '', 'nobody', '@gmail.com', 'a@b', 'a b@gmail.com']) expect(parseMailbox(v)).toBeNull()
  })
})
