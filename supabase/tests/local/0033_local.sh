#!/usr/bin/env bash
# ============================================================================
# 0033 — vários serviços no mesmo atendimento. SOMENTE LOCAL. Banco até a 0032.
# Prova: sem adicionais, TODAS as mensagens ficam idênticas; com adicionais, elas
# listam todos os serviços; criação atômica; permissões; reversão exata.
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DB="aurea_0033"
export PGOPTIONS="-c client_min_messages=warning"
"$HERE/fresh_db.sh" "$DB" 0032 >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
PSQL=(psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d "$DB")
Q() { "${PSQL[@]}" -c "$1"; }
U() { "${PSQL[@]}" -c "begin; set local \"request.jwt.claim.sub\" = '$1'; set local role authenticated; $2; commit;"; }
W() { "${PSQL[@]}" -c "begin; set local role wa_worker; $1; commit;"; }
OPS="$ROOT/operations/0033_aplicacao_supabase.sql"
blk() { sed -n "/^-- \[$1\]/,/^-- \[\/$1\]/p" "$OPS"; }
B() { psql -X -q -A -F'|' -t -d "$DB" -c "$(blk "$1")" 2>&1; }
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
ko() { echo "FAIL $1"; fail=$((fail+1)); }
check() { [[ "$(Q "select ($2)")" == "t" ]] && ok "$1" || ko "$1"; }
errc() { local code="$1" name="$2"; shift 2; local out; out="$("$@" 2>&1)"; grep -q "ERROR:  $code" <<<"$out" && ok "$name" || ko "$name -> $(head -c 200 <<<"$out")"; }

eval "$(Q "do \$\$ declare uo uuid; up uuid; ub uuid; a uuid; b uuid; begin
  insert into auth.users (email) values ('own@m.local') returning id into uo;
  insert into auth.users (email) values ('pro@m.local') returning id into up;
  insert into auth.users (email) values ('ownb@m.local') returning id into ub;
  insert into companies (name) values ('Studio A') returning id into a;
  insert into companies (name) values ('Studio B') returning id into b;
  insert into company_members (company_id, user_id, role) values (a, uo, 'owner'), (a, up, 'professional'), (b, ub, 'owner');
end \$\$;
select format('A=%s B=%s OWN=%s PRO=%s OWNB=%s', (select id from companies where name = 'Studio A'), (select id from companies where name = 'Studio B'),
  (select id from auth.users where email = 'own@m.local'), (select id from auth.users where email = 'pro@m.local'), (select id from auth.users where email = 'ownb@m.local'))")"
MA="$(Q "select cm.id from company_members cm join auth.users u on u.id = cm.user_id where u.email = 'own@m.local'")"
S1="$(Q "insert into services (company_id, name, duration_minutes, price) values ('$A', 'Manicure', 60, 50) returning id")"
S2="$(Q "insert into services (company_id, name, duration_minutes, price) values ('$A', 'Pedicure', 45, 60) returning id")"
S3="$(Q "insert into services (company_id, name, duration_minutes, price) values ('$A', 'Esmaltação', 15, 20) returning id")"
SB="$(Q "insert into services (company_id, name, duration_minutes, price) values ('$B', 'Da B', 30, 10) returning id")"
K1="$(Q "insert into clients (company_id, name, phone, comm_status) values ('$A', 'Ana Lima', '11987654321', 'allowed') returning id")"
Q "insert into whatsapp_private.sessions (company_id, status, phone, last_seen_at, lease_owner, lease_until, connected_at)
   values ('$A', 'connected', '5511900000000', now(), 'w1', now() + interval '10 minutes', now())" >/dev/null
Q "create sequence zz_slot; grant usage on sequence zz_slot to authenticated" >/dev/null
SLOT="date_trunc('hour', now()) + interval '2 days' + nextval('zz_slot') * interval '4 hours'"
mk() { U "$OWN" "insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end, price)
                 select '$A', '$K1', '$S1', '$MA', t, t + interval '1 hour', 50 from (select $SLOT as t) z returning id"; }
TEXTS="select string_agg(t, '|' order by id, k) from (select a.id, f.k, f.t from appointments a cross join lateral (values
         (1, whatsapp_private.confirmation_text(a.id)), (2, whatsapp_private.reminder_text(a.id)),
         (3, whatsapp_private.reschedule_notice_text(a.id)), (4, whatsapp_private.cancel_notice_text(a.id)),
         (5, whatsapp_private.custom_confirmation_text(a.id, 'Oi {nome}: {servico} {data} {horario}'))) f(k, t)) z"
for i in 1 2 3 4 5 6; do mk >/dev/null; done
ORIG="$(Q "select string_agg(quote_literal(id), ',') from appointments")"
TEXTS="${TEXTS/appointments a cross join/appointments a cross join} "
TEXTS="select string_agg(t, '|' order by id, k) from (select a.id, f.k, f.t from appointments a cross join lateral (values
         (1, whatsapp_private.confirmation_text(a.id)), (2, whatsapp_private.reminder_text(a.id)),
         (3, whatsapp_private.reschedule_notice_text(a.id)), (4, whatsapp_private.cancel_notice_text(a.id)),
         (5, whatsapp_private.custom_confirmation_text(a.id, 'Oi {nome}: {servico} {data} {horario}'))) f(k, t) where a.id in ($ORIG)) z"
T0="$(Q "$TEXTS" | md5sum | cut -c1-32)"
[[ "$(B B0)" == "t|f" ]] && ok "B0 antes: $(B B0)" || ko "B0"
psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/0033_appointment_extra_services.sql" >/dev/null 2>&1 && ok "B2 0033 aplicada" || ko "B2"
[[ "$(B B3)" == "t|4|0|13|0" ]] && ok "B3 depois: $(B B3)" || ko "B3: $(B B3)"
[[ "$(Q "$TEXTS" | md5sum | cut -c1-32)" == "$T0" ]] && ok "M1 SEM adicionais: confirmação (sistema e própria), lembrete e avisos IDÊNTICOS aos de antes" || ko "M1"

# ================================================================ L. lista de serviços
a1="$(mk)"
lbl() { Q "select whatsapp_private.appointment_services_label('$1')"; }
[[ "$(lbl "$a1")" == "Manicure" ]] && ok "L1 só o principal: 'Manicure'" || ko "L1 $(lbl "$a1")"
U "$PRO" "select set_appointment_extra_services('$a1', '[{\"service_id\":\"$S2\",\"price\":60,\"duration_minutes\":45}]')" >/dev/null
[[ "$(lbl "$a1")" == "Manicure e Pedicure" ]] && ok "L2 com 1 adicional: 'Manicure e Pedicure'" || ko "L2 $(lbl "$a1")"
U "$PRO" "select set_appointment_extra_services('$a1', '[{\"service_id\":\"$S2\",\"price\":60,\"duration_minutes\":45},{\"service_id\":\"$S3\",\"price\":20,\"duration_minutes\":15}]')" >/dev/null
[[ "$(lbl "$a1")" == "Manicure, Pedicure e Esmaltação" ]] && ok "L3 com 2: 'Manicure, Pedicure e Esmaltação' (a lista é TROCADA, não somada)" || ko "L3 $(lbl "$a1")"
check "L4 mensagens listam todos os serviços (lembrete, aviso de alteração e de cancelamento, mensagem própria)" \
  "whatsapp_private.reminder_text('$a1') like '%Manicure, Pedicure e Esmaltação%'
   and whatsapp_private.reschedule_notice_text('$a1') like '%Manicure, Pedicure e Esmaltação%'
   and whatsapp_private.cancel_notice_text('$a1') like '%Manicure, Pedicure e Esmaltação%'
   and whatsapp_private.custom_confirmation_text('$a1', 'Oi {nome}: {servico} {data} {horario}') like 'Oi Ana: Manicure, Pedicure e Esmaltação %'"

# ================================================================ C. criação atômica + confirmação
Q "update whatsapp_private.settings set auto_confirmation_enabled = true" >/dev/null
c1="$(U "$PRO" "select create_appointment_with_extras('$A', '$K1', '$S1', '$MA', $SLOT, $SLOT, 110, 'obs', '[{\"service_id\":\"$S2\",\"price\":60,\"duration_minutes\":45}]')" 2>&1)"
c1="$(U "$PRO" "select create_appointment_with_extras('$A', '$K1', '$S1', '$MA', t, t + interval '105 minutes', 110, 'obs', '[{\"service_id\":\"$S2\",\"price\":60,\"duration_minutes\":45}]') from (select $SLOT as t) z")"
check "C1 profissional cria atendimento com adicional numa operação: principal + 1 adicional, valor total 110" \
  "(select a.price = 110 and a.service_id = '$S1' and (select count(*) from appointment_extra_services e where e.appointment_id = a.id) = 1 from appointments a where a.id = '$c1')"
W "select count(*) from whatsapp_private.claim_outbox('w1', 50, 60)" >/dev/null
check "C2 a confirmação automática SAI com os dois serviços (texto refeito na hora do envio)" \
  "(select o.body like '%Manicure e Pedicure%' from whatsapp_private.appointment_confirmations ac join whatsapp_private.outbox o on o.id = ac.outbox_id where ac.appointment_id = '$c1')"
n0="$(Q "select count(*) from appointments")"
errc AUE04 "C3 adicional de OUTRA empresa: recusado" U "$PRO" "select create_appointment_with_extras('$A', '$K1', '$S1', '$MA', t, t + interval '1 hour', 50, null, '[{\"service_id\":\"$SB\",\"price\":1,\"duration_minutes\":10}]') from (select $SLOT as t) z"
[[ "$(Q "select count(*) from appointments")" == "$n0" ]] && ok "C4 ...e o atendimento NÃO foi criado pela metade (tudo ou nada)" || ko "C4"
errc P0002 "C5 dona de outra empresa não grava adicionais aqui" U "$OWNB" "select set_appointment_extra_services('$a1', '[]')"

# ================================================================ P. regras por situação
past="$(U "$OWN" "insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end, price)
                  values ('$A', '$K1', '$S1', '$MA', now() - interval '5 hours', now() - interval '4 hours', 50) returning id")"
U "$OWN" "select conclude_appointment('$past', 50, 'pix')" >/dev/null
errc 42501 "P1 concluído: profissional NÃO mexe nos serviços" U "$PRO" "select set_appointment_extra_services('$past', '[{\"service_id\":\"$S3\",\"price\":20,\"duration_minutes\":15}]')"
[[ "$(U "$OWN" "select set_appointment_extra_services('$past', '[{\"service_id\":\"$S3\",\"price\":20,\"duration_minutes\":15}]')")" == 1 ]] && ok "P2 concluído: a dona registra o serviço adicional" || ko "P2"
cx="$(mk)"; U "$OWN" "update appointments set status = 'cancelado' where id = '$cx'" >/dev/null
errc AUE01 "P3 cancelado: não aceita serviços" U "$OWN" "select set_appointment_extra_services('$cx', '[]')"
Q "update services set active = false where id = '$S2'" >/dev/null
p4="$(mk)"
errc AUE04 "P4 serviço desativado não entra como NOVO adicional" U "$PRO" "select set_appointment_extra_services('$p4', '[{\"service_id\":\"$S2\",\"price\":1,\"duration_minutes\":5}]')"
[[ "$(U "$PRO" "select set_appointment_extra_services('$a1', '[{\"service_id\":\"$S2\",\"price\":60,\"duration_minutes\":45}]')")" == 1 ]] && ok "P5 ...mas um que já estava na lista pode continuar" || ko "P5"
Q "update services set active = true where id = '$S2'" >/dev/null
errc AUE06 "P6 valor negativo: recusado" U "$PRO" "select set_appointment_extra_services('$a1', '[{\"service_id\":\"$S3\",\"price\":-1,\"duration_minutes\":15}]')"
errc AUE06 "P7 mais de 10 adicionais: recusado" U "$PRO" "select set_appointment_extra_services('$a1', (select jsonb_agg(jsonb_build_object('service_id','$S3','price',1,'duration_minutes',5)) from generate_series(1,11)))"
check "P8 recusas não mexeram na lista" "(select count(*) = 1 from appointment_extra_services where appointment_id = '$a1')"

# ================================================================ S. segurança
errc 42501 "S1 gravação DIRETA na tabela é bloqueada (só pelas funções)" U "$OWN" "insert into appointment_extra_services (appointment_id, company_id, service_id, price, duration_minutes) values ('$a1', '$A', '$S3', 1, 1)"
[[ "$(U "$PRO" "select count(*) from appointment_extra_services")" -ge 1 ]] && ok "S2 a equipe da empresa lê os adicionais" || ko "S2"
[[ "$(U "$OWNB" "select count(*) from appointment_extra_services")" == 0 ]] && ok "S3 outra empresa não enxerga nenhum" || ko "S3"
errc 42501 "S4 a lista interna de serviços não é chamável pela API" U "$OWN" "select whatsapp_private.appointment_services_label('$a1')"

# ================================================================ BR. reversão
FNS="select md5(string_agg(p.proname || md5(p.prosrc) || coalesce(p.proacl::text,''), '|' order by p.proname)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','whatsapp_private') and p.proname not in ('set_appointment_extra_services','create_appointment_with_extras','appointment_services_label')"
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "$(blk BR-SQL)" >/dev/null 2>&1 && ok "BR reversão executada" || ko "BR"
[[ "$(B B0)" == "t|f" ]] && ok "BR [B0] igual ao de antes" || ko "BR B0: $(B B0)"
[[ "$(Q "$TEXTS" | md5sum | cut -c1-32)" == "$T0" ]] && ok "BR textos dos atendimentos originais idênticos aos de antes" || ko "BR textos"

echo "RESULTADO 0033: PASS=$pass FAIL=$fail"
dropdb --force "$DB"
[[ $fail -eq 0 ]]
