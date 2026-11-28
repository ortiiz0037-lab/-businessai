/**
 * Email through Resend, prepared but optional. Nothing is sent (and nothing
 * is marked sent) unless RESEND_API_KEY and EMAIL_FROM are configured on the
 * server. The key never reaches the browser and is never logged.
 */
export type EmailConfig = { apiKey: string; from: string }
export type SendResult = { ok: true; id: string | null } | { ok: false; error: string; notConfigured?: boolean }

type Source = Record<string, string | undefined>

export function emailConfig(source: Source = process.env): EmailConfig | null {
  const apiKey = source.RESEND_API_KEY?.trim()
  const from = source.EMAIL_FROM?.trim()
  if (!apiKey || !from || !/^re_[A-Za-z0-9_]{8,}$/.test(apiKey) || !/@/.test(from)) return null
  return { apiKey, from }
}

export function emailConfigured(source: Source = process.env): boolean {
  return emailConfig(source) !== null
}

const EMAIL = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/

export async function sendEmail(
  msg: { to: string; subject: string; text: string; replyTo?: string | null; fromName?: string | null },
  opts: { source?: Source; fetchImpl?: typeof fetch } = {},
): Promise<SendResult> {
  const cfg = emailConfig(opts.source)
  if (!cfg) return { ok: false, error: 'email_not_configured', notConfigured: true }
  if (!EMAIL.test(msg.to)) return { ok: false, error: 'email_invalid' }
  const name = msg.fromName?.replace(/[<>"\r\n]/g, '').trim()
  const body = {
    from: name ? `${name} <${cfg.from.replace(/^.*<|>$/g, '')}>` : cfg.from,
    to: [msg.to],
    subject: msg.subject.replace(/[\r\n]+/g, ' ').slice(0, 200),
    text: msg.text.slice(0, 10_000),
    ...(msg.replyTo && EMAIL.test(msg.replyTo) ? { reply_to: msg.replyTo } : {}),
  }
  try {
    const res = await (opts.fetchImpl ?? fetch)('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return { ok: false, error: `http_${res.status}` }
    const data = (await res.json().catch(() => null)) as { id?: string } | null
    return { ok: true, id: data?.id ?? null }
  } catch {
    return { ok: false, error: 'network' }
  }
}
