import Link from "next/link";
import { requireSuperadmin } from "@/lib/supabase/require-superadmin";
import { Card } from "@/components/ui/card";
import { StatusPill } from "@/components/admin/status-pill";
import {
  BILLING_LABEL,
  BILLING_ORDER,
  BILLING_TONE,
  ORDER_OPTIONS,
  PAGE_SIZE,
  accountFiltersQuery,
  accountFiltersToRpc,
  fmtDate,
  parseAccountFilters,
  parseAccountList,
  type AccountRow,
} from "@/lib/hive/admin";
import { Download, Search } from "lucide-react";

export const dynamic = "force-dynamic";

const field = "rounded border border-ink-200 bg-surface px-2.5 py-2 text-sm text-ink-800";

function Status({ r }: { r: AccountRow }) {
  return (
    <span className="flex flex-wrap gap-1">
      <StatusPill tone={BILLING_TONE[r.billing_status]}>{BILLING_LABEL[r.billing_status]}</StatusPill>
      {r.suspended && <StatusPill tone="danger">Suspensa</StatusPill>}
      {r.is_demo && <StatusPill tone="muted">Demonstração</StatusPill>}
    </span>
  );
}

export default async function AdminProfissionaisPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await requireSuperadmin();
  const f = parseAccountFilters(await searchParams);
  const { data, error } = await supabase.rpc("admin_list_accounts", {
    ...accountFiltersToRpc(f),
    p_order: f.ordem,
    p_limit: PAGE_SIZE,
    p_offset: (f.pagina - 1) * PAGE_SIZE,
  });
  const list = error ? null : parseAccountList(data);
  const pages = list ? Math.max(1, Math.ceil(list.total / PAGE_SIZE)) : 1;
  const filtered = !!(f.q || f.assinatura || f.situacao || f.de || f.ate || f.demo);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Profissionais</h1>
          <p className="text-sm text-ink-500">
            {list ? `${list.total} ${list.total === 1 ? "conta" : "contas"}${filtered ? " no filtro" : ""}` : "—"}
          </p>
        </div>
        {list && list.total > 0 && (
          <a
            href={`/admin/profissionais/exportar${accountFiltersQuery(f, { pagina: 1 })}`}
            className="flex items-center gap-1.5 rounded px-3 py-2 text-sm font-semibold text-ink-800 ring-1 ring-ink-200 hover:bg-ink-50"
          >
            <Download className="size-4" />
            Exportar CSV
          </a>
        )}
      </div>

      <form action="/admin/profissionais" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_auto_auto_auto_auto_auto]">
        <label className="relative sm:col-span-2 lg:col-span-1">
          <span className="sr-only">Buscar</span>
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-500" />
          <input name="q" defaultValue={f.q} placeholder="Negócio, responsável ou e-mail" className={`${field} w-full pl-8`} />
        </label>
        <select name="assinatura" defaultValue={f.assinatura} aria-label="Assinatura" className={field}>
          <option value="">Toda assinatura</option>
          {BILLING_ORDER.map((s) => (
            <option key={s} value={s}>{BILLING_LABEL[s]}</option>
          ))}
        </select>
        <select name="situacao" defaultValue={f.situacao} aria-label="Acesso" className={field}>
          <option value="">Todo acesso</option>
          <option value="ativas">Acesso normal</option>
          <option value="suspensas">Suspensas</option>
        </select>
        <select name="ordem" defaultValue={f.ordem} aria-label="Ordem" className={field}>
          {ORDER_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>{o.label}</option>
          ))}
        </select>
        <span className="flex items-center gap-1.5 text-sm text-ink-500">
          <input type="date" name="de" defaultValue={f.de} aria-label="Cadastro a partir de" className={field} />
          <input type="date" name="ate" defaultValue={f.ate} aria-label="Cadastro até" className={field} />
        </span>
        <span className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-sm text-ink-600">
            <input type="checkbox" name="demo" value="1" defaultChecked={f.demo} /> Demonstração
          </label>
          <button className="rounded bg-primary px-3.5 py-2 text-sm font-semibold text-primary-ink hover:bg-primary-hover">Filtrar</button>
        </span>
      </form>

      {!list ? (
        <Card>
          <p className="text-sm text-ink-500">Não foi possível carregar a lista. Recarregue a página.</p>
        </Card>
      ) : list.rows.length === 0 ? (
        <Card>
          <p className="text-sm font-medium text-ink-700">Nenhuma conta encontrada.</p>
          {filtered && (
            <Link href="/admin/profissionais" className="mt-1 inline-block text-sm text-ink-500 underline">
              Limpar os filtros
            </Link>
          )}
        </Card>
      ) : (
        <>
          {/* Computador: tabela */}
          <div className="hidden overflow-x-auto rounded-lg border border-ink-100 bg-surface md:block">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-ink-100 text-xs text-ink-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Negócio e responsável</th>
                  <th className="px-3 py-2.5 font-medium">Assinatura</th>
                  <th className="px-3 py-2.5 font-medium">Cadastro</th>
                  <th className="px-3 py-2.5 font-medium">Último acesso</th>
                  <th className="px-3 py-2.5 text-right font-medium">Atendimentos</th>
                  <th className="px-4 py-2.5 font-medium">Última atividade</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-50">
                {list.rows.map((r) => (
                  <tr key={r.company_id} className="hover:bg-ink-50/60">
                    <td className="px-4 py-3">
                      <Link href={`/admin/profissionais/${r.company_id}`} className="font-medium text-ink-800 hover:underline">
                        {r.company_name}
                      </Link>
                      <p className="text-xs text-ink-500">
                        {r.owner_name ?? "Sem nome"} {r.owner_email && <>· {r.owner_email}</>}
                      </p>
                    </td>
                    <td className="px-3 py-3"><Status r={r} /></td>
                    <td className="px-3 py-3 text-ink-600">{fmtDate(r.created_at)}</td>
                    <td className="px-3 py-3 text-ink-600">{fmtDate(r.owner_last_sign_in)}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-ink-700">{r.appointments_count}</td>
                    <td className="px-4 py-3 text-ink-600">{fmtDate(r.last_activity_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Celular: cartões */}
          <div className="space-y-2 md:hidden">
            {list.rows.map((r) => (
              <Link key={r.company_id} href={`/admin/profissionais/${r.company_id}`}>
                <Card interactive padding="sm" className="space-y-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium text-ink-800">{r.company_name}</p>
                    <Status r={r} />
                  </div>
                  <p className="truncate text-xs text-ink-500">{r.owner_email ?? r.owner_name ?? "Sem responsável"}</p>
                  <p className="text-xs text-ink-500">
                    Cadastro {fmtDate(r.created_at)}, {r.appointments_count} atendimentos, último acesso {fmtDate(r.owner_last_sign_in)}
                  </p>
                </Card>
              </Link>
            ))}
          </div>

          {pages > 1 && (
            <nav aria-label="Páginas" className="flex items-center justify-between text-sm">
              {f.pagina > 1 ? (
                <Link href={`/admin/profissionais${accountFiltersQuery(f, { pagina: f.pagina - 1 })}`} className="font-semibold text-ink-700 hover:underline">
                  Anterior
                </Link>
              ) : <span />}
              <span className="text-ink-500">Página {f.pagina} de {pages}</span>
              {f.pagina < pages ? (
                <Link href={`/admin/profissionais${accountFiltersQuery(f, { pagina: f.pagina + 1 })}`} className="font-semibold text-ink-700 hover:underline">
                  Próxima
                </Link>
              ) : <span />}
            </nav>
          )}
        </>
      )}
    </div>
  );
}
