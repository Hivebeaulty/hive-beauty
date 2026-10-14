#!/usr/bin/env bash
# ============================================================================
# Ensaio LOCAL do roteiro supabase/operations/0015_validacao_supabase.sql,
# bloco a bloco, num banco com o perfil de produção (IDs reais dos 2
# atendimentos). Prova que o roteiro funciona como descrito ANTES de usá-lo
# no Supabase. SOMENTE LOCAL.
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OPS="$ROOT/operations/0015_validacao_supabase.sql"
DB="aurea_proc_0015"
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
psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/0014_appointment_lifecycle_guards.sql" >/dev/null || { echo "FALHA: 0014"; exit 1; }

blk() { sed -n "/^-- \[$1\]/,/^-- \[\/$1\]/p" "$OPS"; }
B() { psql -X -q -A -F'|' -t -d "$DB" -c "$(blk "$1")" 2>&1; }
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
ko() { echo "FAIL $1"; fail=$((fail+1)); }

# ---- ETAPA 0
V01="$(B V0.1)"; IFS='|' read -r _ usr p14 sch _ job nusr <<<"$V01"
[[ "$usr" == postgres && "$p14" == 5 && "$sch" == f && "$job" == 0 && "$nusr" -ge 1 ]] && ok "V0.1 ambiente ($usr, 0014=$p14, schema=$sch, job=$job)" || ko "V0.1: $V01"
[[ -z "$(B V0.2)" ]] && ok "V0.2 nenhum gatilho inesperado" || ko "V0.2: $(B V0.2)"
[[ -z "$(B V0.3)" ]] && ok "V0.3 nenhuma função com chamada externa" || ko "V0.3"
[[ "$(B V0.4)" == "0|0" ]] && ok "V0.4 isolamento: nada em 2020, nenhuma empresa ZZ" || ko "V0.4: $(B V0.4)"
[[ -z "$(B V0.5)" ]] && ok "V0.5 tabelas públicas pertencem a postgres" || ko "V0.5"
[[ "$(B V0.7 | wc -l)" == 3 ]] && ok "V0.7 3 registros sensíveis encontrados (R\$ 90 + os 2)" || ko "V0.7: $(B V0.7)"
FOTO0="$(B V0.8)"; [[ "$(wc -l <<<"$FOTO0")" == 13 ]] && ok "V0.8 foto ANTES com 13 itens" || ko "V0.8: $FOTO0"

# detector de gatilho inesperado funciona?
Q "create function zz_hook() returns trigger language plpgsql as \$b\$ begin return new; end \$b\$; create trigger zz_webhook after insert on appointments for each row execute function zz_hook();" >/dev/null
[[ "$(B V0.2)" == *zz_webhook* ]] && ok "V0.2 detecta um gatilho estranho (ex.: webhook)" || ko "V0.2 não detectou"
Q "drop trigger zz_webhook on appointments; drop function zz_hook();" >/dev/null
[[ "$(B V0.8)" == "$FOTO0" ]] && ok "V0.8 foto estável (remoção do gatilho de teste restaurou as definições)" || ko "V0.8 instável"

# ---- ETAPA 1: aplicação com falha forçada no fim -> nada aplicado
{ echo "begin;"; cat "$ROOT/migrations/0015_auto_conclusion.sql"; echo "select 1/0;"; echo "commit;"; } > /tmp/proc_fail.sql
psql -X -q -d "$DB" -f /tmp/proc_fail.sql >/dev/null 2>&1
[[ "$(Q "select exists (select 1 from pg_namespace where nspname = 'aurea_private')")" == f && "$(B V0.8)" == "$FOTO0" ]] \
  && ok "E1 falha no meio da aplicação (begin/commit): NADA aplicado, foto igual" || ko "E1 aplicação parcial!"
# aplicação real como no roteiro
{ echo "begin;"; cat "$ROOT/migrations/0015_auto_conclusion.sql"; echo "commit;"; } > /tmp/proc_ok.sql
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f /tmp/proc_ok.sql >/dev/null 2>&1 && ok "E1 0015 aplicada com begin/commit" || ko "E1 aplicação"

# ---- ETAPA 2
[[ "$(B V2.1)" == "t|4|10|2|3|f||0|0|0|0" ]] && ok "V2.1 objetos: $(B V2.1)" || ko "V2.1: $(B V2.1)"
SUM="$(psql -X -q -A -F'|' -t -d "$DB" -c "$(sed -n '/SEÇÃO 2/,/schemas_expostos_postgrest_se_disponivel;/p' "$ROOT/diagnostics/0015_privileges_audit.sql")")"
[[ "$SUM" == "10|4|0|0|0|0|" ]] && ok "V2.2 privilégios: $SUM" || ko "V2.2: $SUM"
EXP="$(psql -X -q -A -t -d "$DB" -c "$(sed -n '/SEÇÃO 1/,/order by 1;/p' "$ROOT/diagnostics/0015_privileges_audit.sql")" | grep -c EXPOSTA)"
[[ "$EXP" == 0 ]] && ok "V2.2 nenhuma função EXPOSTA" || ko "V2.2 expostas: $EXP"
[[ "$(B V0.8)" == "$FOTO0" ]] && ok "V2.3 foto DEPOIS da aplicação = ANTES (dados, definições, R\$ 90, os 2)" || { ko "V2.3"; diff <(echo "$FOTO0") <(B V0.8); }
[[ "$(B V2.4)" == '{"status": "disabled"}' ]] && ok "V2.4 automação desligada não faz nada" || ko "V2.4: $(B V2.4)"

# ---- ETAPA 3
psql -X -q -d "$DB" -f "$ROOT/tests/0015_auto_conclusion_producao_sem_ddl.sql" > /tmp/proc_t.out 2>&1
NP=$(grep -a -c '^PASS' /tmp/proc_t.out); NF=$(grep -a -c '^FAIL' /tmp/proc_t.out)
[[ "$NF" == 0 && "$NP" -ge 81 ]] && ok "E3 testes de produção (sem DDL): PASS=$NP FAIL=$NF" || { ko "E3 PASS=$NP FAIL=$NF"; grep -a '^FAIL' /tmp/proc_t.out; }

# ---- ETAPA 4
[[ "$(B V0.8)" == "$FOTO0" ]] && ok "V4.1 foto DEPOIS dos testes = ANTES" || { ko "V4.1"; diff <(echo "$FOTO0") <(B V0.8); }
[[ "$(B V4.2)" == "0|0|0|0|0|f||" ]] && ok "V4.2 nenhum rastro dos testes: $(B V4.2)" || ko "V4.2: $(B V4.2)"

# ---- REVERSÃO
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "$(blk VR)" >/dev/null 2>&1 && ok "VR reversão executada" || ko "VR"
[[ "$(Q "select exists (select 1 from pg_namespace where nspname = 'aurea_private')")" == f && "$(B V0.8)" == "$FOTO0" ]] \
  && ok "VR depois da reversão: schema removido e foto = ANTES" || ko "VR estado"
[[ "$(Q "select count(*) from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace where n.nspname = 'aurea_private'")" == 0 ]] \
  && ok "VR nenhum resíduo de privilégio padrão do schema" || ko "VR resíduo"
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f /tmp/proc_ok.sql >/dev/null 2>&1 && [[ "$(B V2.1)" == "t|4|10|2|3|f||0|0|0|0" ]] \
  && ok "VR reaplicar a 0015 depois da reversão funciona" || ko "VR reaplicação"

echo "RESULTADO roteiro de validação 0015: PASS=$pass FAIL=$fail"
dropdb --force "$DB"
[[ $fail -eq 0 ]]
