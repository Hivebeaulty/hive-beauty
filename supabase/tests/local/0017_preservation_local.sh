#!/usr/bin/env bash
# ============================================================================
# 0017 — a migration NÃO altera nada do que existe. SOMENTE LOCAL.
# Banco com o perfil ATUAL de produção: 0001–0015, os 2 atendimentos já
# regularizados, automação ativada, o concluído sem recebimento de R$ 90.
# Tira fotos (dados, definições existentes, automação, R$ 90), aplica a 0017,
# compara e roda as baterias da 0014, 0015 e 0017 nesse banco.
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DB="aurea_presv_0017"
export PGOPTIONS="-c client_min_messages=warning"
"$HERE/fresh_db.sh" "$DB" 0013 >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
Q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d "$DB" -c "$1"; }
UID_A="$(Q "select id from auth.users order by created_at limit 1")"
Q "
do \$\$
declare c1 uuid; c2 uuid; m1 uuid; m2 uuid; s1 uuid; s2 uuid; k1 uuid; k2 uuid; a uuid; i int;
  hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  insert into companies (name) values ('Studio 1') returning id into c1;
  insert into companies (name) values ('Studio 2') returning id into c2;
  insert into company_members (company_id, user_id, role) values (c1, '$UID_A', 'owner') returning id into m1;
  insert into company_members (company_id, user_id, role) values (c2, '$UID_A', 'owner') returning id into m2;
  insert into services (company_id, name, price) values (c1, 'Mão', 100) returning id into s1;
  insert into services (company_id, name, price) values (c2, 'Pé', 150) returning id into s2;
  insert into clients (company_id, name) values (c1, 'Cliente 1') returning id into k1;
  insert into clients (company_id, name) values (c2, 'Cliente 2') returning id into k2;

  -- concluídos e recebidos, pelo fluxo real (RPC como a usuária)
  perform set_config('request.jwt.claim.sub', '$UID_A', true);
  for i in 1..11 loop
    insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end)
      values (c1, k1, s1, m1, 100, now() - (i + 2) * interval '1 day', now() - (i + 2) * interval '1 day' + interval '1 hour') returning id into a;
    perform conclude_appointment(a, 100, 'pix');
    insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end)
      values (c2, k2, s2, m2, 150, now() - (i + 2) * interval '1 day', now() - (i + 2) * interval '1 day' + interval '1 hour') returning id into a;
    perform conclude_appointment(a, 150, 'dinheiro');
  end loop;

  -- o caso de R\$ 90: concluído pela RPC e recebimento apagado depois (Receitas > Excluir)
  insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end, notes)
    values (c1, k1, s1, m1, 90, now() - interval '9 days 3 hours', now() - interval '9 days 2 hours', 'LEGADO-90') returning id into a;
  perform conclude_appointment(a, 90, 'pix');
  delete from payments where appointment_id = a;

  -- os 2 a regularizar: em aberto, terminaram antes de hoje
  insert into appointments (id, company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end, notes)
    values ('f077bf3d-5507-441a-8114-b3493ebd640b', c1, k1, s1, m1, 100, (hoje - 14 + time '17:00') at time zone 'America/Sao_Paulo',
            (hoje - 14 + time '18:00') at time zone 'America/Sao_Paulo', 'REGULARIZAR-100'),
           ('674b1ea5-3bbc-46dd-bd39-2799f0f51a35', c2, k2, s2, m2, 150, (hoje - 16 + time '08:00') at time zone 'America/Sao_Paulo',
            (hoje - 16 + time '09:00') at time zone 'America/Sao_Paulo', 'REGULARIZAR-150');

  -- cancelados/faltas e futuros
  for i in 1..5 loop
    insert into appointments (company_id, client_id, service_id, professional_member_id, price, status, scheduled_start, scheduled_end)
      values (c1, k1, s1, m1, 100, case when i % 2 = 0 then 'cancelado' else 'nao_compareceu' end::appointment_status,
              now() - (i + 20) * interval '1 day', now() - (i + 20) * interval '1 day' + interval '1 hour');
  end loop;
  for i in 1..6 loop
    insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end)
      values (c2, k2, s2, m2, 120, now() + i * interval '1 day', now() + i * interval '1 day' + interval '1 hour');
  end loop;
end \$\$;"
for m in 0014_appointment_lifecycle_guards 0015_auto_conclusion; do
  psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/$m.sql" >/dev/null || { echo "FALHA: $m"; exit 1; }
done
# estado de produção: regularização feita e automação ativada
REG="$(Q "select aurea_private.regularize(array['f077bf3d-5507-441a-8114-b3493ebd640b','674b1ea5-3bbc-46dd-bd39-2799f0f51a35']::uuid[], 250, false) ->> 'run_id'")"
Q "select aurea_private.activate_auto_conclusion('$REG')" >/dev/null

DATA="select md5(string_agg(x, '|' order by x)) from (
  select 'a' || to_jsonb(t)::text x from appointments t union all select 'p' || to_jsonb(t)::text from payments t
  union all select 'c' || to_jsonb(t)::text from clients t union all select 'h' || to_jsonb(t)::text from appointment_status_history t
  union all select 'm' || to_jsonb(t)::text from company_members t union all select 'o' || to_jsonb(t)::text from companies t
  union all select 'l' || count(*)::text from audit_logs) z"
DEFS="select md5(string_agg(d, '|' order by d)) from (
  select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public','aurea_private') and p.prokind in ('f','p') and p.proname not like 'wa\_%'
  union all select pg_get_triggerdef(t.oid) || t.tgenabled::text from pg_trigger t join pg_class c on c.oid = t.tgrelid
   join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public','aurea_private') and not t.tgisinternal
  union all select pol.polname || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') from pg_policy pol
  union all select conname || pg_get_constraintdef(oid) from pg_constraint where connamespace in ('public'::regnamespace, 'aurea_private'::regnamespace)
  union all select grantee || privilege_type || table_schema || table_name from information_schema.role_table_grants
   where table_schema in ('public','aurea_private')) z"
AUTO="select md5(string_agg(x, '|' order by x)) from (
  select to_jsonb(s)::text x from aurea_private.settings s union all select to_jsonb(r)::text from aurea_private.runs r
  union all select to_jsonb(i)::text from aurea_private.run_items i union all select to_jsonb(st)::text from aurea_private.appointment_state st) z"
LEG="select md5(to_jsonb(a)::text) from appointments a where notes = 'LEGADO-90'"

pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
ko() { echo "FAIL $1"; fail=$((fail+1)); }
D0="$(Q "$DATA")"; F0="$(Q "$DEFS")"; A0="$(Q "$AUTO")"; L0="$(Q "$LEG")"
[[ ${#D0} -eq 32 && ${#F0} -eq 32 && ${#A0} -eq 32 && ${#L0} -eq 32 ]] || { echo "FAIL fotos vazias"; exit 1; }
psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/0017_whatsapp_core.sql" >/dev/null || { echo "FAIL: 0017 não aplicou"; exit 1; }
[[ "$(Q "$DATA")" == "$D0" ]] && ok "M1 nenhum dado mudou (atendimentos, recebimentos, clientes, histórico, membros, empresas, auditoria)" || ko "M1"
[[ "$(Q "$DEFS")" == "$F0" ]] && ok "M2 nenhuma função, gatilho, policy, constraint ou permissão existente mudou (0014/0015 intactas)" || ko "M2"
[[ "$(Q "$AUTO")" == "$A0" ]] && ok "M3 automação de atendimentos intacta (configuração ativada, execuções, itens, controle)" || ko "M3"
[[ "$(Q "$LEG")" == "$L0" ]] && ok "M4 o atendimento de R\$ 90 está idêntico" || ko "M4"
[[ "$(Q "select aurea_private.run_auto_conclusion() ->> 'status'")" =~ ^(idle|ok)$ ]] && ok "M5 a automação continua executando normalmente depois da 0017" || ko "M5"
# a M5 é uma execução real (grava o batimento da automação): nova foto antes das baterias
D1="$(Q "$DATA")"; A1="$(Q "$AUTO")"
for t in 0014_appointment_lifecycle_staging 0015_auto_conclusion_staging 0017_whatsapp_core_staging; do
  out="$(psql -X -q -d "$DB" -f "$ROOT/tests/$t.sql" 2>&1)"
  nf=$(grep -a -c '^FAIL' <<<"$out"); np=$(grep -a -c '^PASS' <<<"$out")
  [[ "$nf" == 0 && "$np" -gt 0 ]] && ok "M6 $t neste banco: PASS=$np FAIL=0" || { ko "M6 $t PASS=$np FAIL=$nf"; grep -a '^FAIL' <<<"$out"; }
done
[[ "$(Q "$DATA")" == "$D1" && "$(Q "$AUTO")" == "$A1" ]] && ok "M7 depois de rodar as 3 baterias, dados e automação continuam idênticos" || ko "M7"

echo "RESULTADO preservação 0017: PASS=$pass FAIL=$fail"
dropdb --force "$DB"
[[ $fail -eq 0 ]]
