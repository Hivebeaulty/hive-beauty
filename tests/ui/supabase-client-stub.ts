// Substitui @/lib/supabase/client no palco de testes. O painel W3 recebe a API
// simulada por propriedade e nunca deve chamar o Supabase. Componentes que usam
// o cliente direto (W5) só funcionam quando o TESTE instala window.__rpc; sem
// isso, qualquer uso continua sendo erro (nunca há Supabase de verdade aqui).
type Rpc = (fn: string, args: unknown) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
export function createClient() {
  const rpc = (window as unknown as { __rpc?: Rpc }).__rpc;
  if (!rpc) throw new Error("Supabase real não deve ser usado no palco de testes");
  return { rpc };
}
