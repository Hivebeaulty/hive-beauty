#!/usr/bin/env bash
# ============================================================================
# 0027 (confirmação: sistema ou mensagem própria) + 0028 (central: envio para
# várias clientes). SOMENTE LOCAL. Banco montado até a 0026, privilégios no PIOR
# caso; RLS real (authenticated) e fila como wa_worker. Ensaia o roteiro:
# a reversão volta EXATAMENTE ao estado anterior.
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DB="aurea_0028"
export PGOPTIONS="-c client_min_messages=warning"
"$HERE/fresh_db.sh" "$DB" 0026 >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
PSQL=(psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d "$DB")
Q() { "${PSQL[@]}" -c "$1"; }
U() { "${PSQL[@]}" -c "begin; set local \"request.jwt.claim.sub\" = '$1'; set local role authenticated; $2; commit;"; }
W() { "${PSQL[@]}" -c "begin; set local role wa_worker; $1; commit;"; }
OPS="$ROOT/operations/0027_0028_aplicacao_supabase.sql"
blk() { sed -n "/^-- \[$1\]/,/^-- \[\/$1\]/p" "$OPS"; }
B() { psql -X -q -A -F'|' -t -d "$DB" -c "$(blk "$1")" 2>&1; }
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
ko() { echo "FAIL $1"; fail=$((fail+1)); }
check() { [[ "$(Q "select ($2)")" == "t" ]] && ok "$1" || ko "$1"; }
errc() { local code="$1" name="$2"; shift 2; local out; out="$("$@" 2>&1)"; grep -q "ERROR:  $code" <<<"$out" && ok "$name" || ko "$name -> $(head -c 200 <<<"$out")"; }

Q "alter default privileges grant execute on functions to anon, authenticated, service_role;
   alter default privileges grant all on tables to anon, authenticated, service_role;
   alter default privileges in schema whatsapp_private grant all on tables to anon, authenticated, service_role, wa_worker;
   alter default privileges in schema whatsapp_private grant execute on functions to anon, authenticated, service_role, wa_worker;" >/dev/null
eval "$(Q "do \$\$ declare uo uuid; up uuid; ur uuid; ub uuid; a uuid; b uuid; begin
  insert into auth.users (email) values ('own@c.local') returning id into uo;
  insert into auth.users (email) values ('pro@c.local') returning id into up;
  insert into auth.users (email) values ('rec@c.local') returning id into ur;
  insert into auth.users (email) values ('ownb@c.local') returning id into ub;
  insert into companies (name) values ('Studio Bella') returning id into a;
  insert into companies (name) values ('Studio B') returning id into b;
  insert into company_members (company_id, user_id, role) values (a, uo, 'owner'), (a, up, 'professional'), (a, ur, 'reception'), (b, ub, 'owner');
end \$\$;
select string_agg(format('%s=%s', k, v), ' ') from (
  select 'A' k, id::text v from companies where name = 'Studio Bella' union all select 'B', id::text from companies where name = 'Studio B'
  union all select 'OWN', id::text from auth.users where email = 'own@c.local' union all select 'PRO', id::text from auth.users where email = 'pro@c.local'
  union all select 'REC', id::text from auth.users where email = 'rec@c.local' union all select 'OWNB', id::text from auth.users where email = 'ownb@c.local') z")"
MA="$(Q "select cm.id from company_members cm join auth.users u on u.id = cm.user_id where u.email = 'own@c.local'")"
SA="$(Q "insert into services (company_id, name, duration_minutes, price) values ('$A', 'Manicure', 60, 50) returning id")"
cli() { Q "insert into clients (company_id, name, phone, comm_status) values ('$1', '$2', $3, '$4') returning id"; }
K_OK="$(cli "$A" 'Ana Maria Lima' "'11987654321'" allowed)"
K_OK2="$(cli "$A" 'Bia Rocha' "'11987650077'" allowed)"
K_UNK="$(cli "$A" 'Sem Autorização' "'11987650011'" unknown)"
K_BL="$(cli "$A" 'Saiu' "'11987650003'" blocked)"
K_NP="$(cli "$A" 'Sem Fone' "null" allowed)"
K_AR="$(Q "insert into clients (company_id, name, phone, comm_status, archived_at) values ('$A', 'Arquivada', '11987650004', 'allowed', now()) returning id")"
K_B="$(cli "$B" 'Cliente da B' "'11987650099'" allowed)"
Q "insert into whatsapp_private.sessions (company_id, status, phone, last_seen_at, lease_owner, lease_until, connected_at)
   values ('$A', 'connected', '5511900000000', now(), 'w1', now() + interval '10 minutes', now())" >/dev/null

STATE="select md5(string_agg(d, '|' order by d)) from (
  select n.nspname || '.' || p.proname || pg_get_function_identity_arguments(p.oid) || p.prosrc || coalesce(p.proacl::text,'') d
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','whatsapp_private','aurea_private')
  union all select pg_get_triggerdef(oid) from pg_trigger where not tgisinternal
  union all select table_schema || '.' || table_name || '.' || column_name || data_type || coalesce(column_default,'') from information_schema.columns where table_schema in ('public','whatsapp_private')
  union all select grantee || privilege_type || table_schema || table_name from information_schema.role_table_grants where table_schema in ('public','whatsapp_private')) z"
[[ "$(B B0)" == "t|f|f" ]] && ok "B0 antes: $(B B0)" || ko "B0: $(B B0)"
S0="$(Q "$STATE")"
for f in 0027_whatsapp_confirmation_choice.sql 0028_whatsapp_campaigns.sql 0029_whatsapp_campaign_no_footer.sql; do
  psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/$f" >/dev/null 2>&1 && ok "B2 $f aplicada" || ko "B2 $f"
done
B3="$(B B3)"; [[ "$B3" == "t|t|t|13|0|"* ]] && ok "B3 depois: $B3" || ko "B3: $B3"

# ================================================================ T. confirmação: sistema ou própria
appt() { U "$OWN" "insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end, price)
                   select '$A', '$1', '$SA', '$MA', t, t + interval '1 hour', 50 from (select date_trunc('hour', now()) + interval '$2' as t) z returning id"; }
a1="$(appt "$K_OK" "3 days")"
check "T1 padrão de todas = opção 1 (mensagens variadas do sistema, no singular)" \
  "whatsapp_private.confirmation_text('$a1') = whatsapp_private.system_confirmation_text('$a1') and whatsapp_private.confirmation_text('$a1') like 'Oi%'"
[[ "$(U "$PRO" "select wa_get_message_settings('$A') ->> 'mode'")" == system ]] && ok "T2 qualquer membro lê a escolha (padrão: sistema)" || ko "T2"
errc 42501 "T3 profissional NÃO muda a mensagem" U "$PRO" "select wa_set_message_settings('$A', 'custom', 'Olá {nome} {data} {horario}')"
errc 42501 "T4 recepção NÃO muda a mensagem" U "$REC" "select wa_set_message_settings('$A', 'custom', 'Olá {nome} {data} {horario}')"
errc AUT01 "T5 variável desconhecida: recusada (nunca vai {cupom} para a cliente)" U "$OWN" "select wa_set_message_settings('$A', 'custom', 'Olá {nome} {data} {horario} {cupom}')"
errc AUT01 "T6 sem {data}/{horario}: recusada" U "$OWN" "select wa_set_message_settings('$A', 'custom', 'Olá {nome}, te espero!')"
[[ "$(Q "select count(*) from whatsapp_private.message_templates")" == 0 ]] && ok "T7 recusas não gravaram nada" || ko "T7"
TPL='Olá {Nome}! Seu {serviço} está confirmado para {dia_semana}, {data}, às {HORÁRIO}.\n\nPara remarcações, o prazo mínimo é de 24h.\n\n{negocio}'
U "$OWN" "select wa_set_message_settings('$A', 'custom', E'$TPL')" >/dev/null
check "T8 dona salva a mensagem própria: confirmação usa o texto dela, variáveis trocadas" \
  "(select t like 'Olá Ana! Seu Manicure está confirmado para %, __/__, às %h.%' and t like '%prazo mínimo é de 24h.' || E'\\n\\n' || 'Studio Bella'
     from (select whatsapp_private.confirmation_text('$a1') t) z)"
Q "update whatsapp_private.settings set auto_confirmation_enabled = true" >/dev/null
a2="$(appt "$K_OK2" "4 days")"
check "T9 confirmação AUTOMÁTICA (gatilho real) sai com a mensagem própria" \
  "(select o.body like 'Olá Bia! Seu Manicure está confirmado%' from whatsapp_private.appointment_confirmations ac join whatsapp_private.outbox o on o.id = ac.outbox_id where ac.appointment_id = '$a2')"
U "$OWN" "select wa_set_message_settings('$A', 'custom', 'Oi {nome}, {data} às {horario}.')" >/dev/null
W "select count(*) from whatsapp_private.claim_outbox('w1', 50, 60)" >/dev/null
check "T10 mudou a mensagem antes do envio: a confirmação pendente sai com o texto NOVO" \
  "(select o.body like 'Oi Bia, __/__ às %h%.' from whatsapp_private.appointment_confirmations ac join whatsapp_private.outbox o on o.id = ac.outbox_id where ac.appointment_id = '$a2')"
U "$OWN" "select wa_set_message_settings('$A', 'system', null)" >/dev/null
check "T11 voltou ao sistema: variações de novo; a mensagem própria fica guardada para depois" \
  "whatsapp_private.confirmation_text('$a1') = whatsapp_private.system_confirmation_text('$a1')
   and (select confirmation_template = 'Oi {nome}, {data} às {horario}.' from whatsapp_private.message_templates where company_id = '$A')"
Q "update whatsapp_private.message_templates set confirmation_mode = 'custom', confirmation_template = 'quebrada {xyz}' where company_id = '$A'" >/dev/null
check "T12 mensagem própria inválida gravada por fora: NUNCA é enviada (cai no sistema)" "whatsapp_private.confirmation_text('$a1') = whatsapp_private.system_confirmation_text('$a1')"
Q "update whatsapp_private.message_templates set confirmation_mode = 'system' where company_id = '$A'" >/dev/null
Q "update whatsapp_private.settings set auto_confirmation_enabled = false" >/dev/null
errc P0002 "T13 dona de outra empresa não lê nem muda a mensagem" U "$OWNB" "select wa_get_message_settings('$A')"

# ================================================================ C. central: envio para várias clientes
send() { U "$1" "select wa_send_campaign('$A', array[$2]::uuid[], E'$3', '$4')"; }
R1="$(Q "select gen_random_uuid()")"
errc 42501 "C1 profissional NÃO envia pela central" send "$PRO" "'$K_OK'" 'Oi {nome}' "$R1"
r="$(send "$OWN" "'$K_OK','$K_OK2','$K_UNK','$K_BL','$K_NP','$K_AR','$K_B'" 'Oi {nome}! Novidades no {negocio}.' "$R1")"
[[ "$r" == *'"queued": 2'* ]] && ok "C2 só as 2 com autorização e celular válido entram" || ko "C2 $r"
check "C3 puladas com motivo: sem autorização, saiu, sem telefone, arquivada, outra empresa" \
  "(select skipped = '{\"blocked\": 1, \"no_phone\": 1, \"archived\": 1, \"not_found\": 1, \"consent_unknown\": 1}'::jsonb from whatsapp_private.campaigns where id = '$R1')"
check "C4 texto: {nome} = 1º nome, {negocio}; SEM rodapé (0029)" \
  "(select body = 'Oi Ana! Novidades no Studio Bella.'
     from whatsapp_private.outbox where campaign_id = '$R1' and client_id = '$K_OK')"
EXP="$(node -e '
const { load } = require("/home/claude/hive-beauty/tests/load-ts.cjs");
const c = load("/home/claude/hive-beauty/lib/hive/communication.ts");
console.log(c.campaignMessage("  Oi {Nome}! {negocio} {xyz}  ", { clientName: "Bia Rocha", companyName: "Studio Bella" }));' | md5sum | cut -c1-32)"
SQLM="$(Q "select whatsapp_private.campaign_text('  Oi {Nome}! {negocio} {xyz}  ', 'Bia Rocha', 'Studio Bella')" | md5sum | cut -c1-32)"
[[ "$EXP" == "$SQLM" ]] && ok "C5 texto do banco = prévia da tela (paridade, inclusive maiúsculas e variável desconhecida)" || ko "C5 $EXP vs $SQLM"
check "C6 espaçadas: entre uma e a seguinte, SEMPRE >= 12 s (proteção contra bloqueio)" \
  "(select max(available_at) - min(available_at) >= interval '12 seconds' from whatsapp_private.outbox where campaign_id = '$R1')"
r="$(send "$OWN" "'$K_OK','$K_OK2'" 'Oi {nome}! Novidades no {negocio}.' "$R1")"
[[ "$r" == *'"repeated": true'* && "$(Q "select count(*) from whatsapp_private.outbox where campaign_id = '$R1'")" == 2 ]] \
  && ok "C7 clique duplo / rede: o MESMO envio não enfileira de novo" || ko "C7 $r"
errc AUW05 "C8 variável desconhecida na central: recusada" send "$OWN" "'$K_OK'" 'Oi {cupom}' "$(Q "select gen_random_uuid()")"
errc AUW05 "C9 mensagem vazia: recusada" send "$OWN" "'$K_OK'" '   ' "$(Q "select gen_random_uuid()")"
errc AUW02 "C10 ninguém pode receber: recusado (nada enfileirado)" send "$OWN" "'$K_UNK','$K_BL'" 'Oi' "$(Q "select gen_random_uuid()")"
Q "update whatsapp_private.settings set campaign_max_recipients = 1" >/dev/null
errc AUW06 "C11 acima do máximo por envio: recusado" send "$OWN" "'$K_OK','$K_OK2'" 'Oi' "$(Q "select gen_random_uuid()")"
Q "update whatsapp_private.settings set campaign_max_recipients = 200, send_per_day = 3" >/dev/null
errc AUW03 "C12 limite diário: recusado com o quanto ainda dá (nada enfileirado)" send "$OWN" "'$K_OK','$K_OK2'" 'Oi' "$(Q "select gen_random_uuid()")"
Q "update whatsapp_private.settings set send_per_day = 300" >/dev/null
Q "update whatsapp_private.sessions set status = 'disconnected' where company_id = '$A'" >/dev/null
errc AUW01 "C13 WhatsApp desconectado: recusado" send "$OWN" "'$K_OK'" 'Oi' "$(Q "select gen_random_uuid()")"
Q "update whatsapp_private.sessions set status = 'connected', last_seen_at = now() where company_id = '$A'" >/dev/null

# envio grande NÃO trava as confirmações (limite por minuto é só das confirmações)
Q "insert into clients (company_id, name, phone, comm_status) select '$A', 'Lote ' || i, '119876' || lpad(i::text, 5, '0'), 'allowed' from generate_series(1, 40) i" >/dev/null
IDS="$(Q "select string_agg(quote_literal(id), ',') from clients where name like 'Lote %'")"
R2="$(Q "select gen_random_uuid()")"
r="$(send "$OWN" "$IDS" 'Oi {nome}' "$R2")"
[[ "$r" == *'"queued": 40'* ]] && ok "C14 envio para 40 clientes enfileirado de uma vez" || ko "C14 $r"
Q "update whatsapp_private.settings set auto_confirmation_enabled = true" >/dev/null
a3="$(appt "$K_OK" "6 days")"
[[ "$(Q "select status from whatsapp_private.appointment_confirmations where appointment_id = '$a3'")" == queued ]] \
  && ok "C15 logo depois de um envio grande, a confirmação de um agendamento novo AINDA sai" || ko "C15 $(Q "select status||coalesce(':'||reason,'') from whatsapp_private.appointment_confirmations where appointment_id = '$a3'")"
Q "update whatsapp_private.settings set auto_confirmation_enabled = false" >/dev/null
check "C16b entre CADA mensagem e a seguinte: no mínimo 12 s, no máximo 18 s" \
  "(select min(d) >= interval '12 seconds' and max(d) <= interval '18 seconds' from (
     select available_at - lag(available_at) over (order by available_at) d from whatsapp_private.outbox where campaign_id = '$R2') z where d is not null)"
check "C16 os 40 estão espaçados no tempo (~12 s cada): o último sai depois de ~8 min" \
  "(select max(available_at) - min(available_at) >= interval '7 minutes' from whatsapp_private.outbox where campaign_id = '$R2')"
Q "update whatsapp_private.outbox set available_at = now() - interval '1 second'
   where id = (select id from whatsapp_private.outbox where campaign_id = '$R2' order by available_at limit 1)" >/dev/null
W "select count(*) from whatsapp_private.claim_outbox('w1', 100, 60)" >/dev/null
check "C17 a fila só pega o que já chegou a hora: 1 de 40 agora, as outras esperam a vez" \
  "(select count(*) filter (where status = 'processing') = 1 and count(*) filter (where status = 'pending') = 39
          and count(*) filter (where status = 'processing' and available_at > now()) = 0
     from whatsapp_private.outbox where campaign_id = '$R2')"
Q "update whatsapp_private.outbox set available_at = now() where campaign_id = '$R1'" >/dev/null
W "select whatsapp_private.record_inbound('$A', 'w1', 'IN-SAIR-C', '5511987650077@s.whatsapp.net', 'SAIR')" >/dev/null
W "select count(*) from whatsapp_private.claim_outbox('w1', 100, 60)" >/dev/null
check "C18 cliente mandou SAIR depois do envio e antes de receber: a mensagem dela é cancelada" \
  "(select status = 'canceled' from whatsapp_private.outbox where campaign_id = '$R1' and client_id = '$K_OK2')"
j="$(U "$PRO" "select wa_get_campaign('$R1')")"
[[ "$j" == *'"queued": 2'* && "$j" == *'"canceled": 1'* && "$j" != *5511* && "$j" != *Novidades* ]] && ok "C19 andamento visível para a equipe, sem telefone nem texto" || ko "C19 $j"
errc P0002 "C20 outra empresa não vê o andamento" U "$OWNB" "select wa_get_campaign('$R1')"
errc 42501 "C21 authenticated NÃO lê a tabela de envios" U "$OWN" "select count(*) from whatsapp_private.campaigns"
errc 42501 "C22 anon NÃO chama o envio" "${PSQL[@]}" -c "begin; set local role anon; select wa_send_campaign('$A', array['$K_OK']::uuid[], 'x', gen_random_uuid()); commit;"
check "C23 privilégios no pior caso: nada privado exposto; worker com as mesmas 13 funções" \
  "(select count(*) = 13 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'whatsapp_private' and has_function_privilege('wa_worker', p.oid, 'execute'))
   and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join unnest(array['anon','authenticated','service_role']) rl
                   where n.nspname = 'whatsapp_private' and has_function_privilege(rl, p.oid, 'execute'))
   and not exists (select 1 from pg_proc p cross join unnest(array['anon','service_role']) rl
                   where p.proname in ('wa_send_campaign','wa_get_campaign','wa_get_message_settings','wa_set_message_settings') and has_function_privilege(rl, p.oid, 'execute'))"

# ================================================================ BR. reversão
B B4 >/dev/null 2>&1 && ok "B4 acompanhamento roda" || ko "B4"
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "$(blk BR-SQL)" >/dev/null 2>&1 && ok "BR reversão executada" || ko "BR"
check "BR envios em massa pendentes foram cancelados antes de reverter" "(select count(*) = 0 from whatsapp_private.outbox where status = 'pending' and idempotency_key like 'campaign:%')"
[[ "$(Q "$STATE")" == "$S0" ]] && ok "BR voltou EXATAMENTE ao estado da 0026 (funções, colunas, tabelas, permissões)" || ko "BR estado"
[[ "$(B B0)" == "t|f|f" ]] && ok "BR [B0] igual ao de antes" || ko "BR B0: $(B B0)"

echo "RESULTADO 0027/0028: PASS=$pass FAIL=$fail"
dropdb --force "$DB"
[[ $fail -eq 0 ]]
