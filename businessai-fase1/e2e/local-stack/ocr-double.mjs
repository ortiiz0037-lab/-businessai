/**
 * TEST DOUBLE of Azure AI Document Intelligence (prebuilt-receipt) — LOCAL
 * TESTS ONLY. It does NOT read images: it returns scripted fields so the tests
 * can drive the real code path (upload to private storage, register, analyze,
 * correct, confirm). The app reaches it only through a loopback endpoint and
 * stores its results with provider 'test_double', shown as a test result.
 *
 * Script: a file whose bytes contain "SIN-DATOS" yields no fields at all (the
 * screen must show every field as not recognized); otherwise merchant, date,
 * total and tax with confidences; never a receipt number or payment method.
 */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

export function startOcrDouble({ port, key }) {
  const results = new Map()
  const log = []
  const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)) }
  const read = (req) => new Promise((ok) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c).toString('utf8'))) })
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    log.push({ method: req.method, path: url.pathname })
    if (req.headers['ocp-apim-subscription-key'] !== key) return send(res, 401, { error: { code: '401', message: 'Access denied (test double)' } })
    if (req.method === 'POST' && url.pathname === '/documentintelligence/documentModels/prebuilt-receipt:analyze') {
      const body = JSON.parse((await read(req)) || '{}')
      const bytes = Buffer.from(body.base64Source ?? '', 'base64').toString('latin1')
      const id = randomBytes(8).toString('hex')
      const fields = bytes.includes('SIN-DATOS') ? {} : {
        MerchantName: { type: 'string', valueString: 'Ferretería Central', content: 'FERRETERIA CENTRAL', confidence: 0.94 },
        TransactionDate: { type: 'date', valueDate: '2026-11-10', content: '11/10/2026', confidence: 0.9 },
        Total: { type: 'currency', valueCurrency: { amount: 48.15, currencyCode: 'USD' }, content: '$48.15', confidence: 0.92 },
        TotalTax: { type: 'currency', valueCurrency: { amount: 5.4, currencyCode: 'USD' }, content: '$5.40', confidence: 0.71 },
      }
      results.set(id, { polls: 0, fields })
      return send(res, 202, {}, { 'operation-location': `http://127.0.0.1:${port}/documentintelligence/documentModels/prebuilt-receipt/analyzeResults/${id}?api-version=2024-11-30` })
    }
    const m = url.pathname.match(/^\/documentintelligence\/documentModels\/prebuilt-receipt\/analyzeResults\/([0-9a-f]+)$/)
    if (req.method === 'GET' && m && results.has(m[1])) {
      const r = results.get(m[1])
      r.polls++
      if (r.polls < 2) return send(res, 200, { status: 'running' })
      return send(res, 200, { status: 'succeeded', analyzeResult: { apiVersion: '2024-11-30', modelId: 'prebuilt-receipt', documents: [{ docType: 'receipt.retailMeal', fields: r.fields, confidence: 0.9 }] } })
    }
    return send(res, 404, { error: { code: 'NotFound' } })
  })
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${port}`, log, close: () => new Promise((d) => server.close(() => d())) })))
}
