// Provedor real: Baileys (WhatsApp Web, multi-dispositivo).
import makeWASocket, {
  Browsers, BufferJSON, initAuthCreds, jidDecode, jidNormalizedUser, makeCacheableSignalKeyStore, proto,
} from 'baileys'
import { isIgnorableJid } from '../wa-utils.js'

export const baileysUtils = { initAuthCreds, BufferJSON, proto }

// Nunca pedir ao celular principal uma cópia de mensagem que o worker não conseguiu ler
// ("placeholder resend", um pedido de dados ao celular). Cada pedido desses faz o
// WhatsApp Business mostrar "A sincronização ... foi concluída" no celular da profissional.
// O Baileys consulta este cache antes de pedir: respondendo "já pedido", o pedido não sai.
// A profissional continua vendo a mensagem normalmente no celular.
export const NO_PHONE_RESEND = Object.freeze({
  get: async () => true,
  set: async () => true,
  del: async () => true,
})

// Grupos, listas de transmissão, status e canais: o worker já descartava essas mensagens
// (isIgnorableJid). Com o filtro aqui, o Baileys nem tenta decifrá-las: sem falha de
// decifração, sem pedido de nova tentativa e sem chaves de grupo guardadas à toa.
// Desligável por WA_IGNORE_GROUPS=false.
export function socketOptions({ auth, logger, ignoreGroups = true }) {
  return {
    auth: { creds: auth.state.creds, keys: makeCacheableSignalKeyStore(auth.state.keys, logger) },
    logger,
    browser: Browsers.ubuntu('Áurea'),       // não mudar: é o nome do aparelho conectado no celular
    syncFullHistory: false,
    shouldSyncHistoryMessage: ({ syncType }) => syncType !== proto.HistorySync.HistorySyncType.FULL, // padrão do Baileys: sem histórico completo, mas recebe o mapa LID↔telefone (o worker só grava mensagens novas)
    shouldIgnoreJid: ignoreGroups ? (jid) => isIgnorableJid(jid) : () => false,
    placeholderResendCache: NO_PHONE_RESEND,
    markOnlineOnConnect: false,              // não marca "online" no celular da profissional
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,       // não guardamos mensagens em memória
    connectTimeoutMs: 20000,
    keepAliveIntervalMs: 25000,
  }
}

export function createSocket({ auth, logger, ignoreGroups = true }) {
  return makeWASocket(socketOptions({ auth, logger, ignoreGroups }))
}

export function selfIdentity(sock) {
  const id = sock?.user?.id
  if (!id) return { phone: null, jid: null }
  return { phone: jidDecode(id)?.user ?? null, jid: jidNormalizedUser(id) }
}
