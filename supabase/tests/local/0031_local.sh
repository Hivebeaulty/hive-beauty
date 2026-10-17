#!/usr/bin/env bash
# ============================================================================
# 0031 + 0032 — mensagem de ANIVERSÁRIO. SOMENTE LOCAL, com pg_cron real
# (banco 'aurea_cron'). Disparo chamado com "agora" controlado; fila como
# wa_worker; RLS real nas RPCs. Ensaia o roteiro e a reversão exata.
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DB="aurea_cron"
export PGOPTIONS="-c client_min_messages=warning"
WITH_CRON=1 "$HERE/fresh_db.sh" "$DB" 0030 >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
PSQL=(psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d "$DB")
Q() { "${PSQL[@]}" -c "$1"; }
U() { "${PSQL[@]}" -c "begin; set local \"request.jwt.claim.sub\" = '$1'; set local role authenticated; $2; commit;"; }
W() { "${PSQL[@]}" -c "begin; set local role wa_worker; $1; commit;"; }
OPS="$ROOT/operations/0031_aplicacao_supabase.sql"
blk() { sed -n "/^-- \[$1\]/,/^-- \[\/$1\]/p" "$OPS"; }
B() { psql -X -q -A -F'|' -t -d "$DB" -c "$(blk "$1")" 2>&1; }
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
ko() { echo "FAIL $1"; fail=$((fail+1)); }
check() { [[ "$(Q "select ($2)")" == "t" ]] && ok "$1" || ko "$1"; }
errc() { local code="$1" name="$2"; shift 2; local out; out="$("$@" 2>&1)"; grep -q "ERROR:  $code" <<<"$out" && ok "$name" || ko "$name -> $(head -c 200 <<<"$out")"; }

STATE="select md5(string_agg(d, '|' order by d)) from (
  select n.nspname || '.' || p.proname || pg_get_function_identity_arguments(p.oid) || p.prosrc || coalesce(p.proacl::text,'') d
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','whatsapp_private','aurea_private')
  union all select pg_get_triggerdef(oid) from pg_trigger where not tgisinternal
  union all select table_schema || '.' || table_name || '.' || column_name || data_type || coalesce(column_default,'') from information_schema.columns where table_schema in ('public','whatsapp_private')
  union all select jobname || schedule || command from cron.job) z"
OTHER="select md5(string_agg(n.nspname || p.proname || md5(p.prosrc) || coalesce(p.proacl::text,''), '|' order by n.nspname, p.proname)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public','whatsapp_private','aurea_private') and p.proname not like '%birthday%'"
JOBS="select string_agg(jobname || schedule, '|' order by jobname) from cron.job where jobname <> 'aurea-wa-birthday'"
[[ "$(B B0)" == "t|f|0" ]] && ok "B0 antes: $(B B0)" || ko "B0: $(B B0)"
S0="$(Q "$STATE")"; O0="$(Q "$OTHER")"; J0="$(Q "$JOBS")"
for f in 0031_whatsapp_birthday.sql 0032_schedule_birthday.sql; do
  psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/$f" >/dev/null 2>&1 && ok "B2 $f aplicada" || ko "B2 $f"
done
[[ "$(B B3)" == "t|0|*/15 12-14 * * *|13|0" ]] && ok "B3 depois: $(B B3)" || ko "B3: $(B B3)"
[[ "$(Q "$OTHER")" == "$O0" && "$(Q "$JOBS")" == "$J0" ]] && ok "M1 confirmação, lembrete, avisos, Central, fila e outras tarefas: idênticos" || ko "M1"

eval "$(Q "do \$\$ declare uo uuid; up uuid; ur uuid; a uuid; b uuid; begin
  insert into auth.users (email) values ('own@n.local') returning id into uo;
  insert into auth.users (email) values ('pro@n.local') returning id into up;
  insert into auth.users (email) values ('rec@n.local') returning id into ur;
  insert into companies (name) values ('Studio Bella') returning id into a;
  insert into companies (name) values ('Studio Sem Zap') returning id into b;
  insert into company_members (company_id, user_id, role) values (a, uo, 'owner'), (a, up, 'professional'), (a, ur, 'reception'), (b, uo, 'owner');
end \$\$;
select format('A=%s B=%s OWN=%s PRO=%s REC=%s', (select id from companies where name = 'Studio Bella'), (select id from companies where name = 'Studio Sem Zap'),
  (select id from auth.users where email = 'own@n.local'), (select id from auth.users where email = 'pro@n.local'), (select id from auth.users where email = 'rec@n.local'))")"
TODAY="$(Q "select (now() at time zone 'America/Sao_Paulo')::date")"
YEAR="${TODAY:0:4}"
BD="(date '$TODAY' - interval '30 years')::date"
cli() { Q "insert into clients (company_id, name, phone, comm_status, birth_date $5) values ('$1', '$2', $3, '$4', $6 ${7:-}) returning id"; }
K1="$(cli "$A" 'Ana Maria Lima' "'11987654321'" allowed "" "$BD")"
K2="$(cli "$A" 'Sem Autorização' "'11987650011'" unknown "" "$BD")"
K3="$(cli "$A" 'Pediu Sair' "'11987650003'" blocked "" "$BD")"
K4="$(cli "$A" 'Amanhã' "'11987650004'" allowed "" "($BD + 1)")"
K6="$(cli "$A" 'Arquivada' "'11987650006'" allowed ", archived_at" "$BD" ", now()")"
K8="$(cli "$A" 'Sem Fone' "null" allowed "" "$BD")"
KB="$(cli "$B" 'Da Outra' "'11987650099'" allowed "" "$BD")"
Q "insert into whatsapp_private.sessions (company_id, status, phone, last_seen_at, lease_owner, lease_until, connected_at)
   values ('$A', 'connected', '5511900000000', now(), 'w1', now() + interval '10 minutes', now())" >/dev/null
AT() { echo "(timestamp '$TODAY $1' at time zone 'America/Sao_Paulo')"; }
run() { Q "select whatsapp_private.enqueue_birthday_messages(${1:-$(AT 09:05:00)})"; }
st() { Q "select coalesce((select status || coalesce(':' || reason, '') from whatsapp_private.birthday_messages where client_id = '$1'), 'none')"; }

# ================================================================ L. ligar / desligar
run >/dev/null
[[ "$(st "$K1")" == none ]] && ok "L1 nasce DESLIGADA: ninguém recebe" || ko "L1 $(st "$K1")"
[[ "$(U "$PRO" "select wa_get_birthday_settings('$A') ->> 'enabled'")" == false ]] && ok "L2 equipe vê a configuração (desligada)" || ko "L2"
errc 42501 "L3 profissional NÃO liga" U "$PRO" "select wa_set_birthday_settings('$A', true, 'system', null)"
errc 42501 "L4 recepção NÃO liga" U "$REC" "select wa_set_birthday_settings('$A', true, 'system', null)"
U "$OWN" "select wa_set_birthday_settings('$A', true, 'system', null)" >/dev/null
[[ "$(run "$(AT 08:59:00)" | grep -o '"status": "[a-z_]*"')" == '"status": "too_early"' ]] && ok "L5 8h59: ainda não" || ko "L5"

# ================================================================ E. quem recebe
run >/dev/null
[[ "$(st "$K1")" == queued ]] && ok "E1 9h05: aniversariante com autorização recebe" || ko "E1 $(st "$K1")"
[[ "$(st "$K2")" == "skipped:consent_unknown" ]] && ok "E2 sem autorização registrada: não recebe (mesma regra da Central)" || ko "E2 $(st "$K2")"
[[ "$(st "$K3")" == "skipped:blocked" && "$(st "$K6")" == "skipped:archived" && "$(st "$K8")" == "skipped:no_phone" ]] && ok "E3 pediu SAIR, arquivada, sem celular: não recebem (motivo registrado)" || ko "E3 $(st "$K3") $(st "$K6") $(st "$K8")"
[[ "$(st "$K4")" == none && "$(st "$KB")" == none ]] && ok "E4 aniversário amanhã / empresa sem aniversário ligado: nada" || ko "E4"
EXP="$(node -e '
const { load } = require("/home/claude/hive-beauty/tests/load-ts.cjs");
const b = load("/home/claude/hive-beauty/lib/hive/birthday-message.ts");
process.stdout.write(b.buildBirthdaySystemMessage("Ana Maria Lima", process.argv[1], Number(process.argv[2])));' "$K1" "$YEAR" | md5sum | cut -c1-32)"
SQLM="$(Q "select body from whatsapp_private.outbox where idempotency_key = 'birthday:$K1:$YEAR'" | tr -d '\n' | md5sum | cut -c1-32)"
[[ "$EXP" == "$SQLM" ]] && ok "E5 texto do sistema = prévia da tela (paridade)" || ko "E5 $EXP vs $SQLM"
check "E6 chave por cliente e ano; sem nome de empresa/assinatura; no singular" \
  "(select idempotency_key = 'birthday:$K1:$YEAR' and body ~ 'Ana' and body !~ 'Studio|esperamos|a gente' from whatsapp_private.outbox where client_id = '$K1')"
n0="$(Q "select count(*) from whatsapp_private.outbox")"; run >/dev/null; run "$(AT 11:40:00)" >/dev/null
[[ "$(Q "select count(*) from whatsapp_private.outbox")" == "$n0" ]] && ok "E7 rodadas seguintes não duplicam" || ko "E7"

# ================================================================ P. mensagem própria
errc AUT01 "P1 variável desconhecida ({data}): recusada" U "$OWN" "select wa_set_birthday_settings('$A', true, 'custom', 'Oi {nome} {data}')"
U "$OWN" "select wa_set_birthday_settings('$A', true, 'custom', 'Parabéns, {Nome}! Um beijo do {NEGÓCIO}.')" >/dev/null
K7="$(cli "$A" 'Bia Rocha' "'11987650077'" allowed "" "$BD")"; run >/dev/null
EXP="$(node -e '
const { load } = require("/home/claude/hive-beauty/tests/load-ts.cjs");
const b = load("/home/claude/hive-beauty/lib/hive/birthday-message.ts");
process.stdout.write(b.renderBirthdayTemplate("Parabéns, {Nome}! Um beijo do {NEGÓCIO}.", "Bia Rocha", "Studio Bella"));' | md5sum | cut -c1-32)"
SQLM="$(Q "select body from whatsapp_private.outbox where client_id = '$K7'" | tr -d '\n' | md5sum | cut -c1-32)"
check "P2 mensagem própria: sai com o texto dela" "(select body = 'Parabéns, Bia! Um beijo do Studio Bella.' from whatsapp_private.outbox where client_id = '$K7')"
[[ "$EXP" == "$SQLM" ]] && ok "P3 texto próprio do banco = prévia da tela (paridade)" || ko "P3"
Q "update whatsapp_private.message_templates set birthday_template = 'quebrada {xyz}' where company_id = '$A'" >/dev/null
K9="$(cli "$A" 'Carla Dias' "'11987650088'" allowed "" "$BD")"; run >/dev/null
check "P4 mensagem própria inválida gravada por fora: cai nas variações do sistema" \
  "(select body = whatsapp_private.birthday_system_text('Carla Dias', '$K9', $YEAR) from whatsapp_private.outbox where client_id = '$K9')"

# ================================================================ S. sessão, 29/02, SAIR
Q "update whatsapp_private.sessions set last_seen_at = now() - interval '10 minutes' where company_id = '$A'" >/dev/null
K10="$(cli "$A" 'Dani' "'11987650010'" allowed "" "$BD")"; run >/dev/null
[[ "$(st "$K10")" == none ]] && ok "S1 WhatsApp sem sinal: não registra (tenta na próxima rodada)" || ko "S1 $(st "$K10")"
Q "update whatsapp_private.sessions set last_seen_at = now() where company_id = '$A'" >/dev/null; run >/dev/null
[[ "$(st "$K10")" == queued ]] && ok "S2 sinal voltou: a rodada seguinte envia" || ko "S2 $(st "$K10")"
KL="$(cli "$A" 'Leap Day' "'11987650029'" allowed "" "date '2000-02-29'")"
Q "select whatsapp_private.enqueue_birthday_messages((timestamp '2027-02-28 09:05' at time zone 'America/Sao_Paulo'))" >/dev/null
[[ "$(Q "select count(*) from whatsapp_private.birthday_messages where client_id = '$KL' and year = 2027")" == 1 ]] && ok "S3 nascida em 29/02: em ano comum recebe em 28/02" || ko "S3"
Q "select whatsapp_private.enqueue_birthday_messages((timestamp '2028-02-28 09:05' at time zone 'America/Sao_Paulo'))" >/dev/null
[[ "$(Q "select count(*) from whatsapp_private.birthday_messages where client_id = '$KL' and year = 2028")" == 0 ]] && ok "S4 em ano bissexto NÃO recebe em 28/02 (espera o dia 29)" || ko "S4"
W "select whatsapp_private.record_inbound('$A', 'w1', 'IN-SAIR-B', '5511987650010@s.whatsapp.net', 'SAIR')" >/dev/null
W "select count(*) from whatsapp_private.claim_outbox('w1', 100, 60)" >/dev/null
check "S5 respondeu SAIR antes de receber: a mensagem é cancelada" \
  "(select o.status = 'canceled' from whatsapp_private.birthday_messages b join whatsapp_private.outbox o on o.id = b.outbox_id where b.client_id = '$K10')"
U "$OWN" "select wa_set_birthday_settings('$A', false, 'system', null)" >/dev/null
K11="$(cli "$A" 'Depois de Desligar' "'11987650012'" allowed "" "$BD")"; run >/dev/null
[[ "$(st "$K11")" == none ]] && ok "S6 desligou: ninguém mais recebe" || ko "S6"
check "S7 a mensagem própria fica guardada ao desligar" "(select birthday_template = 'quebrada {xyz}' from whatsapp_private.message_templates where company_id = '$A')"

# ================================================================ X. permissões
errc 42501 "X1 authenticated NÃO lê o registro de aniversários" U "$OWN" "select count(*) from whatsapp_private.birthday_messages"
errc 42501 "X2 authenticated NÃO dispara aniversários" U "$OWN" "select whatsapp_private.enqueue_birthday_messages()"
errc 42501 "X3 wa_worker NÃO dispara aniversários" W "select whatsapp_private.enqueue_birthday_messages()"
errc 42501 "X4 anon não chama a configuração" "${PSQL[@]}" -c "begin; set local role anon; select wa_get_birthday_settings('$A'); commit;"
[[ "$(Q "select command from cron.job where jobname = 'aurea-wa-birthday'")" == "select whatsapp_private.enqueue_birthday_messages()" ]] && ok "X5 a tarefa só chama o disparo do aniversário" || ko "X5"

# ================================================================ BR. reversão
B B4 >/dev/null 2>&1 && ok "B4 acompanhamento roda" || ko "B4"
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "$(blk BR-SQL)" >/dev/null 2>&1 && ok "BR reversão executada" || ko "BR"
[[ "$(Q "$STATE")" == "$S0" ]] && ok "BR voltou EXATAMENTE ao estado da 0030 (funções, colunas, gatilhos, tarefas)" || ko "BR estado"
check "BR mensagens de aniversário pendentes canceladas" "not exists (select 1 from whatsapp_private.outbox where idempotency_key like 'birthday:%' and status = 'pending')"

echo "RESULTADO 0031/0032: PASS=$pass FAIL=$fail"
dropdb --force "$DB"
[[ $fail -eq 0 ]]
