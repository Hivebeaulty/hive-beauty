#!/usr/bin/env bash
# ============================================================================
# 0056 — lembrete no celular dos compromissos da agenda (blocked_times). SOMENTE LOCAL.
# ============================================================================
set -uo pipefail
export PGOPTIONS="-c client_min_messages=warning"; DB=aurea_0056; R="$(cd "$(dirname "$0")/../.." && pwd)"
bash $R/tests/local/fresh_db.sh $DB 0055 >/dev/null
Q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d $DB -c "$1" 2>&1; }
SR() { psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d $DB -c "begin; set local role service_role; $1; commit;" 2>&1; }
U() { psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d $DB -c "begin;
  set local \"request.jwt.claims\" = '{\"sub\":\"$1\",\"role\":\"authenticated\"}';
  set local role authenticated; $2; commit;" 2>&1; }
pass=0; fail=0; ok() { echo "PASS $1"; pass=$((pass+1)); }; ko() { echo "FAIL $1"; fail=$((fail+1)); }
has() { [[ "$1" == *"$2"* ]]; }

# --- cenário: empresa C (A e B com aparelho, C sem), empresa inativa X, membro inativo ---------
Q "do \$\$ declare uA uuid; uB uuid; uC uuid; uD uuid; uE uuid; c uuid; x uuid; begin
  insert into auth.users (email) values ('a@r.com') returning id into uA;
  insert into auth.users (email) values ('b@r.com') returning id into uB;
  insert into auth.users (email) values ('c@r.com') returning id into uC;
  insert into auth.users (email) values ('d@r.com') returning id into uD;
  insert into auth.users (email) values ('e@r.com') returning id into uE;
  insert into companies (name, status) values ('Studio', 'ativa') returning id into c;
  insert into companies (name, status) values ('Parada', 'inativa') returning id into x;
  insert into company_members (company_id, user_id, role) values (c, uA, 'owner'), (c, uB, 'professional'), (c, uC, 'professional');
  insert into company_members (company_id, user_id, role, active) values (c, uE, 'professional', false);
  insert into company_members (company_id, user_id, role) values (x, uD, 'owner');
  insert into push_subscriptions (user_id, endpoint, p256dh, auth_key) values
    (uA, 'https://push.example/a-1-aaaaaaaaaaaa', 'p256dh-aaaaaaaaaaaaaaaaaaaa', 'auth-aaaa'),
    (uA, 'https://push.example/a-2-aaaaaaaaaaaa', 'p256dh-aaaaaaaaaaaaaaaaaaaa', 'auth-aaaa'),
    (uB, 'https://push.example/b-1-bbbbbbbbbbbb', 'p256dh-bbbbbbbbbbbbbbbbbbbb', 'auth-bbbb'),
    (uD, 'https://push.example/d-1-dddddddddddd', 'p256dh-dddddddddddddddddddd', 'auth-dddd'),
    (uE, 'https://push.example/e-1-eeeeeeeeeeee', 'p256dh-eeeeeeeeeeeeeeeeeeee', 'auth-eeee');
end \$\$" >/dev/null
C=$(Q "select id from companies where name='Studio'"); X=$(Q "select id from companies where name='Parada'")
mem() { Q "select m.id from company_members m join auth.users u on u.id = m.user_id where u.email = '$1'"; }
MA=$(mem a@r.com); MB=$(mem b@r.com); MC=$(mem c@r.com); ME=$(mem e@r.com); MD=$(mem d@r.com)
UA=$(Q "select id from auth.users where email='a@r.com'"); UC=$(Q "select id from auth.users where email='c@r.com'")
# blk <empresa> <membro|null> <início em min a partir de agora> <duração min> <lembrar min|null> [observação]
blk() { local m="${2:-null}"; [[ "$m" != null ]] && m="'$m'"
  Q "insert into blocked_times (company_id, professional_member_id, start_at, end_at, reason, remind_before_minutes)
     values ('$1', $m, now() + interval '$3 minutes', now() + interval '$3 minutes' + interval '$4 minutes', '${6:-Almoço}', $5) returning id"; }
CLAIM() { SR "select alert_block_id, alert_all_day, alert_reason, alert_before, jsonb_array_length(subs) from push_claim_due_block_reminders() order by alert_reason"; }

psql -X -q -1 -v ON_ERROR_STOP=1 -d $DB -f $R/migrations/0056_blocked_time_reminders.sql >/dev/null 2>/tmp/0056.err && ok "0056 aplicada" || ko "0056: $(cat /tmp/0056.err)"
psql -X -q -1 -v ON_ERROR_STOP=1 -d $DB -f $R/migrations/0056_blocked_time_reminders.sql >/dev/null 2>/tmp/0056b.err && ok "0056 reaplicada sem erro" || ko "0056 de novo: $(cat /tmp/0056b.err)"
[[ "$(Q "select count(*) from blocked_times where remind_before_minutes is not null")" == "0" ]] && ok "D1 nada existente ganhou lembrete" || ko "D1"

# --- quem e quando ---------------------------------------------------------------------------------
B1=$(blk $C $MA 20 60 30 "Almoço da Ana")                # aviso era 10 min atrás: na hora
B2=$(blk $C $MA 60 60 30 "Dentista")                     # aviso só daqui a 30 min
B3=$(blk $C $MA 10 60 30 "Perdeu a hora")                # aviso era 20 min atrás (passou de 15)
B4=$(blk $C $MA 20 60 null "Sem lembrete")
out=$(CLAIM)
has "$out" "$B1|f|Almoço da Ana|30|2" && ok "L1 chegou na hora: bloqueio da Ana, horário (não dia todo), 30 min antes, 2 aparelhos dela" || ko "L1 $out"
[[ "$(echo "$out" | grep -c .)" == "1" ]] && ok "L2 só esse: o futuro, o atrasado (>15 min) e o sem lembrete ficam de fora" || ko "L2 $out"
[[ -z "$(CLAIM)" ]] && ok "L3 segunda rodada não repete" || ko "L3"
[[ "$(Q "select count(*) from push_block_alert_log where block_id = '$B1'")" == "1" ]] && ok "L4 reservado uma vez no registro" || ko "L4"

# --- equipe toda, quem não tem aparelho, inativos --------------------------------------------------
BT=$(blk $C null 10 60 15 "Reunião da equipe")           # equipe toda: aviso 5 min atrás
out=$(CLAIM)
has "$out" "$BT|f|Reunião da equipe|15|3" && ok "E1 equipe toda: aparelhos da Ana (2) e da Bia (1); sem aparelho e membro inativo não entram" || ko "E1 $out"
BC=$(blk $C $MC 10 60 15 "Da Carla")                     # Carla sem aparelho
[[ -z "$(CLAIM)" ]] && ok "E2 sem aparelho: nada é enviado" || ko "E2"
[[ "$(Q "select count(*) from push_block_alert_log where block_id = '$BC'")" == "0" ]] && ok "E3 e o aviso NÃO é gasto: quem inscrever o aparelho a tempo ainda recebe" || ko "E3"
Q "insert into push_subscriptions (user_id, endpoint, p256dh, auth_key) values ('$UC', 'https://push.example/c-1-cccccccccccc', 'p256dh-cccccccccccccccccccc', 'auth-cccc')" >/dev/null
has "$(CLAIM)" "$BC|f|Da Carla|15|1" && ok "E4 depois de inscrever o aparelho, o aviso chega" || ko "E4"
BE=$(blk $C $ME 10 60 15 "Do membro inativo"); BX=$(blk $X $MD 10 60 15 "Empresa parada")
[[ -z "$(CLAIM)" ]] && ok "E5 membro inativo e empresa inativa não recebem" || ko "E5"

# --- dia todo, fim já passado, alterar --------------------------------------------------------------
AD=$(Q "insert into blocked_times (company_id, professional_member_id, start_at, end_at, reason, remind_before_minutes)
  select '$C', '$MA', s, s + interval '1 day', 'Folga',
         ceil(extract(epoch from (s - now())) / 60)::int
  from (select ((date_trunc('day', now() at time zone 'America/Sao_Paulo') + interval '1 day') at time zone 'America/Sao_Paulo') as s) t returning id")
has "$(CLAIM)" "$AD|t|Folga|" && ok "A1 dia todo (meia-noite de Brasília a meia-noite): marcado como dia todo e avisado" || ko "A1"
Q "insert into blocked_times (company_id, professional_member_id, start_at, end_at, remind_before_minutes)
   values ('$C', '$MA', now() - interval '3 hours', now() - interval '1 minute', 0)" >/dev/null
[[ -z "$(CLAIM)" ]] && ok "A2 compromisso que já terminou não avisa" || ko "A2"
Q "update blocked_times set start_at = start_at + interval '1 minute', end_at = end_at + interval '1 minute' where id = '$B1'" >/dev/null
has "$(CLAIM)" "$B1|f|Almoço da Ana|30|2" && ok "A3 mudar o horário gera um aviso novo" || ko "A3"
Q "update blocked_times set reason = 'Almoço (corrigido)' where id = '$B1'" >/dev/null
[[ -z "$(CLAIM)" ]] && ok "A4 mudar só a observação não repete o aviso" || ko "A4"
Q "delete from blocked_times where id = '$B1'" >/dev/null
[[ "$(Q "select count(*) from push_block_alert_log where block_id = '$B1'")" == "0" ]] && ok "A5 apagar o bloqueio apaga o registro do aviso" || ko "A5"

# --- limites do lembrete ---------------------------------------------------------------------------
has "$(Q "update blocked_times set remind_before_minutes = 10081 where id = '$B2'")" "blocked_times_remind_range" && ok "V1 mais de 7 dias antes é recusado" || ko "V1"
has "$(Q "update blocked_times set remind_before_minutes = -1441 where id = '$B2'")" "blocked_times_remind_range" && ok "V2 mais de 1 dia depois do início é recusado" || ko "V2"
[[ -z "$(Q "update blocked_times set remind_before_minutes = -480 where id = '$B2'")" ]] && ok "V3 -480 (no dia, às 8h) é aceito" || ko "V3"

# --- permissões ---------------------------------------------------------------------------------------
[[ "$(Q "select has_function_privilege('authenticated', 'push_claim_due_block_reminders()', 'execute') or has_function_privilege('anon', 'push_claim_due_block_reminders()', 'execute')")" == "f" ]] && ok "P1 a função de envio só para o servidor" || ko "P1"
[[ "$(Q "select has_function_privilege('service_role', 'push_claim_due_block_reminders()', 'execute')")" == "t" ]] && ok "P2 service_role executa" || ko "P2"
[[ "$(Q "select has_table_privilege('authenticated', 'push_block_alert_log', 'select') or has_table_privilege('anon', 'push_block_alert_log', 'select')")" == "f" ]] && ok "P3 registro de avisos fechado para a API" || ko "P3"
# a profissional grava o lembrete pela mesma política do bloqueio; outra empresa não mexe
BM=$(blk $C $MA 600 60 null "Meu compromisso")
[[ "$(U $UA "update blocked_times set remind_before_minutes = 30 where id = '$BM' returning remind_before_minutes" | head -1)" == "30" ]] && ok "P4 membro da empresa define o lembrete" || ko "P4"
UD=$(Q "select id from auth.users where email='d@r.com'")
[[ -z "$(U $UD "update blocked_times set remind_before_minutes = 5 where id = '$BM' returning id" | head -1)" ]] && ok "P5 membro de outra empresa não mexe" || ko "P5"

echo "RESULTADO 0056: PASS=$pass FAIL=$fail"
dropdb --force $DB 2>/dev/null
[[ $fail -eq 0 ]]
