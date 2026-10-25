export const calls: any[] = [];
export const cfgStub: any = { secretOk: true, targets: { welcome: [], trial_ending: [] }, claim: (args: any) => 100 + calls.filter((c) => c[0] === "billing_email_claim").length };
export function createClient(..._a: unknown[]) {
  return { rpc: async (fn: string, args: any = {}): Promise<{ data: any; error: any }> => {
    calls.push([fn, args]);
    if (fn === "billing_emails_secret_ok") return { data: cfgStub.secretOk, error: null };
    if (fn === "billing_email_targets") return { data: cfgStub.targets, error: null };
    if (fn === "billing_email_claim") return { data: cfgStub.claim(args), error: null };
    return { data: null, error: null };
  } };
}
