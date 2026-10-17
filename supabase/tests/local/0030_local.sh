#!/usr/bin/env bash
# ============================================================================
# 0030 — editar atendimento CONCLUÍDO + LANÇAMENTO RETROATIVO. SOMENTE LOCAL.
# Banco até a 0029 (tudo ligado: confirmação, lembrete, avisos; WhatsApp
# conectado). Financeiro conferido pela MESMA função das telas
# (get_period_indicators). Ensaia a reversão.
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DB="aurea_0030"
export PGOPTIONS="-c client_min_messages=warning"
"$HERE/fresh_db.sh" "$DB" 0029 >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
PSQL=(psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d "$DB")
Q() { "${PSQL[@]}" -c "$1"; }
U() { "${PSQL[@]}" -c "begin; set local \"request.jwt.claim.sub\" = '$1'; set local role authenticated; $2; commit;"; }
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
ko() { echo "FAIL $1"; fail=$((fail+1)); }
check() { [[ "$(Q "select ($2)")" == "t" ]] && ok "$1" || ko "$1"; }
errc() { local code="$1" name="$2"; shift 2; local out; out="$("$@" 2>&1)"; grep -q "ERROR:  $code" <<<"$out" && ok "$name" || ko "$name -> $(head -c 200 <<<"$out")"; }

STATE="select md5(string_agg(d, '|' order by d)) from (
  select n.nspname || '.' || p.proname || pg_get_function_identity_arguments(p.oid) || p.prosrc || coalesce(p.proacl::text,'') d
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','whatsapp_private','aurea_private')
  union all select pg_get_triggerdef(oid) from pg_trigger where not tgisinternal) z"
S0="$(Q "$STATE")"
psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/0030_appointment_full_edit_retroactive.sql" >/dev/null 2>&1 && ok "B2 0030 aplicada" || ko "B2"

eval "$(Q "do \$\$ declare uo uuid; ua uuid; up uuid; ur uuid; ub uuid; a uuid; b uuid; begin
  insert into auth.users (email) values ('own@f.local') returning id into uo;
  insert into auth.users (email) values ('adm@f.local') returning id into ua;
  insert into auth.users (email) values ('pro@f.local') returning id into up;
  insert into auth.users (email) values ('rec@f.local') returning id into ur;
  insert into auth.users (email) values ('ownb@f.local') returning id into ub;
  insert into companies (name) values ('Studio A') returning id into a;
  insert into companies (name) values ('Studio B') returning id into b;
  insert into company_members (company_id, user_id, role) values (a, uo, 'owner'), (a, ua, 'admin'), (a, up, 'professional'), (a, ur, 'reception'), (b, ub, 'owner');
end \$\$;
select string_agg(format('%s=%s', k, v), ' ') from (
  select 'A' k, id::text v from companies where name = 'Studio A' union all select 'B', id::text from companies where name = 'Studio B'
  union all select 'OWN', id::text from auth.users where email = 'own@f.local' union all select 'ADM', id::text from auth.users where email = 'adm@f.local'
  union all select 'PRO', id::text from auth.users where email = 'pro@f.local' union all select 'REC', id::text from auth.users where email = 'rec@f.local'
  union all select 'OWNB', id::text from auth.users where email = 'ownb@f.local') z")"
MA="$(Q "select cm.id from company_members cm join auth.users u on u.id = cm.user_id where u.email = 'own@f.local'")"
MP="$(Q "select cm.id from company_members cm join auth.users u on u.id = cm.user_id where u.email = 'pro@f.local'")"
SA="$(Q "insert into services (company_id, name, duration_minutes, price) values ('$A', 'Manicure', 60, 50) returning id")"
SA2="$(Q "insert into services (company_id, name, duration_minutes, price) values ('$A', 'Gel', 90, 120) returning id")"
SOFF="$(Q "insert into services (company_id, name, duration_minutes, price, active) values ('$A', 'Antigo', 60, 40, false) returning id")"
K1="$(Q "insert into clients (company_id, name, phone, comm_status) values ('$A', 'Ana Lima', '11987654321', 'allowed') returning id")"
KAR="$(Q "insert into clients (company_id, name, phone, archived_at) values ('$A', 'Arquivada', '11987650004', now()) returning id")"
# tudo ligado + WhatsApp conectado: qualquer mensagem indevida apareceria na fila
Q "update whatsapp_private.settings set auto_confirmation_enabled = true, reminder_enabled = true, change_notices_enabled = true;
   insert into whatsapp_private.sessions (company_id, status, phone, last_seen_at, lease_owner, lease_until, connected_at)
   values ('$A', 'connected', '5511900000000', now(), 'w1', now() + interval '10 minutes', now())" >/dev/null
D() { echo "((now() at time zone 'America/Sao_Paulo')::date - $1)"; }                     # dia em Brasília
T() { echo "(($(D $1) + time '$2') at time zone 'America/Sao_Paulo')"; }                 # horário em Brasília
IND() { Q "select $2 from get_period_indicators('$A', $(D $1), $(D $1))"; }               # indicador de um dia
nout() { Q "select count(*) from whatsapp_private.outbox"; }

# atendimento concluído "de verdade" (fluxo normal: agenda -> conclusão)
a1="$(U "$OWN" "insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end, price)
                values ('$A', '$K1', '$SA', '$MA', now() - interval '3 hours', now() - interval '2 hours', 50) returning id")"
U "$OWN" "select conclude_appointment('$a1', 50, 'pix')" >/dev/null
O0="$(nout)"
exp() { Q "select jsonb_build_object('service_id', a.service_id, 'professional_member_id', a.professional_member_id, 'scheduled_start', a.scheduled_start,
                   'scheduled_end', a.scheduled_end, 'price', a.price, 'status', a.status, 'payment_status', p.status)::text
           from appointments a join payments p on p.appointment_id = a.id where a.id = '$1'"; }
# ed <uid> <id> <serv> <prof> <ini> <fim> <preço> <status_pag> <forma> [notes]
ed() { local ex; ex="$(exp "$2")"; U "$1" "select edit_concluded_appointment('$2', '$3', '$4', $5, $6, $7, '$8', '$9', ${10:-null}, '$ex'::jsonb)"; }
START="(select scheduled_start from appointments where id = '$a1')"; END="(select scheduled_end from appointments where id = '$a1')"

# ================================================================ E. editar concluído
rec0="$(IND 0 recebido)"; pen0="$(IND 0 pendente)"
r="$(ed "$OWN" "$a1" "$SA" "$MA" "$START" "$END" 50 pendente pix)"
[[ "$r" == *'"changed": true'* ]] && ok "E1 dona marca o concluído como PENDENTE" || ko "E1 $r"
check "E2 ...e o Financeiro reflete na hora: Recebido -50, Pendente +50" \
  "(select recebido = $rec0 - 50 and pendente = $pen0 + 50 from get_period_indicators('$A', $(D 0), $(D 0)))"
check "E3 recebimento coerente: pendente, nada recebido, sem data de pagamento" \
  "(select status = 'pendente' and paid_amount = 0 and paid_at is null from payments where appointment_id = '$a1')"
ed "$ADM" "$a1" "$SA2" "$MP" "$START" "$START + interval '90 minutes'" 120 pago dinheiro "'ajuste'" >/dev/null
check "E4 administradora troca serviço, profissional, duração, valor e marca PAGO" \
  "(select a.service_id = '$SA2' and a.professional_member_id = '$MP' and a.price = 120 and a.payment_method = 'dinheiro' and a.notes = 'ajuste'
          and p.amount = 120 and p.paid_amount = 120 and p.status = 'pago' and p.paid_at is not null and p.method = 'dinheiro'
     from appointments a join payments p on p.appointment_id = a.id where a.id = '$a1')"
check "E5 Financeiro do dia: faturado e recebido = 120" "(select faturado = 120 and recebido = 120 from get_period_indicators('$A', $(D 0), $(D 0)))"
ed "$OWN" "$a1" "$SA2" "$MP" "$(T 5 10:00)" "$(T 5 11:30)" 120 pago dinheiro "'ajuste'" >/dev/null
check "E6 mudou a DATA (5 dias atrás): o lançamento MUDA de dia no Financeiro" \
  "(select faturado = 0 from get_period_indicators('$A', $(D 0), $(D 0))) and (select faturado = 120 from get_period_indicators('$A', $(D 5), $(D 5)))"
check "E7 primeira/última visita da cliente acompanham a data real" \
  "(select first_visit_at = $(D 5) and last_visit_at = $(D 5) from clients where id = '$K1')"
r="$(ed "$OWN" "$a1" "$SA2" "$MP" "$(T 5 10:00)" "$(T 5 11:30)" 120 pago dinheiro "'ajuste'")"
[[ "$r" == *'"changed": false'* ]] && ok "E8 salvar sem mudar nada: nada gravado" || ko "E8 $r"
errc 42501 "E9 profissional NÃO edita concluído" ed "$PRO" "$a1" "$SA2" "$MP" "$(T 5 10:00)" "$(T 5 11:30)" 99 pago dinheiro
errc 42501 "E10 recepção NÃO edita concluído" ed "$REC" "$a1" "$SA2" "$MP" "$(T 5 10:00)" "$(T 5 11:30)" 99 pago dinheiro
errc P0002 "E11 outra empresa não enxerga" ed "$OWNB" "$a1" "$SA2" "$MP" "$(T 5 10:00)" "$(T 5 11:30)" 99 pago dinheiro
errc AUE02 "E12 alterado por outra pessoa (tela desatualizada): recusado" \
  U "$OWN" "select edit_concluded_appointment('$a1', '$SA', '$MA', now() - interval '1 day', now() - interval '23 hours', 50, 'pago', 'pix', null, '{\"price\": 1}'::jsonb)"
errc AUE06 "E13 concluído não vai para o futuro" ed "$OWN" "$a1" "$SA2" "$MP" "now() + interval '1 day'" "now() + interval '25 hours'" 120 pago dinheiro
errc AUE04 "E14 trocar para serviço inativo: recusado" ed "$OWN" "$a1" "$SOFF" "$MP" "$(T 5 10:00)" "$(T 5 11:30)" 120 pago dinheiro
b1="$(U "$OWN" "insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end, price)
                values ('$A', '$K1', '$SA', '$MP', $(T 5 13:00), $(T 5 14:00), 50) returning id")"
errc 23P01 "E15 horário que bate com outro atendimento da profissional: recusado" ed "$OWN" "$a1" "$SA2" "$MP" "$(T 5 12:30)" "$(T 5 14:00)" 120 pago dinheiro
check "E16 depois da recusa nada mudou" "(select scheduled_start = $(T 5 10:00) from appointments where id = '$a1')"
Q "update payments set status = 'parcial', paid_amount = 50 where appointment_id = '$a1'" >/dev/null
errc AUR03 "E17 recebimento parcial: ajuste pelo Financeiro" \
  U "$OWN" "select edit_concluded_appointment('$a1', '$SA2', '$MP', $(T 5 10:00), $(T 5 11:30), 120, 'pago', 'dinheiro', 'ajuste', (select jsonb_build_object('service_id', a.service_id, 'professional_member_id', a.professional_member_id, 'scheduled_start', a.scheduled_start, 'scheduled_end', a.scheduled_end, 'price', a.price, 'status', a.status, 'payment_status', 'parcial') from appointments a where a.id = '$a1'))"
Q "update payments set status = 'pago', paid_amount = amount where appointment_id = '$a1'" >/dev/null
errc AUE01 "E18 agendamento em aberto: usa a edição normal (recusado aqui)" \
  U "$OWN" "select edit_concluded_appointment('$b1', '$SA', '$MP', $(T 5 13:00), $(T 5 14:00), 50, 'pago', 'pix', null, '{}'::jsonb)"
errc 22023 "E19 edição DIRETA de concluído pela API continua bloqueada (trava da 0014)" \
  U "$OWN" "update appointments set price = 1 where id = '$a1'"

# ================================================================ R. lançamento retroativo
ret() { U "${1:-$OWN}" "select create_retroactive_appointment('$A', '${2:-$K1}', '${3:-$SA}', '$MA', $4, $5, ${6:-80}, '${7:-pago}', 'pix', 'lançado depois')"; }
r1="$(ret "$OWN" "$K1" "$SA" "$(T 10 15:00)" "$(T 10 16:00)" 80 pago)"
check "R1 retroativo pago: concluído, recebimento pago NA DATA do atendimento" \
  "(select a.status = 'concluido' and a.completed_at = $(T 10 16:00) and p.status = 'pago' and p.paid_amount = 80
          and p.created_at = $(T 10 16:00) and p.paid_at = $(T 10 16:00)
     from appointments a join payments p on p.appointment_id = a.id where a.id = '$r1')"
check "R2 Financeiro: entra no dia do atendimento (10 dias atrás), NÃO em hoje" \
  "(select faturado = 80 and recebido = 80 from get_period_indicators('$A', $(D 10), $(D 10))) and (select faturado = 0 from get_period_indicators('$A', $(D 0), $(D 0)))"
pen1="$(IND 0 pendente)"
r2="$(ret "$ADM" "$K1" "$SA" "$(T 8 15:00)" "$(T 8 16:00)" 70 pendente)"
check "R3 retroativo pendente: nada recebido; 'Pendente' do Financeiro sobe 70" \
  "(select status = 'pendente' and paid_amount = 0 from payments where appointment_id = '$r2') and (select pendente = $pen1 + 70 from get_period_indicators('$A', $(D 0), $(D 0)))"
check "R4 primeira visita = a mais antiga real; última = a mais recente real" \
  "(select first_visit_at = $(D 10) and last_visit_at = $(D 5) from clients where id = '$K1')"
[[ "$(nout)" == "$O0" ]] && ok "R5/E20 NENHUMA mensagem na fila (tudo ligado, WhatsApp conectado)" || ko "R5 fila mudou: $O0 -> $(nout)"
check "R6 nada registrado como confirmação/aviso para esses atendimentos" \
  "not exists (select 1 from whatsapp_private.appointment_confirmations where appointment_id in ('$a1','$r1','$r2'))
   and not exists (select 1 from whatsapp_private.appointment_notices where appointment_id in ('$a1','$r1','$r2'))"
errc AUE06 "R7 data futura: não é retroativo" ret "$OWN" "$K1" "$SA" "now() + interval '1 hour'" "now() + interval '2 hours'"
errc 42501 "R8 profissional NÃO faz lançamento retroativo" ret "$PRO" "$K1" "$SA" "$(T 12 10:00)" "$(T 12 11:00)"
errc AUE03 "R9 cliente arquivada: recusado" ret "$OWN" "$KAR" "$SA" "$(T 12 10:00)" "$(T 12 11:00)"
errc AUE04 "R10 serviço inativo: recusado" ret "$OWN" "$K1" "$SOFF" "$(T 12 10:00)" "$(T 12 11:00)"
errc 23P01 "R11 horário que bate com outro atendimento: recusado (nada gravado)" ret "$OWN" "$K1" "$SA" "$(T 10 15:30)" "$(T 10 16:30)"
check "R12 recusa não deixou atendimento nem recebimento pela metade" \
  "(select count(*) = 2 from appointments where notes = 'lançado depois') and (select count(*) = 2 from payments p join appointments a on a.id = p.appointment_id where a.notes = 'lançado depois')"
errc P0002 "R13 outra empresa: recusado" U "$OWNB" "select create_retroactive_appointment('$A', '$K1', '$SA', '$MA', $(T 12 10:00), $(T 12 11:00), 80, 'pago', 'pix', null)"
errc 42501 "R14 anon não chama" "${PSQL[@]}" -c "begin; set local role anon; select create_retroactive_appointment('$A', '$K1', '$SA', '$MA', now() - interval '2 days', now() - interval '47 hours', 1, 'pago', 'pix', null); commit;"
check "R15 nenhuma função nova no esquema privado (inventário da automação intacto)" \
  "not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'aurea_private' and p.proname like '%visit%')"

# ================================================================ BR. reversão
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "begin;
  drop function if exists public.edit_concluded_appointment(uuid, uuid, uuid, timestamptz, timestamptz, numeric, payment_status, payment_method, text, jsonb);
  drop function if exists public.create_retroactive_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, numeric, payment_status, payment_method, text);
  commit;" >/dev/null 2>&1 && ok "BR reversão executada" || ko "BR"
[[ "$(Q "$STATE")" == "$S0" ]] && ok "BR funções e gatilhos voltaram EXATAMENTE ao estado da 0029 (dados lançados ficam)" || ko "BR estado"

echo "RESULTADO 0030: PASS=$pass FAIL=$fail"
dropdb --force "$DB"
[[ $fail -eq 0 ]]
