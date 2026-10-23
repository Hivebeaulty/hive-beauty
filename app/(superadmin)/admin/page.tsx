import Link from "next/link";
import { requireSuperadmin } from "@/lib/supabase/require-superadmin";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { PeriodPicker } from "@/components/admin/period-picker";
import {
  BILLING_LABEL,
  BILLING_ORDER,
  PLAN_PRICE,
  formatBRL,
  monthLabel,
  pctChange,
  resolvePeriod,
  type BillingStatus,
} from "@/lib/hive/admin";

export const dynamic = "force-dynamic";

// Cores da composição da base: as do próprio app (pagante = verde de sucesso,
// teste = dourado, cortesia = vinho), do mais valioso para o que precisa de ação.
const SEGMENT: Record<BillingStatus, string> = {
  active: "bg-success",
  trialing: "bg-gold-500",
  free: "bg-wine-500",
  past_due: "bg-warning",
  pending: "bg-ink-400",
  canceled: "bg-ink-500",
  none: "bg-danger/70",
};

type Overview = {
  total: number;
  demo: number;
  suspended: number;
  by_status: Partial<Record<BillingStatus, number>>;
  trials_ending_3d: number;
  new_in_period: number;
  new_prev_period: number;
  mrr_estimated: number;
  signups_by_month: { month: string; count: number }[];
  billing_since: string | null;
};

export default async function AdminHomePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const supabase = await requireSuperadmin();
  const sp = await searchParams;
  const period = resolvePeriod(sp.periodo, new Date(), { de: sp.de, ate: sp.ate });

  const { data, error } = await supabase.rpc("admin_overview", {
    p_from: period.from.toISOString(),
    p_to: period.to.toISOString(),
    p_plan_price: PLAN_PRICE,
  });
  const ov = (error ? null : data) as Overview | null;

  if (!ov) {
    return (
      <Card>
        <h1 className="text-base font-semibold text-ink-800">Não foi possível carregar a visão geral</h1>
        <p className="mt-1 text-sm text-ink-500">
          Recarregue a página. Se continuar, confira se a migration 0038 foi aplicada no Supabase.
        </p>
      </Card>
    );
  }

  const n = (s: BillingStatus) => ov.by_status[s] ?? 0;
  const change = pctChange(ov.new_in_period, ov.new_prev_period);
  const maxMonth = Math.max(1, ...ov.signups_by_month.map((m) => m.count));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Visão geral</h1>
          <p className="text-sm text-ink-500">{period.label}</p>
        </div>
        <PeriodPicker basePath="/admin" period={period} de={sp.de} ate={sp.ate} />
      </div>

      {/* A base hoje: o que mais importa, numa leitura só */}
      <Card className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-ink-800">
            <span className="font-serif text-4xl">{ov.total}</span>{" "}
            <span className="text-sm text-ink-500">{ov.total === 1 ? "profissional na Áurea" : "profissionais na Áurea"} hoje</span>
          </p>
          <p className="text-xs text-ink-500">
            {ov.demo > 0 && `${ov.demo} de demonstração fora da conta. `}
            {ov.suspended > 0 && `${ov.suspended} com acesso suspenso.`}
          </p>
        </div>
        {ov.total > 0 && (
          <div
            className="flex h-3 overflow-hidden rounded-full bg-ink-50"
            role="img"
            aria-label={BILLING_ORDER.filter((s) => n(s)).map((s) => `${BILLING_LABEL[s]}: ${n(s)}`).join(", ")}
          >
            {BILLING_ORDER.filter((s) => n(s) > 0).map((s) => (
              <div key={s} className={SEGMENT[s]} style={{ width: `${(n(s) / ov.total) * 100}%` }} />
            ))}
          </div>
        )}
        <ul className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4 lg:grid-cols-7">
          {BILLING_ORDER.map((s) => (
            <li key={s}>
              <Link href={`/admin/profissionais?assinatura=${s}`} className="group block">
                <span className="flex items-center gap-1.5 text-xs text-ink-500 group-hover:text-ink-800">
                  <span className={cn("size-2 rounded-full", SEGMENT[s])} />
                  {BILLING_LABEL[s]}
                </span>
                <span className="text-lg font-semibold text-ink-800">{n(s)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <p className="text-sm text-ink-500">Receita recorrente mensal (estimada)</p>
          <p className="mt-1 text-2xl font-semibold text-ink-800">{formatBRL(ov.mrr_estimated)}</p>
          <p className="mt-1 text-xs text-ink-500">
            {n("active")} {n("active") === 1 ? "assinatura paga ativa" : "assinaturas pagas ativas"} × {formatBRL(PLAN_PRICE)}. Teste,
            cortesia e atrasadas não entram.
          </p>
        </Card>
        <Card>
          <p className="text-sm text-ink-500">Novas profissionais no período</p>
          <p className="mt-1 text-2xl font-semibold text-ink-800">{ov.new_in_period}</p>
          <p className="mt-1 text-xs text-ink-500">
            {change === null
              ? `Período anterior: ${ov.new_prev_period}.`
              : `${change > 0 ? "+" : ""}${change}% em relação ao período anterior (${ov.new_prev_period}).`}
          </p>
        </Card>
        <Card>
          <p className="text-sm text-ink-500">Testes terminando em até 3 dias</p>
          <p className="mt-1 text-2xl font-semibold text-ink-800">{ov.trials_ending_3d}</p>
          <p className="mt-1 text-xs text-ink-500">
            <Link href="/admin/profissionais?assinatura=trialing" className="underline hover:text-ink-700">
              Ver as {n("trialing")} em teste
            </Link>
          </p>
        </Card>
      </div>

      <Card>
        <h2 className="text-sm font-semibold text-ink-700">Cadastros por mês</h2>
        <p className="text-xs text-ink-500">Últimos 12 meses, sem contas de demonstração.</p>
        <div className="mt-4 flex h-36 items-end gap-1.5 sm:gap-2.5">
          {ov.signups_by_month.map((m) => (
            <div key={m.month} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
              <span className="text-[11px] font-semibold text-ink-600">{m.count || ""}</span>
              <div
                className={cn("w-full rounded-t", m.count ? "bg-gold-500" : "bg-ink-100")}
                style={{ height: `${m.count ? Math.max(6, (m.count / maxMonth) * 100) : 2}%` }}
              />
              <span className="text-[10px] text-ink-500">{monthLabel(m.month)}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-700">Ainda sem dados suficientes</h2>
          <p className="text-xs text-ink-500">
            Estes números não aparecem estimados para não mostrar valores inventados. Cada um passa a ser medido na fase indicada.
          </p>
        </div>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          {[
            [
              "Receita recebida, pendências, reembolsos e taxas",
              "Os pagamentos do Mercado Pago ainda não são gravados um a um; hoje só a situação de cada assinatura. Fase 3.",
            ],
            ["Ticket médio por pagante", "Depende da receita recebida. Fase 3."],
            [
              "Conversão de teste para pago e churn",
              "Exigem o histórico de mudanças de situação de cada assinatura, que ainda não é guardado. Fase 3.",
            ],
            [
              "Visitas à landing e funil até a assinatura",
              "A landing (Lovable) ainda não envia eventos. A medição começa quando a instrumentação for instalada. Fase 4.",
            ],
          ].map(([t, d]) => (
            <div key={t} className="rounded-md bg-ink-50/70 px-3 py-2.5">
              <dt className="font-medium text-ink-700">{t}</dt>
              <dd className="mt-0.5 text-xs text-ink-500">{d}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}
