#!/usr/bin/env bash
# 0034 — corrigir a CLIENTE de atendimento concluído. SOMENTE LOCAL. Banco até a 0033.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"; DB="aurea_0034"
export PGOPTIONS="-c client_min_messages=warning"
"$HERE/fresh_db.sh" "$DB" 0033 >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
PSQL=(psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d "$DB")
Q() { "${PSQL[@]}" -c "$1"; }
U() { "${PSQL[@]}" -c "begin; set local \"request.jwt.claim.sub\" = '$1'; set local role authenticated; $2; commit;"; }
OPS="$ROOT/operations/0034_aplicacao_supabase.sql"; blk() { sed -n "/^-- \[$1\]/,/^-- \[\/$1\]/p" "$OPS"; }
B() { psql -X -q -A -F'|' -t -d "$DB" -c "$(blk "$1")" 2>&1; }
pass=0; fail=0; ok() { echo "PASS $1"; pass=$((pass+1)); }; ko() { echo "FAIL $1"; fail=$((fail+1)); }
check() { [[ "$(Q "select ($2)")" == "t" ]] && ok "$1" || ko "$1"; }
errc() { local code="$1" name="$2"; shift 2; local out; out="$("$@" 2>&1)"; grep -q "ERROR:  $code" <<<"$out" && ok "$name" || ko "$name -> $(head -c 200 <<<"$out")"; }
eval "$(Q "do \$\$ declare uo uuid; up uuid; a uuid; b uuid; begin
  insert into auth.users (email) values ('own@k.local') returning id into uo; insert into auth.users (email) values ('pro@k.local') returning id into up;
  insert into companies (name) values ('Studio A') returning id into a; insert into companies (name) values ('Studio B') returning id into b;
  insert into company_members (company_id, user_id, role) values (a, uo, 'owner'), (a, up, 'professional');
end \$\$; select format('A=%s B=%s OWN=%s PRO=%s', (select id from companies where name='Studio A'), (select id from companies where name='Studio B'),
  (select id from auth.users where email='own@k.local'), (select id from auth.users where email='pro@k.local'))")"
MA="$(Q "select cm.id from company_members cm join auth.users u on u.id = cm.user_id where u.email = 'own@k.local'")"
SA="$(Q "insert into services (company_id, name, duration_minutes, price) values ('$A', 'Manicure', 60, 50) returning id")"
K1="$(Q "insert into clients (company_id, name, phone) values ('$A', 'Ana Errada', '11987654321') returning id")"
K2="$(Q "insert into clients (company_id, name, phone) values ('$A', 'Bia Certa', '11987650077') returning id")"
KAR="$(Q "insert into clients (company_id, name, phone, archived_at) values ('$A', 'Arquivada', '11987650004', now()) returning id")"
KB="$(Q "insert into clients (company_id, name, phone) values ('$B', 'Da B', '11987650099') returning id")"
Q "update whatsapp_private.settings set auto_confirmation_enabled = true, reminder_enabled = true, change_notices_enabled = true;
   insert into whatsapp_private.sessions (company_id, status, phone, last_seen_at, lease_owner, lease_until, connected_at)
   values ('$A', 'connected', '5511900000000', now(), 'w1', now() + interval '10 minutes', now())" >/dev/null
a1="$(U "$OWN" "insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end, price)
                values ('$A', '$K1', '$SA', '$MA', now() - interval '3 days', now() - interval '3 days' + interval '1 hour', 50) returning id")"
U "$OWN" "select conclude_appointment('$a1', 50, 'pix')" >/dev/null
DAY="((now() - interval '3 days') at time zone 'America/Sao_Paulo')::date"
F0="$(Q "select faturado || '/' || recebido from get_period_indicators('$A', $DAY, $DAY)")"
O0="$(Q "select count(*) from whatsapp_private.outbox")"
[[ "$(B B0)" == "10" ]] && ok "B0 antes: 10 parâmetros" || ko "B0 $(B B0)"
psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/0034_edit_concluded_client.sql" >/dev/null 2>&1 && ok "B2 0034 aplicada" || ko "B2"
[[ "$(B B3)" == "11|0" ]] && ok "B3 depois: $(B B3)" || ko "B3 $(B B3)"
exp() { Q "select jsonb_build_object('client_id', a.client_id, 'service_id', a.service_id, 'professional_member_id', a.professional_member_id, 'scheduled_start', a.scheduled_start,
           'scheduled_end', a.scheduled_end, 'price', a.price, 'status', a.status, 'payment_status', p.status)::text from appointments a join payments p on p.appointment_id = a.id where a.id = '$a1'"; }
ed() { local ex; ex="$(exp)"; U "$1" "select edit_concluded_appointment('$a1', '$SA', '$MA', a.scheduled_start, a.scheduled_end, 50, 'pago', 'pix', null, '$ex'::jsonb $2) from appointments a where a.id = '$a1'"; }
r="$(ed "$OWN" "")"
[[ "$r" == *'"changed": false'* ]] && ok "C0 chamada da tela ANTIGA (sem cliente) continua funcionando" || ko "C0 $r"
errc 42501 "C1 profissional NÃO corrige a cliente de concluído" ed "$PRO" ", '$K2'"
errc AUE03 "C2 cliente de OUTRA empresa: recusada" ed "$OWN" ", '$KB'"
errc AUE03 "C3 cliente arquivada: recusada" ed "$OWN" ", '$KAR'"
errc AUE02 "C4 tela desatualizada (cliente mudou nesse meio-tempo): recusado" \
  U "$OWN" "select edit_concluded_appointment('$a1', '$SA', '$MA', a.scheduled_start, a.scheduled_end, 50, 'pago', 'pix', null, jsonb_set('$(exp)'::jsonb, '{client_id}', to_jsonb('$K2'::text)), '$K2') from appointments a where a.id = '$a1'"
r="$(ed "$OWN" ", '$K2'")"
[[ "$r" == *'"client_changed": true'* ]] && ok "C5 dona corrige a cliente do atendimento concluído" || ko "C5 $r"
check "C6 atendimento E recebimento passam para a cliente certa" \
  "(select a.client_id = '$K2' and p.client_id = '$K2' from appointments a join payments p on p.appointment_id = a.id where a.id = '$a1')"
check "C7 visitas: a cliente certa ganha a visita; a errada fica sem (não tinha outra)" \
  "(select first_visit_at = $DAY and last_visit_at = $DAY from clients where id = '$K2') and (select first_visit_at is null and last_visit_at is null from clients where id = '$K1')"
[[ "$(Q "select faturado || '/' || recebido from get_period_indicators('$A', $DAY, $DAY)")" == "$F0" ]] && ok "C8 Financeiro do dia não muda (só a cliente)" || ko "C8"
[[ "$(Q "select count(*) from whatsapp_private.outbox")" == "$O0" ]] && ok "C9 nenhuma mensagem para nenhuma das duas clientes" || ko "C9"
FN="select md5(p.prosrc || coalesce(p.proacl::text,'')) from pg_proc p where p.proname = 'edit_concluded_appointment'"
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "$(blk BR-SQL)" >/dev/null 2>&1 && ok "BR reversão executada" || ko "BR"
[[ "$(B B0)" == "10" ]] && ok "BR voltou à função da 0030 (10 parâmetros)" || ko "BR"
echo "RESULTADO 0034: PASS=$pass FAIL=$fail"; dropdb --force "$DB"; [[ $fail -eq 0 ]]
