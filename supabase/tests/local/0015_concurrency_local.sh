#!/usr/bin/env bash
# ============================================================================
# 0015 — concorrência real (duas sessões) e COMMIT real. SOMENTE LOCAL.
# Banco descartável criado do zero (0001–0015) e apagado no fim.
# Cada cenário usa um DIA próprio de junho/2020 e roda a automação só para
# aquele dia ("agora" = 12:00 SP, início da janela = 00:00 SP do dia).
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DB="aurea_conc_0015"
export PGOPTIONS="-c client_min_messages=warning"
"$HERE/fresh_db.sh" "$DB" 0015 >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
Q() { psql -X -q -A -t -d "$DB" -c "$1"; }
UID_A="$(Q "select id from auth.users order by created_at limit 1")"
AS_USER="set request.jwt.claim.sub = '$UID_A'; set role authenticated;"

Q "insert into companies (name) values ('ZZ-CONC-15')" >/dev/null
CO=$(Q "select id from companies where name = 'ZZ-CONC-15'")
Q "insert into company_members (company_id, user_id, role) values ('$CO', '$UID_A', 'owner')" >/dev/null
MEM=$(Q "select id from company_members where company_id = '$CO'")
Q "insert into services (company_id, name, price) values ('$CO', 'S', 100)" >/dev/null
SVC=$(Q "select id from services where company_id = '$CO'")
# mk <rótulo> <dia> <hora início> <hora fim> : atendimento com cliente própria
mk() {
  Q "with c as (insert into clients (company_id, name) values ('$CO', 'C-$1') returning id)
     insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end, notes)
     select '$CO', c.id, '$SVC', '$MEM', 100, timestamptz '2020-06-$2 $3:00-03', timestamptz '2020-06-$2 $4:00-03', '$1' from c returning id"
}
run_day() { echo "select aurea_private._run('2020-06-$1 12:00:00-03', '2020-06-$1 00:00:00-03', null, true)"; }

pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
ko() { echo "FAIL $1"; fail=$((fail+1)); }
check() { [[ "$(Q "select ($2)")" == "t" ]] && ok "$1" || ko "$1"; }
# race <nome> <A como usuária 1/0> <sql A> <B como usuária 1/0> <sql B> <padrão esperado em B>
# A segura a transação 2 s; B começa 0,7 s depois.
race() {
  local preA="" preB="" t0 t1 outB
  [[ "$2" == 1 ]] && preA="$AS_USER"; [[ "$4" == 1 ]] && preB="$AS_USER"
  psql -X -q -d "$DB" >/tmp/c15_A.out 2>&1 <<SQL &
$preA
\set VERBOSITY verbose
begin;
$3;
select pg_sleep(2);
commit;
SQL
  sleep 0.7
  outB="$(psql -X -q -d "$DB" 2>&1 <<SQL
$preB
\set VERBOSITY verbose
$5;
SQL
)"
  wait
  if grep -q -- "$6" <<<"$outB" && ! grep -q ERROR /tmp/c15_A.out; then ok "$1 (B -> $6)"
  else ko "$1"; echo "   A: $(tr '\n' ' ' </tmp/c15_A.out | cut -c1-300)"; echo "   B: $(tr '\n' ' ' <<<"$outB" | cut -c1-300)"; fi
}

# E1 — conclusão manual segurando a linha x automação: a automação PULA (SKIP LOCKED), sem esperar nem duplicar
e1=$(mk e1 01 09 10)
race "E1 conclusão manual (A) x automação (B): a automação pula a linha travada" \
  1 "select conclude_appointment('$e1', 90, 'dinheiro')" 0 "$(run_day 01)" '"skipped": 1'
Q "$(run_day 01)" >/dev/null
check "E1 estado: 1 recebimento, o manual (R\$ 90); nova execução não toca" \
  "(select count(*) = 1 and bool_and(source = 'manual' and amount = 90) from payments where appointment_id = '$e1')"

# E2 — automação concluindo (segurando) x cancelar pela tela desatualizada: espera e é recusada
e2=$(mk e2 02 09 10)
race "E2 automação (A) x cancelar com tela desatualizada (B): B espera e é recusada" \
  0 "$(run_day 02)" 1 "update appointments set status = 'cancelado' where id = '$e2'" "22023"
check "E2 estado: concluído com exatamente 1 recebimento auto" \
  "(select status from appointments where id = '$e2') = 'concluido' and (select count(*) from payments where appointment_id = '$e2' and source = 'auto') = 1"

# E3 — duas execuções ao mesmo tempo: a segunda sai como 'busy'
e3=$(mk e3 03 09 10)
race "E3 automação (A) x automação (B): B não roda (busy)" 0 "$(run_day 03)" 0 "$(run_day 03)" '"status": "busy"'
check "E3 estado: 1 recebimento" "(select count(*) from payments where appointment_id = '$e3') = 1"

# E4 — falta registrada (segurando) x automação: a automação pula; depois nunca conclui
e4=$(mk e4 04 09 10)
race "E4 falta registrada (A) x automação (B): a automação pula a linha" \
  1 "update appointments set status = 'nao_compareceu' where id = '$e4'" 0 "$(run_day 04)" '"skipped": 1'
Q "$(run_day 04)" >/dev/null
check "E4 estado: falta, sem recebimento, mesmo depois de nova execução" \
  "(select status from appointments where id = '$e4') = 'nao_compareceu' and not exists (select 1 from payments where appointment_id = '$e4')"

# E5 — reversão (segurando) x marcar pendente: a profissional espera e recebe 22023 (já não está concluído)
e5=$(mk e5 05 09 10); Q "$(run_day 05)" >/dev/null
R5=$(Q "select run_id from aurea_private.run_items where appointment_id = '$e5' and outcome = 'concluded'")
race "E5 reversão (A) x marcar pendente (B): B espera e é recusada (22023)" \
  0 "select aurea_private.revert_run('$R5', false)" 1 "select mark_appointment_payment_pending('$e5')" "22023"
check "E5 estado: revertido, sem recebimento, excluído da automação" \
  "(select status from appointments where id = '$e5') = 'agendado' and not exists (select 1 from payments where appointment_id = '$e5')
   and (select status from aurea_private.appointment_state where appointment_id = '$e5') = 'excluded'"

# E6 — marcar pendente (segurando) x reversão: a reversão espera e é BLOQUEADA
e6=$(mk e6 06 09 10); Q "$(run_day 06)" >/dev/null
R6=$(Q "select run_id from aurea_private.run_items where appointment_id = '$e6' and outcome = 'concluded'")
race "E6 marcar pendente (A) x reversão (B): a reversão espera e é bloqueada" \
  1 "select mark_appointment_payment_pending('$e6')" 0 "select aurea_private.revert_run('$R6', false)" '"status": "bloqueada"'
check "E6 estado: recebimento pendente preservado" "(select status from payments where appointment_id = '$e6') = 'pendente'"

# E7 — correção CONCORRENTE com horário ANTERIOR ao da automação: detectada pela contagem
e7=$(mk e7 07 09 10)
psql -X -q -d "$DB" >/tmp/c15_A.out 2>&1 <<SQL &
$AS_USER
begin;
select now();
select pg_sleep(1);
update appointments set notes = 'corrigido durante a automação' where id = '$e7';
commit;
SQL
sleep 0.3
psql -X -q -d "$DB" >/dev/null 2>&1 <<SQL
begin;
$(run_day 07);
select pg_sleep(2);
commit;
SQL
wait
R7=$(Q "select run_id from aurea_private.run_items where appointment_id = '$e7' and outcome = 'concluded'")
check "E7 a edição concorrente ficou com horário ANTERIOR ao da automação (por horário, passaria despercebida)" \
  "(select max(created_at) from audit_logs where entity = 'appointments' and entity_id = '$e7' and metadata->'after'->>'notes' = 'corrigido durante a automação')
     < (select started_at from aurea_private.runs where id = '$R7')"
check "E7 ... mas a reversão a detecta pela contagem e bloqueia" \
  "(aurea_private.revert_run('$R7', false) ->> 'status') = 'bloqueada' and (select status from appointments where id = '$e7') = 'concluido'"

# E8 — cancelado e reaberto pela API: nunca concluído
e8=$(mk e8 08 09 10)
psql -X -q -d "$DB" >/dev/null 2>&1 <<SQL
$AS_USER
update appointments set status = 'cancelado' where id = '$e8';
update appointments set status = 'agendado' where id = '$e8';
SQL
Q "$(run_day 08)" >/dev/null
check "E8 cancelado e reaberto pela API: nunca concluído" "(select status from appointments where id = '$e8') = 'agendado'"

check "G  invariante global: concluído <=> tem recebimento (todos os atendimentos deste banco)" \
  "not exists (select 1 from appointments a where (a.status = 'concluido') <> exists (select 1 from payments p where p.appointment_id = a.id))"
check "G  nenhum atendimento com mais de 1 recebimento" \
  "not exists (select 1 from payments where appointment_id is not null group by appointment_id having count(*) > 1)"

echo "RESULTADO concorrência 0015: PASS=$pass FAIL=$fail"
dropdb "$DB"
[[ $fail -eq 0 ]]
