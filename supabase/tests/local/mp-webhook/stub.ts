export const calls: any[] = [];
export const cfg: any = { rpcError: null, createErr: null, resetErr: null };
export function createClient(..._a: unknown[]) {
  return {
    rpc: async (fn: string, args: any) => { calls.push(["rpc", fn, args]); return cfg.rpcError ? { data: null, error: { message: cfg.rpcError } } : { data: args.p_status, error: null }; },
    auth: {
      admin: { createUser: async (a: any) => { calls.push(["createUser", a]); return { data: {}, error: cfg.createErr }; } },
      resetPasswordForEmail: async (e: string, o: any) => { calls.push(["reset", e, o]); return { data: {}, error: cfg.resetErr }; },
    },
  };
}
