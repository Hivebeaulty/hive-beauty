#!/usr/bin/env bash
# ============================================================================
# Ensaio LOCAL do roteiro supabase/operations/0017_aplicacao_supabase.sql, bloco a bloco.
# Banco com o perfil ATUAL de produção: 0001–0015, os 2 atendimentos já
# regularizados, automação ativada, o concluído sem recebimento de R$ 90.
# Tira fotos (dados, definições existentes, automação, R$ 90), aplica a 0017,
# compara e roda as baterias da 0014, 0015 e 0017 nesse banco.
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DB="aurea_proc_0017"
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
           ('674b1ea5-3bbc-46dd-bd39-2799f0f51a35', c2, k2, s2, m2, 150, (hoje - 10 + time '08:00') at time zone 'America/Sao_Paulo',
            (hoje - 10 + time '09:00') at time zone 'America/Sao_Paulo', 'REGULARIZAR-150');

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

OPS="$ROOT/operations/0017_aplicacao_supabase.sql"
blk() { sed -n "/^-- \[$1\]/,/^-- \[\/$1\]/p" "$OPS"; }
B() { psql -X -q -A -F'|' -t -d "$DB" -c "$(blk "$1")" 2>&1; }
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
ko() { echo "FAIL $1"; fail=$((fail+1)); }
DEFS="select md5(string_agg(d, '|' order by d)) from (
  select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public','aurea_private') and p.prokind in ('f','p')
  union all select pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid = t.tgrelid
   join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public','aurea_private') and not t.tgisinternal
  union all select conname || pg_get_constraintdef(oid) from pg_constraint where connamespace in ('public'::regnamespace, 'aurea_private'::regnamespace)) z"

# o papel é do cluster: em ensaio local, outro banco pode tê-lo criado antes
OTHER_DB_ROLE="$(Q "select exists (select 1 from pg_roles where rolname = 'wa_worker')")"
B0="$(B B0)"
[[ "$B0" == "5|10|t|f|$OTHER_DB_ROLE|0" ]] && ok "B0 antes: $B0" || ko "B0: $B0"
F0="$(B B1)"; DF0="$(Q "$DEFS")"
{ echo "begin;"; cat "$ROOT/migrations/0017_whatsapp_core.sql"; echo "commit;"; } > /tmp/proc17.sql
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f /tmp/proc17.sql >/dev/null 2>&1 && ok "B2 0017 aplicada com begin/commit" || ko "B2"
[[ "$(B B3)" == "t|7|7|19|13|f|0|0" ]] && ok "B3 depois: $(B B3)" || ko "B3: $(B B3)"
[[ "$(B B1)" == "$F0" ]] && ok "B1 foto igual depois da aplicação (dados, R\$ 90, automação)" || ko "B1 depois da aplicação"
out="$(psql -X -q -d "$DB" -f "$ROOT/tests/0017_whatsapp_core_staging.sql" 2>&1)"
NF=$(grep -a -c '^FAIL' <<<"$out"); NP=$(grep -a -c '^PASS' <<<"$out")
[[ "$NF" == 0 && "$NP" -ge 42 ]] && ok "B4 testes da 0017: PASS=$NP FAIL=0" || { ko "B4 PASS=$NP FAIL=$NF"; grep -a '^FAIL' <<<"$out"; }
[[ "$(B B1)" == "$F0" ]] && ok "B1 foto igual depois dos testes" || ko "B1 depois dos testes"

# reversão
DEPS="$(Q "select count(*) from pg_shdepend d join pg_roles r on r.oid = d.refobjid
            where r.rolname = 'wa_worker' and d.dbid <> (select oid from pg_database where datname = current_database())")"
if [[ "$DEPS" == 0 ]]; then
  psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "$(blk BR-SQL)" >/dev/null 2>&1 && ok "BR reversão executada (com remoção do papel)" || ko "BR"
  [[ "$(Q "select exists (select 1 from pg_roles where rolname = 'wa_worker')")" == f ]] && ok "BR papel wa_worker removido" || ko "BR papel"
else
  psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "$(blk BR-SQL | grep -v 'drop role')" >/dev/null 2>&1 && ok "BR reversão executada" || ko "BR"
  echo "INFO BR remoção do papel não ensaiada aqui: o papel é usado por outro banco local ($DEPS dependências)"
fi
[[ "$(Q "select exists (select 1 from pg_namespace where nspname = 'whatsapp_private') or exists (select 1 from pg_proc where proname like 'wa\\_%')")" == f ]] \
  && ok "BR schema e RPCs removidos" || ko "BR resíduos"
[[ "$(Q "$DEFS")" == "$DF0" && "$(B B1)" == "$F0" ]] && ok "BR definições e foto voltaram exatamente ao estado de antes" || ko "BR estado"
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f /tmp/proc17.sql >/dev/null 2>&1 && [[ "$(B B3)" == "t|7|7|19|13|f|0|0" ]] \
  && ok "BR reaplicar a 0017 depois da reversão funciona" || ko "BR reaplicação"

echo "RESULTADO roteiro 0017: PASS=$pass FAIL=$fail"
dropdb --force "$DB"
[[ $fail -eq 0 ]]
