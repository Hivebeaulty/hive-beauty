// Stub do supabase-js para a trial-signup: registra as chamadas e responde o que o teste mandar.
export const calls: [string, unknown][] = [];
// deno-lint-ignore no-explicit-any
type R = { data: any; error: any };
export const cfg: { rpc: Record<string, R>; createUser: R } = {
  rpc: {}, createUser: { data: { user: { id: "u1" } }, error: null },
};
export function createClient(_url: string, _key: string, _o?: unknown) {
  return {
    rpc: async (fn: string, args: unknown): Promise<R> => { calls.push([fn, args]); return cfg.rpc[fn] ?? { data: null, error: null }; },
    auth: { admin: { createUser: async (args: unknown): Promise<R> => { calls.push(["createUser", args]); return cfg.createUser; } } },
  };
}
