// Espera crescente entre tentativas de reconexão: 2s, 4s, 8s... até 60s, com ±20% de variação.
export function nextDelayMs(attempt, { baseMs = 2000, maxMs = 60000, jitter = 0.2, random = Math.random } = {}) {
  const a = Math.max(0, Math.floor(attempt))
  const raw = Math.min(maxMs, baseMs * 2 ** a)
  const spread = raw * jitter
  return Math.max(0, Math.round(raw - spread + random() * 2 * spread))
}
