#!/usr/bin/env bash
# ============================================================================
# 0025 + 0026 — confirmação em FORMATO PADRÃO e lembrete às 8h. SOMENTE LOCAL,
# com pg_cron real (banco 'aurea_cron'). Ensaia o roteiro: aplicar sobre a 0024
# muda só o previsto; a reversão volta EXATAMENTE ao estado anterior.
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DB="aurea_cron"
export PGOPTIONS="-c client_min_messages=warning"
WITH_CRON=1 "$HERE/fresh_db.sh" "$DB" 0024 >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
Q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d "$DB" -c "$1"; }
OPS="$ROOT/operations/0025_aplicacao_supabase.sql"
blk() { sed -n "/^-- \[$1\]/,/^-- \[\/$1\]/p" "$OPS"; }
B() { psql -X -q -A -F'|' -t -d "$DB" -c "$(blk "$1")" 2>&1; }
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
ko() { echo "FAIL $1"; fail=$((fail+1)); }
check() { [[ "$(Q "select ($2)")" == "t" ]] && ok "$1" || ko "$1"; }

TODAY="$(Q "select (now() at time zone 'America/Sao_Paulo')::date")"
AT() { echo "(timestamp '$TODAY $1' at time zone 'America/Sao_Paulo')"; }
TOM() { echo "((date '$TODAY' + 1) + time '$1') at time zone 'America/Sao_Paulo'"; }
eval "$(Q "do \$\$ declare u uuid; co uuid; m uuid; sv uuid; begin
  select id into u from auth.users limit 1;
  insert into companies (name) values ('Studio A') returning id into co;
  insert into company_members (company_id, user_id, role) values (co, u, 'owner') returning id into m;
  insert into services (company_id, name, duration_minutes, price) values (co, 'Manicure', 60, 50) returning id into sv;
  perform set_config('zz.co', co::text, false);
end \$\$;
select format('A=%s MA=%s SA=%s', c.id, m.id, s.id) from companies c join company_members m on m.company_id = c.id join services s on s.company_id = c.id where c.name = 'Studio A'")"
K1="$(Q "insert into clients (company_id, name, phone) values ('$A', 'Ana Maria Lima', '11987654321') returning id")"
Q "insert into whatsapp_private.sessions (company_id, status, phone, last_seen_at, lease_owner, lease_until, connected_at)
   values ('$A', 'connected', '5511900000000', now(), 'w1', now() + interval '10 minutes', now())" >/dev/null
Q "create sequence zz_slot" >/dev/null
mk() { Q "insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end, price, created_at)
          select '$A', '$K1', '$SA', '$MA', t, t + interval '1 hour', 50, ${2:-now() - interval '2 days'}
          from (select $1 as t) z returning id"; }
FNS="select md5(string_agg(p.proname || md5(p.prosrc) || coalesce(p.proacl::text,''), '|' order by p.proname)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','whatsapp_private','aurea_private')"
OTHER="select md5(string_agg(p.proname || md5(p.prosrc) || coalesce(p.proacl::text,''), '|' order by p.proname)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','whatsapp_private','aurea_private') and p.proname not in ('confirmation_text','enqueue_day_before_reminders')"
JOBS="select string_agg(jobname || '=' || schedule || '=' || command, ' | ' order by jobname) from cron.job"
OTHERJOBS="select string_agg(jobname || '=' || schedule || '=' || command, ' | ' order by jobname) from cron.job where jobname <> 'aurea-wa-day-before-reminder'"

[[ "$(B B0)" == "f|*/15 21-23 * * *|1" ]] && ok "B0 antes: $(B B0)" || ko "B0: $(B B0)"
F0="$(Q "$FNS")"; O0="$(Q "$OTHER")"; J0="$(Q "$JOBS")"; OJ0="$(Q "$OTHERJOBS")"
for f in 0025_whatsapp_confirmation_standard_reminder_8h.sql 0026_schedule_reminder_8h.sql; do
  psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/$f" >/dev/null 2>&1 && ok "B2 $f aplicada" || ko "B2 $f"
done
[[ "$(B B3)" == "t|*/15 11-13 * * *|1|13|0" ]] && ok "B3 depois: $(B B3)" || ko "B3: $(B B3)"
[[ "$(Q "$OTHER")" == "$O0" && "$(Q "$OTHERJOBS")" == "$OJ0" ]] && ok "M1 nenhuma outra função nem tarefa mudou (conclusão automática, avisos, fila...)" || ko "M1"

# ---------------- confirmação: formato padrão, IGUAL para todas
c1="$(mk "$(TOM 14:00)")"; c2="$(mk "$(TOM 15:30)")"; c3="$(mk "$(TOM 17:00) + interval '9 days'")"
check "C1 exatamente o modelo pedido" \
  "whatsapp_private.confirmation_text('$c1') = 'Olá, Ana!' || E'\\n\\n' || 'Horário agendado: ' ||
     (array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'])[extract(dow from date '$TODAY' + 1)::int + 1]
     || ', ' || to_char(date '$TODAY' + 1, 'DD/MM') || ', às 14h' || E'\\nServiço: Manicure\\n\\nPara remarcações, o prazo mínimo é de 24h.\\n\\nObrigada!'"
check "C2 igual para todas: mesmo modelo em agendamentos diferentes (só dia/hora mudam)" \
  "(select count(distinct regexp_replace(whatsapp_private.confirmation_text(id), '\\d+(h\\d*)?|[a-zçá]+-feira|sábado|domingo', '#', 'g')) = 1
     from appointments where id in ('$c1','$c2','$c3'))"
check "C3 minutos, sem 'hoje/amanhã', sem emoji, sem assinatura" \
  "(select t like '%às 15h30%' and t !~ 'hoje|amanhã|Studio|[💕✨🌸]' from (select whatsapp_private.confirmation_text('$c2') t) z)"
Q "update clients set name = '' where id = '$K1'; update services set name = '' where id = '$SA'" >/dev/null
check "C4 sem nome => 'Olá!'; sem serviço => sem a linha 'Serviço'" \
  "(select t like 'Olá!' || E'\\n\\n' || 'Horário agendado:%' and t not like '%Serviço%' and t !~ E'\\n\\n\\n' from (select whatsapp_private.confirmation_text('$c1') t) z)"
Q "update clients set name = 'Ana Maria Lima' where id = '$K1'; update services set name = 'Manicure' where id = '$SA'" >/dev/null

# ---------------- lembrete às 8h da véspera
Q "update whatsapp_private.settings set reminder_enabled = true" >/dev/null
r_old="$(mk "$(TOM 10:00)")"
r_late="$(mk "$(TOM 11:00)" "$(AT 08:30:00)")"
r_ok_morning="$(mk "$(TOM 12:00)" "$(AT 07:45:00)")"
[[ "$(Q "select whatsapp_private.enqueue_day_before_reminders($(AT 07:59:00)) ->> 'status'")" == too_early ]] && ok "L1 7h59: ainda não dispara" || ko "L1"
Q "select whatsapp_private.enqueue_day_before_reminders($(AT 08:05:00))" >/dev/null
rem() { Q "select coalesce((select status || coalesce(':' || reason, '') from whatsapp_private.appointment_reminders where appointment_id = '$1'), 'none')"; }
[[ "$(rem "$r_old")" == queued ]] && ok "L2 8h05: atendimento de amanhã recebe o lembrete" || ko "L2 $(rem "$r_old")"
[[ "$(rem "$r_ok_morning")" == queued ]] && ok "L3 agendado hoje ANTES das 8h: recebe o lembrete" || ko "L3 $(rem "$r_ok_morning")"
[[ "$(rem "$r_late")" == "skipped:late_booking" ]] && ok "L4 agendado hoje DEPOIS das 8h (já recebeu a confirmação): pula" || ko "L4 $(rem "$r_late")"
check "L5 texto do lembrete inalterado: continua 'amanhã', no singular" \
  "(select bool_and(o.body ~* 'amanhã' and o.body !~* 'esperamos|a gente') from whatsapp_private.appointment_reminders r join whatsapp_private.outbox o on o.id = r.outbox_id)"
n0="$(Q "select count(*) from whatsapp_private.outbox")"
Q "select whatsapp_private.enqueue_day_before_reminders($(AT 10:40:00))" >/dev/null
[[ "$(Q "select count(*) from whatsapp_private.outbox")" == "$n0" ]] && ok "L6 rodadas seguintes da manhã não duplicam" || ko "L6"
[[ "$(Q "select command from cron.job where jobname = 'aurea-wa-day-before-reminder'")" == "select whatsapp_private.enqueue_day_before_reminders()" ]] \
  && ok "L7 a tarefa continua chamando só o disparo do lembrete" || ko "L7"

# ---------------- transição e reversão
[[ "$(B B4)" == *'"status"'* ]] && ok "B4 passo de transição roda (idempotente)" || ko "B4: $(B B4)"
[[ "$(Q "select count(*) from whatsapp_private.outbox")" == "$n0" ]] && ok "B4 a transição não duplicou nada" || ko "B4 dup"
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "$(blk BR-SQL)" >/dev/null 2>&1 && ok "BR reversão executada" || ko "BR"
[[ "$(Q "$FNS")" == "$F0" && "$(Q "$JOBS")" == "$J0" ]] && ok "BR voltou EXATAMENTE ao estado da 0024 (funções, permissões e tarefas)" || ko "BR estado"
[[ "$(B B0)" == "f|*/15 21-23 * * *|1" ]] && ok "BR [B0] igual ao de antes" || ko "BR B0: $(B B0)"

echo "RESULTADO 0025/0026: PASS=$pass FAIL=$fail"
dropdb --force "$DB"
[[ $fail -eq 0 ]]
