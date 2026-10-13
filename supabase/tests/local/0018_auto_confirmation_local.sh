#!/usr/bin/env bash
# ============================================================================
# 0018 — confirmação AUTOMÁTICA de agendamento. SOMENTE LOCAL (Postgres local).
# Banco do zero com todas as migrations. Agendamentos criados como a usuária
# logada (papel authenticated + RLS reais), fila consumida como o papel wa_worker
# (funções reais do worker). O WhatsApp em si não participa (ver integração do worker).
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DB="aurea_auto_0018"
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
# erro esperado com SQLSTATE: errc <codigo> <nome> <comando...>
errc() { local code="$1" name="$2"; shift 2; local out; out="$("$@" 2>&1)"; grep -q "ERROR:  $code" <<<"$out" && ok "$name" || ko "$name -> $(head -c 200 <<<"$out")"; }

# ---------------------------------------------------------------- fixtures
eval "$(Q "
do \$\$
declare uo uuid; up uuid; ur uuid; ub uuid; a uuid; b uuid;
begin
  insert into auth.users (email, raw_user_meta_data) values ('own@t.local', '{\"full_name\":\"Olga Dona\"}') returning id into uo;
  insert into auth.users (email, raw_user_meta_data) values ('pro@t.local', '{\"full_name\":\"Patrícia Souza\"}') returning id into up;
  insert into auth.users (email) values ('rec@t.local') returning id into ur;
  insert into auth.users (email) values ('ownb@t.local') returning id into ub;
  insert into companies (name) values ('Studio A') returning id into a;
  insert into companies (name) values ('Studio B') returning id into b;
  insert into company_members (company_id, user_id, role) values (a, uo, 'owner'), (a, up, 'professional'), (a, ur, 'reception'), (b, ub, 'owner');
  perform set_config('zz.a', a::text, false); perform set_config('zz.b', b::text, false);
end \$\$;
select string_agg(format('%s=%s', k, v), ' ') from (
  select 'A' k, id::text v from companies where name = 'Studio A' union all
  select 'B', id::text from companies where name = 'Studio B' union all
  select 'OWN', id::text from auth.users where email = 'own@t.local' union all
  select 'PRO', id::text from auth.users where email = 'pro@t.local' union all
  select 'REC', id::text from auth.users where email = 'rec@t.local' union all
  select 'OWNB', id::text from auth.users where email = 'ownb@t.local') z")"
MPRO="$(Q "select cm.id from company_members cm join auth.users u on u.id = cm.user_id where u.email = 'pro@t.local'")"
MB="$(Q "select cm.id from company_members cm join auth.users u on u.id = cm.user_id where u.email = 'ownb@t.local'")"
SA="$(Q "insert into services (company_id, name, duration_minutes, price) values ('$A', 'Manicure', 60, 80) returning id")"
SB="$(Q "insert into services (company_id, name, duration_minutes, price) values ('$B', 'Pedicure', 60, 80) returning id")"
cli() { Q "insert into clients (company_id, name, phone $3) values ('$1', '$2', $4) returning id"; }
K_OK="$(cli "$A" 'Ana Lima' '' "'11987654321'")"
K_OK2="$(cli "$A" 'Bia Rocha' '' "'11987650077'")"
K_NP="$(cli "$A" 'Sem Fone' '' "null")"
K_IP="$(cli "$A" 'Fone Ruim' '' "'123'")"
K_LL="$(cli "$A" 'Fixo' '' "'1133334444'")"
K_AR="$(cli "$A" 'Arquivada' ', archived_at' "'11987650004', now()")"
K_BL="$(cli "$A" 'Bloqueada' ', comm_status' "'11987650003', 'blocked'")"
K_B="$(cli "$B" 'Ana na B' '' "'11987654321'")"
SESS() { Q "insert into whatsapp_private.sessions (company_id, status, phone, last_seen_at, lease_owner, lease_until, connected_at)
            values ('$1', 'connected', '5511900000000', now(), '$2', now() + interval '10 minutes', now())
            on conflict (company_id) do update set status = 'connected', last_seen_at = now(), lease_owner = '$2',
              lease_until = now() + interval '10 minutes', auto_confirmation = true" >/dev/null; }
# horários sempre distintos (mk roda em subshell: o contador fica no banco)
Q "create sequence zz_slot; grant usage on sequence zz_slot to authenticated" >/dev/null
# novo agendamento COMO A USUÁRIA (RLS real). mk <cliente> [empresa] [serviço] [membro] [status] [início]
mk() {
  local co="${2:-$A}" sv="${3:-$SA}" m="${4:-$MPRO}" st="${5:-agendado}" uid="$OWN"
  [[ "$co" == "$B" ]] && uid="$OWNB"
  local start="${6:-date_trunc('minute', now()) + nextval('zz_slot') * interval '1 day'}"
  U "$uid" "insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end, price, status)
            select '$co', '$1', '$sv', '$m', t, t + interval '1 hour', 80, '$st' from (select $start as t) z returning id"
}
conf() { Q "select coalesce((select status || coalesce(':' || reason, '') from whatsapp_private.appointment_confirmations where appointment_id = '$1'), 'none')"; }
nout() { Q "select count(*) from whatsapp_private.outbox where appointment_id = '$1'"; }
reset_queue() { Q "update whatsapp_private.outbox set status = 'canceled' where kind = 'send_text' and status in ('pending','processing')" >/dev/null; }

# ================================================================ D. desligado (padrão)
SESS "$A" w1; SESS "$B" w2
check "D1 a 0018 nasce DESLIGADA (chave global false)" "not (select auto_confirmation_enabled from whatsapp_private.settings)"
a="$(mk "$K_OK")"
[[ "$(conf "$a")" == none && "$(nout "$a")" == 0 ]] && ok "D2 desligada: agendamento novo não registra nem enfileira nada" || ko "D2"

Q "update whatsapp_private.settings set auto_confirmation_enabled = true" >/dev/null

# ================================================================ C. criação gera UMA confirmação
a="$(mk "$K_OK")"
[[ "$(conf "$a")" == queued && "$(nout "$a")" == 1 ]] && ok "C1 agendamento novo: 1 confirmação na fila (queued)" || ko "C1 $(conf "$a") $(nout "$a")"
check "C2 pedido certo: cliente, telefone normalizado, chave por agendamento, autor = quem agendou" \
  "(select client_id = '$K_OK' and to_phone = '5511987654321' and idempotency_key = 'auto-confirmation:$a' and status = 'pending'
          and created_by = '$OWN' from whatsapp_private.outbox where appointment_id = '$a')"
check "C3 texto com dados reais: 1º nome, serviço · duração, assinatura da profissional · empresa" \
  "(select body like 'Oi, Ana%' and body like '%Manicure · 1h%' and body like '%Patrícia · Studio A' and body like '%às %h%'
     from whatsapp_private.outbox where appointment_id = '$a')"
check "C4 texto do banco = whatsapp_private.confirmation_text (mesma regra da tela; paridade em 0018_message_parity)" \
  "(select body = whatsapp_private.confirmation_text('$a') from whatsapp_private.outbox where appointment_id = '$a')"
[[ "$(U "$OWN" "select j->>'state' = 'queued' and not (j::text like '%5511987654321%') and not (j::text like '%Manicure%')
               from (select wa_get_appointment_confirmation('$a') j) z")" == t ]] \
  && ok "C5 situação visível para a usuária: queued, sem telefone nem texto na resposta" || ko "C5"
[[ "$(U "$REC" "select wa_get_appointment_confirmation('$a')->>'state'")" == queued ]] && ok "C6 recepção também vê a situação" || ko "C6"

# ================================================================ E. edição NÃO gera confirmação
U "$OWN" "update appointments set notes = 'obs', price = 95 where id = '$a'" >/dev/null
U "$OWN" "update appointments set scheduled_start = scheduled_start + interval '2 hours', scheduled_end = scheduled_end + interval '2 hours' where id = '$a'" >/dev/null
U "$OWN" "update appointments set status = 'confirmado' where id = '$a'" >/dev/null
[[ "$(nout "$a")" == 1 && "$(Q "select count(*) from whatsapp_private.appointment_confirmations where appointment_id = '$a'")" == 1 ]] \
  && ok "E1 editar (obs, preço, horário, status) não cria outra confirmação" || ko "E1"
check "E2 reaplicar o gatilho à mão no mesmo agendamento não duplica (chave + registro únicos)" \
  "(select count(*) = 1 from whatsapp_private.outbox where idempotency_key = 'auto-confirmation:$a')"

# ================================================================ R. transação desfeita / retries do app
before="$(Q "select count(*) from whatsapp_private.outbox")"
"${PSQL[@]}" -c "begin; set local \"request.jwt.claim.sub\" = '$OWN'; set local role authenticated;
  insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end, price)
  values ('$A', '$K_OK2', '$SA', '$MPRO', now() + interval '300 days', now() + interval '300 days 1 hour', 80); rollback;" >/dev/null
[[ "$(Q "select count(*) from whatsapp_private.outbox")" == "$before" ]] && ok "R1 agendamento desfeito (erro/rollback) não deixa confirmação órfã" || ko "R1"
errc 23P01 "R2 repetir o MESMO horário (clique duplo) é recusado pela agenda e não enfileira 2ª confirmação" \
  U "$OWN" "insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end, price)
            select company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end, price from appointments where id = '$a'"
check "R3 depois da recusa: continua 1 confirmação para a cliente" "(select count(*) = 1 from whatsapp_private.outbox where client_id = '$K_OK' and kind = 'send_text' and status = 'pending')"

# ================================================================ B. quem NÃO recebe
for pair in "K_NP:no_phone" "K_IP:invalid_phone" "K_LL:landline" "K_AR:archived" "K_BL:blocked"; do
  var="${pair%%:*}"; reason="${pair##*:}"
  x="$(mk "${!var}")"
  [[ "$(conf "$x")" == "skipped:$reason" && "$(nout "$x")" == 0 ]] && ok "B $reason: não enfileira; registra o motivo" || ko "B $reason -> $(conf "$x")"
done
x="$(mk "$K_OK" "$A" "$SA" "$MPRO" agendado "now() - interval '3 days'")"
[[ "$(conf "$x")" == none ]] && ok "B passado: agendamento retroativo não gera confirmação" || ko "B passado $(conf "$x")"
x="$(mk "$K_OK" "$A" "$SA" "$MPRO" cancelado)"
[[ "$(conf "$x")" == none ]] && ok "B cancelado: lançado já cancelado não gera confirmação" || ko "B cancelado $(conf "$x")"

# ================================================================ S. sessão / preferência
Q "update whatsapp_private.sessions set last_seen_at = now() - interval '10 minutes' where company_id = '$A'" >/dev/null
x="$(mk "$K_OK2")"
[[ "$(conf "$x")" == "skipped:not_connected" ]] && ok "S1 worker sem sinal: não enfileira (a tela oferece o wa.me)" || ko "S1 $(conf "$x")"
Q "update whatsapp_private.sessions set status = 'disconnected' where company_id = '$A'" >/dev/null
x="$(mk "$K_OK2")"
[[ "$(conf "$x")" == "skipped:not_connected" ]] && ok "S2 WhatsApp desconectado: não enfileira" || ko "S2 $(conf "$x")"
SESS "$A" w1
errc 42501 "S3 profissional NÃO altera a preferência da empresa" U "$PRO" "select wa_set_auto_confirmation('$A', false)"
errc 42501 "S3b recepção NÃO altera a preferência da empresa" U "$REC" "select wa_set_auto_confirmation('$A', false)"
U "$OWN" "select wa_set_auto_confirmation('$A', false)" >/dev/null
x="$(mk "$K_OK2")"
[[ "$(conf "$x")" == "skipped:disabled" && "$(nout "$x")" == 0 ]] && ok "S4 owner desligou para a empresa: não enfileira (disabled)" || ko "S4 $(conf "$x")"
[[ "$(U "$PRO" "select (wa_get_auto_confirmation('$A')->>'enabled')")" == false ]] && ok "S5 qualquer membro lê a preferência" || ko "S5"
U "$OWN" "select wa_set_auto_confirmation('$A', true)" >/dev/null
xb="$(mk "$K_B" "$B" "$SB" "$MB")"
[[ "$(conf "$xb")" == queued ]] && ok "S6 preferência/sessão de A não afetam a empresa B" || ko "S6 $(conf "$xb")"
C3ID="$(Q "insert into companies (name) values ('Studio Sem WhatsApp') returning id")"
errc 22023 "S7 preferência só para empresa que já pediu conexão (não cria sessão)" \
  "${PSQL[@]}" -c "begin; set local \"request.jwt.claim.sub\" = '$OWN'; insert into company_members (company_id, user_id, role) values ('$C3ID', '$OWN', 'owner'); set local role authenticated; select wa_set_auto_confirmation('$C3ID', false); commit;"

# ================================================================ I. isolamento
errc P0002 "I1 dona de B NÃO vê a confirmação de um agendamento de A" U "$OWNB" "select wa_get_appointment_confirmation('$a')"
errc P0002 "I2 dona de B NÃO lê nem muda a preferência de A" U "$OWNB" "select wa_get_auto_confirmation('$A')"
W "select count(*) from whatsapp_private.claim_outbox('w2', 50, 60)" >/dev/null
check "I3 worker da B (w2) pega só a confirmação da B; a de A continua pendente" \
  "(select status from whatsapp_private.outbox where appointment_id = '$xb') = 'processing'
   and (select status from whatsapp_private.outbox where appointment_id = '$a') = 'pending'"

# ================================================================ O. opt-out (SAIR) em qualquer caminho
reset_queue
o1="$(mk "$K_OK")"; ob="$(mk "$K_B" "$B" "$SB" "$MB")"
W "select whatsapp_private.record_inbound('$A', 'w1', 'IN-SAIR-1', '5511987654321@s.whatsapp.net', 'Parar.')" >/dev/null
check "O1 'Parar.' bloqueia a cliente em A (client_opt_out)" "(select comm_status = 'blocked' and comm_status_source = 'client_opt_out' from clients where id = '$K_OK')"
W "select count(*) from whatsapp_private.claim_outbox('w1', 50, 60)" >/dev/null
check "O2 confirmação pendente de quem saiu é CANCELADA na fila, não enviada" \
  "(select status = 'canceled' and last_error like '%blocked%' from whatsapp_private.outbox where appointment_id = '$o1')"
[[ "$(U "$OWN" "select wa_get_appointment_confirmation('$o1')->>'reason'")" == recipient_blocked ]] && ok "O3 a tela vê 'cancelada: cliente bloqueada'" || ko "O3"
x="$(mk "$K_OK")"
[[ "$(conf "$x")" == "skipped:blocked" ]] && ok "O4 novo agendamento de quem saiu: não enfileira (blocked)" || ko "O4 $(conf "$x")"
check "O5 o SAIR em A não bloqueia a mesma pessoa na B; a fila da B segue" \
  "(select comm_status from clients where id = '$K_B') = 'unknown' and (select status from whatsapp_private.outbox where appointment_id = '$ob') = 'pending'"
Q "update clients set comm_status = 'unknown', comm_status_source = null where id = '$K_OK'" >/dev/null 2>&1 || Q "update clients set comm_status = 'unknown' where id = '$K_OK'" >/dev/null

# ================================================================ F. fila: validade no momento do envio
reset_queue
f_cancel="$(mk "$K_OK")"; f_del="$(mk "$K_OK2")"; f_move="$(mk "$K_OK")"; f_cli="$(mk "$K_OK2")"; f_late="$(mk "$K_OK")"
U "$OWN" "update appointments set status = 'cancelado' where id = '$f_cancel'" >/dev/null
# apagar agendamento EM ABERTO não existe pelo app (delete_appointment só aceita concluído); simula remoção direta
Q "delete from appointments where id = '$f_del'" >/dev/null
U "$OWN" "update appointments set client_id = '$K_OK' where id = '$f_cli'" >/dev/null
Q "update appointments set scheduled_start = now() - interval '1 minute', scheduled_end = now() + interval '59 minutes' where id = '$f_late'" >/dev/null
old_body="$(Q "select md5(body) from whatsapp_private.outbox where appointment_id = '$f_move'")"
U "$OWN" "update appointments set scheduled_start = scheduled_start + interval '400 days 30 minutes', scheduled_end = scheduled_end + interval '400 days 30 minutes' where id = '$f_move'" >/dev/null
Q "update whatsapp_private.sessions set status = 'connecting' where company_id = '$A'" >/dev/null
W "select count(*) from whatsapp_private.claim_outbox('w1', 50, 60)" >/dev/null
check "F1 sessão reconectando: envio NÃO é pego e não gasta tentativa" \
  "(select status = 'pending' and attempts = 0 from whatsapp_private.outbox where appointment_id = '$f_move')"
check "F2 cancelado / apagado / trocou de cliente / já começou → cancelado na fila" \
  "(select count(*) = 4 and bool_and(status = 'canceled') from whatsapp_private.outbox where appointment_id in ('$f_cancel','$f_del','$f_cli','$f_late'))"
check "F3 remarcado: o texto pendente é REFEITO com o horário novo (igual ao gerado agora)" \
  "(select md5(body) <> '$old_body' and body = whatsapp_private.confirmation_text('$f_move') from whatsapp_private.outbox where appointment_id = '$f_move')"
Q "update clients set phone = '(11) 97777-1234' where id = '$K_OK'" >/dev/null
W "select count(*) from whatsapp_private.claim_outbox('w1', 50, 60)" >/dev/null
check "F4 cliente trocou de celular antes do envio: vai para o número novo" "(select to_phone from whatsapp_private.outbox where appointment_id = '$f_move') = '5511977771234'"
Q "update clients set phone = '11987654321' where id = '$K_OK'" >/dev/null

# ================================================================ T. tentativas sem duplicidade
SESS "$A" w1
claimed="$(W "select string_agg(id::text, ',') from whatsapp_private.claim_outbox('w1', 50, 60) where appointment_id = '$f_move'")"
[[ -n "$claimed" ]] && ok "T1 sessão conectada: o worker pega a confirmação" || ko "T1"
[[ "$(U "$OWN" "select wa_get_appointment_confirmation('$f_move')->>'state'")" == sending ]] && ok "T2 tela: 'sending'" || ko "T2"
W "select whatsapp_private.fail_outbox('$claimed', 'w1', 'rede', true)" >/dev/null
check "T3 falha temporária: volta para a fila com espera, 1 tentativa gasta" \
  "(select status = 'pending' and attempts = 1 and available_at > now() from whatsapp_private.outbox where id = '$claimed')"
[[ "$(U "$OWN" "select wa_get_appointment_confirmation('$f_move')->>'state'")" == retrying ]] && ok "T4 tela: 'retrying'" || ko "T4"
Q "update whatsapp_private.outbox set available_at = now() where id = '$claimed'" >/dev/null
W "select count(*) from whatsapp_private.claim_outbox('w1', 50, 60)" >/dev/null
W "select whatsapp_private.complete_outbox('$claimed', 'w1', '3EB0AAAAAAAAAAAAAAAAAA')" >/dev/null
W "select whatsapp_private.complete_outbox('$claimed', 'w1', '3EB0AAAAAAAAAAAAAAAAAA')" >/dev/null
check "T5 enviada: 1 pedido 'sent', 1 mensagem; concluir de novo é inofensivo" \
  "(select status from whatsapp_private.outbox where id = '$claimed') = 'sent'
   and (select count(*) from whatsapp_private.messages where outbox_id = '$claimed') = 1"
W "select whatsapp_private.record_message_status('$A', 'w1', '3EB0AAAAAAAAAAAAAAAAAA', 'delivered')" >/dev/null
[[ "$(U "$OWN" "select wa_get_appointment_confirmation('$f_move')->>'state'")" == delivered ]] && ok "T6 tela: 'delivered' (recibo do WhatsApp)" || ko "T6"
W "select count(*) from whatsapp_private.claim_outbox('w1', 50, 60)" >/dev/null
check "T7 depois de enviada, nenhuma volta da fila a pega de novo" "(select status from whatsapp_private.outbox where id = '$claimed') = 'sent'"

# ================================================================ L. limite e falhas nunca bloqueiam a agenda
reset_queue
Q "update whatsapp_private.settings set send_per_minute = 2" >/dev/null
l1="$(mk "$K_OK")"; l2="$(mk "$K_OK2")"; l3="$(mk "$K_OK")"
[[ "$(conf "$l3")" == "skipped:rate_limited" && -n "$l3" ]] && ok "L1 limite de ritmo: o agendamento é SALVO; a confirmação fica 'rate_limited'" || ko "L1 $(conf "$l3")"
Q "update whatsapp_private.settings set send_per_minute = 20" >/dev/null
Q "alter function whatsapp_private.confirmation_text(uuid, timestamptz) rename to confirmation_text_off" >/dev/null
e1="$(mk "$K_OK2" 2>/dev/null)"
Q "alter function whatsapp_private.confirmation_text_off(uuid, timestamptz) rename to confirmation_text" >/dev/null
[[ -n "$e1" && "$(conf "$e1")" == "skipped:error" ]] && ok "L2 erro interno na confirmação: o agendamento é SALVO; registra 'error'" || ko "L2 '$e1' $(conf "$e1")"

# ================================================================ N. nada muda na agenda / financeiro
reset_queue
snap() { Q "select md5(string_agg(x, '|' order by x)) from (select to_jsonb(p)::text x from payments p union all select 'n' || count(*) from payments) z"; }
P0="$(snap)"
Q "update whatsapp_private.settings set auto_confirmation_enabled = false" >/dev/null
off="$(mk "$K_OK2")"
aud_off="$(Q "select count(*) from audit_logs where entity_id = '$off'")"
hist_off="$(Q "select count(*) from appointment_status_history where appointment_id = '$off'")"
Q "update whatsapp_private.settings set auto_confirmation_enabled = true" >/dev/null
on="$(mk "$K_OK2")"
check "N1 a linha do agendamento é gravada EXATAMENTE como enviada (o gatilho não altera nada)" \
  "(select status = 'agendado' and price = 80 and client_id = '$K_OK2' and notes is null from appointments where id = '$on')"
[[ "$(Q "select count(*) from audit_logs where entity_id = '$on'")" == "$aud_off" && "$(Q "select count(*) from appointment_status_history where appointment_id = '$on'")" == "$hist_off" ]] \
  && ok "N2 auditoria e histórico: ligado gera o MESMO que desligado" || ko "N2"
[[ "$(snap)" == "$P0" ]] && ok "N3 recebimentos/financeiro intocados" || ko "N3"
check "N4 o gatilho é AFTER INSERT (não roda em UPDATE/DELETE) e é o único objeto novo em appointments" \
  "(select count(*) = 1 from pg_trigger where tgrelid = 'appointments'::regclass and tgname = 'trg_appointments_wa_auto_confirmation'
     and tgtype & 4 = 4 and tgtype & (8|16) = 0 and tgtype & 2 = 0)"

# ================================================================ P. permissões
errc 42501 "P1 authenticated NÃO lê o registro de confirmações" U "$OWN" "select count(*) from whatsapp_private.appointment_confirmations"
errc 42501 "P2 authenticated NÃO chama a função do texto" U "$OWN" "select whatsapp_private.confirmation_text('$on')"
errc 42501 "P3 wa_worker NÃO lê o registro de confirmações" W "select count(*) from whatsapp_private.appointment_confirmations"
errc 42501 "P4 wa_worker NÃO chama as RPCs novas do app" W "select wa_get_appointment_confirmation('$on')"
check "P5 wa_worker continua com SÓ as 13 funções do worker (nenhuma nova)" \
  "(select count(*) = 13 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'whatsapp_private' and has_function_privilege('wa_worker', p.oid, 'execute'))"
check "P6 RPCs novas: authenticated executa; anon e service_role não" \
  "(select count(*) = 3 and bool_and(has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
          and not has_function_privilege('service_role', p.oid, 'execute'))
     from pg_proc p where p.proname in ('wa_get_appointment_confirmation','wa_get_auto_confirmation','wa_set_auto_confirmation'))"
check "P7 tabela nova com RLS e sem acesso para anon/authenticated/service_role/wa_worker" \
  "(select relrowsecurity from pg_class where oid = 'whatsapp_private.appointment_confirmations'::regclass)
   and not exists (select 1 from unnest(array['anon','authenticated','service_role','wa_worker']) rl
                   where has_table_privilege(rl, 'whatsapp_private.appointment_confirmations', 'select,insert,update,delete'))"

# ================================================================ M. reaplicar
"${PSQL[@]}" -1 -f "$ROOT/migrations/0018_whatsapp_auto_confirmation.sql" >/dev/null 2>&1 && ok "M1 a 0018 pode ser reaplicada" || ko "M1"
check "M2 depois de reaplicar: 1 gatilho, chave global preservada" \
  "(select count(*) = 1 from pg_trigger where tgname = 'trg_appointments_wa_auto_confirmation')
   and (select auto_confirmation_enabled from whatsapp_private.settings)"

echo "RESULTADO confirmação automática 0018: PASS=$pass FAIL=$fail"
dropdb --force "$DB"
[[ $fail -eq 0 ]]
