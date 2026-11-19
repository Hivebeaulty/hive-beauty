import { requireSuperadmin } from "@/lib/supabase/require-superadmin";
import { Card } from "@/components/ui/card";
import { StatusPill } from "@/components/admin/status-pill";
import { CourtesyRowActions, NewCourtesy } from "@/components/admin/courtesy-actions";
import {
  ORIGIN_LABEL, SITUATION_LABEL, SITUATION_TONE, convertedToPaying, daysLeft, formatDay, parseCourtesies, type Courtesy,
} from "@/lib/hive/courtesy";
import { fmtDate } from "@/lib/hive/admin";

export const dynamic = "force-dynamic";

// Cortesias com prazo (0054): só a dona oferece, aqui. O banco confere superadmin + verificação em duas
// etapas em cada função admin_courtesy_*; esta página só mostra e chama.
function Row({ c }: { c: Courtesy }) {
  const left = daysLeft(c.endsAt);
  const active = c.situation === "ativa" || c.situation === "termina_em_breve";
  return (
    <li className="space-y-2 px-2 py-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium text-ink-800">{c.name ?? c.email}</p>
          {c.name && <p className="truncate text-xs text-ink-500">{c.email}</p>}
        </div>
        <span className="flex flex-wrap gap-1">
          <StatusPill tone={SITUATION_TONE[c.situation]}>{SITUATION_LABEL[c.situation]}</StatusPill>
          {convertedToPaying(c) && <StatusPill tone="success">Virou assinante</StatusPill>}
          {!c.hasAccount && active && <StatusPill tone="neutral">Ainda não criou a senha</StatusPill>}
        </span>
      </div>
      <p className="text-ink-600">
        {c.situation === "sem_prazo"
          ? "Cortesia antiga, sem data para acabar."
          : c.endsAt
            ? `${active ? "Vai até" : "Foi até"} ${formatDay(c.endsAt)}${active && left !== null ? ` (${left === 0 ? "termina hoje" : left === 1 ? "falta 1 dia" : `faltam ${left} dias`})` : ""}.`
            : null}
      </p>
      {c.id && (
        <p className="text-xs text-ink-500">
          {c.origin ? ORIGIN_LABEL[c.origin] : "—"} · {c.days} dias · dada em {fmtDate(c.grantedAt)}
          {c.grantedBy ? ` por ${c.grantedBy}` : ""}
          {c.extensions > 0 ? ` · estendida ${c.extensions}x` : ""}
          {c.reason ? ` · ${c.reason}` : ""}
          {c.revokedAt ? ` · encerrada em ${fmtDate(c.revokedAt)}${c.revokedReason ? `: ${c.revokedReason}` : ""}` : ""}
        </p>
      )}
      <CourtesyRowActions
        id={c.id}
        email={c.email}
        endsAt={c.endsAt}
        canExtend={c.situation !== "revogada" && c.situation !== "sem_prazo"}
        canRevoke={active}
        canInvite={!c.hasAccount && active}
      />
    </li>
  );
}

export default async function AdminCortesiasPage() {
  const supabase = await requireSuperadmin();
  const { data, error } = await supabase.rpc("admin_list_courtesies", { p_email: null });
  const list = parseCourtesies(data, error);
  const ativas = list?.filter((c) => c.situation === "ativa" || c.situation === "termina_em_breve") ?? [];
  const resto = list?.filter((c) => !ativas.includes(c)) ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Cortesias</h1>
          <p className="text-sm text-ink-500">Acesso com prazo que só você oferece. Nada é cobrado e, no fim, a pessoa assina se quiser continuar.</p>
        </div>
        <NewCourtesy />
      </div>

      {!list ? (
        <Card><p className="text-sm text-ink-500">Não foi possível carregar as cortesias. Recarregue a página.</p></Card>
      ) : list.length === 0 ? (
        <Card><p className="text-sm text-ink-500">Nenhuma cortesia ainda. Use “Nova cortesia” para oferecer o acesso a alguém.</p></Card>
      ) : (
        <>
          <Card padding="sm">
            <h2 className="px-2 pt-1 text-sm font-semibold text-ink-700">Ativas ({ativas.length})</h2>
            {ativas.length === 0 ? (
              <p className="px-2 py-3 text-sm text-ink-500">Nenhuma cortesia ativa agora.</p>
            ) : (
              <ul className="divide-y divide-ink-50">{ativas.map((c) => <Row key={c.id ?? c.email} c={c} />)}</ul>
            )}
          </Card>
          {resto.length > 0 && (
            <Card padding="sm">
              <h2 className="px-2 pt-1 text-sm font-semibold text-ink-700">Encerradas e sem prazo ({resto.length})</h2>
              <ul className="divide-y divide-ink-50">{resto.map((c) => <Row key={c.id ?? c.email} c={c} />)}</ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
