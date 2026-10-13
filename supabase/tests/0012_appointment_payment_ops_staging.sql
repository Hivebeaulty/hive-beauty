-- ============================================================================
-- TESTES — 0011 (cartão crédito/débito), 0012 (pagamento/exclusão de atendimento)
--          e 0013 (nome de exibição)
--
-- Cole TUDO no SQL Editor e execute UMA vez. Requer 0008, 0009, 0010 e pelo menos
-- 1 usuário em auth.users.
--
-- Nada persiste: o bloco DO termina com uma exceção INTENCIONAL (é ela que desfaz
-- as empresas e os dados de teste). O relatório vem na mensagem de erro.
--
-- Rode ANTES (baseline) e DEPOIS de aplicar 0011 + 0012 + 0013:
--   ANTES : muitos FAIL (as funções ainda não existem) — prova que o teste detecta.
--   DEPOIS: esperado ZERO "FAIL".
--
-- Convenções: instruções separadas por "@@" rodam em sequência, no mesmo papel,
-- dentro do MESMO teste. Uma asserção que falha vira divisão por zero.
-- ============================================================================

create or replace function pg_temp.t(
  p_name text, p_expect text, p_uid uuid, p_sql text,
  p_pre text default null, p_post text default null)
returns text
language plpgsql
as $fn$
declare
  v_stmt text;
begin
  begin
    if p_pre is not null then               -- preparação COMO DONO (sem RLS)
      foreach v_stmt in array string_to_array(p_pre, '@@') loop execute v_stmt; end loop;
    end if;
    if p_uid is not null then
      perform set_config('request.jwt.claims',
                         json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
      perform set_config('request.jwt.claim.sub', p_uid::text, true);
      set local role authenticated;         -- age como essa usuária, sob RLS
    end if;
    foreach v_stmt in array string_to_array(p_sql, '@@') loop execute v_stmt; end loop;
    if p_post is not null then              -- verificação COMO DONO, depois da ação
      reset role;
      foreach v_stmt in array string_to_array(p_post, '@@') loop execute v_stmt; end loop;
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
  v_user uuid; v_other uuid;
  v_A uuid; v_B uuid; v_mem uuid; v_memB uuid; v_svc uuid; v_svcB uuid;
  c_A uuid; c_B uuid;
  a1 uuid; a2 uuid; a_B uuid;
  -- trechos reutilizados ------------------------------------------------------
  s_setup_a1 text;     -- a1 já concluído + 1 pagamento "pago/pix" (montado como dono)
  s_setup_a1_nopay text;
  s_setup_aB text;
  today_sp text;
  v_fail int;
  r text := '';
  nl text := E'\n';
begin
  select id into v_user from auth.users order by created_at limit 1;
  if v_user is null then
    raise exception 'auth.users está vazio: crie ao menos um usuário.';
  end if;
  select id into v_other from profiles where id <> v_user limit 1;
  today_sp := ((now() at time zone 'America/Sao_Paulo')::date)::text;

  -- ---------------------------------------------------------------- fixtures
  insert into companies (name) values ('ZZ-TESTE-0012-A') returning id into v_A;
  insert into companies (name) values ('ZZ-TESTE-0012-B') returning id into v_B;
  insert into company_members (company_id, user_id, role) values (v_A, v_user, 'owner') returning id into v_mem;
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
  -- um recebimento da empresa B (precisa continuar intocado em toda exclusão da A)
  insert into payments (company_id, appointment_id, client_id, amount, method, status, paid_at)
    values (v_B, a_B, c_B, 50, 'pix', 'pago', now());

  s_setup_a1 := format($q$
      update appointments set status = 'concluido', price = 100, payment_method = 'pix', completed_at = now() where id = %L
      @@ insert into payments (company_id, appointment_id, client_id, amount, method, status, paid_at)
         values (%L, %L, %L, 100, 'pix', 'pago', now()) $q$, a1, v_A, a1, c_A);
  s_setup_a1_nopay := format($q$
      update appointments set status = 'concluido', price = 100, payment_method = 'pix', completed_at = now() where id = %L $q$, a1);
  s_setup_aB := format($q$
      update appointments set status = 'concluido', completed_at = now() where id = %L $q$, a_B);

  -- ------------------------------------------------------ S. estrutura criada
  r := r || pg_temp.t('S1 enum payment_method tem pix, dinheiro, cartao (legado), cartao_credito, cartao_debito, outro', 'ok', null,
    $q$ select 1 / (case when (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid
          where t.typname = 'payment_method'
            and e.enumlabel in ('pix','dinheiro','cartao','cartao_credito','cartao_debito','outro')) = 6 then 1 else 0 end) $q$) || nl;
  r := r || pg_temp.t('S2 funções get/update/delete_appointment + gatilho de órfão existem', 'ok', null,
    $q$ select 1 / (case when (select count(*) from pg_proc where proname in
          ('get_appointment_payment','update_appointment_payment','delete_appointment','prevent_appointment_delete_with_payment')) = 4
          and exists (select 1 from pg_trigger where tgname = 'trg_appointments_block_delete_with_payment') then 1 else 0 end) $q$) || nl;
  r := r || pg_temp.t('S3 profiles.display_name e get_company_member_display_names existem', 'ok', null,
    $q$ select 1 / (case when exists (select 1 from information_schema.columns where table_name = 'profiles' and column_name = 'display_name')
          and exists (select 1 from pg_proc where proname = 'get_company_member_display_names') then 1 else 0 end) $q$) || nl;
  r := r || pg_temp.t('S4 funções SECURITY DEFINER com search_path endurecido (pg_temp por último)', 'ok', null,
    $q$ select 1 / (case when (select count(*) from pg_proc where proname in
          ('get_appointment_payment','update_appointment_payment','delete_appointment','prevent_appointment_delete_with_payment')
          and prosecdef and array_to_string(proconfig, ',') like '%search_path=public, pg_temp%') = 4 then 1 else 0 end) $q$) || nl;

  -- ------------------------- CM. conclusão com as novas formas (como owner, sob RLS)
  r := r || pg_temp.t('CM1 concluir com CARTÃO DE CRÉDITO grava pagamento e atendimento com essa forma (1 pagamento)', 'ok', v_user,
    format($q$ select conclude_appointment(%L, 100, 'cartao_credito', 'pago')
              @@ select 1 / (case when (select count(*) from payments where appointment_id = %L) = 1
                    and exists (select 1 from payments where appointment_id = %L and method = 'cartao_credito' and status = 'pago')
                    and (select payment_method from appointments where id = %L) = 'cartao_credito' then 1 else 0 end) $q$, a1, a1, a1, a1)) || nl;
  r := r || pg_temp.t('CM2 concluir com CARTÃO DE DÉBITO', 'ok', v_user,
    format($q$ select conclude_appointment(%L, 100, 'cartao_debito', 'pago')
              @@ select 1 / (case when exists (select 1 from payments where appointment_id = %L and method = 'cartao_debito') then 1 else 0 end) $q$, a1, a1)) || nl;

  -- --------------------------- M. alterar a forma de pagamento (um só pagamento)
  r := r || pg_temp.t('M1 PIX -> CARTÃO DE CRÉDITO: continua 1 pagamento, R$ 100, recebido, nova forma (e no atendimento)', 'ok', v_user,
    format($q$ select conclude_appointment(%L, 100, 'pix', 'pago')
              @@ select update_appointment_payment(%L, 'cartao_credito')
              @@ select 1 / (case when (select count(*) from payments where appointment_id = %L) = 1
                    and exists (select 1 from payments where appointment_id = %L and amount = 100 and paid_amount = 100
                                and status = 'pago' and method = 'cartao_credito')
                    and (select payment_method from appointments where id = %L) = 'cartao_credito' then 1 else 0 end) $q$, a1, a1, a1, a1, a1)) || nl;
  r := r || pg_temp.t('M2 alterar para DINHEIRO e depois para CARTÃO DE DÉBITO (sempre o mesmo pagamento)', 'ok', v_user,
    format($q$ select conclude_appointment(%L, 100, 'pix', 'pago')
              @@ select update_appointment_payment(%L, 'dinheiro')
              @@ select update_appointment_payment(%L, 'cartao_debito')
              @@ select 1 / (case when (select count(*) from payments where appointment_id = %L) = 1
                    and exists (select 1 from payments where appointment_id = %L and method = 'cartao_debito' and status = 'pago') then 1 else 0 end) $q$, a1, a1, a1, a1, a1)) || nl;
  r := r || pg_temp.t('M3 recebimento PENDENTE: alterar a forma NÃO o torna recebido (continua pendente, paid_amount 0, sem paid_at)', 'ok', v_user,
    format($q$ select conclude_appointment(%L, 100, 'pix', 'pendente')
              @@ select update_appointment_payment(%L, 'dinheiro')
              @@ select 1 / (case when (select count(*) from payments where appointment_id = %L) = 1
                    and exists (select 1 from payments where appointment_id = %L and status = 'pendente' and paid_amount = 0
                                and paid_at is null and method = 'dinheiro') then 1 else 0 end) $q$, a1, a1, a1, a1)) || nl;
  r := r || pg_temp.t('M4 pendente -> MARCAR COMO RECEBIDO: pago, paid_amount = valor, paid_at preenchido, 1 pagamento', 'ok', v_user,
    format($q$ select conclude_appointment(%L, 100, 'pix', 'pendente')
              @@ select update_appointment_payment(%L, 'pix', true)
              @@ select 1 / (case when (select count(*) from payments where appointment_id = %L) = 1
                    and exists (select 1 from payments where appointment_id = %L and status = 'pago'
                                and paid_amount = 100 and amount = 100 and paid_at is not null) then 1 else 0 end) $q$, a1, a1, a1, a1)) || nl;
  r := r || pg_temp.t('M5 recebido não vira pendente ao alterar a forma com p_mark_received = false', 'ok', v_user,
    format($q$ select conclude_appointment(%L, 100, 'pix', 'pago')
              @@ select update_appointment_payment(%L, 'dinheiro', false)
              @@ select 1 / (case when exists (select 1 from payments where appointment_id = %L and status = 'pago' and paid_amount = 100) then 1 else 0 end) $q$, a1, a1, a1)) || nl;
  r := r || pg_temp.t('M6 atendimento NÃO concluído (agendado): alterar recebimento é recusado', 'fail', v_user,
    format($q$ select update_appointment_payment(%L, 'pix') $q$, a2)) || nl;
  r := r || pg_temp.t('M7 papel "reception" não consegue alterar o recebimento', 'fail', v_user,
    format($q$ select update_appointment_payment(%L, 'dinheiro') $q$, a1),
    s_setup_a1 || format($q$ @@ update company_members set role = 'reception' where id = %L $q$, v_mem)) || nl;
  r := r || pg_temp.t('M8 usuária que NÃO é membro da empresa B não altera recebimento de B', 'fail', v_user,
    format($q$ select update_appointment_payment(%L, 'dinheiro') $q$, a_B),
    s_setup_aB) || nl;
  r := r || pg_temp.t('M9 profissional DONA do atendimento consegue alterar a forma (não lê payments por RLS, mas a RPC permite)', 'ok', v_user,
    format($q$ select update_appointment_payment(%L, 'cartao_credito')
              @@ select 1 / (case when (select pay_method from get_appointment_payment(%L)) = 'cartao_credito' then 1 else 0 end) $q$, a1, a1),
    s_setup_a1 || format($q$ @@ update company_members set role = 'professional' where id = %L $q$, v_mem)) || nl;

  -- ------------------------------------------- G. leitura do recebimento (RPC)
  r := r || pg_temp.t('G1 owner lê o recebimento do atendimento (status, valor, forma)', 'ok', v_user,
    format($q$ select 1 / (case when exists (select 1 from get_appointment_payment(%L)
                where pay_status = 'pago' and pay_amount = 100 and pay_method = 'pix') then 1 else 0 end) $q$, a1),
    s_setup_a1) || nl;
  r := r || pg_temp.t('G2 reception não lê o recebimento', 'fail', v_user,
    format($q$ select * from get_appointment_payment(%L) $q$, a1),
    s_setup_a1 || format($q$ @@ update company_members set role = 'reception' where id = %L $q$, v_mem)) || nl;
  r := r || pg_temp.t('G3 não-membro não lê recebimento de outra empresa', 'fail', v_user,
    format($q$ select * from get_appointment_payment(%L) $q$, a_B)) || nl;

  -- --------------------------------------------- D. excluir atendimento concluído
  r := r || pg_temp.t('D1 concluir (R$ 100, pago) e EXCLUIR: some o atendimento E o pagamento; nada órfão', 'ok', v_user,
    format($q$ select conclude_appointment(%L, 100, 'pix', 'pago')
              @@ select delete_appointment(%L)
              @@ select 1 / (case when not exists (select 1 from appointments where id = %L)
                    and not exists (select 1 from payments where appointment_id = %L)
                    and not exists (select 1 from payments where company_id = %L) then 1 else 0 end) $q$, a1, a1, a1, a1, v_A)) || nl;
  r := r || pg_temp.t('D2 a exclusão devolve o que foi removido (payment_deleted = true, payment_amount = 100)', 'ok', v_user,
    format($q$ select conclude_appointment(%L, 100, 'pix', 'pago')
              @@ select 1 / (case when (select (delete_appointment(%L)->>'payment_deleted')::boolean) then 1 else 0 end) $q$, a1, a1)) || nl;
  r := r || pg_temp.t('D3 excluir NÃO toca no pagamento de OUTRO atendimento nem no da empresa B', 'ok', v_user,
    format($q$ select delete_appointment(%L) $q$, a1),
    s_setup_a1 || format($q$ @@ update appointments set status = 'concluido', completed_at = now() where id = %L
                            @@ insert into payments (company_id, appointment_id, client_id, amount, method, status, paid_at)
                               values (%L, %L, %L, 80, 'dinheiro', 'pago', now()) $q$, a2, v_A, a2, c_A),
    -- verificação COMO DONO (p_post): a usuária é membro INATIVO da empresa B, então
    -- a RLS esconderia o pagamento de B se a checagem rodasse como ela.
    format($q$ select 1 / (case when exists (select 1 from payments where appointment_id = %L)
                    and exists (select 1 from payments where company_id = %L) then 1 else 0 end) $q$, a2, v_B)) || nl;
  r := r || pg_temp.t('D4 atendimento concluído SEM pagamento também pode ser excluído', 'ok', v_user,
    format($q$ select delete_appointment(%L)
              @@ select 1 / (case when not exists (select 1 from appointments where id = %L) then 1 else 0 end) $q$, a1, a1),
    s_setup_a1_nopay) || nl;
  r := r || pg_temp.t('D5 atendimento NÃO concluído (agendado): exclusão recusada', 'fail', v_user,
    format($q$ select delete_appointment(%L) $q$, a2)) || nl;
  r := r || pg_temp.t('D6 papel "reception" não exclui atendimento', 'fail', v_user,
    format($q$ select delete_appointment(%L) $q$, a1),
    s_setup_a1 || format($q$ @@ update company_members set role = 'reception' where id = %L $q$, v_mem)) || nl;
  r := r || pg_temp.t('D7 "professional" (mesmo dona do atendimento) não exclui: só a administração', 'fail', v_user,
    format($q$ select delete_appointment(%L) $q$, a1),
    s_setup_a1 || format($q$ @@ update company_members set role = 'professional' where id = %L $q$, v_mem)) || nl;
  r := r || pg_temp.t('D8 atendimento de OUTRA empresa: exclusão recusada e nada é removido', 'fail', v_user,
    format($q$ select delete_appointment(%L) $q$, a_B),
    s_setup_aB) || nl;
  r := r || pg_temp.t('D9 DELETE direto na API de atendimento concluído COM pagamento é bloqueado (sem pagamento órfão)', 'fail', null,
    format($q$ delete from appointments where id = %L $q$, a1),
    s_setup_a1) || nl;
  r := r || pg_temp.t('D10 DELETE direto de atendimento SEM pagamento (agendado) continua permitido', 'ok', null,
    format($q$ delete from appointments where id = %L $q$, a2)) || nl;
  r := r || pg_temp.t('D11 admin com papel "admin" também exclui', 'ok', v_user,
    format($q$ select delete_appointment(%L) $q$, a1),
    s_setup_a1 || format($q$ @@ update company_members set role = 'admin' where id = %L $q$, v_mem)) || nl;

  -- ----------------------- I. indicadores seguem os dados restantes (recalculo natural)
  r := r || pg_temp.t('I1 RECEBIDO: entra em faturado e recebido; ao excluir, ambos voltam a 0 e atendimentos realizados a 0', 'ok', v_user,
    format($q$ select conclude_appointment(%L, 100, 'pix', 'pago')
              @@ select 1 / (case when exists (select 1 from get_period_indicators(%L, %L::date - 1, %L::date + 1)
                    where faturado = 100 and recebido = 100 and pendente = 0 and atendimentos_realizados = 1) then 1 else 0 end)
              @@ select delete_appointment(%L)
              @@ select 1 / (case when exists (select 1 from get_period_indicators(%L, %L::date - 1, %L::date + 1)
                    where faturado = 0 and recebido = 0 and pendente = 0 and atendimentos_realizados = 0) then 1 else 0 end) $q$,
      a1, v_A, today_sp, today_sp, a1, v_A, today_sp, today_sp)) || nl;
  r := r || pg_temp.t('I2 PENDENTE: NÃO entra em recebido/resultado de caixa (recebido 0, pendente 100); excluir zera o pendente', 'ok', v_user,
    format($q$ select conclude_appointment(%L, 100, 'pix', 'pendente')
              @@ select 1 / (case when exists (select 1 from get_period_indicators(%L, %L::date - 1, %L::date + 1)
                    where faturado = 100 and recebido = 0 and resultado_caixa = 0 and pendente = 100) then 1 else 0 end)
              @@ select delete_appointment(%L)
              @@ select 1 / (case when exists (select 1 from get_period_indicators(%L, %L::date - 1, %L::date + 1)
                    where pendente = 0 and faturado = 0) then 1 else 0 end) $q$,
      a1, v_A, today_sp, today_sp, a1, v_A, today_sp, today_sp)) || nl;
  r := r || pg_temp.t('I3 pendente -> recebido: recebido passa a 100 e pendente a 0, sem duplicar', 'ok', v_user,
    format($q$ select conclude_appointment(%L, 100, 'pix', 'pendente')
              @@ select update_appointment_payment(%L, 'pix', true)
              @@ select 1 / (case when exists (select 1 from get_period_indicators(%L, %L::date - 1, %L::date + 1)
                    where faturado = 100 and recebido = 100 and pendente = 0) then 1 else 0 end) $q$,
      a1, a1, v_A, today_sp, today_sp)) || nl;
  r := r || pg_temp.t('I4 cliente: last/first_visit_at recalculados (preenchidos ao concluir, NULL ao excluir o único atendimento)', 'ok', v_user,
    format($q$ select conclude_appointment(%L, 100, 'pix', 'pago')
              @@ select 1 / (case when (select last_visit_at from clients where id = %L) is not null
                    and (select first_visit_at from clients where id = %L) is not null then 1 else 0 end)
              @@ select delete_appointment(%L)
              @@ select 1 / (case when (select last_visit_at from clients where id = %L) is null
                    and (select first_visit_at from clients where id = %L) is null then 1 else 0 end) $q$,
      a1, c_A, c_A, a1, c_A, c_A)) || nl;
  r := r || pg_temp.t('I5 exclusão preserva trilha: audit_logs guarda DELETE de appointments e de payments', 'ok', v_user,
    format($q$ select conclude_appointment(%L, 100, 'pix', 'pago') @@ select delete_appointment(%L) $q$, a1, a1),
    null,
    format($q$ select 1 / (case when exists (select 1 from audit_logs where company_id = %L and entity = 'appointments' and action = 'delete' and entity_id = %L)
                and exists (select 1 from audit_logs where company_id = %L and entity = 'payments' and action = 'delete') then 1 else 0 end) $q$, v_A, a1, v_A)) || nl;
  r := r || pg_temp.t('I6 exclusão remove o histórico de status do atendimento (cascata) — sem registro solto', 'ok', v_user,
    format($q$ select conclude_appointment(%L, 100, 'pix', 'pago') @@ select delete_appointment(%L) $q$, a1, a1),
    null,
    format($q$ select 1 / (case when not exists (select 1 from appointment_status_history where appointment_id = %L) then 1 else 0 end) $q$, a1)) || nl;

  -- --------------------------------------------------- P. nome de exibição (0013)
  r := r || pg_temp.t('P1 a própria usuária define "Como você quer ser chamada" (RLS profiles_self_update)', 'ok', v_user,
    format($q$ with u as (update profiles set display_name = 'Paty' where id = %L returning 1)
              select 1 / (case when exists (select 1 from u) then 1 else 0 end)
              @@ select 1 / (case when (select display_name from profiles where id = %L) = 'Paty' then 1 else 0 end) $q$, v_user, v_user)) || nl;
  r := r || pg_temp.t('P2 nome em branco é recusado (CHECK)', 'fail', v_user,
    format($q$ update profiles set display_name = '   ' where id = %L $q$, v_user)) || nl;
  r := r || pg_temp.t('P3 nome com mais de 40 caracteres é recusado (CHECK)', 'fail', v_user,
    format($q$ update profiles set display_name = repeat('a', 41) where id = %L $q$, v_user)) || nl;
  r := r || pg_temp.t('P4 limpar o campo (NULL) é permitido: volta ao nome cadastrado', 'ok', v_user,
    format($q$ update profiles set display_name = null where id = %L $q$, v_user)) || nl;
  r := r || pg_temp.t('P5 equipe da MESMA empresa lê o nome de exibição (sem expor phone/avatar)', 'ok', v_user,
    format($q$ select 1 / (case when exists (select 1 from get_company_member_display_names(%L)
                where member_id = %L and display_name = 'Paty') then 1 else 0 end) $q$, v_A, v_mem),
    format($q$ update profiles set display_name = 'Paty' where id = %L $q$, v_user)) || nl;
  r := r || pg_temp.t('P6 não-membro NÃO lê nomes de outra empresa (0 linhas)', 'ok', v_user,
    format($q$ select 1 / (case when not exists (select 1 from get_company_member_display_names(%L)) then 1 else 0 end) $q$, v_B)) || nl;
  if v_other is not null then
    r := r || pg_temp.t('P7 uma usuária NÃO consegue alterar o nome de exibição de OUTRA (0 linhas)', 'ok', v_user,
      format($q$ with u as (update profiles set display_name = 'invasao' where id = %L returning 1)
                select 1 / (case when exists (select 1 from u) then 0 else 1 end) $q$, v_other)) || nl;
  else
    r := r || 'INFO P7 (pulado: só existe 1 perfil no banco)' || nl;
  end if;

  v_fail := (length(r) - length(replace(r, 'FAIL ', ''))) / 5;

  raise exception E'\n=== RESULTADO 0011-0013 (esta falha é intencional: desfaz os dados de teste) ===\n%\nLINHAS "FAIL": %\n', r, v_fail;
end
$do$;
