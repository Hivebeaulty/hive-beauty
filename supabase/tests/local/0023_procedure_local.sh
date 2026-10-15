#!/usr/bin/env bash
# ============================================================================
# Ensaio LOCAL do roteiro 0022 + 0023 com privilégios no PIOR caso e dados reais
# de agenda. Prova: nada fora da edição/avisos muda (dados, confirmação,
# lembrete, conclusão); nada é enviado; a reversão volta EXATAMENTE ao estado
# anterior (0020).
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DB="aurea_proc_0023"
export PGOPTIONS="-c client_min_messages=warning"
"$HERE/fresh_db.sh" "$DB" 0021 >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
Q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d "$DB" -c "$1"; }
OPS="$ROOT/operations/0022_0023_aplicacao_supabase.sql"
blk() { sed -n "/^-- \[$1\]/,/^-- \[\/$1\]/p" "$OPS"; }
B() { psql -X -q -A -F'|' -t -d "$DB" -c "$(blk "$1")" 2>&1; }
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
ko() { echo "FAIL $1"; fail=$((fail+1)); }
# dados de agenda + confirmação/lembrete ligados (como em produção)
Q "do \$\$ declare u uuid; co uuid; m uuid; sv uuid; k uuid; begin
  select id into u from auth.users limit 1;
  insert into companies (name) values ('Studio P') returning id into co;
  insert into company_members (company_id, user_id, role) values (co, u, 'owner') returning id into m;
  insert into services (company_id, name, duration_minutes, price) values (co, 'Manicure', 60, 50) returning id into sv;
  insert into clients (company_id, name, phone) values (co, 'Ana', '11987654321') returning id into k;
  for i in 1..5 loop
    insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end, price)
    values (co, k, sv, m, now() + i * interval '1 day', now() + i * interval '1 day' + interval '1 hour', 50);
  end loop;
  update whatsapp_private.settings set auto_confirmation_enabled = true, reminder_enabled = true;
end \$\$" >/dev/null
Q "alter default privileges grant execute on functions to anon, authenticated, service_role;
   alter default privileges grant all on tables to anon, authenticated, service_role;
   alter default privileges in schema whatsapp_private grant all on tables to anon, authenticated, service_role, wa_worker;
   alter default privileges in schema whatsapp_private grant execute on functions to anon, authenticated, service_role, wa_worker;" >/dev/null
STATE="select md5(string_agg(d, '|' order by d)) from (
  select n.nspname || '.' || p.proname || pg_get_function_identity_arguments(p.oid) || p.prosrc || coalesce(p.proacl::text,'') d
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','whatsapp_private','aurea_private')
  union all select pg_get_triggerdef(oid) || tgenabled::text from pg_trigger where not tgisinternal
  union all select table_schema || '.' || table_name || '.' || column_name || data_type || coalesce(column_default,'') from information_schema.columns where table_schema in ('public','whatsapp_private','aurea_private')
  union all select grantee || privilege_type || table_schema || table_name from information_schema.role_table_grants where table_schema in ('public','whatsapp_private')
  union all select conname || pg_get_constraintdef(oid) from pg_constraint where connamespace in ('public'::regnamespace, 'whatsapp_private'::regnamespace)) z"
KEEP="select md5(string_agg(d, '|' order by d)) from (
  select n.nspname || '.' || p.proname || p.prosrc || coalesce(p.proacl::text,'') d from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public','whatsapp_private','aurea_private')
     and p.proname not in ('claim_outbox','update_appointment','wa_get_change_notice','notice_parts','reschedule_notice_text','cancel_notice_text','on_appointment_changed')
  union all select pg_get_triggerdef(oid) || tgenabled::text from pg_trigger where not tgisinternal and tgname <> 'trg_appointments_wa_change_notice'
  union all select conname || pg_get_constraintdef(oid) from pg_constraint where connamespace = 'public'::regnamespace) z"
DATA="select md5(string_agg(x, '|' order by x)) from (select to_jsonb(a)::text x from appointments a union all select to_jsonb(p)::text from payments p
      union all select to_jsonb(o)::text from whatsapp_private.outbox o union all select to_jsonb(h)::text from appointment_status_history h) z"
[[ "$(B B0)" == "t|f|f|0" ]] && ok "B0 antes: $(B B0)" || ko "B0: $(B B0)"
S0="$(Q "$STATE")"; K0="$(Q "$KEEP")"; D0="$(Q "$DATA")"
for f in 0022_appointment_edit.sql 0023_whatsapp_change_notices.sql; do
  psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/$f" >/dev/null 2>&1 && ok "B2 $f aplicada" || ko "B2 $f"
done
[[ "$(B B3)" == "t|t|f|1|13|0|1" ]] && ok "B3 depois: $(B B3)" || ko "B3: $(B B3)"
[[ "$(Q "$KEEP")" == "$K0" ]] && ok "M1 confirmação, lembrete, conclusão, gatilhos e restrições existentes: idênticos" || ko "M1"
[[ "$(Q "$DATA")" == "$D0" ]] && ok "M2 nenhum dado mudou (agenda, recebimentos, fila, histórico)" || ko "M2"
check_exposed="$(Q "select count(*) from pg_proc p cross join unnest(array['anon','service_role']) rl where p.proname in ('update_appointment','wa_get_change_notice') and has_function_privilege(rl, p.oid, 'execute')")"
[[ "$check_exposed" == 0 ]] && ok "M3 privilégios no pior caso: RPCs novas só para authenticated" || ko "M3 $check_exposed"
[[ "$(B B5)" == "t" ]] && ok "B5 ligar" || ko "B5"
B B6 >/dev/null; [[ "$(Q "select change_notices_enabled from whatsapp_private.settings")" == f ]] && ok "B6 desligar" || ko "B6"
B B4 >/dev/null 2>&1 && ok "B4 acompanhamento roda" || ko "B4"
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "$(blk BR-SQL)" >/dev/null 2>&1 && ok "BR reversão executada" || ko "BR"
[[ "$(Q "$STATE")" == "$S0" ]] && ok "BR voltou EXATAMENTE ao estado anterior (funções, claim_outbox, gatilhos, colunas, permissões, restrições)" || ko "BR estado"
[[ "$(Q "$DATA")" == "$D0" ]] && ok "BR dados intactos" || ko "BR dados"
[[ "$(B B0)" == "t|f|f|0" ]] && ok "BR [B0] igual ao de antes" || ko "BR B0: $(B B0)"
echo "RESULTADO roteiro 0022/0023: PASS=$pass FAIL=$fail"
dropdb --force "$DB"
[[ $fail -eq 0 ]]
