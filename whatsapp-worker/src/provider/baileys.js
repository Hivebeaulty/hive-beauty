// Provedor real: Baileys (WhatsApp Web, multi-dispositivo).
import makeWASocket, {
  Browsers, BufferJSON, initAuthCreds, jidDecode, jidNormalizedUser, makeCacheableSignalKeyStore, proto,
} from 'baileys'

export const baileysUtils = { initAuthCreds, BufferJSON, proto }

export function createSocket({ auth, logger }) {
  return makeWASocket({
    auth: { creds: auth.state.creds, keys: makeCacheableSignalKeyStore(auth.state.keys, logger) },
    logger,
    browser: Browsers.ubuntu('Áurea'),
    syncFullHistory: false,
    shouldSyncHistoryMessage: ({ syncType }) => syncType !== proto.HistorySync.HistorySyncType.FULL, // padrão do Baileys: sem histórico completo, mas recebe o mapa LID↔telefone (o worker só grava mensagens novas)
    markOnlineOnConnect: false,              // não marca "online" no celular da profissional
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,       // não guardamos mensagens em memória
    connectTimeoutMs: 20000,
    keepAliveIntervalMs: 25000,
  })
}

export function selfIdentity(sock) {
  const id = sock?.user?.id
  if (!id) return { phone: null, jid: null }
  return { phone: jidDecode(id)?.user ?? null, jid: jidNormalizedUser(id) }
}
