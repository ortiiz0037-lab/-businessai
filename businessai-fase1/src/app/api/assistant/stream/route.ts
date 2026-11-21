/**
 * Assistant turn as a Server-Sent Events stream (A11).
 *   - same-origin only (Origin / Sec-Fetch-Site checked; the session cookie
 *     alone is not enough), JSON body ≤ 16 KB;
 *   - the turn deadline (ASSISTANT_TURN_DEADLINE_MS ≤ 55 s) stays below
 *     maxDuration, so the turn is always finished and recorded in time;
 *   - closing the connection cancels the provider call; the turn is still
 *     finished in the database with the usage consumed so far.
 * Events: start · model · tool · delta (provisional text) · reset · final · error.
 */
import { streamTurn, type StreamEvent } from '@/lib/assistant/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

function sameOrigin(req: Request): boolean {
  const site = req.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin') return false
  const origin = req.headers.get('origin')
  if (!origin) return false
  const self = new URL(req.url).origin
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, '')
  return origin === self || (!!configured && origin === configured)
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return Response.json({ error: 'forbidden' }, { status: 403 })
  if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) return Response.json({ error: 'invalid' }, { status: 415 })
  const raw = await req.text()
  if (raw.length > 16_384) return Response.json({ error: 'invalid' }, { status: 413 })
  let body: unknown
  try { body = JSON.parse(raw) } catch { return Response.json({ error: 'invalid' }, { status: 400 }) }

  const encoder = new TextEncoder()
  const abort = new AbortController()
  req.signal.addEventListener('abort', () => abort.abort('cancelled'), { once: true })
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true
      const emit = (e: StreamEvent) => {
        if (!open) return
        try { controller.enqueue(encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}\n\n`)) } catch { open = false }
      }
      try { await streamTurn(body, emit, abort.signal) }
      catch (e) { console.error('ASSISTANT_STREAM_ERROR', { kind: (e as Error)?.name }); emit({ type: 'error', error: 'forbidden' }) }
      finally { open = false; try { controller.close() } catch { /* client gone */ } }
    },
    cancel() { abort.abort('cancelled') },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' } })
}
