// Exportação CSV da lista de profissionais (mesmos filtros da tela).
// Route handlers não passam pelo layout do painel: a trava vem aqui, e o banco
// confere de novo (admin_export_accounts -> admin_assert) e REGISTRA a exportação.
// Minimização: só dados da conta e contagens; nada das clientes finais.
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { accountFiltersToRpc, accountsCsv, businessYmd, parseAccountFilters, parseAccountList, parseWhoami } from "@/lib/hive/admin";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: who } = await supabase.rpc("admin_whoami");
  const w = parseWhoami(who);
  if (!w.isSuperadmin || !w.mfaOk) return NextResponse.json({ error: "Acesso restrito." }, { status: 403 });

  const f = parseAccountFilters(Object.fromEntries(request.nextUrl.searchParams));
  const { data, error } = await supabase.rpc("admin_export_accounts", accountFiltersToRpc(f));
  const list = error ? null : parseAccountList(data);
  if (!list) return NextResponse.json({ error: "Não foi possível exportar." }, { status: 500 });

  return new NextResponse(accountsCsv(list.rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="aurea-profissionais-${businessYmd(new Date())}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
