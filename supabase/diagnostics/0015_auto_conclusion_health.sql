-- ============================================================================
-- ÁUREA — SAÚDE DA CONCLUSÃO AUTOMÁTICA — SOMENTE LEITURA
-- Rode cada seção separadamente (selecione e "Run selected").
-- ============================================================================

-- SEÇÃO 1 — Configuração e batimento
select enabled, grace, batch_limit, max_attempts, retry_interval,
       to_char(process_from at time zone 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI') as inicio_sp,
       activated_at, activated_by, activation_run_id,
       last_run_at, last_run_status, last_run_id,
       now() - last_run_at as desde_a_ultima_execucao
from aurea_private.settings;

-- SEÇÃO 2 — Atendimentos em aberto que já deveriam ter sido concluídos (esperado: 0 linhas com motivo NULL)
select a.id, co.name as empresa,
       to_char(a.scheduled_end at time zone 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI') as fim_sp,
       a.price, a.status,
       aurea_private.appointment_ineligibility(a.id, now() - s.grace, s.process_from) as motivo,
       st.status as controle, st.attempts, st.last_sqlstate, st.last_message
from appointments a
join companies co on co.id = a.company_id
cross join aurea_private.settings s
left join aurea_private.appointment_state st on st.appointment_id = a.id
where s.process_from is not null
  and a.status in ('agendado','confirmado','em_atendimento')
  and a.scheduled_end <= now() - interval '15 minutes'
order by a.scheduled_end;

-- SEÇÃO 3 — Revisão: anomalias, bloqueados e excluídos
select st.status, st.reason, st.attempts, st.last_sqlstate, st.last_message, st.updated_at,
       a.id as appointment_id, co.name as empresa,
       to_char(a.scheduled_end at time zone 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI') as fim_sp, a.status as status_atendimento
from aurea_private.appointment_state st
left join appointments a on a.id = st.appointment_id
left join companies co on co.id = st.company_id
order by st.updated_at desc;

-- SEÇÃO 4 — Últimas execuções
select id, kind, status, started_at, finished_at, selected, concluded, skipped, failed, total_amount, message
from aurea_private.runs order by started_at desc limit 30;

-- SEÇÃO 5 — Últimas execuções do cron (só depois da 0016)
select d.start_time, d.end_time, d.status, d.return_message
from cron.job_run_details d join cron.job j on j.jobid = d.jobid
where j.jobname = 'aurea-auto-conclusion'
order by d.start_time desc limit 20;
