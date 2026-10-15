#!/usr/bin/env bash
# ============================================================================
# 0014 — a migration NÃO altera dados existentes. SOMENTE LOCAL.
#
# Monta um banco com 0001–0013 e um estado parecido com o de produção
# (diagnóstico de 10/10/2026): 2 atendimentos em aberto que terminaram antes
# de hoje (R$ 100 e R$ 150), 1 concluído SEM recebimento (R$ 90, recebimento
# apagado depois da conclusão), concluídos recebidos, cancelados/faltas e
# futuros. Tira uma "foto" (hash) das tabelas, aplica a 0014 e compara.
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DB="aurea_presv_0014"
export PGOPTIONS="-c client_min_messages=warning"
"$HERE/fresh_db.sh" "$DB" 0013 >/dev/null
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
  insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end, notes)
    values (c1, k1, s1, m1, 100, (hoje - 14 + time '17:00') at time zone 'America/Sao_Paulo',
            (hoje - 14 + time '18:00') at time zone 'America/Sao_Paulo', 'REGULARIZAR-100'),
           (c2, k2, s2, m2, 150, (hoje - 16 + time '08:00') at time zone 'America/Sao_Paulo',
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

SNAP="
select 'appointments', md5(string_agg(t::text, '|' order by t.id)) from (select * from appointments) t
union all select 'payments', md5(string_agg(t::text, '|' order by t.id)) from
  (select id, company_id, appointment_id, client_id, amount, paid_amount, method, status, paid_at, description, created_at from payments) t
union all select 'clients', md5(string_agg(t::text, '|' order by t.id)) from (select * from clients) t
union all select 'audit_logs (qtd)', count(*)::text from audit_logs
union all select 'appointment_status_history (qtd)', count(*)::text from appointment_status_history
order by 1;"
DIAG="${DIAG:-}"

Q "$SNAP" > /tmp/presv_antes.txt
psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/0014_appointment_lifecycle_guards.sql" || { echo "FAIL: 0014 não aplicou"; exit 1; }
Q "$SNAP" > /tmp/presv_depois.txt

pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
ko() { echo "FAIL $1"; fail=$((fail+1)); }
if diff -q /tmp/presv_antes.txt /tmp/presv_depois.txt >/dev/null; then ok "M1 0014 não alterou nenhuma linha (hash de appointments, payments, clients) nem gerou auditoria/histórico"; else ko "M1"; diff /tmp/presv_antes.txt /tmp/presv_depois.txt; fi
[[ "$(Q "select count(*) from payments where source <> 'manual' or modified_at is not null")" == "0" ]] \
  && ok "M2 recebimentos existentes ficaram como source=manual e sem marca de alteração" || ko "M2"
[[ "$(Q "select count(*) from appointments a where notes = 'LEGADO-90' and status = 'concluido' and not exists (select 1 from payments p where p.appointment_id = a.id)")" == "1" ]] \
  && ok "M3 o concluído SEM recebimento (R\$ 90) continua exatamente como estava" || ko "M3"
[[ "$(Q "select count(*) from appointments a where notes like 'REGULARIZAR-%' and status = 'agendado' and not exists (select 1 from payments p where p.appointment_id = a.id)")" == "2" ]] \
  && ok "M4 os 2 atendimentos a regularizar continuam em aberto e sem recebimento" || ko "M4"

# depois da 0014, o legado não fica "travado": editar só a observação dele passa no COMMIT
out="$(psql -X -q -d "$DB" 2>&1 <<SQL
set request.jwt.claim.sub = '$UID_A'; set role authenticated;
begin;
update appointments set notes = 'LEGADO-90' where notes = 'LEGADO-90';
commit;
SQL
)"
grep -q ERROR <<<"$out" && ko "M5 editar a observação do legado: $out" || ok "M5 o legado continua editável na observação (invariante só vale para o que muda de estado)"
out="$(psql -X -q -d "$DB" 2>&1 <<SQL
set request.jwt.claim.sub = '$UID_A'; set role authenticated; \\set VERBOSITY verbose
select reclassify_appointment_as_no_show((select id from appointments where notes = 'LEGADO-90'));
SQL
)"
grep -q AUR01 <<<"$out" && ok "M6 o legado NÃO pode ser reclassificado (AUR01)" || ko "M6: $out"
out="$(psql -X -q -d "$DB" 2>&1 <<SQL
set request.jwt.claim.sub = '$UID_A'; set role authenticated; \\set VERBOSITY verbose
delete from appointments where notes = 'LEGADO-90';
SQL
)"
grep -q 22023 <<<"$out" && ok "M7 o legado NÃO pode mais ser apagado diretamente pela API (22023)" || ko "M7: $out"
[[ "$(Q "select count(*) from appointments where notes in ('LEGADO-90','REGULARIZAR-100','REGULARIZAR-150')")" == "3" ]] \
  && ok "M8 após as tentativas, os 3 registros sensíveis continuam presentes" || ko "M8"

if [[ -f "$DIAG" ]]; then
  psql -X -q -A -d "$DB" -f "$DIAG" > /tmp/presv_diag.txt 2>&1
  grep -a -E "^0[1-9]|^10|^TOTAL" /tmp/presv_diag.txt | head -12
fi
echo "RESULTADO preservação 0014: PASS=$pass FAIL=$fail"
dropdb "$DB"
[[ $fail -eq 0 ]]
