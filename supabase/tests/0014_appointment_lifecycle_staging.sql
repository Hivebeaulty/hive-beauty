-- ============================================================================
-- TESTES — 0014 (ciclo de vida do atendimento: proteções, pendência, falta)
--
-- Nada persiste: o bloco DO termina com uma exceção INTENCIONAL (é ela que
-- desfaz as empresas e os dados de teste). O relatório vem na mensagem de erro.
-- Requer 0001–0014 e pelo menos 1 usuário em auth.users (2 para os testes com
-- outra profissional; sem o 2º usuário eles são pulados e aparecem como INFO).
--
-- Rode ANTES (baseline) e DEPOIS de aplicar a 0014:
--   ANTES : muitos FAIL (colunas/funções/gatilhos ainda não existem).
--   DEPOIS: esperado ZERO "FAIL".
--
-- A invariante atendimento x recebimento é verificada no COMMIT. Como estes
-- testes nunca fazem COMMIT, os passos que precisam dela terminam com
-- "set constraints all immediate", que dispara a verificação na hora.
--
-- Convenções: instruções separadas por "@@" rodam em sequência, no mesmo papel.
-- p_pre roda COMO DONO (sem RLS); p_post verifica COMO DONO depois da ação.
-- Uma asserção que falha vira divisão por zero. Testes negativos declaram o
-- código de erro esperado ('fail:22023'): bloqueio por outro motivo é FAIL.
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
    if p_pre is not null then
      foreach v_stmt in array string_to_array(p_pre, '@@') loop execute v_stmt; end loop;
    end if;
    if p_uid is not null then
      perform set_config('request.jwt.claims',
                         json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
      perform set_config('request.jwt.claim.sub', p_uid::text, true);
      set local role authenticated;
    end if;
    foreach v_stmt in array string_to_array(p_sql, '@@') loop execute v_stmt; end loop;
    if p_post is not null then
      reset role;
      foreach v_stmt in array string_to_array(p_post, '@@') loop execute v_stmt; end loop;
    end if;
    raise exception using errcode = 'P9999', message = '__sem_erro__';
  exception
    when sqlstate 'P9999' then
      return rpad(case when p_expect = 'ok' then 'PASS' when p_expect like 'fail%' then 'FAIL' else 'INFO' end, 5)
             || p_name
             || case when p_expect like 'fail%' then '   [executou SEM erro, mas DEVERIA ser bloqueado]'
                     when p_expect = 'info' then '   -> executou sem erro'
                     else '' end;
    when others then
      -- 'fail:XXXXX' só passa se o erro for EXATAMENTE o código esperado (um erro
      -- de preparação, por exemplo coluna inexistente, conta como FAIL).
      return rpad(case when p_expect = 'ok' then 'FAIL'
                       when p_expect = 'fail' then 'PASS'
                       when p_expect like 'fail:%' and sqlstate = substr(p_expect, 6) then 'PASS'
                       when p_expect like 'fail:%' then 'FAIL'
                       else 'INFO' end, 5)
             || p_name || '   -> ' || sqlstate || ': ' || sqlerrm;
  end;
end;
$fn$;

do $do$
declare
  v_user uuid; v_other uuid;
  v_A uuid; v_B uuid; v_mem uuid; v_memO uuid; v_memB uuid; v_svc uuid; v_svcB uuid;
  c_A uuid; c_A2 uuid; c_B uuid;
  a1 uuid; a_prev uuid; a_fut uuid; a_o uuid; a_B uuid;
  d_day date;                -- dia (São Paulo) do atendimento principal a1
  d_prev date;               -- dia (São Paulo) de a_prev
  s_auto_a1 text; s_back_a1 text; s_manual_a1 text; s_legacy_a1 text; s_parcial_a1 text;
  s_prev text; s_auto_aB text; s_auto_ao text;
  s_ind text;                -- trecho: indicadores do dia d_day para a empresa A
  v_fail int;
  r text := '';
  nl text := E'\n';
begin
  select id into v_user from auth.users order by created_at limit 1;
  if v_user is null then
    raise exception 'auth.users está vazio: crie ao menos um usuário.';
  end if;
  select id into v_other from profiles where id <> v_user order by created_at limit 1;

  d_day  := (now() at time zone 'America/Sao_Paulo')::date - 5;
  d_prev := (now() at time zone 'America/Sao_Paulo')::date - 15;

  -- ---------------------------------------------------------------- fixtures
  insert into companies (name) values ('ZZ-TESTE-0014-A') returning id into v_A;
  insert into companies (name) values ('ZZ-TESTE-0014-B') returning id into v_B;
  insert into company_members (company_id, user_id, role) values (v_A, v_user, 'owner') returning id into v_mem;
  insert into company_members (company_id, user_id, role, active) values (v_B, v_user, 'owner', false) returning id into v_memB;
  if v_other is not null then
    insert into company_members (company_id, user_id, role) values (v_A, v_other, 'professional') returning id into v_memO;
  end if;
  insert into services (company_id, name, duration_minutes, price) values (v_A, 'ZZ servico A', 60, 100) returning id into v_svc;
  insert into services (company_id, name, duration_minutes, price) values (v_B, 'ZZ servico B', 60, 100) returning id into v_svcB;
  insert into clients (company_id, name) values (v_A, 'ZZ cliente A') returning id into c_A;
  insert into clients (company_id, name) values (v_A, 'ZZ cliente A2') returning id into c_A2;
  insert into clients (company_id, name) values (v_B, 'ZZ cliente B') returning id into c_B;

  -- a1: atendimento principal, dia d_day 10:00–11:00 (São Paulo)
  insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end)
    values (v_A, c_A, v_svc, v_mem, 100,
            (d_day + time '10:00') at time zone 'America/Sao_Paulo',
            (d_day + time '11:00') at time zone 'America/Sao_Paulo') returning id into a1;
  -- a_prev: visita anterior da mesma cliente, dia d_prev
  insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end)
    values (v_A, c_A, v_svc, v_mem, 80,
            (d_prev + time '10:00') at time zone 'America/Sao_Paulo',
            (d_prev + time '11:00') at time zone 'America/Sao_Paulo') returning id into a_prev;
  -- a_fut: em aberto no futuro
  insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end)
    values (v_A, c_A, v_svc, v_mem, 100, now() + interval '2 days', now() + interval '2 days 1 hour') returning id into a_fut;
  -- a_o: atendimento de OUTRA profissional da empresa A
  if v_other is not null then
    insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end)
      values (v_A, c_A2, v_svc, v_memO, 70,
              (d_day + time '14:00') at time zone 'America/Sao_Paulo',
              (d_day + time '15:00') at time zone 'America/Sao_Paulo') returning id into a_o;
  end if;
  -- a_B: empresa B (a usuária é membro INATIVO de B)
  insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end)
    values (v_B, c_B, v_svcB, v_memB, 100, now() - interval '3 hours', now() - interval '2 hours') returning id into a_B;

  -- ---------------------------------------------------- trechos de preparação
  -- conclusão AUTOMÁTICA simulada (o que a 0015 fará): datas = scheduled_end
  s_auto_a1 := format($q$
      update appointments set status = 'concluido', payment_method = 'pix', completed_at = scheduled_end where id = %L
      @@ insert into payments (company_id, appointment_id, client_id, amount, method, status, paid_at, created_at, source)
         select company_id, id, client_id, price, 'pix', 'pago', scheduled_end, scheduled_end, 'auto' from appointments where id = %L
      @@ update clients set first_visit_at = %L, last_visit_at = %L where id = %L $q$,
      a1, a1, d_day, d_day, c_A);
  s_back_a1   := replace(s_auto_a1, $x$'auto'$x$, $x$'backfill'$x$);
  s_manual_a1 := replace(s_auto_a1, $x$'auto'$x$, $x$'manual'$x$);
  -- registro antigo: concluído SEM recebimento (como o caso de R$ 90 em produção)
  s_legacy_a1 := format($q$
      update appointments set status = 'concluido', payment_method = 'pix', completed_at = scheduled_end where id = %L $q$, a1);
  s_parcial_a1 := format($q$
      update appointments set status = 'concluido', payment_method = 'pix', completed_at = scheduled_end where id = %L
      @@ insert into payments (company_id, appointment_id, client_id, amount, paid_amount, method, status, created_at, source)
         select company_id, id, client_id, price, 40, 'pix', 'parcial', scheduled_end, 'auto' from appointments where id = %L $q$,
      a1, a1);
  -- visita anterior concluída manualmente
  s_prev := format($q$
      update appointments set status = 'concluido', payment_method = 'pix', completed_at = scheduled_end where id = %L
      @@ insert into payments (company_id, appointment_id, client_id, amount, method, status, paid_at, created_at)
         select company_id, id, client_id, price, 'pix', 'pago', scheduled_end, scheduled_end from appointments where id = %L $q$,
      a_prev, a_prev);
  s_auto_aB := format($q$
      update appointments set status = 'concluido', payment_method = 'pix', completed_at = scheduled_end where id = %L
      @@ insert into payments (company_id, appointment_id, client_id, amount, method, status, paid_at, created_at, source)
         select company_id, id, client_id, price, 'pix', 'pago', scheduled_end, scheduled_end, 'auto' from appointments where id = %L $q$,
      a_B, a_B);
  if v_other is not null then
    s_auto_ao := format($q$
        update appointments set status = 'concluido', payment_method = 'pix', completed_at = scheduled_end where id = %L
        @@ insert into payments (company_id, appointment_id, client_id, amount, method, status, paid_at, created_at, source)
           select company_id, id, client_id, price, 'pix', 'pago', scheduled_end, scheduled_end, 'auto' from appointments where id = %L $q$,
        a_o, a_o);
  end if;
  s_ind := format($q$ (select %%s from get_period_indicators(%L, %L::date, %L::date)) $q$, v_A, d_day, d_day);

  -- ============================================================ S. estrutura
  r := r || pg_temp.t('S1 payments.source/modified_at/modified_by existem; source padrão = manual', 'ok', null,
    $q$ select 1 / (case when (select count(*) from information_schema.columns
          where table_schema = 'public' and table_name = 'payments'
            and column_name in ('source','modified_at','modified_by')) = 3
          and (select column_default from information_schema.columns
                where table_schema = 'public' and table_name = 'payments' and column_name = 'source') like '%manual%'
          then 1 else 0 end) $q$) || nl;
  r := r || pg_temp.t('S2 gatilhos da 0014 existem (2 BEFORE + 3 de verificação no COMMIT)', 'ok', null,
    $q$ select 1 / (case when (select count(*) from pg_trigger where tgname in (
          'trg_payments_track_origin','trg_appointments_guard_lifecycle',
          'trg_appointments_payment_consistency_ins','trg_appointments_payment_consistency_upd',
          'trg_payments_appointment_consistency')) = 5
          and (select count(*) from pg_trigger where tgname like 'trg_%consistency%' and tgdeferrable and tginitdeferred) = 3
          then 1 else 0 end) $q$) || nl;
  r := r || pg_temp.t('S3 RPCs: authenticated executa; anon NÃO executa', 'ok', null,
    $q$ select 1 / (case when
          has_function_privilege('authenticated', 'mark_appointment_payment_pending(uuid)', 'execute')
          and has_function_privilege('authenticated', 'reclassify_appointment_as_no_show(uuid)', 'execute')
          and has_function_privilege('authenticated', 'get_appointment_no_show_eligibility(uuid)', 'execute')
          and not has_function_privilege('anon', 'mark_appointment_payment_pending(uuid)', 'execute')
          and not has_function_privilege('anon', 'reclassify_appointment_as_no_show(uuid)', 'execute')
          and not has_function_privilege('anon', 'get_appointment_no_show_eligibility(uuid)', 'execute')
          then 1 else 0 end) $q$) || nl;
  r := r || pg_temp.t('S4 função interna de verificação NÃO é executável por anon/authenticated', 'ok', null,
    $q$ select 1 / (case when
          not has_function_privilege('authenticated', 'assert_appointment_payment_consistency(uuid)', 'execute')
          and not has_function_privilege('anon', 'assert_appointment_payment_consistency(uuid)', 'execute')
          then 1 else 0 end) $q$) || nl;

  -- ====================================================== O. origem/alteração
  r := r || pg_temp.t('O1 API não forja origem: INSERT com source=auto vira manual', 'ok', v_user,
    format($q$ insert into payments (company_id, client_id, amount, method, status, description, source, modified_at)
              values (%L, %L, 10, 'pix', 'pago', 'ZZ avulso', 'auto', now()) $q$, v_A, c_A),
    null,
    $q$ select 1 / (case when exists (select 1 from payments where description = 'ZZ avulso'
          and source = 'manual' and modified_at is null) then 1 else 0 end) $q$) || nl;
  r := r || pg_temp.t('O2 API não muda origem nem apaga a marca de alteração', 'ok', v_user,
    format($q$ update payments set source = 'manual', modified_at = null where appointment_id = %L
              @@ update payments set description = 'x' where appointment_id = %L
              @@ update payments set modified_at = null, source = 'manual' where appointment_id = %L $q$, a1, a1, a1),
    s_auto_a1,
    format($q$ select 1 / (case when (select source = 'auto' and modified_at is not null from payments where appointment_id = %L)
              then 1 else 0 end) $q$, a1)) || nl;
  r := r || pg_temp.t('O3 trocar a forma (RPC 0012) marca o recebimento automático como alterado, por quem', 'ok', v_user,
    format($q$ select update_appointment_payment(%L, 'dinheiro') $q$, a1),
    s_auto_a1,
    format($q$ select 1 / (case when (select modified_at is not null and modified_by = %L and source = 'auto'
              from payments where appointment_id = %L) then 1 else 0 end) $q$, v_user, a1)) || nl;
  r := r || pg_temp.t('O4 UPDATE sem mudança de valor NÃO marca alteração', 'ok', v_user,
    format($q$ update payments set method = 'pix' where appointment_id = %L $q$, a1),
    s_auto_a1,
    format($q$ select 1 / (case when (select modified_at is null from payments where appointment_id = %L)
              then 1 else 0 end) $q$, a1)) || nl;

  -- ========================================== G. concluído é imutável pela API
  r := r || pg_temp.t('G1 owner: concluído -> cancelado por UPDATE direto (tela desatualizada) é recusado', 'fail:22023', v_user,
    format($q$ update appointments set status = 'cancelado' where id = %L $q$, a1), s_auto_a1) || nl;
  r := r || pg_temp.t('G2 owner: concluído -> não compareceu por UPDATE direto é recusado', 'fail:22023', v_user,
    format($q$ update appointments set status = 'nao_compareceu' where id = %L $q$, a1), s_auto_a1) || nl;
  r := r || pg_temp.t('G3 owner: reabrir concluído (-> agendado) é recusado', 'fail:22023', v_user,
    format($q$ update appointments set status = 'agendado' where id = %L $q$, a1), s_auto_a1) || nl;
  r := r || pg_temp.t('G4 owner: editar só a observação de um concluído continua permitido', 'ok', v_user,
    format($q$ update appointments set notes = 'obs nova' where id = %L $q$, a1), s_auto_a1,
    format($q$ select 1 / (case when (select notes from appointments where id = %L) = 'obs nova' then 1 else 0 end) $q$, a1)) || nl;
  r := r || pg_temp.t('G5 owner: mudar o preço de um concluído é recusado', 'fail:22023', v_user,
    format($q$ update appointments set price = 1 where id = %L $q$, a1), s_auto_a1) || nl;
  r := r || pg_temp.t('G6 owner: mudar a data de um concluído é recusado', 'fail:22023', v_user,
    format($q$ update appointments set scheduled_start = scheduled_start - interval '1 day',
                                       scheduled_end = scheduled_end - interval '1 day' where id = %L $q$, a1), s_auto_a1) || nl;
  r := r || pg_temp.t('G7 owner: DELETE direto de concluído SEM recebimento (caso legado) é recusado', 'fail:22023', v_user,
    format($q$ delete from appointments where id = %L $q$, a1), s_legacy_a1) || nl;
  r := r || pg_temp.t('G8 owner: concluir por UPDATE direto (sem a RPC) é recusado', 'fail:22023', v_user,
    format($q$ update appointments set status = 'concluido' where id = %L $q$, a_fut)) || nl;
  r := r || pg_temp.t('G9 owner: INSERT direto já como concluído é recusado', 'fail:22023', v_user,
    format($q$ insert into appointments (company_id, client_id, service_id, professional_member_id, price, status, scheduled_start, scheduled_end)
              values (%L, %L, %L, %L, 100, 'concluido', now() + interval '9 days', now() + interval '9 days 1 hour') $q$,
              v_A, c_A, v_svc, v_mem)) || nl;
  r := r || pg_temp.t('G10 em aberto -> cancelado continua permitido (sem regressão)', 'ok', v_user,
    format($q$ update appointments set status = 'cancelado' where id = %L @@ set constraints all immediate $q$, a_fut)) || nl;
  r := r || pg_temp.t('G11 em aberto -> não compareceu continua permitido (sem regressão)', 'ok', v_user,
    format($q$ update appointments set status = 'nao_compareceu' where id = %L @@ set constraints all immediate $q$, a1)) || nl;
  r := r || pg_temp.t('G12 profissional dona: concluído -> cancelado por UPDATE direto é recusado', 'fail:22023', v_user,
    format($q$ update appointments set status = 'cancelado' where id = %L $q$, a1),
    s_auto_a1 || format($q$ @@ update company_members set role = 'professional' where id = %L $q$, v_mem)) || nl;
  r := r || pg_temp.t('G13 conclude_appointment continua funcionando e passa na verificação do COMMIT', 'ok', v_user,
    format($q$ select conclude_appointment(%L, 100, 'pix') @@ set constraints all immediate $q$, a1),
    null,
    format($q$ select 1 / (case when (select count(*) from payments where appointment_id = %L and source = 'manual') = 1
              and (select status from appointments where id = %L) = 'concluido' then 1 else 0 end) $q$, a1, a1)) || nl;
  r := r || pg_temp.t('G14 conclude_appointment repetido continua recusado (22023), sem 2º recebimento', 'fail:22023', v_user,
    format($q$ select conclude_appointment(%L, 100, 'pix') @@ select conclude_appointment(%L, 100, 'pix') $q$, a1, a1)) || nl;
  r := r || pg_temp.t('G15 delete_appointment continua funcionando e passa na verificação do COMMIT', 'ok', v_user,
    format($q$ select delete_appointment(%L) @@ set constraints all immediate $q$, a1),
    s_auto_a1,
    format($q$ select 1 / (case when not exists (select 1 from appointments where id = %L)
              and not exists (select 1 from payments where appointment_id = %L) then 1 else 0 end) $q$, a1, a1)) || nl;

  -- ================================= I. invariante no COMMIT (qualquer papel)
  r := r || pg_temp.t('I1 dono do banco: concluir sem recebimento falha no COMMIT', 'fail:23514', null,
    format($q$ update appointments set status = 'concluido' where id = %L @@ set constraints all immediate $q$, a_fut)) || nl;
  r := r || pg_temp.t('I2 owner: apagar o recebimento de um concluído (Receitas > Excluir) falha no COMMIT', 'fail:23514', v_user,
    format($q$ delete from payments where appointment_id = %L @@ set constraints all immediate $q$, a1), s_auto_a1) || nl;
  r := r || pg_temp.t('I3 owner: criar recebimento para atendimento em aberto falha no COMMIT', 'fail:23514', v_user,
    format($q$ insert into payments (company_id, appointment_id, client_id, amount, method, status)
              values (%L, %L, %L, 100, 'pix', 'pago') @@ set constraints all immediate $q$, v_A, a_fut, c_A)) || nl;
  r := r || pg_temp.t('I4 owner: desvincular o recebimento de um concluído falha no COMMIT', 'fail:23514', v_user,
    format($q$ update payments set appointment_id = null where appointment_id = %L @@ set constraints all immediate $q$, a1),
    s_auto_a1) || nl;
  r := r || pg_temp.t('I5 owner: trocar a cliente do recebimento de um atendimento falha no COMMIT', 'fail:23514', v_user,
    format($q$ update payments set client_id = %L where appointment_id = %L @@ set constraints all immediate $q$, c_A2, a1),
    s_auto_a1) || nl;
  r := r || pg_temp.t('I6 owner: editar valor/descrição do recebimento (Receitas > Editar) continua permitido e fica marcado', 'ok', v_user,
    format($q$ update payments set amount = 90, description = 'desconto' where appointment_id = %L @@ set constraints all immediate $q$, a1),
    s_auto_a1,
    format($q$ select 1 / (case when (select amount = 90 and modified_at is not null from payments where appointment_id = %L)
              then 1 else 0 end) $q$, a1)) || nl;

  -- ============================================== P. recebido -> pendente
  r := r || pg_temp.t('P1 owner marca pendente: MESMO recebimento, pendente, valor pago 0, sem data de pagamento', 'ok', v_user,
    format($q$ select mark_appointment_payment_pending(%L) $q$, a1),
    s_auto_a1 || format($q$ @@ create temp table zz_pid on commit drop as select id from payments where appointment_id = %L $q$, a1),
    format($q$ select 1 / (case when (select count(*) from payments where appointment_id = %L) = 1
              and (select status = 'pendente' and paid_amount = 0 and paid_at is null and id = (select id from zz_pid)
                   from payments where appointment_id = %L) then 1 else 0 end) $q$, a1, a1)) || nl;
  r := r || pg_temp.t('P2 repetir "marcar pendente" é inofensivo (changed=false, 1 recebimento)', 'ok', v_user,
    format($q$ select mark_appointment_payment_pending(%L)
              @@ select 1 / (case when (mark_appointment_payment_pending(%L) ->> 'changed')::boolean = false then 1 else 0 end)
              @@ set constraints all immediate $q$, a1, a1),
    s_auto_a1,
    format($q$ select 1 / (case when (select count(*) from payments where appointment_id = %L) = 1 then 1 else 0 end) $q$, a1)) || nl;
  r := r || pg_temp.t('P3 pendente -> recebido de novo (RPC 0012) atualiza o MESMO recebimento', 'ok', v_user,
    format($q$ select mark_appointment_payment_pending(%L) @@ select update_appointment_payment(%L, 'pix', true)
              @@ set constraints all immediate $q$, a1, a1),
    s_auto_a1,
    format($q$ select 1 / (case when (select count(*) from payments where appointment_id = %L) = 1
              and (select status = 'pago' and paid_amount = 100 and paid_at is not null from payments where appointment_id = %L)
              then 1 else 0 end) $q$, a1, a1)) || nl;
  r := r || pg_temp.t('P4 recebimento parcial NÃO vira pendente (AUR03) — não apaga o que já entrou', 'fail:AUR03', v_user,
    format($q$ select mark_appointment_payment_pending(%L) $q$, a1), s_parcial_a1) || nl;
  r := r || pg_temp.t('P5 atendimento em aberto: marcar pendente é recusado (22023)', 'fail:22023', v_user,
    format($q$ select mark_appointment_payment_pending(%L) $q$, a_fut)) || nl;
  r := r || pg_temp.t('P6 concluído SEM recebimento (legado): marcar pendente é recusado e nada muda', 'fail:P0002', v_user,
    format($q$ select mark_appointment_payment_pending(%L) $q$, a1), s_legacy_a1) || nl;
  r := r || pg_temp.t('P7 profissional dona marca pendente (não lê payments por RLS, a RPC permite)', 'ok', v_user,
    format($q$ select mark_appointment_payment_pending(%L) $q$, a1),
    s_auto_a1 || format($q$ @@ update company_members set role = 'professional' where id = %L $q$, v_mem),
    format($q$ select 1 / (case when (select status from payments where appointment_id = %L) = 'pendente' then 1 else 0 end) $q$, a1)) || nl;
  r := r || pg_temp.t('P8 recepção NÃO marca pendente', 'fail:42501', v_user,
    format($q$ select mark_appointment_payment_pending(%L) $q$, a1),
    s_auto_a1 || format($q$ @@ update company_members set role = 'reception' where id = %L $q$, v_mem)) || nl;
  if v_other is not null then
    r := r || pg_temp.t('P9 profissional NÃO marca pendente no atendimento de outra profissional', 'fail:42501', v_user,
      format($q$ select mark_appointment_payment_pending(%L) $q$, a_o),
      s_auto_ao || format($q$ @@ update company_members set role = 'professional' where id = %L $q$, v_mem)) || nl;
  else
    r := r || 'INFO P9 (pulado: só existe 1 usuário no banco)' || nl;
  end if;
  r := r || pg_temp.t('P10 isolamento: membro inativo NÃO marca pendente em outra empresa (P0002)', 'fail:P0002', v_user,
    format($q$ select mark_appointment_payment_pending(%L) $q$, a_B), s_auto_aB) || nl;
  r := r || pg_temp.t('P11 sem login (anon) NÃO executa', 'fail:42501', null,
    format($q$ set local role anon @@ select mark_appointment_payment_pending(%L) $q$, a1), s_auto_a1) || nl;
  r := r || pg_temp.t('P12 Financeiro após pendente: faturado 100, recebido 0, pendente 100, resultado 0', 'ok', v_user,
    format($q$ select mark_appointment_payment_pending(%L) $q$, a1),
    s_auto_a1,
    format($q$ select 1 / (case when %s = 100 and %s = 0 and %s = 100 and %s = 0 then 1 else 0 end) $q$,
      format(s_ind, 'faturado'), format(s_ind, 'recebido'), format(s_ind, 'pendente'), format(s_ind, 'resultado_caixa'))) || nl;
  r := r || pg_temp.t('P13 Financeiro após voltar a recebido: faturado 100, recebido 100, pendente 0', 'ok', v_user,
    format($q$ select mark_appointment_payment_pending(%L) @@ select update_appointment_payment(%L, 'pix', true) $q$, a1, a1),
    s_auto_a1,
    format($q$ select 1 / (case when %s = 100 and %s = 100 and %s = 0 then 1 else 0 end) $q$,
      format(s_ind, 'faturado'), format(s_ind, 'recebido'), format(s_ind, 'pendente'))) || nl;
  r := r || pg_temp.t('P14 lista de pendências (Dashboard/Financeiro/Receitas?status=pendente) passa a mostrar o recebimento', 'ok', v_user,
    format($q$ select mark_appointment_payment_pending(%L) $q$, a1),
    s_auto_a1,
    format($q$ select 1 / (case when exists (select 1 from payments where company_id = %L and appointment_id = %L
              and status in ('pendente','parcial')) then 1 else 0 end) $q$, v_A, a1)) || nl;

  -- ========================================= R. reclassificar como falta
  r := r || pg_temp.t('R1 automático intacto -> não compareceu: recebimento removido, datas limpas', 'ok', v_user,
    format($q$ select reclassify_appointment_as_no_show(%L) @@ set constraints all immediate $q$, a1),
    s_auto_a1,
    format($q$ select 1 / (case when not exists (select 1 from payments where appointment_id = %L)
              and (select status = 'nao_compareceu' and completed_at is null and payment_method is null
                   from appointments where id = %L) then 1 else 0 end) $q$, a1, a1)) || nl;
  r := r || pg_temp.t('R2 auditoria: audit_logs guarda o recebimento removido e quem removeu; histórico com nota', 'ok', v_user,
    format($q$ select reclassify_appointment_as_no_show(%L) $q$, a1),
    s_auto_a1,
    format($q$ select 1 / (case when exists (select 1 from audit_logs where entity = 'payments' and action = 'delete'
                 and user_id = %L and metadata->'before'->>'appointment_id' = %L
                 and (metadata->'before'->>'amount')::numeric = 100 and metadata->'before'->>'source' = 'auto')
              and exists (select 1 from appointment_status_history where appointment_id = %L
                 and status = 'nao_compareceu' and changed_by = %L and note like 'Reclassificado de concluído (automático)%%')
              then 1 else 0 end) $q$, v_user, a1, a1, v_user)) || nl;
  r := r || pg_temp.t('R3 Financeiro: faturado/recebido do dia voltam a 0; realizados 0; faltas 1', 'ok', v_user,
    format($q$ select reclassify_appointment_as_no_show(%L) $q$, a1),
    s_auto_a1,
    format($q$ select 1 / (case when %s = 0 and %s = 0 and %s = 0 and %s = 1 then 1 else 0 end) $q$,
      format(s_ind, 'faturado'), format(s_ind, 'recebido'), format(s_ind, 'atendimentos_realizados'), format(s_ind, 'faltas'))) || nl;
  r := r || pg_temp.t('R4 cliente sem outra visita: primeira/última visita ficam vazias', 'ok', v_user,
    format($q$ select reclassify_appointment_as_no_show(%L) $q$, a1),
    s_auto_a1,
    format($q$ select 1 / (case when (select first_visit_at is null and last_visit_at is null from clients where id = %L)
              then 1 else 0 end) $q$, c_A)) || nl;
  r := r || pg_temp.t('R5 cliente com visita anterior: última visita volta para a anterior', 'ok', v_user,
    format($q$ select reclassify_appointment_as_no_show(%L) @@ set constraints all immediate $q$, a1),
    s_prev || '@@' || s_auto_a1,
    format($q$ select 1 / (case when (select first_visit_at = %L::date and last_visit_at = %L::date from clients where id = %L)
              and (select count(*) from payments where appointment_id = %L) = 1 then 1 else 0 end) $q$,
      d_prev, d_prev, c_A, a_prev)) || nl;
  r := r || pg_temp.t('R6 repetir a reclassificação é recusado (22023) e nada muda', 'fail:22023', v_user,
    format($q$ select reclassify_appointment_as_no_show(%L) @@ select reclassify_appointment_as_no_show(%L) $q$, a1, a1),
    s_auto_a1) || nl;
  r := r || pg_temp.t('R7 recebimento MANUAL: reclassificação recusada (AUR01)', 'fail:AUR01', v_user,
    format($q$ select reclassify_appointment_as_no_show(%L) $q$, a1), s_manual_a1) || nl;
  r := r || pg_temp.t('R8 automático ALTERADO (forma trocada): recusada (AUR02)', 'fail:AUR02', v_user,
    format($q$ select update_appointment_payment(%L, 'dinheiro') @@ select reclassify_appointment_as_no_show(%L) $q$, a1, a1),
    s_auto_a1) || nl;
  r := r || pg_temp.t('R9 automático marcado como PENDENTE: recusada (AUR02)', 'fail:AUR02', v_user,
    format($q$ select mark_appointment_payment_pending(%L) @@ select reclassify_appointment_as_no_show(%L) $q$, a1, a1),
    s_auto_a1) || nl;
  r := r || pg_temp.t('R10 concluído SEM recebimento (legado, como o de R$ 90): recusada (AUR01)', 'fail:AUR01', v_user,
    format($q$ select reclassify_appointment_as_no_show(%L) $q$, a1), s_legacy_a1) || nl;
  r := r || pg_temp.t('R11 recebimento de regularização (backfill) intacto: reclassificação permitida', 'ok', v_user,
    format($q$ select reclassify_appointment_as_no_show(%L) @@ set constraints all immediate $q$, a1),
    s_back_a1,
    format($q$ select 1 / (case when not exists (select 1 from payments where appointment_id = %L)
              and exists (select 1 from appointment_status_history where appointment_id = %L
                          and note like 'Reclassificado de concluído (regularização)%%') then 1 else 0 end) $q$, a1, a1)) || nl;
  r := r || pg_temp.t('R12 recusas deixam tudo intacto (manual): recebimento e status preservados', 'ok', v_user,
    format($q$ do $d$ begin
                 begin
                   perform reclassify_appointment_as_no_show(%L);
                   raise exception 'NAO_RECUSOU';
                 exception when sqlstate 'AUR01' then null;
                 end;
               end $d$ $q$, a1),
    s_manual_a1,
    format($q$ select 1 / (case when (select count(*) from payments where appointment_id = %L and status = 'pago') = 1
              and (select status from appointments where id = %L) = 'concluido' then 1 else 0 end) $q$, a1, a1)) || nl;
  r := r || pg_temp.t('R13 profissional dona reclassifica o próprio atendimento', 'ok', v_user,
    format($q$ select reclassify_appointment_as_no_show(%L) $q$, a1),
    s_auto_a1 || format($q$ @@ update company_members set role = 'professional' where id = %L $q$, v_mem),
    format($q$ select 1 / (case when (select status from appointments where id = %L) = 'nao_compareceu' then 1 else 0 end) $q$, a1)) || nl;
  r := r || pg_temp.t('R14 recepção NÃO reclassifica', 'fail:42501', v_user,
    format($q$ select reclassify_appointment_as_no_show(%L) $q$, a1),
    s_auto_a1 || format($q$ @@ update company_members set role = 'reception' where id = %L $q$, v_mem)) || nl;
  if v_other is not null then
    r := r || pg_temp.t('R15 profissional NÃO reclassifica atendimento de outra profissional', 'fail:42501', v_user,
      format($q$ select reclassify_appointment_as_no_show(%L) $q$, a_o),
      s_auto_ao || format($q$ @@ update company_members set role = 'professional' where id = %L $q$, v_mem)) || nl;
  else
    r := r || 'INFO R15 (pulado: só existe 1 usuário no banco)' || nl;
  end if;
  r := r || pg_temp.t('R16 isolamento: membro inativo NÃO reclassifica em outra empresa (P0002)', 'fail:P0002', v_user,
    format($q$ select reclassify_appointment_as_no_show(%L) $q$, a_B), s_auto_aB) || nl;
  r := r || pg_temp.t('R17 sem login (anon) NÃO executa', 'fail:42501', null,
    format($q$ set local role anon @@ select reclassify_appointment_as_no_show(%L) $q$, a1), s_auto_a1) || nl;
  r := r || pg_temp.t('R18 falha no MEIO (depois de apagar o recebimento): tudo é desfeito', 'ok', v_user,
    format($q$ do $d$ begin
                 begin
                   perform reclassify_appointment_as_no_show(%L);
                   raise exception 'NAO_FALHOU';
                 exception when others then
                   if sqlerrm <> 'zz falha simulada' then raise exception 'erro inesperado: %%', sqlerrm; end if;
                 end;
               end $d$ $q$, a1),
    s_auto_a1 || $q$ @@ create function zz_boom() returns trigger language plpgsql as $b$ begin raise exception 'zz falha simulada'; end $b$
                  @@ create trigger zz_boom before insert on appointment_status_history for each row execute function zz_boom() $q$,
    format($q$ select 1 / (case when (select count(*) from payments where appointment_id = %L and source = 'auto' and status = 'pago') = 1
              and (select status from appointments where id = %L) = 'concluido'
              and (select last_visit_at from clients where id = %L) = %L::date then 1 else 0 end) $q$, a1, a1, c_A, d_day)) || nl;
  r := r || pg_temp.t('R19 depois da falta, o horário fica livre para outro agendamento', 'ok', v_user,
    format($q$ select reclassify_appointment_as_no_show(%L)
              @@ insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end)
                 select company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end
                 from appointments where id = %L $q$, a1, a1),
    s_auto_a1) || nl;

  -- ============================================= E. elegibilidade (tela)
  r := r || pg_temp.t('E1 elegibilidade: automático intacto = ok', 'ok', v_user,
    format($q$ select 1 / (case when get_appointment_no_show_eligibility(%L) ->> 'reason' = 'ok' then 1 else 0 end) $q$, a1),
    s_auto_a1) || nl;
  r := r || pg_temp.t('E2 elegibilidade: manual / alterado / em aberto / sem recebimento', 'ok', v_user,
    format($q$ select 1 / (case when get_appointment_no_show_eligibility(%L) ->> 'reason' = 'not_concluded' then 1 else 0 end) $q$, a_fut)
    || format($q$ @@ select 1 / (case when get_appointment_no_show_eligibility(%L) ->> 'reason' = 'manual' then 1 else 0 end) $q$, a_prev),
    s_prev) || nl;
  r := r || pg_temp.t('E3 elegibilidade: automático com forma trocada = modified', 'ok', v_user,
    format($q$ select update_appointment_payment(%L, 'dinheiro')
              @@ select 1 / (case when get_appointment_no_show_eligibility(%L) ->> 'reason' = 'modified' then 1 else 0 end) $q$, a1, a1),
    s_auto_a1) || nl;
  r := r || pg_temp.t('E4 elegibilidade: concluído sem recebimento (legado) = no_payment', 'ok', v_user,
    format($q$ select 1 / (case when get_appointment_no_show_eligibility(%L) ->> 'reason' = 'no_payment' then 1 else 0 end) $q$, a1),
    s_legacy_a1) || nl;
  r := r || pg_temp.t('E5 elegibilidade: outra empresa (membro inativo) = P0002', 'fail:P0002', v_user,
    format($q$ select get_appointment_no_show_eligibility(%L) $q$, a_B), s_auto_aB) || nl;

  v_fail := (length(r) - length(replace(r, 'FAIL ', ''))) / 5;

  raise exception E'\n=== RESULTADO 0014 (esta falha é intencional: desfaz os dados de teste) ===\n%\nLINHAS "FAIL": %\n', r, v_fail;
end
$do$;
