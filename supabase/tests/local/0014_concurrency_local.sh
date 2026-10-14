#!/usr/bin/env bash
# ============================================================================
# 0014 — concorrência e COMMIT real, com DUAS sessões simultâneas.
# SOMENTE LOCAL: cria um banco descartável do zero (fresh_db.sh) e o apaga no
# fim. Não aponte para o Supabase.
#
# Cada cenário: a sessão A executa uma operação e SEGURA a transação por 2 s;
# a sessão B começa 0,7 s depois sobre o MESMO atendimento. Esperado: B espera
# a trava de A e então recebe o resultado coerente com o estado já gravado.
# Uso (como usuário do Postgres local): supabase/tests/local/0014_concurrency_local.sh
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DB="aurea_conc_0014"
"$HERE/fresh_db.sh" "$DB" >/dev/null
Q() { psql -X -q -A -t -d "$DB" -c "$1"; }

UID_A="$(Q "select id from auth.users order by created_at limit 1")"
AS_USER="set request.jwt.claim.sub = '$UID_A'; set role authenticated; \\set VERBOSITY verbose"

# ---------------------------------------------------------------- fixtures
Q "
do \$\$
declare c uuid; m uuid; s uuid; cl uuid; i int; d date := (now() at time zone 'America/Sao_Paulo')::date - 20;
begin
  insert into companies (name) values ('ZZ-CONC') returning id into c;
  insert into company_members (company_id, user_id, role) values (c, '$UID_A', 'owner') returning id into m;
  insert into services (company_id, name, price) values (c, 'Mão', 100) returning id into s;
  insert into clients (company_id, name) values (c, 'Cliente') returning id into cl;
  for i in 1..8 loop
    insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end, notes)
    values (c, cl, s, m, 100, (d + i + time '10:00') at time zone 'America/Sao_Paulo',
            (d + i + time '11:00') at time zone 'America/Sao_Paulo', 'a' || i);
  end loop;
  -- a1..a6: conclusão AUTOMÁTICA simulada (o que a 0015 fará); a7, a8 ficam em aberto
  update appointments set status = 'concluido', payment_method = 'pix', completed_at = scheduled_end
   where company_id = c and notes in ('a1','a2','a3','a4','a5','a6');
  insert into payments (company_id, appointment_id, client_id, amount, method, status, paid_at, created_at, source)
  select company_id, id, client_id, price, 'pix', 'pago', scheduled_end, scheduled_end, 'auto'
  from appointments where company_id = c and notes in ('a1','a2','a3','a4','a5','a6');
end \$\$;"
A() { Q "select id from appointments where notes = '$1'"; }

pass=0; fail=0
check() { # nome, condição SQL (true = ok)
  if [[ "$(Q "select ($2)")" == "t" ]]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi
}
race() { # nome, sql_A, sql_B, padrão esperado na saída de B
  local t0 t1 outB
  psql -X -q -d "$DB" >/tmp/conc_A.out 2>&1 <<SQL &
$AS_USER
begin;
$2;
select pg_sleep(2);
commit;
SQL
  sleep 0.7
  t0=$(date +%s.%N)
  outB="$(psql -X -q -d "$DB" 2>&1 <<SQL
$AS_USER
$3;
SQL
)"
  t1=$(date +%s.%N)
  wait
  local waited; waited=$(awk "BEGIN{print ($t1-$t0>0.9)?\"sim\":\"NAO\"}")
  if grep -q -- "$4" <<<"$outB" && [[ "$waited" == "sim" ]] && ! grep -q ERROR /tmp/conc_A.out; then
    echo "PASS $1 (B esperou a trava: $waited; B -> $(grep -o -m1 -- "$4" <<<"$outB"))"; pass=$((pass+1))
  else
    echo "FAIL $1 (B esperou: $waited)"; echo "  A: $(tr '\n' ' ' </tmp/conc_A.out)"; echo "  B: $(tr '\n' ' ' <<<"$outB")"; fail=$((fail+1))
  fi
}

a1=$(A a1); a2=$(A a2); a3=$(A a3); a4=$(A a4); a5=$(A a5); a6=$(A a6); a7=$(A a7); a8=$(A a8)

race "C1 reclassificar (A) x marcar pendente (B): B recusado 22023" \
  "select reclassify_appointment_as_no_show('$a1')" "select mark_appointment_payment_pending('$a1')" "22023"
check "C1 estado final: 0 recebimentos, não compareceu" \
  "not exists (select 1 from payments where appointment_id = '$a1') and (select status from appointments where id = '$a1') = 'nao_compareceu'"

race "C2 marcar pendente (A) x reclassificar (B): B recusado AUR02" \
  "select mark_appointment_payment_pending('$a2')" "select reclassify_appointment_as_no_show('$a2')" "AUR02"
check "C2 estado final: 1 recebimento pendente, concluído" \
  "(select count(*) from payments where appointment_id = '$a2' and status = 'pendente') = 1 and (select status from appointments where id = '$a2') = 'concluido'"

race "C3 reclassificar duas vezes ao mesmo tempo: a 2ª recusada 22023" \
  "select reclassify_appointment_as_no_show('$a3')" "select reclassify_appointment_as_no_show('$a3')" "22023"
check "C3 estado final: 0 recebimentos e UMA entrada de histórico 'nao_compareceu'" \
  "not exists (select 1 from payments where appointment_id = '$a3') and (select count(*) from appointment_status_history where appointment_id = '$a3' and status = 'nao_compareceu') = 1"

race "C4 concluir (A) x cancelar pela tela desatualizada (B): B recusado 22023" \
  "select conclude_appointment('$a7', 100, 'pix')" "update appointments set status = 'cancelado' where id = '$a7'" "22023"
check "C4 estado final: concluído com exatamente 1 recebimento" \
  "(select count(*) from payments where appointment_id = '$a7') = 1 and (select status from appointments where id = '$a7') = 'concluido'"

race "C5 marcar pendente duas vezes ao mesmo tempo: a 2ª é inofensiva (changed=false)" \
  "select mark_appointment_payment_pending('$a4')" "select mark_appointment_payment_pending('$a4')" '"changed": false'
check "C5 estado final: 1 recebimento pendente" \
  "(select count(*) from payments where appointment_id = '$a4') = 1 and (select status from payments where appointment_id = '$a4') = 'pendente'"

# ------------------------------------------------- COMMIT real (não simulado)
out="$(psql -X -q -d "$DB" 2>&1 <<SQL
$AS_USER
begin;
delete from payments where appointment_id = '$a5';
commit;
SQL
)"
if grep -q "23514" <<<"$out"; then echo "PASS C6 COMMIT real: owner apagando o recebimento de um concluído é desfeito (23514)"; pass=$((pass+1)); else echo "FAIL C6: $out"; fail=$((fail+1)); fi
check "C6 estado final: recebimento preservado" "(select count(*) from payments where appointment_id = '$a5') = 1"

out="$(psql -X -q -d "$DB" 2>&1 <<SQL
\\set VERBOSITY verbose
begin;
update appointments set status = 'concluido' where id = '$a8';
commit;
SQL
)"
if grep -q "23514" <<<"$out"; then echo "PASS C7 COMMIT real: dono do banco (SQL Editor) concluindo sem recebimento é desfeito (23514)"; pass=$((pass+1)); else echo "FAIL C7: $out"; fail=$((fail+1)); fi
check "C7 estado final: continua em aberto" "(select status from appointments where id = '$a8') = 'agendado'"

check "G  nenhum atendimento com mais de 1 recebimento" \
  "not exists (select 1 from payments where appointment_id is not null group by appointment_id having count(*) > 1)"
check "G  invariante global: concluído <=> tem recebimento (todos os atendimentos deste banco)" \
  "not exists (select 1 from appointments a where (a.status = 'concluido') <> exists (select 1 from payments p where p.appointment_id = a.id))"

echo "RESULTADO concorrência 0014: PASS=$pass FAIL=$fail"
dropdb "$DB"
[[ $fail -eq 0 ]]
