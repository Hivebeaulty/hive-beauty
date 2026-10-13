-- ============================================================================
-- TESTES DE STAGING — 0009 (integridade multiempresa + exclusão com histórico)
--
-- SOMENTE STAGING. Cole TUDO no SQL Editor e execute UMA vez.
-- Requer: 0008 aplicada e pelo menos 1 usuário em auth.users.
--
-- Como funciona (nada persiste):
--   * cria 2 empresas de teste (ZZ-TESTE-0009-A / -B) e dados dentro de um bloco DO;
--   * cada teste roda num sub-bloco que é SEMPRE desfeito (PASS/FAIL é lido do erro);
--   * no fim o bloco levanta uma exceção com o RELATÓRIO. Essa "falha" é
--     INTENCIONAL: é ela que desfaz as empresas e os dados de teste.
--
-- Rode DUAS vezes:
--   1) ANTES da 0009  -> baseline. Esperado FAIL em: S1-S4, B1-B4, C3, C5, C7, G1-G4, G6
--                        (é a prova de que a lacuna existia).
--   2) DEPOIS da 0009 -> esperado ZERO "FAIL". Linhas INFO (H1/H2) só registram o
--                        comportamento e devem ser IGUAIS antes e depois.
-- ============================================================================

create or replace function pg_temp.t(p_name text, p_expect text, p_uid uuid, p_sql text, p_pre text default null)
returns text
language plpgsql
as $fn$
begin
  begin
    -- p_pre: preparação executada COMO DONO (sem RLS) antes de assumir a usuária
    if p_pre is not null then
      execute p_pre;
    end if;
    if p_uid is not null then
      -- age como essa usuária, sob RLS (papel "authenticated")
      perform set_config('request.jwt.claims',
                         json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
      perform set_config('request.jwt.claim.sub', p_uid::text, true);
      set local role authenticated;
    end if;
    execute p_sql;
    -- chegou aqui = a instrução NÃO deu erro. Esta exceção desfaz seus efeitos.
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
  v_A uuid; v_B uuid; v_mem uuid; v_svc uuid;
  c_free uuid; c_appt uuid; c_pay uuid; c_both uuid; c_arch uuid; c_B uuid;
  a_appt uuid; a_both uuid;
  p_pay uuid; p_both uuid; p_arch uuid;
  v_fail int;
  r text := '';
  nl text := E'\n';
begin
  select id into v_user from auth.users order by created_at limit 1;
  if v_user is null then
    raise exception 'auth.users está vazio: crie ao menos um usuário em staging.';
  end if;

  -- ---------------------------------------------------------------- fixtures
  insert into companies (name) values ('ZZ-TESTE-0009-A') returning id into v_A;
  insert into companies (name) values ('ZZ-TESTE-0009-B') returning id into v_B;
  -- a usuária de teste é membro SÓ da empresa A, como "reception":
  -- papel que não enxerga payments (RLS admin-only) mas pode mexer em clientes.
  insert into company_members (company_id, user_id, role) values (v_A, v_user, 'reception') returning id into v_mem;
  insert into services (company_id, name, duration_minutes, price) values (v_A, 'ZZ servico', 60, 10) returning id into v_svc;

  insert into clients (company_id, name) values (v_A, 'ZZ sem historico')       returning id into c_free;
  insert into clients (company_id, name) values (v_A, 'ZZ com atendimento')     returning id into c_appt;
  insert into clients (company_id, name) values (v_A, 'ZZ so pagamento')        returning id into c_pay;
  insert into clients (company_id, name) values (v_A, 'ZZ atendimento+pgto')    returning id into c_both;
  insert into clients (company_id, name, archived_at) values (v_A, 'ZZ arquivada com pgto', now()) returning id into c_arch;
  insert into clients (company_id, name) values (v_B, 'ZZ cliente da empresa B') returning id into c_B;

  insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end)
    values (v_A, c_appt, v_svc, v_mem, now() + interval '1 day', now() + interval '1 day 1 hour') returning id into a_appt;
  insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end)
    values (v_A, c_both, v_svc, v_mem, now() + interval '2 days', now() + interval '2 days 1 hour') returning id into a_both;

  insert into payments (company_id, client_id, amount, method, status) values (v_A, c_pay,  10, 'pix', 'pendente') returning id into p_pay;
  insert into payments (company_id, client_id, amount, method, status) values (v_A, c_both, 10, 'pix', 'pendente') returning id into p_both;
  insert into payments (company_id, client_id, amount, method, status) values (v_A, c_arch, 10, 'pix', 'pendente') returning id into p_arch;

  -- ------------------------------------------------------ S. estrutura criada
  r := r || pg_temp.t('S1 FK composta de appointments existe', 'ok', null,
    $q$ select 1 / (case when exists (select 1 from pg_constraint where conname = 'appointments_client_same_company_fkey') then 1 else 0 end) $q$) || nl;
  r := r || pg_temp.t('S2 FK composta de payments existe', 'ok', null,
    $q$ select 1 / (case when exists (select 1 from pg_constraint where conname = 'payments_client_same_company_fkey') then 1 else 0 end) $q$) || nl;
  r := r || pg_temp.t('S3 existe exatamente 1 FK appointments->clients e 1 payments->clients (PostgREST sem ambiguidade)', 'ok', null,
    $q$ select 1 / (case when
          (select count(*) from pg_constraint where contype = 'f' and conrelid = 'public.appointments'::regclass and confrelid = 'public.clients'::regclass) = 1
      and (select count(*) from pg_constraint where contype = 'f' and conrelid = 'public.payments'::regclass     and confrelid = 'public.clients'::regclass) = 1
        then 1 else 0 end) $q$) || nl;
  r := r || pg_temp.t('S4 gatilhos de clients existem', 'ok', null,
    $q$ select 1 / (case when (select count(*) from pg_trigger where tgrelid = 'public.clients'::regclass
          and tgname in ('trg_clients_block_delete_with_history', 'trg_clients_company_id_immutable')) = 2 then 1 else 0 end) $q$) || nl;

  -- -------------------------------------------------- A. mesmo tenant (deve funcionar)
  r := r || pg_temp.t('A1 empresa A -> cliente A -> atendimento A', 'ok', null,
    format($q$ insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end)
              values (%L, %L, %L, %L, now() + interval '30 days', now() + interval '30 days 1 hour') $q$, v_A, c_free, v_svc, v_mem)) || nl;
  r := r || pg_temp.t('A2 empresa A -> cliente A -> pagamento A', 'ok', null,
    format($q$ insert into payments (company_id, client_id, amount, method, status) values (%L, %L, 10, 'pix', 'pendente') $q$, v_A, c_free)) || nl;
  r := r || pg_temp.t('A3 pagamento A SEM cliente (receita avulsa) continua permitido', 'ok', null,
    format($q$ insert into payments (company_id, amount, method, status) values (%L, 10, 'pix', 'pendente') $q$, v_A)) || nl;
  r := r || pg_temp.t('A4 trocar o atendimento para OUTRA cliente da MESMA empresa', 'ok', null,
    format($q$ update appointments set client_id = %L where id = %L $q$, c_free, a_appt)) || nl;

  -- ----------------------------------------- B. cross-tenant (deve falhar no banco)
  r := r || pg_temp.t('B1 empresa A -> cliente B -> atendimento A', 'fail', null,
    format($q$ insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end)
              values (%L, %L, %L, %L, now() + interval '31 days', now() + interval '31 days 1 hour') $q$, v_A, c_B, v_svc, v_mem)) || nl;
  r := r || pg_temp.t('B2 empresa A -> cliente B -> pagamento A', 'fail', null,
    format($q$ insert into payments (company_id, client_id, amount, method, status) values (%L, %L, 10, 'pix', 'pendente') $q$, v_A, c_B)) || nl;
  r := r || pg_temp.t('B3 UPDATE: atendimento A passa a apontar para cliente B', 'fail', null,
    format($q$ update appointments set client_id = %L where id = %L $q$, c_B, a_appt)) || nl;
  r := r || pg_temp.t('B4 UPDATE: pagamento A passa a apontar para cliente B', 'fail', null,
    format($q$ update payments set client_id = %L where id = %L $q$, c_B, p_pay)) || nl;

  -- ------------------------------------------------ C. DELETE direto de cliente
  r := r || pg_temp.t('C1 cliente sem histórico: DELETE', 'ok', null,
    format($q$ delete from clients where id = %L $q$, c_free)) || nl;
  r := r || pg_temp.t('C2 cliente com atendimento: DELETE bloqueado', 'fail', null,
    format($q$ delete from clients where id = %L $q$, c_appt)) || nl;
  r := r || pg_temp.t('C3 cliente com SÓ pagamento: DELETE bloqueado (a lacuna original)', 'fail', null,
    format($q$ delete from clients where id = %L $q$, c_pay)) || nl;
  r := r || pg_temp.t('C4 cliente com atendimento + pagamento: DELETE bloqueado', 'fail', null,
    format($q$ delete from clients where id = %L $q$, c_both)) || nl;
  r := r || pg_temp.t('C5 DELETE direto pela API, como "reception" (RLS esconde payments), cliente só com pagamento: bloqueado', 'fail', v_user,
    format($q$ delete from clients where id = %L $q$, c_pay)) || nl;
  r := r || pg_temp.t('C6 DELETE direto pela API, como "reception", cliente sem histórico: permitido', 'ok', v_user,
    format($q$ delete from clients where id = %L $q$, c_free)) || nl;
  r := r || pg_temp.t('C7 cliente ARQUIVADA com pagamento: DELETE bloqueado', 'fail', null,
    format($q$ delete from clients where id = %L $q$, c_arch)) || nl;

  -- --------------------------------------------- D. RPC existente (sem mudança)
  r := r || pg_temp.t('D1 delete_client_without_history: cliente sem histórico funciona', 'ok', v_user,
    format($q$ select delete_client_without_history(%L) $q$, c_free)) || nl;
  r := r || pg_temp.t('D2 RPC: cliente só com pagamento continua bloqueada', 'fail', v_user,
    format($q$ select delete_client_without_history(%L) $q$, c_pay)) || nl;
  r := r || pg_temp.t('D3 RPC: cliente com atendimento continua bloqueada', 'fail', v_user,
    format($q$ select delete_client_without_history(%L) $q$, c_appt)) || nl;
  r := r || pg_temp.t('D4 RPC: cliente de OUTRA empresa -> mesmo erro de "não existe"', 'fail', v_user,
    format($q$ select delete_client_without_history(%L) $q$, c_B)) || nl;
  r := r || pg_temp.t('D5 RPC get_client_history_summary: cliente da própria empresa funciona', 'ok', v_user,
    format($q$ select * from get_client_history_summary(%L) $q$, c_both)) || nl;
  r := r || pg_temp.t('D6 RPC get_client_history_summary: cliente de OUTRA empresa bloqueada', 'fail', v_user,
    format($q$ select * from get_client_history_summary(%L) $q$, c_B)) || nl;

  -- ------------------------------------------------------------------- E. RLS
  r := r || pg_temp.t('E1 usuária de A NÃO enxerga cliente de B', 'ok', v_user,
    format($q$ select 1 / (case when exists (select 1 from clients where id = %L) then 0 else 1 end) $q$, c_B)) || nl;
  r := r || pg_temp.t('E2 usuária de A NÃO consegue alterar cliente de B (0 linhas)', 'ok', v_user,
    format($q$ with u as (update clients set name = 'invasao' where id = %L returning 1)
              select 1 / (case when exists (select 1 from u) then 0 else 1 end) $q$, c_B)) || nl;
  r := r || pg_temp.t('E3 usuária de A NÃO consegue excluir cliente de B (0 linhas)', 'ok', v_user,
    format($q$ with d as (delete from clients where id = %L returning 1)
              select 1 / (case when exists (select 1 from d) then 0 else 1 end) $q$, c_B)) || nl;
  r := r || pg_temp.t('E4 usuária de A NÃO consegue criar atendimento na empresa B', 'fail', v_user,
    format($q$ insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end)
              values (%L, %L, %L, %L, now() + interval '40 days', now() + interval '40 days 1 hour') $q$, v_B, c_B, v_svc, v_mem)) || nl;
  r := r || pg_temp.t('E5 usuária de A NÃO consegue criar cliente na empresa B', 'fail', v_user,
    format($q$ insert into clients (company_id, name) values (%L, 'invasao') $q$, v_B)) || nl;

  -- ------------------------------------------------- F. arquivar / reativar
  r := r || pg_temp.t('F1 arquivar cliente COM histórico (1 linha atualizada)', 'ok', v_user,
    format($q$ with u as (update clients set archived_at = now() where id = %L returning 1)
              select 1 / (case when exists (select 1 from u) then 1 else 0 end) $q$, c_both)) || nl;
  r := r || pg_temp.t('F2 reativar cliente arquivada com histórico (1 linha atualizada)', 'ok', v_user,
    format($q$ with u as (update clients set archived_at = null where id = %L returning 1)
              select 1 / (case when exists (select 1 from u) then 1 else 0 end) $q$, c_arch)) || nl;

  -- ------------------------------------- G. company_id não pode criar vínculo cruzado
  r := r || pg_temp.t('G1 UPDATE company_id do atendimento para B (cliente continua em A)', 'fail', null,
    format($q$ update appointments set company_id = %L where id = %L $q$, v_B, a_appt)) || nl;
  r := r || pg_temp.t('G2 UPDATE company_id do pagamento para B (cliente continua em A)', 'fail', null,
    format($q$ update payments set company_id = %L where id = %L $q$, v_B, p_pay)) || nl;
  r := r || pg_temp.t('G3 UPDATE company_id de cliente SEM histórico para B', 'fail', null,
    format($q$ update clients set company_id = %L where id = %L $q$, v_B, c_free)) || nl;
  r := r || pg_temp.t('G4 UPDATE company_id de cliente COM histórico para B', 'fail', null,
    format($q$ update clients set company_id = %L where id = %L $q$, v_B, c_both)) || nl;
  r := r || pg_temp.t('G5 usuária só de A tenta mover cliente para B (RLS)', 'fail', v_user,
    format($q$ update clients set company_id = %L where id = %L $q$, v_B, c_free)) || nl;
  r := r || pg_temp.t('G6 usuária membro de A E de B tenta mover cliente de A para B (a RLS permitiria; o gatilho recusa)', 'fail', v_user,
    format($q$ update clients set company_id = %L where id = %L $q$, v_B, c_free),
    format($q$ insert into company_members (company_id, user_id, role) values (%L, %L, 'owner') $q$, v_B, v_user)) || nl;
  r := r || pg_temp.t('G7 UPDATE company_id para o MESMO valor (no-op) continua permitido', 'ok', null,
    format($q$ update clients set company_id = company_id where id = %L $q$, c_free)) || nl;

  -- ------------------------- H. exclusão de EMPRESA (informativo; igual antes e depois)
  r := r || pg_temp.t('H1 DELETE empresa B (só 1 cliente, sem histórico, sem membros)', 'info', null,
    format($q$ delete from companies where id = %L $q$, v_B)) || nl;
  r := r || pg_temp.t('H2 DELETE empresa A (com membro, atendimentos e pagamentos)', 'info', null,
    format($q$ delete from companies where id = %L $q$, v_A)) || nl;

  v_fail := (length(r) - length(replace(r, 'FAIL ', ''))) / 5;

  -- A "falha" abaixo é intencional: desfaz TODOS os dados de teste.
  raise exception E'\n=== RESULTADO 0009 (esta falha é intencional: desfaz os dados de teste) ===\n%\nLINHAS "FAIL": %\n', r, v_fail;
end
$do$;
