import { requireSuperadmin } from "@/lib/supabase/require-superadmin";
import { Card } from "@/components/ui/card";
import { PeriodPicker } from "@/components/admin/period-picker";
import { cn } from "@/lib/utils";
import { fmtDate, resolvePeriod } from "@/lib/hive/admin";
import { pct } from "@/lib/hive/admin-finance";
import { CTA_LABEL, DEVICE_LABEL, funnelSteps, originLabel, parseFunnel } from "@/lib/hive/admin-funnel";
import { Info } from "lucide-react";

export const dynamic = "force-dynamic";

function Bar({ value, max }: { value: number; max: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-ink-100">
      <div className="h-full rounded-full bg-gold-500" style={{ width: `${max > 0 ? Math.max(2, (value / max) * 100) : 0}%` }} />
    </div>
  );
}

export default async function AdminAquisicaoPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const supabase = await requireSuperadmin();
  const sp = await searchParams;
  const period = resolvePeriod(sp.periodo, new Date(), { de: sp.de, ate: sp.ate });
  const { data, error } = await supabase.rpc("admin_funnel", { p_from: period.from.toISOString(), p_to: period.to.toISOString() });
  const f = error ? null : parseFunnel(data);

  if (!f) {
    return (
      <Card>
        <h1 className="text-base font-semibold text-ink-800">Não foi possível carregar a aquisição</h1>
        <p className="mt-1 text-sm text-ink-600">Recarregue a página. Se continuar, confira se a migration 0041 foi aplicada.</p>
      </Card>
    );
  }

  const steps = funnelSteps(f);
  const maxStep = Math.max(1, ...steps.map((s) => s.value));
  const maxOrigin = Math.max(1, ...f.by_origin.map((o) => o.visitors));
  const deviceTotal = Object.values(f.by_device).reduce((a, b) => a + b, 0);
  const maxDay = Math.max(1, ...f.by_day.map((d) => d.visitors));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Aquisição</h1>
        <p className="text-sm text-ink-500">{period.label}</p>
      </div>
      <PeriodPicker basePath="/admin/aquisicao" period={period} de={sp.de} ate={sp.ate} />

      <p className="flex items-start gap-2 rounded-lg border border-ink-200 bg-sand px-4 py-3 text-sm text-ink-700">
        <Info className="mt-0.5 size-4 shrink-0 text-ink-500" />
        <span>
          {f.measuring_since ? `Medição do site desde ${fmtDate(f.measuring_since)}.` : "A medição do site ainda não recebeu nenhuma visita."}{" "}
          Sem cookies e sem dados pessoais. O funil compara totais do período: como o link de assinatura é o mesmo para todas, não dá
          para saber qual visita virou qual assinatura, e a origem fica medida até o clique.
        </span>
      </p>

      <Card>
        <h2 className="text-sm font-semibold text-ink-800">Funil do período</h2>
        <ol className="mt-4 space-y-4">
          {steps.map((s) => (
            <li key={s.key}>
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="font-medium text-ink-800">{s.label}</span>
                <span className="text-ink-600">
                  <span className="text-lg font-semibold tabular-nums text-ink-800">{s.value}</span>
                  {s.rate !== null && <span className="ml-2 text-xs">({pct(s.rate)} da etapa anterior)</span>}
                </span>
              </div>
              <div className="mt-1.5"><Bar value={s.value} max={maxStep} /></div>
              <p className="mt-1 text-xs text-ink-500">Fonte: {s.source}</p>
            </li>
          ))}
        </ol>
        <p className="mt-4 text-xs text-ink-500">
          Hoje: {f.paying_now} {f.paying_now === 1 ? "assinatura paga ativa" : "assinaturas pagas ativas"}. Visitas também contam quem
          volta em outro dia. Recarregar a página no mesmo dia não conta de novo.
        </p>
      </Card>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card><p className="text-sm text-ink-600">Visualizações de página</p><p className="mt-1 text-2xl font-semibold tabular-nums text-ink-800">{f.pageviews}</p></Card>
        <Card><p className="text-sm text-ink-600">Cliques no WhatsApp</p><p className="mt-1 text-2xl font-semibold tabular-nums text-ink-800">{f.whatsapp_clicks}</p></Card>
        <Card><p className="text-sm text-ink-600">Cliques em &quot;Já sou cliente&quot;</p><p className="mt-1 text-2xl font-semibold tabular-nums text-ink-800">{f.login_clicks}</p></Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink-800">De onde vêm as visitantes</h2>
          {f.by_origin.length === 0 ? <p className="text-sm text-ink-600">Nenhuma visita no período.</p> : (
            <ul className="space-y-3">
              {f.by_origin.slice(0, 10).map((o) => (
                <li key={o.origin} className="text-sm">
                  <div className="flex justify-between gap-3">
                    <span className="truncate text-ink-800">{originLabel(o.origin)}</span>
                    <span className="shrink-0 tabular-nums text-ink-600">
                      {o.visitors} {o.visitors === 1 ? "visitante" : "visitantes"}, {o.clickers} {o.clickers === 1 ? "clicou" : "clicaram"}
                    </span>
                  </div>
                  <div className="mt-1"><Bar value={o.visitors} max={maxOrigin} /></div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="space-y-5">
          <div>
            <h2 className="mb-2 text-sm font-semibold text-ink-800">Aparelho</h2>
            {deviceTotal === 0 ? <p className="text-sm text-ink-600">Sem dados.</p> : (
              <ul className="space-y-1 text-sm">
                {Object.entries(f.by_device).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                  <li key={k} className="flex justify-between"><span className="text-ink-800">{DEVICE_LABEL[k] ?? k}</span>
                    <span className="tabular-nums text-ink-600">{v} ({pct(v / deviceTotal)})</span></li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h2 className="mb-2 text-sm font-semibold text-ink-800">Botão mais clicado</h2>
            {Object.keys(f.by_cta).length === 0 ? <p className="text-sm text-ink-600">Nenhum clique no período.</p> : (
              <ul className="space-y-1 text-sm">
                {Object.entries(f.by_cta).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                  <li key={k} className="flex justify-between"><span className="text-ink-800">{CTA_LABEL[k] ?? k}</span>
                    <span className="tabular-nums text-ink-600">{v}</span></li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>

      {f.by_campaign.length > 0 && (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink-800">Campanhas (UTM)</h2>
          <ul className="divide-y divide-ink-100 text-sm">
            {f.by_campaign.map((c) => (
              <li key={`${c.campaign}-${c.source}`} className="flex justify-between gap-3 py-2">
                <span className="text-ink-800">{c.campaign}{c.source && <span className="text-ink-500">, {originLabel(c.source)}</span>}</span>
                <span className="shrink-0 tabular-nums text-ink-600">{c.visitors} visitantes, {c.clickers} clicaram</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {f.by_day.length > 1 && (
        <Card>
          <h2 className="text-sm font-semibold text-ink-800">Visitantes por dia</h2>
          <div className="mt-4 flex h-28 items-end gap-1">
            {f.by_day.map((d) => (
              <div key={d.day} className="flex h-full flex-1 flex-col justify-end" title={`${fmtDate(`${d.day}T12:00:00Z`)}: ${d.visitors} visitantes, ${d.clickers} clicaram`}>
                <div className={cn("w-full rounded-t", d.visitors ? "bg-gold-500" : "bg-ink-100")}
                     style={{ height: `${d.visitors ? Math.max(4, (d.visitors / maxDay) * 100) : 2}%` }} />
              </div>
            ))}
          </div>
          <p className="mt-2 flex justify-between text-[11px] text-ink-500">
            <span>{fmtDate(`${f.by_day[0].day}T12:00:00Z`)}</span><span>{fmtDate(`${f.by_day[f.by_day.length - 1].day}T12:00:00Z`)}</span>
          </p>
        </Card>
      )}
    </div>
  );
}
