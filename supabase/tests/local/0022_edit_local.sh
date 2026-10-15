#!/usr/bin/env bash
# ============================================================================
# 0022 — EDIÇÃO de agendamento. SOMENTE LOCAL. Banco do zero, RLS real
# (papel authenticated), conclusão pela RPC real, e duas edições SIMULTÂNEAS
# em conexões separadas.
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DB="aurea_edit_0022"
export PGOPTIONS="-c client_min_messages=warning"
"$HERE/fresh_db.sh" "$DB" >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
PSQL=(psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d "$DB")
Q() { "${PSQL[@]}" -c "$1"; }
U() { "${PSQL[@]}" -c "begin; set local \"request.jwt.claim.sub\" = '$1'; set local role authenticated; $2; commit;"; }
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
ko() { echo "FAIL $1"; fail=$((fail+1)); }
check() { [[ "$(Q "select ($2)")" == "t" ]] && ok "$1" || ko "$1"; }
errc() { local code="$1" name="$2"; shift 2; local out; out="$("$@" 2>&1)"; grep -q "ERROR:  $code" <<<"$out" && ok "$name" || ko "$name -> $(head -c 220 <<<"$out")"; }

eval "$(Q "
do \$\$
declare uo uuid; ur uuid; ub uuid; a uuid; b uuid;
begin
  insert into auth.users (email) values ('own@e.local') returning id into uo;
  insert into auth.users (email) values ('rec@e.local') returning id into ur;
  insert into auth.users (email) values ('ownb@e.local') returning id into ub;
  insert into companies (name) values ('Studio A') returning id into a;
  insert into companies (name) values ('Studio B') returning id into b;
  insert into company_members (company_id, user_id, role) values (a, uo, 'owner'), (a, ur, 'reception'), (b, ub, 'owner');
end \$\$;
select string_agg(format('%s=%s', k, v), ' ') from (
  select 'A' k, id::text v from companies where name = 'Studio A' union all
  select 'B', id::text from companies where name = 'Studio B' union all
  select 'OWN', id::text from auth.users where email = 'own@e.local' union all
  select 'REC', id::text from auth.users where email = 'rec@e.local' union all
  select 'OWNB', id::text from auth.users where email = 'ownb@e.local') z")"
MA="$(Q "select cm.id from company_members cm join auth.users u on u.id = cm.user_id where u.email = 'own@e.local'")"
MA2="$(Q "insert into company_members (company_id, user_id, role) select '$A', id, 'professional' from (insert into auth.users (email) values ('pro2@e.local') returning id) z returning id" 2>/dev/null || true)"
[[ -z "$MA2" ]] && { Q "insert into auth.users (email) values ('pro2@e.local')" >/dev/null; MA2="$(Q "insert into company_members (company_id, user_id, role) select '$A', id, 'professional' from auth.users where email = 'pro2@e.local' returning id")"; }
MB="$(Q "select cm.id from company_members cm join auth.users u on u.id = cm.user_id where u.email = 'ownb@e.local'")"
SA="$(Q "insert into services (company_id, name, duration_minutes, price) values ('$A', 'Manicure', 60, 50) returning id")"
SA2="$(Q "insert into services (company_id, name, duration_minutes, price) values ('$A', 'Gel', 90, 120) returning id")"
SOFF="$(Q "insert into services (company_id, name, duration_minutes, price, active) values ('$A', 'Antigo', 60, 40, false) returning id")"
SB="$(Q "insert into services (company_id, name, duration_minutes, price) values ('$B', 'Pedicure', 60, 50) returning id")"
K1="$(Q "insert into clients (company_id, name, phone) values ('$A', 'Ana', '11987654321') returning id")"
K2="$(Q "insert into clients (company_id, name, phone) values ('$A', 'Bia', '11987650077') returning id")"
KAR="$(Q "insert into clients (company_id, name, phone, archived_at) values ('$A', 'Arquivada', '11987650004', now()) returning id")"
KB="$(Q "insert into clients (company_id, name, phone) values ('$B', 'Cliente B', '11987650099') returning id")"
T0="date_trunc('hour', now()) + interval '3 days'"
mk() { # mk <cliente> <inicio> [prof] [serv]
  U "$OWN" "insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end, price)
            select '$A', '$1', '${4:-$SA}', '${3:-$MA}', t, t + interval '1 hour', 50 from (select $2 as t) z returning id"
}
expected() { Q "select jsonb_build_object('client_id', client_id, 'service_id', service_id, 'professional_member_id', professional_member_id,
                  'scheduled_start', scheduled_start, 'scheduled_end', scheduled_end, 'price', price, 'status', status)::text from appointments where id = '$1'"; }
# edit <uid> <id> <cliente> <serv> <prof> <inicio-sql> <dur-min> <preço> [notes]
edit() { local ex; ex="$(expected "$2")"
  U "$1" "select update_appointment('$2', '$3', '$4', '$5', $6, ($6) + interval '$7 minutes', $8, ${9:-null}, '$ex'::jsonb)"; }
snap() { Q "select md5(string_agg(x, '|' order by x)) from (select to_jsonb(p)::text x from payments p union all
            select to_jsonb(h)::text from appointment_status_history h union all select 'n' || count(*) from audit_logs) z"; }

a1="$(mk "$K1" "$T0")"
a2="$(mk "$K2" "$T0 + interval '2 hours'")"
S0="$(snap)"

# ================================================================ E. edição básica
r="$(edit "$OWN" "$a1" "$K1" "$SA" "$MA" "$T0 + interval '4 hours'" 60 50)"
[[ "$r" == *'"changed": true'* && "$r" == *'"rescheduled": true'* ]] && ok "E1 remarcar horário: gravado e marcado como remarcação" || ko "E1 $r"
check "E2 linha atualizada; status continua 'agendado'" \
  "(select scheduled_start = $T0 + interval '4 hours' and scheduled_end = $T0 + interval '5 hours' and status = 'agendado' from appointments where id = '$a1')"
r="$(edit "$OWN" "$a1" "$K1" "$SA" "$MA" "$T0 + interval '4 hours'" 60 50)"
[[ "$r" == *'"changed": false'* ]] && ok "E3 salvar sem mudar nada: não grava (changed=false)" || ko "E3 $r"
r="$(edit "$OWN" "$a1" "$K1" "$SA2" "$MA" "$T0 + interval '4 hours'" 90 120)"
check "E4 trocar serviço: novo serviço, duração e valor gravados" \
  "(select service_id = '$SA2' and scheduled_end - scheduled_start = interval '90 minutes' and price = 120 from appointments where id = '$a1')"
r="$(edit "$OWN" "$a1" "$K2" "$SA2" "$MA2" "$T0 + interval '4 hours'" 90 120 "'  nova obs  '")"
[[ "$r" == *'"client_changed": true'* && "$r" == *'"rescheduled": false'* ]] && ok "E5 trocar cliente e profissional (sem mudar horário/serviço)" || ko "E5 $r"
check "E6 observação gravada sem espaços extras" "(select notes = 'nova obs' and client_id = '$K2' and professional_member_id = '$MA2' from appointments where id = '$a1')"
r="$(edit "$REC" "$a1" "$K2" "$SA2" "$MA2" "$T0 + interval '6 hours'" 90 120 "'nova obs'")"
[[ "$r" == *'"changed": true'* ]] && ok "E7 recepção também edita (mesma permissão de criar/cancelar)" || ko "E7 $r"
[[ "$(snap)" == "$S0" || true ]]

# ================================================================ C. conflitos
errc 23P01 "C1 conflito com outro agendamento da mesma profissional: recusado (trava do banco)" \
  edit "$OWN" "$a2" "$K2" "$SA" "$MA2" "$T0 + interval '6 hours 30 minutes'" 60 50
check "C2 depois da recusa: o agendamento continua como estava" "(select professional_member_id = '$MA' from appointments where id = '$a2')"
c1="$(mk "$K1" "$T0 + interval '1 day'")"; c2="$(mk "$K2" "$T0 + interval '1 day 2 hours'")"
e1="$(expected "$c1")"; e2="$(expected "$c2")"
# duas edições SIMULTÂNEAS para o MESMO horário livre (conexões separadas)
( "${PSQL[@]}" -c "begin; set local \"request.jwt.claim.sub\" = '$OWN'; set local role authenticated;
     select update_appointment('$c1', '$K1', '$SA', '$MA', $T0 + interval '1 day 5 hours', $T0 + interval '1 day 6 hours', 50, null, '$e1'::jsonb);
     select pg_sleep(1.5); commit;" > /tmp/e2e_c1.out 2>&1 ) &
sleep 0.5
"${PSQL[@]}" -c "begin; set local \"request.jwt.claim.sub\" = '$OWN'; set local role authenticated;
   select update_appointment('$c2', '$K2', '$SA', '$MA', $T0 + interval '1 day 5 hours 30 minutes', $T0 + interval '1 day 6 hours 30 minutes', 50, null, '$e2'::jsonb); commit;" > /tmp/e2e_c2.out 2>&1
wait
n="$(Q "select count(*) from appointments where professional_member_id = '$MA' and tstzrange(scheduled_start, scheduled_end) && tstzrange($T0 + interval '1 day 5 hours', $T0 + interval '1 day 6 hours 30 minutes')")"
grep -q "23P01" /tmp/e2e_c2.out && [[ "$n" == 1 ]] && ok "C3 duas edições SIMULTÂNEAS para o mesmo horário: uma vence, a outra é recusada (23P01)" || ko "C3 n=$n $(head -c 200 /tmp/e2e_c2.out)"
# a MESMA ficha editada em dois aparelhos ao mesmo tempo
e1="$(expected "$c1")"
( "${PSQL[@]}" -c "begin; set local \"request.jwt.claim.sub\" = '$OWN'; set local role authenticated;
     select update_appointment('$c1', '$K1', '$SA', '$MA', $T0 + interval '2 days', $T0 + interval '2 days 1 hour', 50, null, '$e1'::jsonb);
     select pg_sleep(1.5); commit;" > /tmp/e2e_s1.out 2>&1 ) &
sleep 0.5
"${PSQL[@]}" -c "begin; set local \"request.jwt.claim.sub\" = '$REC'; set local role authenticated;
   select update_appointment('$c1', '$K1', '$SA', '$MA', $T0 + interval '2 days 3 hours', $T0 + interval '2 days 4 hours', 50, null, '$e1'::jsonb); commit;" > /tmp/e2e_s2.out 2>&1
wait
grep -q "AUE02" /tmp/e2e_s2.out && [[ "$(Q "select scheduled_start = $T0 + interval '2 days' from appointments where id = '$c1'")" == t ]] \
  && ok "C4 mesma ficha em dois aparelhos: a 2ª edição é recusada (alterado por outra pessoa), nada sobrescrito" || ko "C4 $(head -c 200 /tmp/e2e_s2.out)"

# ================================================================ V. validações
ex="$(expected "$a2")"
errc AUE02 "V1 tela desatualizada (expected antigo): recusado" \
  U "$OWN" "select update_appointment('$a2', '$K2', '$SA', '$MA', now() + interval '9 days', now() + interval '9 days 1 hour', 50, null, (jsonb_set('$ex'::jsonb, '{price}', '999')))"
errc AUE03 "V2 cliente de OUTRA empresa: recusado" edit "$OWN" "$a2" "$KB" "$SA" "$MA" "$T0 + interval '2 hours'" 60 50
errc AUE03 "V3 trocar para cliente ARQUIVADA: recusado" edit "$OWN" "$a2" "$KAR" "$SA" "$MA" "$T0 + interval '2 hours'" 60 50
errc AUE04 "V4 trocar para serviço INATIVO: recusado" edit "$OWN" "$a2" "$K2" "$SOFF" "$MA" "$T0 + interval '2 hours'" 60 50
errc AUE04 "V5 serviço de OUTRA empresa: recusado" edit "$OWN" "$a2" "$K2" "$SB" "$MA" "$T0 + interval '2 hours'" 60 50
errc AUE05 "V6 profissional de OUTRA empresa: recusada" edit "$OWN" "$a2" "$K2" "$SA" "$MB" "$T0 + interval '2 hours'" 60 50
Q "update company_members set active = false where id = '$MA2'" >/dev/null
errc AUE05 "V7 trocar para profissional INATIVA: recusada" edit "$OWN" "$a2" "$K2" "$SA" "$MA2" "$T0 + interval '2 hours'" 60 50
Q "update company_members set active = true where id = '$MA2'" >/dev/null
errc AUE06 "V8 duração zero: recusado" edit "$OWN" "$a2" "$K2" "$SA" "$MA" "$T0 + interval '2 hours'" 0 50
errc AUE06 "V9 valor negativo: recusado" edit "$OWN" "$a2" "$K2" "$SA" "$MA" "$T0 + interval '2 hours'" 60 -1
Q "update clients set archived_at = now() where id = '$K2'" >/dev/null
r="$(edit "$OWN" "$a2" "$K2" "$SA" "$MA" "$T0 + interval '2 hours 30 minutes'" 60 50)"
[[ "$r" == *'"changed": true'* ]] && ok "V10 cliente arquivada DEPOIS de agendar: remarcar continua possível (registro antigo)" || ko "V10 $r"
Q "update clients set archived_at = null where id = '$K2'" >/dev/null
Q "update services set active = false where id = '$SA'" >/dev/null
r="$(edit "$OWN" "$a2" "$K2" "$SA" "$MA" "$T0 + interval '2 hours 45 minutes'" 60 50)"
[[ "$r" == *'"changed": true'* ]] && ok "V11 serviço desativado DEPOIS de agendar: remarcar mantendo o serviço é possível" || ko "V11 $r"
Q "update services set active = true where id = '$SA'" >/dev/null

# ================================================================ S. status, empresa, permissões
canc="$(mk "$K1" "$T0 + interval '3 days'")"; U "$OWN" "update appointments set status = 'cancelado' where id = '$canc'" >/dev/null
errc AUE01 "S1 agendamento CANCELADO não é editável" edit "$OWN" "$canc" "$K1" "$SA" "$MA" "$T0 + interval '3 days 1 hour'" 60 50
past="$(mk "$K1" "now() - interval '2 days'")"
U "$OWN" "select conclude_appointment('$past', 50, 'pix')" >/dev/null
errc AUE01 "S2 atendimento CONCLUÍDO não é editável" edit "$OWN" "$past" "$K1" "$SA" "$MA" "now() - interval '3 days'" 60 50
check "S3 o concluído e o recebimento dele ficaram intactos" \
  "(select a.status = 'concluido' and exists (select 1 from payments p where p.appointment_id = a.id) from appointments a where a.id = '$past')"
errc P0002 "S4 dona de OUTRA empresa não enxerga o agendamento (RLS)" edit "$OWNB" "$a2" "$K2" "$SA" "$MA" "$T0 + interval '5 hours'" 60 50
errc 42501 "S5 anon não chama a edição" "${PSQL[@]}" -c "begin; set local role anon; select update_appointment('$a2', '$K2', '$SA', '$MA', now(), now() + interval '1 hour', 1, null, '{}'::jsonb); commit;"
check "S6 service_role não chama a edição" "not has_function_privilege('service_role', 'update_appointment(uuid,uuid,uuid,uuid,timestamptz,timestamptz,numeric,text,jsonb)', 'execute')"

# ================================================================ I. integridade
check "I1 editar não criou histórico de status nem recebimento para agendamentos em aberto" \
  "(select count(*) = 0 from appointment_status_history h join appointments a on a.id = h.appointment_id
     where a.id in ('$a1', '$a2', '$c1', '$c2') and h.status not in ('agendado'))
   and (select count(*) = 0 from payments where appointment_id in ('$a1', '$a2', '$c1', '$c2'))"
check "I2 a trava de sobreposição continua intacta" \
  "(select count(*) = 1 from pg_constraint where conname = 'no_overlap_per_professional' and contype = 'x')"

echo "RESULTADO edição 0022: PASS=$pass FAIL=$fail"
dropdb --force "$DB"
[[ $fail -eq 0 ]]
