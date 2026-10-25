import Link from "next/link";
import { requireSuperadmin } from "@/lib/supabase/require-superadmin";
import { Card } from "@/components/ui/card";
import { StatusPill } from "@/components/admin/status-pill";
import { PeriodPicker } from "@/components/admin/period-picker";
import { ReconcileButton } from "@/components/admin/billing-actions";
import { UnlinkedSubscriptions } from "@/components/admin/unlinked-subscriptions";
import { parseUnlinked } from "@/lib/hive/admin-unlinked";
import { cn } from "@/lib/utils";
import { fmtDate, formatBRL, monthLabel, resolvePeriod } from "@/lib/hive/admin";
import {
  DEFINITIONS,
  EVENT_LABEL,
  SOURCE_LABEL,
  churnRate,
  conversionRate,
  parseFinance,
  paymentLabel,
  paymentTone,
  pct,
  startsBeforeMeasuring,
  ticketMedio,
} from "@/lib/hive/admin-finance";
import { Info } from "lucide-react";

export const dynamic = "force-dynamic";

type PayRow = { id: string; at: string; status: string; amount: number | null; refunded: number; fee: number | null; net: number | null;
  retry: number | null; company_id: string | null; company_name: string | null };
type EvRow = { at: string; status: string; source: string; company_id: string | null; company_name: string | null };

function Metric({ label, value, hint, tone }: { label: string; value: string; hint?: React.ReactNode; tone?: "muted" }) {
  return (
    <Card>
      <p className="text-sm text-ink-600">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tabular-nums", tone === "muted" ? "text-ink-500" : "text-ink-800")}>{value}</p>
      {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
    </Card>
  );
}

const money = (v: number | null | undefined) => (v === null || v === undefined ? "—" : formatBRL(Number(v)));

export default async function AdminFinanceiroPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const supabase = await requireSuperadmin();
  const sp = await searchParams;
  const period = resolvePeriod(sp.periodo, new Date(), { de: sp.de, ate: sp.ate });
  const range = { p_from: period.from.toISOString(), p_to: period.to.toISOString() };

  const [ov, pays, evs, unl] = await Promise.all([
    supabase.rpc("admin_finance_overview", range),
    supabase.rpc("admin_list_billing", { p_kind: "payments", ...range, p_limit: 20 }),
    supabase.rpc("admin_list_billing", { p_kind: "events", ...range, p_limit: 20 }),
    supabase.rpc("admin_list_unlinked"),
  ]);
  const unlinked = unl.error ? [] : (parseUnlinked(unl.data) ?? []);
  const f = ov.error ? null : parseFinance(ov.data);
  const payments = (pays.error ? null : (pays.data as { total: number; rows: PayRow[] })) ?? null;
  const events = (evs.error ? null : (evs.data as { total: number; rows: EvRow[] })) ?? null;

  if (!f) {
    return (
      <Card>
        <h1 className="text-base font-semibold text-ink-800">Não foi possível carregar o financeiro</h1>
        <p className="mt-1 text-sm text-ink-600">Recarregue a página. Se continuar, confira se a migration 0040 foi aplicada.</p>
      </Card>
    );
  }

  const ticket = ticketMedio(f);
  const conv = conversionRate(f);
  const churn = churnRate(f);
  const maxMonth = Math.max(1, ...f.revenue_by_month.map((m) => m.received));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Assinaturas e financeiro</h1>
          <p className="text-sm text-ink-500">{period.label}</p>
        </div>
        <ReconcileButton />
      </div>
      <UnlinkedSubscriptions rows={unlinked} />
      <PeriodPicker basePath="/admin/financeiro" period={period} de={sp.de} ate={sp.ate} />

      {startsBeforeMeasuring(period.from, f.measuring_since) && (
        <p className="flex items-start gap-2 rounded-lg border border-ink-200 bg-sand px-4 py-3 text-sm text-ink-700">
          <Info className="mt-0.5 size-4 shrink-0 text-ink-500" />
          A medição de cobranças começou em {fmtDate(f.measuring_since)}. Antes disso não há dados, então o começo deste período aparece zerado.
        </p>
      )}

      <section aria-label="Receita" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Recebido no período" value={money(f.received)}
                hint={`${f.approved_count} ${f.approved_count === 1 ? "cobrança aprovada" : "cobranças aprovadas"}, valor bruto (antes das taxas).`} />
        <Metric label="Líquido após taxas" value={money(f.net)}
                hint={<>Taxas: {money(f.fees)}{f.fees_unknown + f.net_unknown > 0 && <>. {Math.max(f.fees_unknown, f.net_unknown)} sem informação do Mercado Pago</>}.</>} />
        <Metric label="Ticket médio" value={ticket === null ? "—" : formatBRL(ticket)}
                hint={ticket === null ? "Nenhuma assinatura pagou no período." : `${f.paying_subscriptions} ${f.paying_subscriptions === 1 ? "assinatura pagou" : "assinaturas pagaram"}.`} />
        <Metric label="MRR contratado (hoje)" value={money(f.mrr_contracted)}
                hint={f.mrr_unknown > 0 ? `${f.mrr_unknown} ativa(s) sem valor informado.` : "Assinaturas pagas ativas, pelo valor do plano."} />
      </section>

      <section aria-label="Pendências" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Pendente" value={money(f.pending_amount)} tone="muted" hint={`${f.pending_count} agendada(s) ou em análise. Não é receita.`} />
        <Metric label="Recusado" value={money(f.rejected_amount)} tone="muted"
                hint={`${f.rejected_count} cobrança(s) recusada(s). ${f.past_due_now} assinatura(s) com pagamento atrasado hoje.`} />
        <Metric label="Reembolsos e estornos" value={money(f.refunded + f.charged_back)} tone="muted"
                hint={`Reembolsos ${money(f.refunded)}, estornos ${money(f.charged_back)}.`} />
        <Metric label="Previsão para 30 dias" value={money(f.forecast_30d)} tone="muted"
                hint={`Não é receita garantida. Mais ${f.trials_ending_30d} teste(s) terminando no período.`} />
      </section>

      <section aria-label="Conversão e cancelamentos" className="grid gap-4 sm:grid-cols-2">
        <Card>
          <p className="text-sm text-ink-600">Conversão de teste para pago</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-ink-800">{pct(conv)}</p>
          <p className="mt-1 text-xs text-ink-500">
            {f.cohort_trials === 0
              ? "Nenhuma assinatura começou em teste no período."
              : `${f.cohort_converted} de ${f.cohort_trials} que começaram em teste no período já pagaram. ${f.cohort_still_trial} ainda em teste, ${f.trial_canceled} desistiram no teste.`}
          </p>
        </Card>
        <Card>
          <p className="text-sm text-ink-600">Churn pago</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-ink-800">{pct(churn)}</p>
          <p className="mt-1 text-xs text-ink-500">
            {f.churn_base === 0
              ? "Não havia assinaturas pagas no início do período."
              : `${f.churn_canceled} de ${f.churn_base} assinaturas pagas no início do período cancelaram.`}
          </p>
        </Card>
      </section>

      <Card>
        <h2 className="text-sm font-semibold text-ink-800">Recebido por mês</h2>
        <p className="text-xs text-ink-500">12 meses até o fim do período escolhido, sem reembolsos e estornos.</p>
        <div className="mt-4 flex h-36 items-end gap-1.5 sm:gap-2.5">
          {f.revenue_by_month.map((m) => (
            <div key={m.month} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
              <span className="text-[11px] font-semibold text-ink-700">{m.received ? Math.round(m.received).toLocaleString("pt-BR") : ""}</span>
              <div className={cn("w-full rounded-t", m.received ? "bg-gold-500" : "bg-ink-100")}
                   style={{ height: `${m.received ? Math.max(6, (m.received / maxMonth) * 100) : 2}%` }} />
              <span className="text-[10px] text-ink-500">{monthLabel(m.month)}</span>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink-800">Cobranças no período {payments && `(${payments.total})`}</h2>
          {!payments ? <p className="text-sm text-ink-600">Não foi possível carregar.</p> : payments.rows.length === 0 ? (
            <p className="text-sm text-ink-600">Nenhuma cobrança no período.</p>
          ) : (
            <ul className="divide-y divide-ink-100">
              {payments.rows.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div className="min-w-0">
                    {p.company_id ? (
                      <Link href={`/admin/profissionais/${p.company_id}`} className="font-medium text-ink-800 hover:underline">{p.company_name}</Link>
                    ) : <span className="font-medium text-ink-700">Sem conta vinculada</span>}
                    <p className="text-xs text-ink-500">
                      {fmtDate(p.at, true)}
                      {p.refunded > 0 && `, reembolso ${money(p.refunded)}`}
                      {p.retry ? `, tentativa ${p.retry}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="tabular-nums text-ink-800">{money(p.amount)}</span>
                    <StatusPill tone={paymentTone(p.status)}>{paymentLabel(p.status)}</StatusPill>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink-800">Mudanças de situação {events && `(${events.total})`}</h2>
          {!events ? <p className="text-sm text-ink-600">Não foi possível carregar.</p> : events.rows.length === 0 ? (
            <p className="text-sm text-ink-600">Nenhuma mudança no período.</p>
          ) : (
            <ul className="divide-y divide-ink-100">
              {events.rows.map((e, i) => (
                <li key={i} className="py-2.5 text-sm">
                  <p className="text-ink-800">
                    {e.company_id ? <Link href={`/admin/profissionais/${e.company_id}`} className="font-medium hover:underline">{e.company_name}</Link> : "Sem conta vinculada"}
                    : {EVENT_LABEL[e.status] ?? e.status}
                  </p>
                  <p className="text-xs text-ink-500">{fmtDate(e.at, true)}, por {SOURCE_LABEL[e.source] ?? e.source}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <details className="rounded-lg border border-ink-100 bg-surface px-4 py-3">
        <summary className="cursor-pointer text-sm font-semibold text-ink-800">Como cada número é calculado</summary>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          {DEFINITIONS.map(([t, d]) => (
            <div key={t}>
              <dt className="font-medium text-ink-800">{t}</dt>
              <dd className="text-ink-600">{d}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
