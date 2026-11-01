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
      paths: ['body', 'text', 'qr', 'creds', 'data', '*.body', '*.text', '*.qr', '*.creds', '*.data', 'password', 'DATABASE_URL',
        // identificadores de contatos que o Baileys põe nos erros de decifração
        'key.remoteJid', 'key.remoteJidAlt', 'key.participant', 'key.participantAlt', 'sender', 'author'],
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

// A biblioteca de criptografia do Baileys (libsignal) escreve DIRETO no console, fora do
// pino, objetos de sessão com chaves privadas (privKey, rootKey, chainKey...). Esta guarda
// descarta essas linhas e troca qualquer objeto de sessão/chave por "[omitido]".
const SIGNAL_NOISE = /^(Closing session|Opening session|Removing old closed session|Session already (closed|open)|Closing open session in favor of incoming prekey bundle|Migrating session to)/
const SECRET_KEYS = new Set(['_chains', 'currentRatchet', 'indexInfo', 'ephemeralKeyPair', 'rootKey', 'privKey', 'pendingPreKey', 'chainKey', 'messageKeys'])

function hasSecret(v, depth = 0) {
  if (!v || typeof v !== 'object' || depth > 3) return false
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return true
  return Object.keys(v).some((k) => SECRET_KEYS.has(k) || hasSecret(v[k], depth + 1))
}

export function sanitizeConsoleArgs(args) {
  if (typeof args[0] === 'string' && SIGNAL_NOISE.test(args[0])) return null   // descarta a linha
  return args.map((a) => (hasSecret(a) ? '[omitido]' : a))
}

export function guardConsole(target = console) {
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = target[m].bind(target)
    target[m] = (...args) => {
      const safe = sanitizeConsoleArgs(args)
      if (safe) orig(...safe)
    }
  }
}
