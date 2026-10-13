-- ============================================================================
-- TESTES — 0010 (um pagamento por atendimento + fluxo de conclusão)
--
-- Cole TUDO no SQL Editor e execute UMA vez. Requer 0008, 0009 e pelo menos
-- 1 usuário em auth.users.
--
-- Nada persiste: tudo roda num bloco DO que termina com uma exceção
-- INTENCIONAL (é ela que desfaz as empresas e os dados de teste). O relatório
-- vem na mensagem de erro. Cada teste roda num sub-bloco sempre desfeito.
--
-- Rode ANTES da 0010 (baseline) e DEPOIS:
--   ANTES : esperado FAIL em S1, S2, S3, U1 (prova que a duplicidade era possível)
--   DEPOIS: esperado ZERO "FAIL".
-- ============================================================================

create or replace function pg_temp.t(
  p_name text, p_expect text, p_uid uuid, p_sql text,
  p_pre text default null, p_then text default null)
returns text
language plpgsql
as $fn$
begin
  begin
    if p_pre is not null then
      execute p_pre;                        -- preparação COMO DONO (sem RLS)
    end if;
    if p_uid is not null then
      perform set_config('request.jwt.claims',
                         json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
      perform set_config('request.jwt.claim.sub', p_uid::text, true);
      set local role authenticated;         -- age como essa usuária, sob RLS
    end if;
    execute p_sql;
    if p_then is not null then
      execute p_then;                       -- verificação / 2ª ação, no mesmo papel
    end if;
    raise exception using errcode = 'P9999', message = '__sem_erro__';
  exception
    when sqlstate 'P9999' then
      return rpad(case p_expect when 'ok' then 'PASS' when 'fail' then 'FAIL' else 'INFO' end, 5)
             || p_name
             || case p_expect
                  when 'fail' then '   [executou SEM erro, mas DEVERIA ser bloqueado]'
                  when 'info' then '   -> executou sem erro'
                  else ''
                end;
    when others then
      return rpad(case p_expect when 'fail' then 'PASS' when 'ok' then 'FAIL' else 'INFO' end, 5)
             || p_name || '   -> ' || sqlstate || ': ' || sqlerrm;
  end;
end;
$fn$;

do $do$
declare
  v_user uuid;
  v_A uuid; v_B uuid; v_mem uuid; v_memB uuid; v_svc uuid; v_svcB uuid;
  c_A uuid; c_B uuid;
  a1 uuid; a2 uuid; a_B uuid;
  v_fail int;
  r text := '';
  nl text := E'\n';
begin
  select id into v_user from auth.users order by created_at limit 1;
  if v_user is null then
    raise exception 'auth.users está vazio: crie ao menos um usuário.';
  end if;

  -- ---------------------------------------------------------------- fixtures
  insert into companies (name) values ('ZZ-TESTE-0010-A') returning id into v_A;
  insert into companies (name) values ('ZZ-TESTE-0010-B') returning id into v_B;
  -- usuária de teste: OWNER da empresa A (precisa ler payments por RLS)
  insert into company_members (company_id, user_id, role) values (v_A, v_user, 'owner') returning id into v_mem;
  -- ... e membro INATIVO da B (não é membro de fato: is_company_member exige active)
  insert into company_members (company_id, user_id, role, active) values (v_B, v_user, 'owner', false) returning id into v_memB;
  insert into services (company_id, name, duration_minutes, price) values (v_A, 'ZZ servico A', 60, 100) returning id into v_svc;
  insert into services (company_id, name, duration_minutes, price) values (v_B, 'ZZ servico B', 60, 100) returning id into v_svcB;
  insert into clients (company_id, name) values (v_A, 'ZZ cliente A') returning id into c_A;
  insert into clients (company_id, name) values (v_B, 'ZZ cliente B') returning id into c_B;

  insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end)
    values (v_A, c_A, v_svc, v_mem, 100, now() - interval '3 hours', now() - interval '2 hours') returning id into a1;
  insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end)
    values (v_A, c_A, v_svc, v_mem, 100, now() - interval '6 hours', now() - interval '5 hours') returning id into a2;
  insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end)
    values (v_B, c_B, v_svcB, v_memB, 100, now() - interval '3 hours', now() - interval '2 hours') returning id into a_B;

  -- ------------------------------------------------------ S. estrutura criada
  r := r || pg_temp.t('S1 índice único payments_appointment_id_unique existe', 'ok', null,
    $q$ select 1 / (case when exists (select 1 from pg_indexes where indexname = 'payments_appointment_id_unique') then 1 else 0 end) $q$) || nl;
  r := r || pg_temp.t('S2 conclude_appointment trava a linha (FOR UPDATE)', 'ok', null,
    $q$ select 1 / (case when exists (select 1 from pg_proc where proname = 'conclude_appointment'
          and position('for update' in lower(pg_get_functiondef(oid))) > 0) then 1 else 0 end) $q$) || nl;
  r := r || pg_temp.t('S3 conclude_appointment com search_path endurecido (pg_temp por último)', 'ok', null,
    $q$ select 1 / (case when exists (select 1 from pg_proc where proname = 'conclude_appointment'
          and array_to_string(proconfig, ',') like '%search_path=public, pg_temp%') then 1 else 0 end) $q$) || nl;

  -- ------------------------------------ U. unicidade de pagamento por atendimento
  r := r || pg_temp.t('U1 DOIS pagamentos para o MESMO atendimento (no mesmo comando) é bloqueado', 'fail', null,
    format($q$ insert into payments (company_id, appointment_id, client_id, amount, method, status)
              values (%L, %L, %L, 10, 'pix', 'pendente'), (%L, %L, %L, 10, 'pix', 'pendente') $q$, v_A, a1, c_A, v_A, a1, c_A)) || nl;
  r := r || pg_temp.t('U2 receitas avulsas (sem atendimento) continuam ilimitadas', 'ok', null,
    format($q$ insert into payments (company_id, amount, method, status)
              values (%L, 10, 'pix', 'pendente'), (%L, 10, 'pix', 'pendente') $q$, v_A, v_A)) || nl;
  r := r || pg_temp.t('U3 um pagamento para cada atendimento diferente funciona', 'ok', null,
    format($q$ insert into payments (company_id, appointment_id, client_id, amount, method, status)
              values (%L, %L, %L, 10, 'pix', 'pendente'), (%L, %L, %L, 10, 'pix', 'pendente') $q$, v_A, a1, c_A, v_A, a2, c_A)) || nl;

  -- --------------------------- C. nenhum pagamento nasce sem atendimento realizado
  r := r || pg_temp.t('C1 criar um agendamento NÃO cria pagamento', 'ok', null,
    format($q$ insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end)
              values (%L, %L, %L, %L, 100, now() + interval '3 days', now() + interval '3 days 1 hour') $q$, v_A, c_A, v_svc, v_mem),
    null,
    format($q$ select 1 / (case when not exists (select 1 from payments where company_id = %L) then 1 else 0 end) $q$, v_A)) || nl;
  r := r || pg_temp.t('C2 CANCELAR um agendamento não cria pagamento', 'ok', null,
    format($q$ update appointments set status = 'cancelado' where id = %L $q$, a2),
    null,
    format($q$ select 1 / (case when not exists (select 1 from payments where appointment_id = %L) then 1 else 0 end) $q$, a2)) || nl;
  r := r || pg_temp.t('C3 marcar FALTA não cria pagamento', 'ok', null,
    format($q$ update appointments set status = 'nao_compareceu' where id = %L $q$, a2),
    null,
    format($q$ select 1 / (case when not exists (select 1 from payments where appointment_id = %L) then 1 else 0 end) $q$, a2)) || nl;

  -- ------------------------------ R. RPC conclude_appointment (como owner, sob RLS)
  r := r || pg_temp.t('R1 atendimento realizado, recebimento NÃO pendente = RECEBIDO (pago, paid_amount = valor, paid_at preenchido)', 'ok', v_user,
    format($q$ select conclude_appointment(%L, 100, 'pix', 'pago') $q$, a1),
    null,
    format($q$ select 1 / (case when
        (select status from appointments where id = %L) = 'concluido'
        and exists (select 1 from payments where appointment_id = %L and status = 'pago'
                    and amount = 100 and paid_amount = 100 and paid_at is not null)
        and (select count(*) from payments where appointment_id = %L) = 1
      then 1 else 0 end) $q$, a1, a1, a1)) || nl;
  r := r || pg_temp.t('R2 "Recebimento pendente" = PENDENTE (paid_amount 0, sem paid_at) e atendimento concluído', 'ok', v_user,
    format($q$ select conclude_appointment(%L, 100, 'pix', 'pendente') $q$, a1),
    null,
    format($q$ select 1 / (case when
        (select status from appointments where id = %L) = 'concluido'
        and exists (select 1 from payments where appointment_id = %L and status = 'pendente'
                    and amount = 100 and paid_amount = 0 and paid_at is null)
        and (select count(*) from payments where appointment_id = %L) = 1
      then 1 else 0 end) $q$, a1, a1, a1)) || nl;
  r := r || pg_temp.t('R3 concluir o MESMO atendimento duas vezes: a 2ª é recusada (sem pagamento duplicado)', 'fail', v_user,
    format($q$ select conclude_appointment(%L, 100, 'pix', 'pago') $q$, a1),
    null,
    format($q$ select conclude_appointment(%L, 100, 'pix', 'pago') $q$, a1)) || nl;
  r := r || pg_temp.t('R4 concluir atendimento CANCELADO é recusado', 'fail', v_user,
    format($q$ select conclude_appointment(%L, 100, 'pix', 'pago') $q$, a1),
    format($q$ update appointments set status = 'cancelado' where id = %L $q$, a1)) || nl;
  r := r || pg_temp.t('R5 concluir atendimento marcado como FALTA é recusado', 'fail', v_user,
    format($q$ select conclude_appointment(%L, 100, 'pix', 'pago') $q$, a1),
    format($q$ update appointments set status = 'nao_compareceu' where id = %L $q$, a1)) || nl;
  r := r || pg_temp.t('R6 papel "reception" não consegue concluir', 'fail', v_user,
    format($q$ select conclude_appointment(%L, 100, 'pix', 'pago') $q$, a1),
    format($q$ update company_members set role = 'reception' where id = %L $q$, v_mem)) || nl;
  r := r || pg_temp.t('R7 não-membro (inativo) da empresa B não consegue concluir atendimento de B', 'fail', v_user,
    format($q$ select conclude_appointment(%L, 100, 'pix', 'pago') $q$, a_B)) || nl;
  r := r || pg_temp.t('R8 conclusão de atendimento que já estava em "confirmado" (legado/WhatsApp) continua funcionando', 'ok', v_user,
    format($q$ select conclude_appointment(%L, 100, 'pix', 'pago') $q$, a1),
    format($q$ update appointments set status = 'confirmado' where id = %L $q$, a1)) || nl;
  r := r || pg_temp.t('R9 conclusão gera pagamento da MESMA empresa da cliente (compatível com a 0009)', 'ok', v_user,
    format($q$ select conclude_appointment(%L, 100, 'dinheiro', 'pago') $q$, a1),
    null,
    format($q$ select 1 / (case when exists (select 1 from payments p join clients c on c.id = p.client_id
                where p.appointment_id = %L and p.company_id = c.company_id and p.company_id = %L) then 1 else 0 end) $q$, a1, v_A)) || nl;

  v_fail := (length(r) - length(replace(r, 'FAIL ', ''))) / 5;

  -- A "falha" abaixo é intencional: desfaz TODOS os dados de teste.
  raise exception E'\n=== RESULTADO 0010 (esta falha é intencional: desfaz os dados de teste) ===\n%\nLINHAS "FAIL": %\n', r, v_fail;
end
$do$;
