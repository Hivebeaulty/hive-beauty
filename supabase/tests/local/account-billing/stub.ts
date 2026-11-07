// Stub do supabase-js: separa o cliente da SESSÃO (com Authorization) do da service role.
export const calls: any[] = [];
export const cfg: any = { user: {}, service: {} };
export function createClient(_url: string, _key: string, opts: any = {}) {
  const who = opts?.global?.headers?.Authorization ? "user" : "service";
  return {
    rpc: async (fn: string, args: any = {}) => {
      calls.push([who, fn, args]);
      const r = cfg[who][fn];
      if (typeof r === "function") return r(args);
      return r ?? { data: { status: args?.p?.status ?? null }, error: null };
    },
  };
}
