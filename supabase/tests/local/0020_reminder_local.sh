#!/usr/bin/env bash
# ============================================================================
# 0020 — LEMBRETE da véspera às 18h. SOMENTE LOCAL. Banco do zero.
# O disparo é chamado com um "agora" controlado (p_now); a fila é consumida
# como o papel wa_worker (funções reais do worker).
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DB="aurea_reminder_0020"
export PGOPTIONS="-c client_min_messages=warning"
# Testa o lembrete como definido de 0020 a 0024 (disparo às 18h). O horário das 8h
# (0025/0026) tem bateria própria: 0025_local.sh.
"$HERE/fresh_db.sh" "$DB" 0024 >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
PSQL=(psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d "$DB")
Q() { "${PSQL[@]}" -c "$1"; }
U() { "${PSQL[@]}" -c "begin; set local \"request.jwt.claim.sub\" = '$1'; set local role authenticated; $2; commit;"; }
W() { "${PSQL[@]}" -c "begin; set local role wa_worker; $1; commit;"; }
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
ko() { echo "FAIL $1"; fail=$((fail+1)); }
check() { [[ "$(Q "select ($2)")" == "t" ]] && ok "$1" || ko "$1"; }
errc() { local code="$1" name="$2"; shift 2; local out; out="$("$@" 2>&1)"; grep -q "ERROR:  $code" <<<"$out" && ok "$name" || ko "$name -> $(head -c 200 <<<"$out")"; }

# "agora" controlado: hoje (São Paulo) às 18h05 e às 17h59; amanhã = dia do atendimento
TODAY="$(Q "select (now() at time zone 'America/Sao_Paulo')::date")"
AT() { echo "(timestamp '$TODAY $1' at time zone 'America/Sao_Paulo')"; }
N1805="$(AT 18:05:00)"; N1759="$(AT 17:59:00)"; N2040="$(AT 20:40:00)"
TOM() { echo "((date '$TODAY' + 1) + time '$1') at time zone 'America/Sao_Paulo'"; }
run() { Q "select whatsapp_private.enqueue_day_before_reminders(${1:-$N1805})"; }

eval "$(Q "
do \$\$
declare uo uuid; ub uuid; a uuid; b uuid;
begin
  insert into auth.users (email, raw_user_meta_data) values ('own@r.local', '{\"full_name\":\"Olga Dona\"}') returning id into uo;
  insert into auth.users (email) values ('ownb@r.local') returning id into ub;
  insert into companies (name) values ('Studio A') returning id into a;
  insert into companies (name) values ('Studio B') returning id into b;
  insert into company_members (company_id, user_id, role) values (a, uo, 'owner'), (b, ub, 'owner');
end \$\$;
select string_agg(format('%s=%s', k, v), ' ') from (
  select 'A' k, id::text v from companies where name = 'Studio A' union all
  select 'B', id::text from companies where name = 'Studio B' union all
  select 'C3', id::text from (select id from companies where name = 'Studio A' limit 0) z union all
  select 'OWN', id::text from auth.users where email = 'own@r.local') z")"
MA="$(Q "select id from company_members where company_id = '$A'")"
MB="$(Q "select id from company_members where company_id = '$B'")"
SA="$(Q "insert into services (company_id, name, duration_minutes, price) values ('$A', 'Manicure', 20, 50) returning id")"
SB="$(Q "insert into services (company_id, name, duration_minutes, price) values ('$B', 'Pedicure', 20, 50) returning id")"
C3="$(Q "insert into companies (name) values ('Studio Sem WhatsApp') returning id")"
M3="$(Q "insert into company_members (company_id, user_id, role) values ('$C3', '$OWN', 'owner') returning id")"
S3="$(Q "insert into services (company_id, name, duration_minutes, price) values ('$C3', 'Escova', 20, 50) returning id")"
cli() { Q "insert into clients (company_id, name, phone $3) values ('$1', '$2', $4) returning id"; }
K_OK="$(cli "$A" 'Ana Lima' '' "'11987654321'")"
K_OK2="$(cli "$A" 'Bia Rocha' '' "'11987650077'")"
K_OK3="$(cli "$A" 'Carla Dias' '' "'11987650088'")"
K_NP="$(cli "$A" 'Sem Fone' '' "null")"
K_BL="$(cli "$A" 'Bloqueada' ', comm_status' "'11987650003', 'blocked'")"
K_AR="$(cli "$A" 'Arquivada' ', archived_at' "'11987650004', now()")"
K_B="$(cli "$B" 'Ana na B' '' "'11987654321'")"
K_C3="$(cli "$C3" 'Cliente C3' '' "'11987650099'")"
SESS() { Q "insert into whatsapp_private.sessions (company_id, status, phone, last_seen_at, lease_owner, lease_until, connected_at)
            values ('$1', 'connected', '5511900000000', now(), '$2', now() + interval '10 minutes', now())
            on conflict (company_id) do update set status = 'connected', last_seen_at = now(), lease_owner = '$2',
              lease_until = now() + interval '10 minutes', reminder = true" >/dev/null; }
SESS "$A" w1; SESS "$B" w2
Q "create sequence zz_slot" >/dev/null
# agendamento (como postgres; criado "há 2 dias" por padrão). mk <cliente> [quando] [empresa] [serv] [membro] [status] [criado_em]
mk() {
  local cl="$1" when="${2:-}" co="${3:-$A}" sv="${4:-$SA}" m="${5:-$MA}" st="${6:-agendado}" cr="${7:-now() - interval '2 days'}"
  [[ -z "$when" ]] && when="$(TOM 08:00) + nextval('zz_slot') * interval '30 minutes'"
  Q "insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end, price, status, created_at)
     select '$co', '$cl', '$sv', '$m', t, t + interval '20 minutes', 50, '$st', $cr from (select $when as t) z returning id"
}
rem() { Q "select coalesce((select status || coalesce(':' || reason, '') from whatsapp_private.appointment_reminders where appointment_id = '$1'), 'none')"; }
nout() { Q "select count(*) from whatsapp_private.outbox where appointment_id = '$1' and idempotency_key like 'reminder:%'"; }

# ================================================================ D. desligado / horário
a1="$(mk "$K_OK")"
check "D1 nasce DESLIGADO (reminder_enabled = false)" "not (select reminder_enabled from whatsapp_private.settings)"
[[ "$(run | grep -o '"status": "[a-z_]*"')" == '"status": "disabled"' && "$(rem "$a1")" == none ]] && ok "D2 desligado: o disparo não faz nada" || ko "D2"
Q "update whatsapp_private.settings set reminder_enabled = true" >/dev/null
[[ "$(run "$N1759" | grep -o '"status": "[a-z_]*"')" == '"status": "too_early"' && "$(rem "$a1")" == none ]] && ok "D3 antes das 18h (17h59): não faz nada" || ko "D3"

# ================================================================ L. lembrete
run >/dev/null
[[ "$(rem "$a1")" == queued && "$(nout "$a1")" == 1 ]] && ok "L1 18h05: atendimento de amanhã ganha 1 lembrete na fila" || ko "L1 $(rem "$a1")"
check "L2 pedido certo: cliente, telefone, chave 'reminder:<id>', pendente" \
  "(select client_id = '$K_OK' and to_phone = '5511987654321' and idempotency_key = 'reminder:$a1' and status = 'pending'
     from whatsapp_private.outbox where appointment_id = '$a1')"
check "L3 texto: 1º nome, 'amanhã', dia, hora, serviço; sem assinatura; até 1 emoji" \
  "(select body like 'Oi, Ana%' and body ilike '%amanhã%' and body like '%Manicure%' and body ~ '\\d{2}/\\d{2}' and body like '%às %h%'
          and body not like '%Studio A%' and body not like '%Olga%'
          and (select count(*) from regexp_matches(body, '[💕✨🌸]', 'g')) <= 1
     from whatsapp_private.outbox where appointment_id = '$a1')"
run >/dev/null; run "$N2040" >/dev/null
[[ "$(nout "$a1")" == 1 && "$(Q "select count(*) from whatsapp_private.appointment_reminders where appointment_id = '$a1'")" == 1 ]] \
  && ok "L4 rodadas seguintes (18h05 de novo, 20h40) NÃO duplicam" || ko "L4"
late="$(mk "$K_OK2" "" "$A" "$SA" "$MA" agendado "$(AT 18:30:00)")"
run "$N2040" >/dev/null
[[ "$(rem "$late")" == "skipped:late_booking" && "$(nout "$late")" == 0 ]] && ok "L5 agendado DEPOIS das 18h da véspera: pula (late_booking)" || ko "L5 $(rem "$late")"
canc="$(mk "$K_OK2" "" "$A" "$SA" "$MA" cancelado)"
far="$(mk "$K_OK2" "((date '$TODAY' + 2) + time '10:00') at time zone 'America/Sao_Paulo'")"
run >/dev/null
[[ "$(rem "$canc")" == none && "$(rem "$far")" == none ]] && ok "L6 cancelado e atendimento de depois de amanhã: nada" || ko "L6 $(rem "$canc") $(rem "$far")"
for pair in "K_NP:no_phone" "K_BL:blocked" "K_AR:archived"; do
  var="${pair%%:*}"; reason="${pair##*:}"; x="$(mk "${!var}")"; run >/dev/null
  [[ "$(rem "$x")" == "skipped:$reason" && "$(nout "$x")" == 0 ]] && ok "L7 $reason: não enfileira; registra o motivo" || ko "L7 $reason -> $(rem "$x")"
done

# ================================================================ S. sessão / preferência / isolamento
c3="$(mk "$K_C3" "" "$C3" "$S3" "$M3")"; run >/dev/null
[[ "$(rem "$c3")" == none ]] && ok "S1 empresa que nunca conectou o WhatsApp: nada registrado" || ko "S1"
Q "update whatsapp_private.sessions set last_seen_at = now() - interval '10 minutes' where company_id = '$A'" >/dev/null
off="$(mk "$K_OK3")"; run >/dev/null
[[ "$(rem "$off")" == none ]] && ok "S2 WhatsApp sem sinal: não registra (tenta na próxima rodada)" || ko "S2 $(rem "$off")"
SESS "$A" w1; run >/dev/null
[[ "$(rem "$off")" == queued ]] && ok "S3 sinal voltou: a rodada seguinte enfileira" || ko "S3 $(rem "$off")"
Q "update whatsapp_private.sessions set reminder = false where company_id = '$A'" >/dev/null
pf="$(mk "$K_OK3")"; run >/dev/null
[[ "$(rem "$pf")" == "skipped:disabled" ]] && ok "S4 empresa com lembrete desligado: pula (disabled)" || ko "S4 $(rem "$pf")"
Q "update whatsapp_private.sessions set reminder = true where company_id = '$A'" >/dev/null
bb="$(mk "$K_B" "" "$B" "$SB" "$MB")"; run >/dev/null
check "S5 isolamento: a empresa B recebe o próprio lembrete, pelo próprio pedido" \
  "(select company_id = '$B' and client_id = '$K_B' from whatsapp_private.outbox where appointment_id = '$bb')"

# ================================================================ R. limite de ritmo
Q "update whatsapp_private.outbox set created_at = now() - interval '2 minutes'" >/dev/null
Q "update whatsapp_private.settings set send_per_minute = 2" >/dev/null
r1="$(mk "$K_OK")"; r2="$(mk "$K_OK2")"; r3="$(mk "$K_OK3")"; run >/dev/null
n="$(Q "select count(*) from whatsapp_private.appointment_reminders where appointment_id in ('$r1','$r2','$r3')")"
[[ "$n" == 2 ]] && ok "R1 limite de ritmo (2/min): 2 enfileirados, o 3º fica para a próxima rodada (sem registro)" || ko "R1 n=$n"
Q "update whatsapp_private.outbox set created_at = now() - interval '2 minutes'" >/dev/null; Q "update whatsapp_private.settings set send_per_minute = 20" >/dev/null
run >/dev/null
[[ "$(Q "select count(*) from whatsapp_private.appointment_reminders where appointment_id in ('$r1','$r2','$r3') and status = 'queued'")" == 3 ]] \
  && ok "R2 rodada seguinte completa o que ficou para trás" || ko "R2"

# ================================================================ F. fila (worker)
moved="$(mk "$K_OK")"; gone="$(mk "$K_OK2")"; stale="$(mk "$K_OK3")"; run >/dev/null
b0="$(Q "select md5(body) from whatsapp_private.outbox where appointment_id = '$moved'")"
Q "update appointments set scheduled_start = scheduled_start + interval '7 hours', scheduled_end = scheduled_end + interval '7 hours' where id = '$moved'" >/dev/null
Q "update appointments set scheduled_start = scheduled_start + interval '3 days', scheduled_end = scheduled_end + interval '3 days' where id = '$gone'" >/dev/null
Q "update whatsapp_private.appointment_reminders set remind_date = remind_date - 1 where appointment_id = '$stale'" >/dev/null
W "select count(*) from whatsapp_private.claim_outbox('w1', 100, 60)" >/dev/null
check "F1 remarcado para outro horário AMANHÃ: o lembrete sai com o horário novo" \
  "(select status = 'processing' and md5(body) <> '$b0' and body = whatsapp_private.reminder_text('$moved') from whatsapp_private.outbox where appointment_id = '$moved')"
check "F2 remarcado para outro dia: lembrete cancelado (não sai 'amanhã' errado)" \
  "(select status = 'canceled' and last_error = 'lembrete fora do prazo' from whatsapp_private.outbox where appointment_id = '$gone')"
check "F3 não saiu na mesma noite (worker fora até o dia seguinte): cancelado" \
  "(select status = 'canceled' from whatsapp_private.outbox where appointment_id = '$stale')"
id1="$(Q "select id from whatsapp_private.outbox where appointment_id = '$moved'")"
W "select whatsapp_private.complete_outbox('$id1', 'w1', '3EB0BBBBBBBBBBBBBBBBBB')" >/dev/null
run >/dev/null; W "select count(*) from whatsapp_private.claim_outbox('w1', 100, 60)" >/dev/null
check "F4 depois de enviado, nenhuma rodada nem a fila geram outro lembrete" \
  "(select count(*) = 1 and bool_and(status = 'sent') from whatsapp_private.outbox where appointment_id = '$moved')"
# opt-out entre o disparo e o envio
oo="$(mk "$K_OK3" "$(TOM 19:00)")"; run >/dev/null
W "select whatsapp_private.record_inbound('$A', 'w1', 'IN-SAIR-R', '5511987650088@s.whatsapp.net', 'SAIR')" >/dev/null
W "select count(*) from whatsapp_private.claim_outbox('w1', 100, 60)" >/dev/null
check "F5 cliente respondeu SAIR antes do envio: lembrete cancelado" \
  "(select status = 'canceled' from whatsapp_private.outbox where appointment_id = '$oo')"

# ================================================================ Q. regressão da confirmação com a 0020
Q "update whatsapp_private.settings set auto_confirmation_enabled = true" >/dev/null
cf="$(U "$OWN" "insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end, price)
               values ('$A', '$K_OK', '$SA', '$MA', now() + interval '9 days', now() + interval '9 days 20 minutes', 50) returning id")"
check "Q1 confirmação automática continua: agendamento novo enfileira 1 confirmação" \
  "(select count(*) = 1 from whatsapp_private.outbox where appointment_id = '$cf' and idempotency_key = 'auto-confirmation:$cf')"
W "select count(*) from whatsapp_private.claim_outbox('w1', 100, 60)" >/dev/null
check "Q2 a fila continua pegando confirmações normalmente" "(select status = 'processing' from whatsapp_private.outbox where appointment_id = '$cf')"
Q "update whatsapp_private.settings set auto_confirmation_enabled = false" >/dev/null

# ================================================================ P. permissões
errc 42501 "P1 authenticated NÃO lê os lembretes" U "$OWN" "select count(*) from whatsapp_private.appointment_reminders"
errc 42501 "P2 authenticated NÃO dispara lembretes" U "$OWN" "select whatsapp_private.enqueue_day_before_reminders()"
errc 42501 "P3 wa_worker NÃO dispara lembretes" W "select whatsapp_private.enqueue_day_before_reminders()"
check "P4 wa_worker continua com SÓ as 13 funções do worker" \
  "(select count(*) = 13 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'whatsapp_private' and has_function_privilege('wa_worker', p.oid, 'execute'))"
check "P5 nenhuma função privada exposta para anon/authenticated/service_role" \
  "not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join unnest(array['anon','authenticated','service_role']) rl
               where n.nspname = 'whatsapp_private' and has_function_privilege(rl, p.oid, 'execute'))"

# ================================================================ M. domingo e reaplicação
SUN="$(Q "select d from generate_series(date '$TODAY' + 7, date '$TODAY' + 13, interval '1 day') d where extract(dow from d) = 0 limit 1")"
SUN="${SUN%% *}"
mon="$(mk "$K_OK2" "((date '$SUN' + 1) + time '09:00') at time zone 'America/Sao_Paulo'")"
Q "select whatsapp_private.enqueue_day_before_reminders((timestamp '$SUN 18:05' at time zone 'America/Sao_Paulo'))" >/dev/null
[[ "$(rem "$mon")" == queued ]] && ok "M1 atendimento de segunda: lembrete sai no domingo às 18h (sem exceção)" || ko "M1 $(rem "$mon")"
psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/0020_whatsapp_day_before_reminder.sql" >/dev/null 2>&1 && ok "M2 a 0020 pode ser reaplicada" || ko "M2"
check "M3 depois de reaplicar: chave e registros preservados" \
  "(select reminder_enabled from whatsapp_private.settings) and (select count(*) > 0 from whatsapp_private.appointment_reminders)"

# todas as variações geradas nesta bateria (não só a sorteada no L3)
check "T1 TODOS os lembretes gerados: 'amanhã', dia, hora; sem assinatura; até 1 emoji; sem buracos" \
  "(select count(*) > 10 and bool_and(body ~* 'amanhã' and body ~ '\d{2}/\d{2}' and body ~ 'às \d{1,2}h'
                                    and body !~ 'Studio|Olga' and body !~ '  |\(\)|, \.'
                                    and (select count(*) from regexp_matches(body, '[💕✨🌸]', 'g')) <= 1)
     from whatsapp_private.outbox where idempotency_key like 'reminder:%')"
# as 6 variações, de forma DETERMINÍSTICA (ids escolhidos: um por variação)
Q "update whatsapp_private.outbox set created_at = now() - interval '2 minutes'" >/dev/null   # fora da janela do limite de ritmo
k=0
for vid in 00000000-0000-4000-9000-000000000005 00000000-0000-4000-9000-000000000006 00000000-0000-4000-9000-000000000001 00000000-0000-4000-9000-000000000002 00000000-0000-4000-9000-000000000003 00000000-0000-4000-9000-000000000004; do
  k=$((k+1))   # horários exclusivos (madrugada de amanhã): não colidem com os outros testes
  Q "insert into appointments (id, company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end, price, created_at)
     select '$vid', '$A', '$K_OK2', '$SA', '$MA', t, t + interval '20 minutes', 50, now() - interval '2 days'
     from (select $(TOM 00:05) + $k * interval '30 minutes' as t) z" >/dev/null || ko "T2 preparo: agendamento $vid recusado"
done
run >/dev/null
check "T2 as 6 variações: todas completas, sem assinatura, textos diferentes; emoji em parte delas" \
  "(select count(*) = 6 and count(distinct split_part(body, E'\n\n', 2)) = 6
          and bool_and(body ~* 'amanhã' and body ~ '\d{2}/\d{2}' and body ~ 'às \d{1,2}h' and body like '%Manicure%'
                       and body !~ 'Studio|Olga' and body !~ '  |\(\)|, \.')
          and count(*) filter (where body ~ '[💕✨🌸]') between 2 and 4
     from whatsapp_private.outbox where idempotency_key in ('reminder:00000000-0000-4000-9000-000000000005', 'reminder:00000000-0000-4000-9000-000000000006', 'reminder:00000000-0000-4000-9000-000000000001', 'reminder:00000000-0000-4000-9000-000000000002', 'reminder:00000000-0000-4000-9000-000000000003', 'reminder:00000000-0000-4000-9000-000000000004'))"
echo "RESULTADO lembrete 0020: PASS=$pass FAIL=$fail"
dropdb --force "$DB"
[[ $fail -eq 0 ]]
