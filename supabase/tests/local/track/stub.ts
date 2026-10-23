export const calls: any[] = [];
export const cfg: any = { salt: "a".repeat(64) };
export function createClient(..._a: unknown[]) {
  return { rpc: async (fn: string, args: any = {}) => { calls.push([fn, args]); return fn === "analytics_daily_salt" ? { data: cfg.salt, error: null } : { data: true, error: null }; } };
}
