export const calls: any[] = [];
export const st: any = { error: null };
export function createClient(..._a: unknown[]) {
  return { rpc: async (fn: string, args: any = {}): Promise<{ data: any; error: any }> => { calls.push([fn, args]); return { data: st.error ? null : true, error: st.error }; } };
}
