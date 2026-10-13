// Funções puras sobre identificadores e mensagens do WhatsApp (testáveis sem rede).
import { createHash } from 'node:crypto'

// Id da mensagem DETERMINÍSTICO por pedido da fila, no mesmo formato do Baileys
// ('3EB0' + 18 hex). Se o worker cair depois de enviar e antes de registrar, o
// reenvio usa o MESMO id: o banco não duplica (messages é único por id) e o
// WhatsApp trata como a mesma mensagem.
export function messageIdFor(outboxId) {
  if (!outboxId) throw new Error('pedido sem id')
  return '3EB0' + createHash('sha256').update(`aurea-outbox:${outboxId}`).digest('hex').toUpperCase().slice(0, 18)
}

export function phoneToJid(phone) {
  const d = String(phone || '').replace(/\D/g, '')
  if (!/^\d{10,15}$/.test(d)) throw new Error('telefone inválido para WhatsApp')
  return `${d}@s.whatsapp.net`
}

// Identificador do remetente para gravar. O WhatsApp pode identificar o contato
// por LID (sem número); quando a biblioteca entrega o identificador alternativo
// com número (remoteJidAlt), ele é preferido para ligar a mensagem à cliente.
export function pickRemoteJid(key = {}) {
  const jid = key.remoteJid || ''
  const alt = key.remoteJidAlt || ''
  if (jid.endsWith('@lid') && alt.endsWith('@s.whatsapp.net')) return alt
  return jid
}

// Normaliza um identificador de telefone devolvido pelo mapa LID→número
// ('5511...:12@s.whatsapp.net' → '5511...@s.whatsapp.net'); outro formato → null.
export function normalizePnJid(pn) {
  const m = /^(\d{10,15})(?::\d+)?@s\.whatsapp\.net$/.exec(String(pn || ''))
  return m ? `${m[1]}@s.whatsapp.net` : null
}

export function isIgnorableJid(jid = '') {
  return jid === 'status@broadcast' || /@(g\.us|broadcast|newsletter)$/.test(jid)
}

// Desembrulha mensagens efêmeras/visualização única e extrai o texto.
export function unwrap(message) {
  let m = message
  for (let i = 0; i < 5 && m; i++) {
    const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message
      || m.documentWithCaptionMessage?.message || m.editedMessage?.message
    if (!inner) break
    m = inner
  }
  return m
}

export function extractText(message) {
  const m = unwrap(message)
  if (!m) return { text: null, type: 'unknown' }
  if (typeof m.conversation === 'string') return { text: m.conversation, type: 'text' }
  if (m.extendedTextMessage) return { text: m.extendedTextMessage.text ?? null, type: 'text' }
  if (m.imageMessage) return { text: m.imageMessage.caption ?? null, type: 'image' }
  if (m.videoMessage) return { text: m.videoMessage.caption ?? null, type: 'video' }
  if (m.documentMessage) return { text: m.documentMessage.caption ?? null, type: 'document' }
  if (m.audioMessage) return { text: null, type: 'audio' }
  if (m.stickerMessage) return { text: null, type: 'sticker' }
  if (m.buttonsResponseMessage) return { text: m.buttonsResponseMessage.selectedDisplayText ?? null, type: 'text' }
  if (m.listResponseMessage) return { text: m.listResponseMessage.title ?? null, type: 'text' }
  if (m.reactionMessage) return { text: null, type: 'reaction' }
  if (m.protocolMessage) return { text: null, type: 'protocol' }
  return { text: null, type: Object.keys(m)[0] || 'unknown' }
}

// proto.WebMessageInfo.Status: ERROR=0, PENDING=1, SERVER_ACK=2, DELIVERY_ACK=3, READ=4, PLAYED=5
export function mapStatus(status) {
  if (status === 3) return 'delivered'
  if (status === 4 || status === 5) return 'read'
  if (status === 0) return 'failed'
  return null
}

// O que fazer quando a conexão fecha (códigos de DisconnectReason do Baileys).
export function classifyClose(statusCode) {
  switch (statusCode) {
    case 401: return 'logged_out'          // desconectado pelo celular: precisa novo QR
    case 500: return 'logged_out'          // sessão corrompida: precisa novo QR
    case 411: return 'logged_out'          // incompatibilidade de multi-dispositivo
    case 440: return 'replaced'            // a mesma sessão foi aberta em outro lugar
    case 403: return 'forbidden'           // acesso negado pelo WhatsApp (possível bloqueio)
    case 515: return 'restart'             // o próprio WhatsApp pede reinício (ex.: após o QR)
    default: return 'reconnect'            // 408, 428, 503, rede, desconhecido
  }
}

export function closeStatusCode(lastDisconnect) {
  const e = lastDisconnect?.error
  return e?.output?.statusCode ?? e?.statusCode ?? null
}

export function isOptOutWord(text) {
  const w = String(text || '').trim().replace(/[\p{P}\s]+$/u, '').toUpperCase()
  return ['SAIR', 'PARAR', 'STOP'].includes(w)
}
