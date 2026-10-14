#!/usr/bin/env bash
# ============================================================================
# 0016 — pg_cron de verdade. SOMENTE LOCAL.
# Requer o Postgres local com:  shared_preload_libraries = 'pg_cron'
#                                cron.database_name = 'aurea_cron'
# Prova: o job é criado sem duplicar; roda como postgres; com a chave
# desligada não grava nada; depois da ativação conclui um atendimento sozinho
# — sem nenhum privilégio para a API.
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DB="aurea_cron"
export PGOPTIONS="-c client_min_messages=warning"
[[ "$(psql -X -A -t -c "show shared_preload_libraries")" == *pg_cron* ]] || { echo "INFO pg_cron não pré-carregado; teste pulado"; exit 0; }
"$HERE/fresh_db.sh" "$DB" 0015 >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
Q() { psql -X -q -A -t -d "$DB" -c "$1"; }
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
ko() { echo "FAIL $1"; fail=$((fail+1)); }
check() { [[ "$(Q "select ($2)")" == "t" ]] && ok "$1" || ko "$1"; }

psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/0016_schedule_auto_conclusion.sql" >/dev/null && ok "C1 0016 aplicada" || ko "C1"
psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/0016_schedule_auto_conclusion.sql" >/dev/null && ok "C2 0016 reaplicada" || ko "C2"
check "C3 exatamente 1 job, a cada 5 min, como postgres, chamando run_auto_conclusion()" \
  "(select count(*) = 1 and bool_and(schedule = '*/5 * * * *' and username = 'postgres' and active
     and command = 'select aurea_private.run_auto_conclusion()') from cron.job where jobname = 'aurea-auto-conclusion')"
check "C4 a API continua sem acesso ao schema privado" \
  "not has_schema_privilege('authenticated', 'aurea_private', 'usage') and not has_schema_privilege('anon', 'aurea_private', 'usage')"

# acelera o job SÓ neste banco de teste para observar execuções reais
JOB=$(Q "select jobid from cron.job where jobname = 'aurea-auto-conclusion'")
Q "select cron.alter_job($JOB, schedule => '3 seconds')" >/dev/null
sleep 8
check "C5 com a chave desligada o job roda com sucesso e NÃO grava nada" \
  "(select count(*) > 0 and bool_and(status = 'succeeded') from cron.job_run_details where jobid = $JOB)
   and not exists (select 1 from aurea_private.runs) and (select last_run_at is null from aurea_private.settings)"

# ativação de verdade (regularização vazia no mesmo dia) + um atendimento que terminou há 10 min
UID_A="$(Q "select id from auth.users order by created_at limit 1")"
Q "
do \$\$
declare c uuid; m uuid; s uuid; cl uuid;
begin
  insert into companies (name) values ('ZZ-CRON') returning id into c;
  insert into company_members (company_id, user_id, role) values (c, '$UID_A', 'owner') returning id into m;
  insert into services (company_id, name, price) values (c, 'S', 100) returning id into s;
  insert into clients (company_id, name) values (c, 'C') returning id into cl;
  insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end, notes)
  values (c, cl, s, m, 100, now() - interval '70 minutes', now() - interval '10 minutes', 'CRON');
end \$\$;" >/dev/null
REG="$(Q "select aurea_private.regularize('{}'::uuid[], 0, false) ->> 'run_id'")"
Q "select aurea_private.activate_auto_conclusion('$REG')" >/dev/null
if [[ "$(Q "select scheduled_end >= (select process_from from aurea_private.settings) from appointments where notes = 'CRON'")" != "t" ]]; then
  echo "INFO C6 pulado: o atendimento de teste caiu antes das 00:00 SP (rode fora dos primeiros 15 min do dia)"
else
  sleep 8
  check "C6 depois da ativação, o cron concluiu o atendimento sozinho (Pix, pago, origem auto)" \
    "(select a.status = 'concluido' and p.status = 'pago' and p.method = 'pix' and p.source = 'auto'
      from appointments a join payments p on p.appointment_id = a.id where a.notes = 'CRON')"
  check "C7 nenhuma execução falhou e nenhum atendimento ganhou 2 recebimentos" \
    "not exists (select 1 from cron.job_run_details where jobid = $JOB and status <> 'succeeded')
     and not exists (select 1 from payments where appointment_id is not null group by appointment_id having count(*) > 1)"
fi
Q "select aurea_private.set_auto_conclusion_enabled(false)" >/dev/null
N1=$(Q "select count(*) from aurea_private.runs"); sleep 5; N2=$(Q "select count(*) from aurea_private.runs")
[[ "$N1" == "$N2" ]] && ok "C8 chave desligada: o job continua rodando e não faz nada" || ko "C8"
Q "select cron.unschedule('aurea-auto-conclusion')" >/dev/null
echo "RESULTADO cron 0016: PASS=$pass FAIL=$fail"
dropdb --force "$DB"
[[ $fail -eq 0 ]]
