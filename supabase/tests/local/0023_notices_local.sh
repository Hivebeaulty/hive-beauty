#!/usr/bin/env bash
# ============================================================================
# 0023 — AVISO de remarcação e cancelamento. SOMENTE LOCAL. Banco do zero.
# Alterações feitas como a usuária logada (RLS real): edição pela RPC da 0022 e
# cancelamento pelo mesmo UPDATE que a tela usa. Fila consumida como wa_worker.
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DB="aurea_notices_0023"
export PGOPTIONS="-c client_min_messages=warning"
"$HERE/fresh_db.sh" "$DB" >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
PSQL=(psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d "$DB")
Q() { "${PSQL[@]}" -c "$1"; }
U() { "${PSQL[@]}" -c "begin; set local \"request.jwt.claim.sub\" = '$1'; set local role authenticated; $2; commit;"; }
W() { "${PSQL[@]}" -c "begin; set local role wa_worker; $1; commit;"; }
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
ko() { echo "FAIL $1"; fail=$((fail+1)); }
check() { [[ "$(Q "select ($2)")" == "t" ]] && ok "$1" || ko "$1"; }
errc() { local code="$1" name="$2"; shift 2; local out; out="$("$@" 2>&1)"; grep -q "ERROR:  $code" <<<"$out" && ok "$name" || ko "$name -> $(head -c 200 <<<"$out")"; }

eval "$(Q "
do \$\$
declare uo uuid; ub uuid; a uuid; b uuid;
begin
  insert into auth.users (email) values ('own@n.local') returning id into uo;
  insert into auth.users (email) values ('ownb@n.local') returning id into ub;
  insert into companies (name) values ('Studio A') returning id into a;
  insert into companies (name) values ('Studio B') returning id into b;
  insert into company_members (company_id, user_id, role) values (a, uo, 'owner'), (b, ub, 'owner');
end \$\$;
select string_agg(format('%s=%s', k, v), ' ') from (
  select 'A' k, id::text v from companies where name = 'Studio A' union all
  select 'B', id::text from companies where name = 'Studio B' union all
  select 'OWN', id::text from auth.users where email = 'own@n.local' union all
  select 'OWNB', id::text from auth.users where email = 'ownb@n.local') z")"
MA="$(Q "select id from company_members where company_id = '$A'")"
MB="$(Q "select id from company_members where company_id = '$B'")"
MA2="$(Q "insert into auth.users (email) values ('pro2@n.local') returning id")"; MA2="$(Q "insert into company_members (company_id, user_id, role) values ('$A', '$MA2', 'professional') returning id")"
SA="$(Q "insert into services (company_id, name, duration_minutes, price) values ('$A', 'Manicure', 60, 50) returning id")"
SA2="$(Q "insert into services (company_id, name, duration_minutes, price) values ('$A', 'Gel', 90, 120) returning id")"
SB="$(Q "insert into services (company_id, name, duration_minutes, price) values ('$B', 'Pedicure', 60, 50) returning id")"
cli() { Q "insert into clients (company_id, name, phone $3) values ('$1', '$2', $4) returning id"; }
K1="$(cli "$A" 'Ana Lima' '' "'11987654321'")"
K2="$(cli "$A" 'Bia Rocha' '' "'11987650077'")"
KBL="$(cli "$A" 'Bloqueada' ', comm_status' "'11987650003', 'blocked'")"
KNP="$(cli "$A" 'Sem Fone' '' "null")"
KB="$(cli "$B" 'Ana na B' '' "'11987654321'")"
SESS() { Q "insert into whatsapp_private.sessions (company_id, status, phone, last_seen_at, lease_owner, lease_until, connected_at)
            values ('$1', 'connected', '5511900000000', now(), '$2', now() + interval '10 minutes', now())
            on conflict (company_id) do update set status = 'connected', last_seen_at = now(), lease_owner = '$2',
              lease_until = now() + interval '10 minutes', auto_confirmation = true" >/dev/null; }
SESS "$A" w1; SESS "$B" w2
Q "create sequence zz_slot; grant usage on sequence zz_slot to authenticated" >/dev/null
mk() { # mk <cliente> [empresa] [serv] [prof]
  local co="${2:-$A}" uid="$OWN"; [[ "$co" == "$B" ]] && uid="$OWNB"
  U "$uid" "insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end, price)
            select '$co', '$1', '${3:-$SA}', '${4:-$MA}', t, t + interval '1 hour', 50
            from (select date_trunc('hour', now()) + interval '2 days' + nextval('zz_slot') * interval '48 hours' as t) z returning id"
}
expected() { Q "select jsonb_build_object('client_id', client_id, 'service_id', service_id, 'professional_member_id', professional_member_id,
                  'scheduled_start', scheduled_start, 'scheduled_end', scheduled_end, 'price', price, 'status', status)::text from appointments where id = '$1'"; }
# ed <id> <shift-sql> [cliente] [serv] [prof] [dur-min] [preço] [notes]  (shift = quanto mover o início)
ed() { local id="$1" sh="$2" ex; ex="$(expected "$id")"
  local cl="${3:-}" sv="${4:-}" pr="${5:-}" du="${6:-}" pc="${7:-}" nt="${8:-null}"
  U "${UID_ED:-$OWN}" "select update_appointment('$id',
      coalesce(nullif('$cl','')::uuid, (select client_id from appointments where id = '$id')),
      coalesce(nullif('$sv','')::uuid, (select service_id from appointments where id = '$id')),
      coalesce(nullif('$pr','')::uuid, (select professional_member_id from appointments where id = '$id')),
      (select scheduled_start + ($sh)::interval from appointments where id = '$id'),
      (select scheduled_start + ($sh)::interval + coalesce(nullif('$du','')::int * interval '1 minute', scheduled_end - scheduled_start) from appointments where id = '$id'),
      coalesce(nullif('$pc','')::numeric, (select price from appointments where id = '$id')), $nt, '$ex'::jsonb)"; }
cancel() { U "${2:-$OWN}" "update appointments set status = 'cancelado' where id = '$1' returning id" >/dev/null; }
nn() { Q "select count(*) from whatsapp_private.appointment_notices where appointment_id = '$1'${2:+ and kind = '$2'}"; }
last() { Q "select coalesce((select kind || ':' || status || coalesce(':' || reason, '') from whatsapp_private.appointment_notices where appointment_id = '$1' order by created_at desc limit 1), 'none')"; }
ob() { Q "select o.status from whatsapp_private.appointment_notices an join whatsapp_private.outbox o on o.id = an.outbox_id where an.appointment_id = '$1' order by an.created_at desc limit 1"; }
claim() { W "select count(*) from whatsapp_private.claim_outbox('${1:-w1}', 100, 60)" >/dev/null; }
age() { Q "update whatsapp_private.outbox set created_at = now() - interval '2 minutes'" >/dev/null; }

# ================================================================ D. desligado
a1="$(mk "$K1")"
check "D1 nasce DESLIGADO (change_notices_enabled = false)" "not (select change_notices_enabled from whatsapp_private.settings)"
ed "$a1" "'1 hour'" >/dev/null
[[ "$(nn "$a1")" == 0 ]] && ok "D2 desligado: remarcar não gera aviso" || ko "D2"
Q "update whatsapp_private.settings set change_notices_enabled = true" >/dev/null

# ================================================================ R. remarcação
ed "$a1" "'1 day'" >/dev/null
[[ "$(last "$a1")" == "reschedule:queued" && "$(ob "$a1")" == pending ]] && ok "R1 remarcar o dia: 1 aviso de remarcação na fila" || ko "R1 $(last "$a1")"
check "R2 aviso: 1º nome, dia/horário NOVOS, serviço; sem assinatura" \
  "(select o.body like 'Oi, Ana%' and o.body like '%Manicure%' and o.body ~ '\\d{2}/\\d{2}' and o.body like '%às %h%'
          and o.body = whatsapp_private.reschedule_notice_text('$a1') and o.body !~ 'Studio|Tain'
          and o.idempotency_key like 'reschedule:$a1:%'
     from whatsapp_private.appointment_notices an join whatsapp_private.outbox o on o.id = an.outbox_id where an.appointment_id = '$a1')"
b_before="$(Q "select o.body from whatsapp_private.appointment_notices an join whatsapp_private.outbox o on o.id = an.outbox_id where an.appointment_id = '$a1'")"
ed "$a1" "'2 hours'" >/dev/null; ed "$a1" "'1 hour'" >/dev/null
[[ "$(nn "$a1")" == 1 ]] && ok "R3 várias edições com o aviso ainda na fila: continua 1 aviso só" || ko "R3 n=$(nn "$a1")"
claim
check "R4 na hora do envio, o aviso sai com os dados FINAIS (refeito)" \
  "(select o.status = 'processing' and o.body = whatsapp_private.reschedule_notice_text('$a1') and o.body <> \$b\$$b_before\$b\$
     from whatsapp_private.appointment_notices an join whatsapp_private.outbox o on o.id = an.outbox_id where an.appointment_id = '$a1')"
oid="$(Q "select outbox_id from whatsapp_private.appointment_notices where appointment_id = '$a1'")"
W "select whatsapp_private.fail_outbox('$oid', 'w1', 'rede', true)" >/dev/null
Q "update whatsapp_private.outbox set available_at = now() where id = '$oid'" >/dev/null; claim
W "select whatsapp_private.complete_outbox('$oid', 'w1', '3EB0CCCCCCCCCCCCCCCCCC')" >/dev/null
W "select whatsapp_private.complete_outbox('$oid', 'w1', '3EB0CCCCCCCCCCCCCCCCCC')" >/dev/null
check "R5 falha temporária + nova tentativa + conclusão repetida: 1 envio, 1 mensagem" \
  "(select status = 'sent' from whatsapp_private.outbox where id = '$oid') and (select count(*) = 1 from whatsapp_private.messages where outbox_id = '$oid')"
age; ed "$a1" "'30 minutes'" >/dev/null
[[ "$(nn "$a1" reschedule)" == 2 && "$(last "$a1")" == "reschedule:queued" ]] && ok "R6 nova remarcação DEPOIS de avisada: novo aviso" || ko "R6 $(nn "$a1")"
k="$(Q "select count(distinct o.idempotency_key) from whatsapp_private.appointment_notices an join whatsapp_private.outbox o on o.id = an.outbox_id where an.appointment_id = '$a1'")"
[[ "$k" == 2 ]] && ok "R7 cada aviso tem chave própria (sem colisão nem duplicata)" || ko "R7 $k"
claim

# ================================================================ X. edições que NÃO avisam
x="$(mk "$K2")"; age
ed "$x" "'0 hours'" "" "" "$MA2" >/dev/null; ed "$x" "'0 hours'" "" "" "" "" 99 >/dev/null
ed "$x" "'0 hours'" "" "" "" 45 >/dev/null; ed "$x" "'0 hours'" "" "" "" "" "" "'só obs'" >/dev/null
r="$(ed "$x" "'0 hours'" "" "" "" "" "" "'só obs'")"
[[ "$(nn "$x")" == 0 && "$r" == *'"changed": false'* ]] && ok "X1 trocar profissional, valor, duração, observação ou salvar sem mudar: sem aviso" || ko "X1 n=$(nn "$x") $r"
ed "$x" "'0 hours'" "" "$SA2" "" 90 120 >/dev/null
[[ "$(last "$x")" == "reschedule:queued" ]] && ok "X2 trocar o SERVIÇO: avisa (a cliente precisa saber)" || ko "X2 $(last "$x")"
y="$(mk "$K1")"; age; ed "$y" "'1 day'" "$K2" >/dev/null
[[ "$(nn "$y")" == 0 ]] && ok "X3 trocar a CLIENTE (mesmo mudando o horário): nenhuma mensagem automática" || ko "X3"
z="$(mk "$K1")"; ed "$z" "'1 day'" >/dev/null; ed "$z" "'0 hours'" "$K2" >/dev/null; claim
check "X4 aviso pendente e depois trocou a cliente: o aviso para a cliente antiga é cancelado" \
  "(select o.status = 'canceled' from whatsapp_private.appointment_notices an join whatsapp_private.outbox o on o.id = an.outbox_id where an.appointment_id = '$z')"

# ================================================================ C. cancelamento
age; c1="$(mk "$K1")"; cancel "$c1"
[[ "$(last "$c1")" == "cancel:queued" ]] && ok "C1 cancelar: 1 aviso de cancelamento na fila" || ko "C1 $(last "$c1")"
check "C2 texto: deixa claro que foi CANCELADO, com dia e horário; não sugere que vale" \
  "(select o.body ~ 'cancelado' and o.body ~ '\\d{2}/\\d{2}' and o.body !~* 'te esperamos|confirmad|até lá' and o.body !~ 'Studio'
          and o.idempotency_key = 'cancel:$c1'
     from whatsapp_private.appointment_notices an join whatsapp_private.outbox o on o.id = an.outbox_id where an.appointment_id = '$c1')"
claim
[[ "$(ob "$c1")" == processing ]] && ok "C3 a fila PEGA o aviso de cancelamento (não o descarta por 'não estar em aberto')" || ko "C3 $(ob "$c1")"
Q "update appointments set status = 'agendado' where id = '$c1'" >/dev/null; Q "update appointments set status = 'cancelado' where id = '$c1'" >/dev/null
[[ "$(nn "$c1" cancel)" == 1 ]] && ok "C4 cancelar de novo o mesmo agendamento: continua 1 aviso de cancelamento" || ko "C4"
c2="$(mk "$K1")"; ed "$c2" "'1 day'" >/dev/null; cancel "$c2"; claim
check "C5 remarcação pendente e depois cancelou: só o CANCELAMENTO sai" \
  "(select count(*) filter (where an.kind = 'reschedule' and o.status = 'canceled') = 1
          and count(*) filter (where an.kind = 'cancel' and o.status = 'processing') = 1
     from whatsapp_private.appointment_notices an join whatsapp_private.outbox o on o.id = an.outbox_id where an.appointment_id = '$c2')"
c3="$(mk "$K1")"; cancel "$c3"; Q "update appointments set scheduled_start = now() - interval '1 hour', scheduled_end = now() where id = '$c3'" >/dev/null; claim
[[ "$(ob "$c3")" == canceled ]] && ok "C6 o horário cancelado já passou antes do envio: aviso descartado" || ko "C6 $(ob "$c3")"
c4="$(mk "$K1")"; cancel "$c4"; Q "update appointments set status = 'agendado' where id = '$c4'" >/dev/null; claim
[[ "$(ob "$c4")" == canceled ]] && ok "C7 agendamento reaberto antes do envio: aviso de cancelamento descartado" || ko "C7 $(ob "$c4")"
past="$(U "$OWN" "insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end, price)
                  values ('$A', '$K1', '$SA', '$MA', now() - interval '5 hours', now() - interval '4 hours', 50) returning id")"
cancel "$past"; U "$OWN" "update appointments set status = 'nao_compareceu' where id = '$(mk "$K2")'" >/dev/null
[[ "$(nn "$past")" == 0 ]] && ok "C8 cancelar agendamento que já passou / marcar falta: sem aviso" || ko "C8"
concl="$(U "$OWN" "insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end, price)
                   values ('$A', '$K1', '$SA', '$MA', now() - interval '9 hours', now() - interval '8 hours', 50) returning id")"
U "$OWN" "select conclude_appointment('$concl', 50, 'pix')" >/dev/null; U "$OWN" "update appointments set notes = 'obs' where id = '$concl'" >/dev/null
[[ "$(nn "$concl")" == 0 ]] && ok "C9 concluir e editar observação de atendimento concluído: sem aviso" || ko "C9"

# ================================================================ P. confirmação pendente / destinatária / sessão
Q "update whatsapp_private.settings set auto_confirmation_enabled = true" >/dev/null; age
p1="$(mk "$K1")"; ed "$p1" "'1 day'" >/dev/null
[[ "$(last "$p1")" == "reschedule:skipped:confirmation_pending" ]] && ok "P1 confirmação ainda não saiu: sem aviso extra" || ko "P1 $(last "$p1")"
claim
check "P2 ...e a confirmação sai com o horário NOVO" \
  "(select o.status = 'processing' and o.body = whatsapp_private.confirmation_text('$p1')
     from whatsapp_private.appointment_confirmations ac join whatsapp_private.outbox o on o.id = ac.outbox_id where ac.appointment_id = '$p1')"
age; p2="$(mk "$K2")"; cancel "$p2"; claim
check "P3 cancelou antes da confirmação sair: confirmação descartada e NENHUMA mensagem" \
  "(select o.status = 'canceled' from whatsapp_private.appointment_confirmations ac join whatsapp_private.outbox o on o.id = ac.outbox_id where ac.appointment_id = '$p2')
   and (select reason = 'confirmation_pending' from whatsapp_private.appointment_notices where appointment_id = '$p2')"
Q "update whatsapp_private.settings set auto_confirmation_enabled = false" >/dev/null; age
b1="$(mk "$KBL")"; cancel "$b1"; n1="$(mk "$KNP")"; ed "$n1" "'1 day'" >/dev/null
[[ "$(last "$b1")" == "cancel:skipped:blocked" && "$(last "$n1")" == "reschedule:skipped:no_phone" ]] && ok "P4 bloqueada (SAIR) e sem telefone: não envia; motivo registrado" || ko "P4 $(last "$b1") $(last "$n1")"
o1="$(mk "$K2")"; cancel "$o1"
W "select whatsapp_private.record_inbound('$A', 'w1', 'IN-SAIR-N', '5511987650077@s.whatsapp.net', 'PARAR')" >/dev/null; claim
[[ "$(ob "$o1")" == canceled ]] && ok "P5 cliente mandou PARAR depois do cancelamento e antes do envio: aviso cancelado" || ko "P5 $(ob "$o1")"
Q "update clients set comm_status = 'unknown', comm_status_source = null where id = '$K2'" >/dev/null 2>&1 || Q "update clients set comm_status = 'unknown' where id = '$K2'" >/dev/null
Q "update whatsapp_private.sessions set status = 'disconnected' where company_id = '$A'" >/dev/null
d1="$(mk "$K1")"; cancel "$d1"
[[ "$(last "$d1")" == "cancel:skipped:not_connected" ]] && ok "P6 WhatsApp desconectado: não envia; motivo registrado" || ko "P6 $(last "$d1")"
Q "update whatsapp_private.sessions set status = 'connecting' where company_id = '$A'" >/dev/null
d2="$(mk "$K1")"; cancel "$d2"; claim
[[ "$(last "$d2")" == "cancel:queued" && "$(ob "$d2")" == pending ]] && ok "P7 WhatsApp reconectando: o aviso ESPERA na fila (sem gastar tentativa)" || ko "P7 $(last "$d2") $(ob "$d2")"
SESS "$A" w1; claim
[[ "$(ob "$d2")" == processing ]] && ok "P8 reconectou: o aviso sai" || ko "P8 $(ob "$d2")"
Q "update whatsapp_private.sessions set auto_confirmation = false where company_id = '$A'" >/dev/null
f1="$(mk "$K1")"; cancel "$f1"
[[ "$(last "$f1")" == "cancel:skipped:disabled" ]] && ok "P9 empresa desligou as mensagens automáticas: sem aviso" || ko "P9 $(last "$f1")"
Q "update whatsapp_private.sessions set auto_confirmation = true where company_id = '$A'" >/dev/null
C3ID="$(Q "insert into companies (name) values ('Sem WhatsApp') returning id")"
M3="$(Q "insert into company_members (company_id, user_id, role) values ('$C3ID', '$OWN', 'owner') returning id")"
S3="$(Q "insert into services (company_id, name, duration_minutes, price) values ('$C3ID', 'Escova', 60, 50) returning id")"
K3="$(cli "$C3ID" 'Cliente 3' '' "'11987650099'")"
g1="$(mk "$K3" "$C3ID" "$S3" "$M3")"; cancel "$g1"
[[ "$(nn "$g1")" == 0 ]] && ok "P10 empresa sem WhatsApp: nada registrado" || ko "P10"

# ================================================================ I. isolamento, robustez, permissões
age; ib="$(mk "$KB" "$B" "$SB" "$MB")"; cancel "$ib" "$OWNB"; claim w1
[[ "$(ob "$ib")" == pending ]] && ok "I1 worker da empresa A não pega o aviso da empresa B" || ko "I1 $(ob "$ib")"
claim w2
[[ "$(ob "$ib")" == processing ]] && ok "I2 o worker da empresa B pega o aviso dela" || ko "I2 $(ob "$ib")"
Q "update whatsapp_private.settings set send_per_minute = 1" >/dev/null
rl1="$(mk "$K1")"; rl2="$(mk "$K1")"; cancel "$rl1"; cancel "$rl2"
check "I3 limite de ritmo: o cancelamento é GRAVADO; o aviso fica 'rate_limited'" \
  "(select status = 'cancelado' from appointments where id = '$rl2') and (select reason = 'rate_limited' from whatsapp_private.appointment_notices where appointment_id = '$rl2')"
Q "update whatsapp_private.settings set send_per_minute = 20" >/dev/null; age
Q "alter function whatsapp_private.reschedule_notice_text(uuid, timestamptz) rename to reschedule_notice_text_off" >/dev/null
e1="$(mk "$K1")"; r="$(ed "$e1" "'1 day'")"
Q "alter function whatsapp_private.reschedule_notice_text_off(uuid, timestamptz) rename to reschedule_notice_text" >/dev/null
[[ "$r" == *'"changed": true'* && "$(last "$e1")" == "reschedule:skipped:error" ]] && ok "I4 erro interno no aviso: a remarcação é GRAVADA mesmo assim" || ko "I4 $r $(last "$e1")"
j="$(U "$OWN" "select wa_get_change_notice('$c1')")"
[[ "$j" == *'"kind": "cancel"'* && "$j" != *5511* && "$j" != *Ana* ]] && ok "I5 a tela vê a situação do aviso, sem telefone nem texto" || ko "I5 $j"
errc P0002 "I6 dona de outra empresa não vê o aviso" U "$OWNB" "select wa_get_change_notice('$c1')"
errc 42501 "I7 authenticated NÃO lê a tabela de avisos" U "$OWN" "select count(*) from whatsapp_private.appointment_notices"
errc 42501 "I8 authenticated NÃO chama a função do texto" U "$OWN" "select whatsapp_private.cancel_notice_text('$c1')"
errc 42501 "I9 wa_worker NÃO chama a RPC do app" W "select wa_get_change_notice('$c1')"
check "I10 wa_worker continua com SÓ as 13 funções; nada privado exposto para a API" \
  "(select count(*) = 13 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'whatsapp_private' and has_function_privilege('wa_worker', p.oid, 'execute'))
   and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join unnest(array['anon','authenticated','service_role']) rl
                   where n.nspname = 'whatsapp_private' and has_function_privilege(rl, p.oid, 'execute'))"
check "I11 TODOS os avisos gerados: sem assinatura, sem buracos, até 1 emoji, com data e hora" \
  "(select count(*) > 8 and bool_and(o.body !~ 'Studio|Tain|  |\\(\\)|, \\.' and o.body ~ '\\d{2}/\\d{2}' and o.body ~ 'às \\d{1,2}h'
          and (select count(*) from regexp_matches(o.body, '[💕✨🌸]', 'g')) <= 1)
     from whatsapp_private.appointment_notices an join whatsapp_private.outbox o on o.id = an.outbox_id)"
psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/0023_whatsapp_change_notices.sql" >/dev/null 2>&1 && ok "I12 a 0023 pode ser reaplicada" || ko "I12"
check "I13 depois de reaplicar: 1 gatilho de aviso, chave preservada" \
  "(select count(*) = 1 from pg_trigger where tgname = 'trg_appointments_wa_change_notice') and (select change_notices_enabled from whatsapp_private.settings)"

echo "RESULTADO avisos 0023: PASS=$pass FAIL=$fail"
dropdb --force "$DB"
[[ $fail -eq 0 ]]
