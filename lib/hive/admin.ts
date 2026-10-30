// ---------------------------------------------------------------------------
// SuperAdmin (0038) — regras PURAS das telas. Nada aqui é segurança: quem pode
// ver e fazer é decidido pelo BANCO (admin_assert: superadmin + MFA aal2).
// Isto só interpreta respostas, monta períodos e filtros e gera CSV.
// ---------------------------------------------------------------------------
import type { BadgeTone } from "@/components/ui/badge";

/** Preço do plano mensal (oferta atual). Usado só no MRR ESTIMADO. */
export const PLAN_PRICE = 59.9;
export const PAGE_SIZE = 25;
const TZ = "America/Sao_Paulo";
// O Brasil não tem horário de verão desde 2019: Brasília é sempre UTC-3.
const TZ_OFFSET = "-03:00";

export type BillingStatus = "active" | "trialing" | "free" | "past_due" | "pending" | "canceled" | "none";
export const BILLING_ORDER: BillingStatus[] = ["active", "trialing", "free", "past_due", "pending", "canceled", "none"];
export const BILLING_LABEL: Record<BillingStatus, string> = {
  active: "Pagante",
  trialing: "Em teste",
  free: "Cortesia",
  past_due: "Pagamento atrasado",
  pending: "Pagamento em análise",
  canceled: "Cancelada",
  none: "Sem assinatura",
};
export const BILLING_TONE: Record<BillingStatus, BadgeTone> = {
  active: "success",
  trialing: "gold",
  free: "wine",
  past_due: "warning",
  pending: "neutral",
  canceled: "muted",
  none: "danger",
};
export const isBillingStatus = (v: unknown): v is BillingStatus => BILLING_ORDER.includes(v as BillingStatus);

// --- quem sou eu (admin_whoami) — falha FECHADA ----------------------------------
export function parseWhoami(data: unknown): { isSuperadmin: boolean; mfaOk: boolean } {
  if (!data || typeof data !== "object") return { isSuperadmin: false, mfaOk: false };
  const d = data as Record<string, unknown>;
  const isSuperadmin = d.is_superadmin === true;
  return { isSuperadmin, mfaOk: isSuperadmin && d.mfa_ok === true };
}

// --- períodos -----------------------------------------------------------------------
export type PeriodKey = "hoje" | "7d" | "30d" | "mes" | "mes_anterior" | "90d" | "ano" | "custom";
export const PERIOD_OPTIONS: { key: Exclude<PeriodKey, "custom">; label: string }[] = [
  { key: "hoje", label: "Hoje" },
  { key: "7d", label: "7 dias" },
  { key: "30d", label: "30 dias" },
  { key: "mes", label: "Este mês" },
  { key: "mes_anterior", label: "Mês passado" },
  { key: "90d", label: "90 dias" },
  { key: "ano", label: "Este ano" },
];
export type Period = { key: PeriodKey; from: Date; to: Date; label: string };

/** "2026-10-22" no fuso do negócio. */
export function businessYmd(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
const startOfDay = (ymd: string) => new Date(`${ymd}T00:00:00${TZ_OFFSET}`);
const isYmd = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(startOfDay(v).getTime());
const addDays = (ymd: string, n: number) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const fmtYmd = (ymd: string) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;

export function resolvePeriod(key: string | undefined, now: Date = new Date(), custom?: { de?: string; ate?: string }): Period {
  const today = businessYmd(now);
  const [y, m] = today.split("-").map(Number);
  const firstOfMonth = `${y}-${String(m).padStart(2, "0")}-01`;
  const days = (n: number, label: string): Period => ({ key: key as PeriodKey, from: new Date(now.getTime() - n * 86400000), to: now, label });
  switch (key) {
    case "hoje":
      return { key, from: startOfDay(today), to: now, label: "Hoje" };
    case "7d":
      return days(7, "Últimos 7 dias");
    case "90d":
      return days(90, "Últimos 90 dias");
    case "mes":
      return { key, from: startOfDay(firstOfMonth), to: now, label: "Este mês" };
    case "mes_anterior": {
      const prev = m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
      return { key, from: startOfDay(prev), to: startOfDay(firstOfMonth), label: "Mês passado" };
    }
    case "ano":
      return { key, from: startOfDay(`${y}-01-01`), to: now, label: "Este ano" };
    case "custom": {
      const { de, ate } = custom ?? {};
      if (isYmd(de) && isYmd(ate) && de <= ate && startOfDay(ate).getTime() - startOfDay(de).getTime() <= 3 * 366 * 86400000) {
        return { key, from: startOfDay(de), to: startOfDay(addDays(ate, 1)), label: `${fmtYmd(de)} a ${fmtYmd(ate)}` };
      }
      return { ...days(30, "Últimos 30 dias"), key: "30d" };
    }
    default:
      return { ...days(30, "Últimos 30 dias"), key: "30d" };
  }
}

/** Variação % entre períodos; null quando o anterior é zero (não há base para comparar). */
export function pctChange(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 100);
}

// --- filtros da lista de profissionais (página e exportação usam os MESMOS) --------
export type AccountFilters = {
  q: string;
  assinatura: BillingStatus | "";
  situacao: "ativas" | "suspensas" | "";
  de: string;
  ate: string;
  ordem: "created_desc" | "created_asc" | "activity_desc" | "name_asc";
  pagina: number;
  demo: boolean;
};
export const ORDER_OPTIONS: { key: AccountFilters["ordem"]; label: string }[] = [
  { key: "created_desc", label: "Cadastro mais recente" },
  { key: "created_asc", label: "Cadastro mais antigo" },
  { key: "activity_desc", label: "Atividade mais recente" },
  { key: "name_asc", label: "Nome do negócio (A–Z)" },
];

type Params = Record<string, string | string[] | undefined>;
const one = (p: Params, k: string) => {
  const v = p[k];
  return (Array.isArray(v) ? v[0] : v) ?? "";
};

export function parseAccountFilters(p: Params): AccountFilters {
  const assinatura = one(p, "assinatura");
  const situacao = one(p, "situacao");
  const ordem = one(p, "ordem");
  const pagina = Number.parseInt(one(p, "pagina"), 10);
  return {
    q: one(p, "q").trim().slice(0, 100),
    assinatura: isBillingStatus(assinatura) ? assinatura : "",
    situacao: situacao === "ativas" || situacao === "suspensas" ? situacao : "",
    de: isYmd(one(p, "de")) ? one(p, "de") : "",
    ate: isYmd(one(p, "ate")) ? one(p, "ate") : "",
    ordem: ORDER_OPTIONS.some((o) => o.key === ordem) ? (ordem as AccountFilters["ordem"]) : "created_desc",
    pagina: Number.isFinite(pagina) && pagina >= 1 ? Math.min(pagina, 10000) : 1,
    demo: one(p, "demo") === "1",
  };
}

/** Argumentos de admin_list_accounts / admin_export_accounts (datas no fuso do negócio). */
export function accountFiltersToRpc(f: AccountFilters) {
  return {
    p_search: f.q || null,
    p_billing: f.assinatura || null,
    p_suspended: f.situacao === "suspensas" ? true : f.situacao === "ativas" ? false : null,
    p_from: f.de ? startOfDay(f.de).toISOString() : null,
    p_to: f.ate ? startOfDay(addDays(f.ate, 1)).toISOString() : null,
    p_include_demo: f.demo,
  };
}

/** Query string dos filtros (para paginação e exportação), sem os vazios. */
export function accountFiltersQuery(f: AccountFilters, overrides: Partial<AccountFilters> = {}): string {
  const g = { ...f, ...overrides };
  const qs = new URLSearchParams();
  if (g.q) qs.set("q", g.q);
  if (g.assinatura) qs.set("assinatura", g.assinatura);
  if (g.situacao) qs.set("situacao", g.situacao);
  if (g.de) qs.set("de", g.de);
  if (g.ate) qs.set("ate", g.ate);
  if (g.ordem !== "created_desc") qs.set("ordem", g.ordem);
  if (g.pagina > 1) qs.set("pagina", String(g.pagina));
  if (g.demo) qs.set("demo", "1");
  const s = qs.toString();
  return s ? `?${s}` : "";
}

// --- linhas da conta (admin_accounts_base) -----------------------------------------
export type AccountRow = {
  company_id: string;
  company_name: string;
  is_demo: boolean;
  created_at: string;
  owner_name: string | null;
  owner_email: string | null;
  owner_last_sign_in: string | null;
  billing_status: BillingStatus;
  billing_provider: string | null;
  next_payment_at: string | null;
  suspended: boolean;
  appointments_count: number;
  clients_count: number;
  services_count: number;
  last_activity_at: string | null;
  whatsapp_status: string | null;
};

export function parseAccountList(data: unknown): { total: number; rows: AccountRow[] } | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { total?: unknown; rows?: unknown };
  if (typeof d.total !== "number" || !Array.isArray(d.rows)) return null;
  const rows = d.rows
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && typeof (r as { company_id?: unknown }).company_id === "string")
    .map((r) => ({
      ...(r as unknown as AccountRow),
      billing_status: isBillingStatus(r.billing_status) ? r.billing_status : "none",
      suspended: r.suspended === true,
      appointments_count: Number(r.appointments_count) || 0,
      clients_count: Number(r.clients_count) || 0,
      services_count: Number(r.services_count) || 0,
    }));
  return { total: d.total, rows };
}

// --- datas para exibição (fuso do negócio) -------------------------------------------
export function fmtDate(iso: string | null | undefined, withTime = false): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("pt-BR", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
/** "2026-10" -> "out/26" */
export function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return MONTHS[m - 1] ? `${MONTHS[m - 1]}/${String(y).slice(2)}` : ym;
}
export function formatBRL(v: number): string {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

// --- ativação: configurou o básico para usar a Sócia? -------------------------------
export function activationSteps(u: { services: number; clients: number; appointments_total: number }) {
  return [
    { key: "services", label: "Cadastrou serviços", done: u.services > 0 },
    { key: "clients", label: "Cadastrou clientes", done: u.clients > 0 },
    { key: "appointments", label: "Criou o primeiro atendimento", done: u.appointments_total > 0 },
  ];
}

// --- auditoria ------------------------------------------------------------------------
export const AUDIT_ACTION_LABEL: Record<string, string> = {
  view_account: "Abriu a ficha",
  suspend: "Suspendeu o acesso",
  reactivate: "Reativou o acesso",
  add_note: "Registrou uma observação",
  export_accounts: "Exportou a lista de profissionais",
  cancel_subscription: "Cancelamento de assinatura no Mercado Pago",
  reconcile: "Conferiu as cobranças com o Mercado Pago",
};
export const auditLabel = (action: string, result?: string) =>
  `${AUDIT_ACTION_LABEL[action] ?? action}${
    result === "noop" ? " (já estava assim)" : result === "error" ? " (falhou)" : result === "requested" ? " (pedido)" : ""}`;

// --- CSV ------------------------------------------------------------------------------
// Ponto e vírgula + BOM: abre direto no Excel em português com acentos certos.
// Células que começam com = + - @ (ou tab/CR) ganham um apóstrofo: evita que o
// Excel execute uma "fórmula" vinda de um nome de negócio (injeção de CSV).
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(headers: string[], rows: unknown[][]): string {
  return "\uFEFF" + [headers, ...rows].map((r) => r.map(csvCell).join(";")).join("\r\n") + "\r\n";
}
export function accountsCsv(rows: AccountRow[]): string {
  return toCsv(
    ["Negócio", "Responsável", "E-mail", "Cadastro", "Último acesso", "Assinatura", "Próxima cobrança", "Suspensa",
     "Atendimentos", "Clientes ativas", "Serviços ativos", "Última atividade", "WhatsApp"],
    rows.map((r) => [
      r.company_name, r.owner_name ?? "", r.owner_email ?? "", fmtDate(r.created_at), fmtDate(r.owner_last_sign_in, true),
      BILLING_LABEL[r.billing_status], fmtDate(r.next_payment_at), r.suspended ? "sim" : "não",
      r.appointments_count, r.clients_count, r.services_count, fmtDate(r.last_activity_at, true), r.whatsapp_status ?? "",
    ])
  );
}
