#!/usr/bin/env bash
# ============================================================================
# 0024 — mensagens no SINGULAR. SOMENTE LOCAL.
# Gera TODAS as variações das 4 mensagens (confirmação, lembrete, alteração,
# cancelamento), confere singular/dados/emoji, e ensaia o roteiro: aplicar sobre
# a 0023 muda SÓ os 4 textos; a reversão volta exatamente ao texto anterior.
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DB="aurea_singular_0024"
export PGOPTIONS="-c client_min_messages=warning"
"$HERE/fresh_db.sh" "$DB" 0023 >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
Q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d "$DB" -c "$1"; }
OPS="$ROOT/operations/0024_aplicacao_supabase.sql"
blk() { sed -n "/^-- \[$1\]/,/^-- \[\/$1\]/p" "$OPS"; }
B() { psql -X -q -A -F'|' -t -d "$DB" -c "$(blk "$1")" 2>&1; }
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
ko() { echo "FAIL $1"; fail=$((fail+1)); }
check() { [[ "$(Q "select ($2)")" == "t" ]] && ok "$1" || ko "$1"; }

# 120 agendamentos com ids e horários FIXOS (resultado determinístico), em 3 profissionais
Q "do \$\$ declare u uuid; co uuid; m uuid[] := '{}'; mi uuid; sv uuid; k uuid; i int; begin
  select id into u from auth.users limit 1;
  insert into companies (name) values ('Studio Bella') returning id into co;
  for i in 1..3 loop
    insert into auth.users (email) values ('p' || i || '@s.local') returning id into u;
    insert into company_members (company_id, user_id, role) values (co, u, 'professional') returning id into mi;
    m := m || mi;
  end loop;
  insert into services (company_id, name, duration_minutes, price) values (co, 'Manicure', 60, 50) returning id into sv;
  insert into clients (company_id, name, phone) values (co, 'Ana Maria Lima', '11987654321') returning id into k;
  for i in 1..120 loop
    insert into appointments (id, company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end, price)
    values (('00000000-0000-4000-a000-' || lpad(i::text, 12, '0'))::uuid, co, k, sv, m[1 + i % 3],
            timestamptz '2027-03-01 12:00:00+00' + (i / 3) * interval '1 day' + (i % 3) * interval '20 minutes',
            timestamptz '2027-03-01 12:00:00+00' + (i / 3) * interval '1 day' + (i % 3) * interval '20 minutes' + interval '1 hour', 50);
  end loop;
end \$\$" >/dev/null
TXT="create temp view zz_txt as select a.id, f.k, f.t from appointments a cross join lateral (values
       ('confirmacao', whatsapp_private.confirmation_text(a.id, timestamptz '2027-02-20 12:00+00')),
       ('lembrete',    whatsapp_private.reminder_text(a.id, timestamptz '2027-02-20 12:00+00')),
       ('alteracao',   whatsapp_private.reschedule_notice_text(a.id, timestamptz '2027-02-20 12:00+00')),
       ('cancelamento',whatsapp_private.cancel_notice_text(a.id, timestamptz '2027-02-20 12:00+00'))) f(k, t)"
FNS="select md5(string_agg(p.proname || md5(p.prosrc) || coalesce(p.proacl::text,''), '|' order by p.proname)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'whatsapp_private' and p.proname in ('confirmation_text','reminder_text','reschedule_notice_text','cancel_notice_text')"
OTHER="select md5(string_agg(n.nspname || p.proname || md5(p.prosrc) || coalesce(p.proacl::text,''), '|' order by n.nspname, p.proname)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','whatsapp_private','aurea_private') and p.proname not in ('confirmation_text','reminder_text','reschedule_notice_text','cancel_notice_text')"
TRG="select md5(string_agg(pg_get_triggerdef(oid), '|' order by tgname)) from pg_trigger where not tgisinternal"
SNAP0="$(psql -X -q -A -t -d "$DB" -c "$TXT; select md5(string_agg(k || t, '|' order by id, k)) from zz_txt")"

[[ "$(B B0)" == "t|4" ]] && ok "B0 antes: os 4 textos ainda no plural ($(B B0))" || ko "B0: $(B B0)"
F0="$(Q "$FNS")"; O0="$(Q "$OTHER")"; T0="$(Q "$TRG")"
psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/0024_whatsapp_messages_singular.sql" >/dev/null 2>&1 && ok "B2 0024 aplicada" || ko "B2"
[[ "$(B B3)" == "0|0|13" ]] && ok "B3 depois: $(B B3)" || ko "B3: $(B B3)"
[[ "$(Q "$OTHER")" == "$O0" && "$(Q "$TRG")" == "$T0" ]] && ok "M1 nenhuma outra função nem gatilho mudou (envio, fila, lembrete às 18h, gatilhos)" || ko "M1"

R="$(psql -X -q -A -t -F'|' -d "$DB" -c "$TXT;
  select k, count(distinct regexp_replace(split_part(t, E'\n\n', 2), '\d+(h\d*)?|(segunda|terça|quarta|quinta|sexta)-feira|sábado|domingo|hoje|amanhã|no dia|o dia', '#', 'g')),
         count(*) filter (where t ~* 'esperamos|aguardamos|a gente|estamos|vamos|nossa|nosso|conosco|\mnós\M'),
         count(*) filter (where t !~ '^Oi, Ana(!|, tudo bem\?)' or t !~ '\d{2}/\d{2}' or t !~ 'às \d{1,2}h' or t !~ 'Manicure'),
         count(*) filter (where (select count(*) from regexp_matches(t, '[💕✨🌸]', 'g')) > 1),
         count(*) filter (where t ~ 'Studio|  |\(\)|, \.|::'),
         count(*) filter (where t ~ '[💕✨🌸]')
  from zz_txt group by k order by k")"
want() { grep "^$1|" <<<"$R"; }
for spec in "confirmacao:8" "lembrete:6" "alteracao:6" "cancelamento:4"; do
  k="${spec%%:*}"; n="${spec##*:}"; IFS='|' read -r _ vars plural faltando emojis buracos comemoji <<<"$(want "$k")"
  [[ "$vars" == "$n" ]] && ok "V $k: as $n variações aparecem" || ko "V $k: $vars variações (esperado $n)"
  [[ "$plural" == 0 ]] && ok "S $k: nenhuma variação no plural (fala a profissional)" || ko "S $k: $plural textos no plural"
  [[ "$faltando" == 0 && "$buracos" == 0 ]] && ok "D $k: nome, serviço, dia e hora em todas; sem assinatura nem buracos" || ko "D $k: faltando=$faltando buracos=$buracos"
  [[ "$emojis" == 0 && "$comemoji" -gt 0 && "$comemoji" -lt 120 ]] && ok "E $k: emoji ocasional, no máximo 1 por mensagem" || ko "E $k: >1=$emojis com=$comemoji"
done
check "A1 alteração: texto neutro entre horário e serviço (fala em 'agendamento', nunca 'seu horário foi alterado')" \
  "(select bool_and(t !~* 'horário foi alterado|horário mudou' ) from (select whatsapp_private.reschedule_notice_text(id) t from appointments) z)"
check "A2 cancelamento: continua deixando claro que foi cancelado e não sugere que vale" \
  "(select bool_and(t ~ 'cancelado' and t !~* 'te espero|confirmad|até lá') from (select whatsapp_private.cancel_notice_text(id) t from appointments) z)"
check "A3 singular de verdade: cada mensagem tem marca de 1ª pessoa (espero/me/comigo/estou/vou/atualizei) ou é neutra" \
  "(select count(*) filter (where t ~* '\m(espero|me|comigo|estou|vou|atualizei)\M') > 0 from (select whatsapp_private.confirmation_text(id) t from appointments
     union all select whatsapp_private.reminder_text(id) from appointments union all select whatsapp_private.cancel_notice_text(id) from appointments) z)"

psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "$(blk BR-SQL)" >/dev/null 2>&1 && ok "BR reversão executada" || ko "BR"
[[ "$(Q "$FNS")" == "$F0" ]] && ok "BR os 4 textos voltaram EXATAMENTE aos anteriores (código e permissões)" || ko "BR textos"
SNAP1="$(psql -X -q -A -t -d "$DB" -c "$TXT; select md5(string_agg(k || t, '|' order by id, k)) from zz_txt")"
[[ "$SNAP1" == "$SNAP0" ]] && ok "BR as mensagens geradas voltaram a ser idênticas às de antes" || ko "BR mensagens"

echo "RESULTADO singular 0024: PASS=$pass FAIL=$fail"
dropdb --force "$DB"
[[ $fail -eq 0 ]]
