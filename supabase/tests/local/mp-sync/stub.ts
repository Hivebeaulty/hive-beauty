export const calls: any[] = [];
export const st: any = { secretOk: true, known: [], createErr: null, cands: [], links: [], knownEmails: [] };
export function createClient(..._a: unknown[]) {
  return {
    rpc: async (fn: string, args: any = {}): Promise<{ data: any; error: any }> => {
      calls.push([fn, args]);
      if (fn === "mp_sync_secret_ok") return { data: st.secretOk, error: null };
      if (fn === "mp_sync_known") return { data: st.known, error: null };
      if (fn === "mp_sync_candidates") return { data: st.cands, error: null };
      if (fn === "mp_manual_links") return { data: st.links, error: null };
      if (fn === "mp_sync_known_emails") return { data: st.knownEmails, error: null };
      return { data: { status: "trialing" }, error: null };
    },
    auth: {
      admin: { createUser: async (a: any): Promise<{ error: any }> => { calls.push(["createUser", a]); return { error: st.createErr }; } },
      resetPasswordForEmail: async (e: string, o: any): Promise<{ error: any }> => { calls.push(["reset", e, o]); return { error: null }; },
    },
  };
}
