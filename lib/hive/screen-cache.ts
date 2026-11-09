// Memória das telas (desempenho, fase 2). Guarda o último resultado de cada aba
// enquanto o app está aberto: ao voltar para o Início, a Agenda ou Clientes, a
// tela aparece NA HORA com o que já tinha e atualiza por trás. Some ao recarregar
// a página e ao sair da conta (clearScreenCache). As chaves sempre incluem a
// empresa, então trocar de conta nunca mostra dados de outra.
const store = new Map<string, { at: number; value: unknown }>();
const MAX_ENTRIES = 40;

export function readScreenCache<T>(key: string): T | undefined {
  return store.get(key)?.value as T | undefined;
}

export function writeScreenCache<T>(key: string, value: T): void {
  store.delete(key);
  store.set(key, { at: Date.now(), value });
  // Mantém só as mais recentes (a Agenda guarda um item por dia, semana ou mês visto).
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value as string);
}

export function clearScreenCache(): void {
  store.clear();
}
