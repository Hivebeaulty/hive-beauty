import Link from "next/link";
import { requireSuperadmin } from "@/lib/supabase/require-superadmin";
import { Card } from "@/components/ui/card";
import { AUDIT_ACTION_LABEL, auditLabel, fmtDate } from "@/lib/hive/admin";

export const dynamic = "force-dynamic";
const PER_PAGE = 50;

type Entry = {
  at: string; action: string; result: string; reason: string | null; company_id: string | null;
  company_name: string | null; admin_name: string | null; details: Record<string, unknown>; correlation_id: string;
};

// Registro somente-inclusão (0038): nem a service role altera ou apaga.
export default async function AdminAuditoriaPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const supabase = await requireSuperadmin();
  const sp = await searchParams;
  const conta = sp.conta && /^[0-9a-f-]{36}$/i.test(sp.conta) ? sp.conta : null;
  const acao = sp.acao && sp.acao in AUDIT_ACTION_LABEL ? sp.acao : null;
  const pagina = Math.max(1, Number.parseInt(sp.pagina ?? "1", 10) || 1);
  const { data, error } = await supabase.rpc("admin_list_audit", {
    p_company_id: conta, p_action: acao, p_limit: PER_PAGE, p_offset: (pagina - 1) * PER_PAGE,
  });
  const res = (error ? null : data) as { total: number; rows: Entry[] } | null;
  const pages = res ? Math.max(1, Math.ceil(res.total / PER_PAGE)) : 1;
  const qs = (p: number) => {
    const q = new URLSearchParams();
    if (conta) q.set("conta", conta);
    if (acao) q.set("acao", acao);
    if (p > 1) q.set("pagina", String(p));
    return q.toString() ? `?${q}` : "";
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="page-title">Auditoria</h1>
        <p className="text-sm text-ink-500">Cada ação no painel fica registrada aqui e não pode ser alterada nem apagada.</p>
      </div>
      <form action="/admin/auditoria" className="flex flex-wrap items-center gap-2">
        {conta && <input type="hidden" name="conta" value={conta} />}
        <select name="acao" defaultValue={acao ?? ""} aria-label="Ação"
                className="rounded border border-ink-200 bg-surface px-2.5 py-2 text-sm text-ink-800">
          <option value="">Todas as ações</option>
          {Object.entries(AUDIT_ACTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button className="rounded bg-primary px-3.5 py-2 text-sm font-semibold text-primary-ink hover:bg-primary-hover">Filtrar</button>
        {conta && <Link href="/admin/auditoria" className="text-sm text-ink-500 underline">Ver todas as contas</Link>}
      </form>

      {!res ? (
        <Card><p className="text-sm text-ink-500">Não foi possível carregar a auditoria. Recarregue a página.</p></Card>
      ) : res.rows.length === 0 ? (
        <Card><p className="text-sm text-ink-500">Nenhuma ação registrada ainda.</p></Card>
      ) : (
        <Card padding="sm">
          <ul className="divide-y divide-ink-50">
            {res.rows.map((l) => (
              <li key={l.correlation_id} className="px-2 py-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-ink-800">
                    <span className="font-medium">{l.admin_name ?? "Administradora"}</span> {auditLabel(l.action, l.result).toLowerCase()}
                    {l.company_id && (
                      <> em <Link href={`/admin/profissionais/${l.company_id}`} className="underline">{l.company_name ?? "conta excluída"}</Link></>
                    )}
                  </p>
                  <span className="text-xs text-ink-500">{fmtDate(l.at, true)}</span>
                </div>
                {l.reason && <p className="mt-0.5 text-xs text-ink-500">Motivo: {l.reason}</p>}
                {l.action === "export_accounts" && typeof l.details?.rows === "number" && (
                  <p className="mt-0.5 text-xs text-ink-500">{l.details.rows} linhas exportadas</p>
                )}
                <p className="mt-0.5 text-[11px] text-ink-500">Registro {l.correlation_id}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {pages > 1 && (
        <nav aria-label="Páginas" className="flex items-center justify-between text-sm">
          {pagina > 1 ? <Link href={`/admin/auditoria${qs(pagina - 1)}`} className="font-semibold text-ink-700 hover:underline">Anterior</Link> : <span />}
          <span className="text-ink-500">Página {pagina} de {pages}</span>
          {pagina < pages ? <Link href={`/admin/auditoria${qs(pagina + 1)}`} className="font-semibold text-ink-700 hover:underline">Próxima</Link> : <span />}
        </nav>
      )}
    </div>
  );
}
