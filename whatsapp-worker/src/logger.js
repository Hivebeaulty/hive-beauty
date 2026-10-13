// Logs estruturados. Nunca registrar conteúdo de mensagem, QR, credencial ou
// telefone completo: use maskPhone() quando precisar identificar um número.
import pino from 'pino'

export function createLogger(level = 'info', destination = undefined) {
  return pino({
    level,
    base: { svc: 'aurea-wa-worker' },
    // mensagens de erro (Baileys/banco) podem trazer JID ou telefone: mascara sequências longas de dígitos
    formatters: { log: (o) => (typeof o.err === 'string' ? { ...o, err: redactDigits(o.err) } : o) },
    redact: {
      paths: ['body', 'text', 'qr', 'creds', 'data', '*.body', '*.text', '*.qr', '*.creds', '*.data', 'password', 'DATABASE_URL'],
      censor: '[oculto]',
    },
  }, destination)
}

export function maskPhone(p) {
  if (!p) return p
  const d = String(p).replace(/\D/g, '')
  return d.length <= 4 ? '****' : `${'*'.repeat(d.length - 4)}${d.slice(-4)}`
}

// Mascara sequências de 8+ dígitos (telefones, JIDs) em textos livres, mantendo os 4 últimos.
export function redactDigits(text) {
  return String(text ?? '').replace(/\d{8,}/g, (d) => maskPhone(d))
}
