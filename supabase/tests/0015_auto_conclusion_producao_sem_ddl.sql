-- ============================================================================
-- TESTES — 0015 — VERSÃO PARA O SUPABASE DE PRODUÇÃO (SEM DDL EM TABELAS DE NEGÓCIO)
--
-- Gerado a partir de 0015_auto_conclusion_staging.sql, SEM os 6 testes que criam
-- gatilhos temporários na tabela payments (F1, F2, F3, F4, K2, R8). Esses 6 ficam
-- para staging/local. Todo o resto é idêntico e também é desfeito no fim.
-- Não edite à mão: altere o arquivo completo e gere de novo.
-- ============================================================================
-- ============================================================================
-- TESTES — 0015 (conclusão automática, regularização, ativação, reversão)
--
-- Nada persiste: o bloco DO termina com uma exceção INTENCIONAL que desfaz
-- tudo. O relatório vem na mensagem de erro. Esperado depois da 0015: ZERO FAIL.
--
-- Isolamento dos dados reais: todos os atendimentos de teste ficam em JUNHO DE
-- 2020 e as funções são chamadas com um "agora" de teste (p_now) em 2020. Os
-- dados reais (2026) ficam depois de qualquer corte usado aqui e nunca são
-- selecionados. Testes de ativação/regularização só rodam se a automação ainda
-- não tiver sido ativada (senão aparecem como INFO).
--
-- Alguns testes criam e removem gatilhos temporários (falha simulada) dentro
-- da transação desfeita: rode num horário sem uso.
-- Convenções iguais às da 0014: "@@" separa instruções; p_pre e p_post rodam
-- COMO DONO; testes negativos declaram o código esperado ('fail:XXXXX').
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
    -- Postgres não desfaz um SET CONSTRAINTS feito num sub-bloco que terminou
    -- bem dentro de outro que foi desfeito; cada teste recomeça no modo padrão.
    set constraints all deferred;
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
                     when p_expect = 'info' then '   -> executou sem erro' else '' end;
    when others then
      return rpad(case when p_expect = 'ok' then 'FAIL'
                       when p_expect = 'fail' then 'PASS'
                       when p_expect like 'fail:%' and sqlstate = substr(p_expect, 6) then 'PASS'
                       when p_expect like 'fail:%' then 'FAIL'
                       else 'INFO' end, 5)
             || p_name || '   -> ' || sqlstate || ': ' || sqlerrm;
  end;
end;
$fn$;

-- asserção com mensagem (usada por quem roda como dono)
create or replace function pg_temp.chk(p_ok boolean, p_msg text)
returns void language plpgsql as $$
begin
  if p_ok is distinct from true then
    raise exception 'ASSERÇÃO: %', p_msg using errcode = 'P0099';
  end if;
end $$;

create or replace function pg_temp.mk(
  p_id uuid, p_company uuid, p_client uuid, p_service uuid, p_member uuid,
  p_end timestamptz, p_minutes int, p_price numeric, p_status text, p_label text)
returns uuid language sql as $$
  insert into appointments (id, company_id, client_id, service_id, professional_member_id, price, status,
                            scheduled_start, scheduled_end, notes)
  values (p_id, p_company, p_client, p_service, p_member, p_price, p_status::appointment_status,
          p_end - make_interval(mins => p_minutes), p_end, p_label)
  returning id
$$;

do $do$
declare
  v_user uuid;
  v_A uuid; v_B uuid; v_mem uuid; v_memB uuid; v_svc uuid; v_svcB uuid; c_A uuid; c_A2 uuid; c_B uuid;
  -- "agora" de teste: 15/06/2020 12:00 em São Paulo; início da janela: 00:00 do mesmo dia
  T0 timestamptz := timestamptz '2020-06-15 12:00:00-03';
  PF timestamptz := timestamptz '2020-06-15 00:00:00-03';
  D1 timestamptz := timestamptz '2020-06-14 10:00:00-03';   -- um dia antes (regularização)
  x1 uuid := gen_random_uuid(); x2 uuid := gen_random_uuid(); x3 uuid := gen_random_uuid();
  x4 uuid := gen_random_uuid(); x5 uuid := gen_random_uuid(); x6 uuid := gen_random_uuid();
  run_now text; run_at text; rid text; s_fail text; s_kill text; s_hash text;
  v_active boolean;
  v_can_service_role boolean;
  v_fail int;
  r text := '';
  nl text := E'\n';
begin
  select id into v_user from auth.users order by created_at limit 1;
  if v_user is null then
    raise exception 'auth.users está vazio: crie ao menos um usuário.';
  end if;
  v_active := (select process_from is not null from aurea_private.settings where id);
  v_can_service_role := exists (select 1 from pg_roles where rolname = 'service_role')
                        and pg_has_role(current_user, 'service_role', 'MEMBER');

  -- ---------------------------------------------------------------- fixtures base
  insert into companies (name) values ('ZZ-TESTE-0015-A') returning id into v_A;
  insert into companies (name) values ('ZZ-TESTE-0015-B') returning id into v_B;
  insert into company_members (company_id, user_id, role) values (v_A, v_user, 'owner') returning id into v_mem;
  insert into company_members (company_id, user_id, role, active) values (v_B, v_user, 'owner', false) returning id into v_memB;
  insert into services (company_id, name, duration_minutes, price) values (v_A, 'ZZ servico A', 60, 100) returning id into v_svc;
  insert into services (company_id, name, duration_minutes, price) values (v_B, 'ZZ servico B', 60, 100) returning id into v_svcB;
  insert into clients (company_id, name) values (v_A, 'ZZ cliente A') returning id into c_A;
  insert into clients (company_id, name) values (v_A, 'ZZ cliente A2') returning id into c_A2;
  insert into clients (company_id, name) values (v_B, 'ZZ cliente B') returning id into c_B;

  -- atalhos: atendimento na empresa A (cliente A por padrão) ou na B
  execute format($f$
    create or replace function pg_temp.mka(p_id uuid, p_end timestamptz, p_min int default 60,
      p_price numeric default 100, p_status text default 'agendado', p_client uuid default %L, p_label text default null)
    returns uuid language sql as $b$ select pg_temp.mk(p_id, %L, p_client, %L, %L, p_end, p_min, p_price, p_status, p_label) $b$ $f$,
    c_A, v_A, v_svc, v_mem);
  execute format($f$
    create or replace function pg_temp.mkb(p_id uuid, p_end timestamptz, p_min int default 60,
      p_price numeric default 100, p_status text default 'agendado')
    returns uuid language sql as $b$ select pg_temp.mk(p_id, %L, %L, %L, %L, p_end, p_min, p_price, p_status, null) $b$ $f$,
    v_B, c_B, v_svcB, v_memB);

  run_now := format($q$ select aurea_private._run(%L::timestamptz, %L::timestamptz, null, true) $q$, T0, PF);
  run_at  := $q$ select aurea_private._run(%L::timestamptz, %L::timestamptz, null, true) $q$;  -- format(run_at, agora, inicio)
  rid     := $q$ (select run_id from aurea_private.run_items where appointment_id = %L and outcome = 'concluded') $q$;
  -- (sem testes de falha simulada nesta versão: nenhum gatilho temporário é criado)
  s_hash := $q$ (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from (
                   select to_jsonb(a)::text as t from appointments a where a.company_id in (%1$L, %2$L)
                   union all select to_jsonb(p)::text from payments p where p.company_id in (%1$L, %2$L)
                   union all select to_jsonb(c)::text from clients c where c.company_id in (%1$L, %2$L)) z) $q$;
  s_hash := format(s_hash, v_A, v_B);

  -- ============================================================ P. privilégios
  r := r || pg_temp.t('P1 funções privadas: SECURITY INVOKER, search_path fixo, dono não é papel da API', 'ok', null,
    $q$ select pg_temp.chk(count(*) >= 10 and bool_and(not p.prosecdef)
                           and bool_and(exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
                           and bool_and(pg_get_userbyid(p.proowner) not in ('anon','authenticated','service_role')),
                           'alguma função privada é DEFINER, sem search_path ou com dono indevido')
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'aurea_private' $q$) || nl;
  r := r || pg_temp.t('P2 nenhuma função privada é executável por PUBLIC/anon/authenticated/service_role', 'ok', null,
    $q$ select pg_temp.chk(not exists (
          select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          cross join (select unnest(array['anon','authenticated','service_role']) as rl) x
          where n.nspname = 'aurea_private'
            and exists (select 1 from pg_roles where rolname = x.rl)
            and has_function_privilege(x.rl, p.oid, 'execute'))
        and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
                        aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e
                        where n.nspname = 'aurea_private' and e.grantee = 0 and e.privilege_type = 'EXECUTE'),
        'alguma função privada é executável pela API ou por PUBLIC') $q$) || nl;
  r := r || pg_temp.t('P3 schema e tabelas privados: sem USAGE nem acesso a tabelas para os papéis da API; RLS ligada', 'ok', null,
    $q$ select pg_temp.chk(
          not exists (select 1 from unnest(array['anon','authenticated','service_role']) rl
                      where exists (select 1 from pg_roles where rolname = rl)
                        and (has_schema_privilege(rl, 'aurea_private', 'usage')
                             or exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                                         where n.nspname = 'aurea_private' and c.relkind = 'r'
                                           and has_table_privilege(rl, c.oid, 'select,insert,update,delete'))))
          and (select bool_and(rowsecurity) from pg_tables where schemaname = 'aurea_private')
          and (select count(*) from pg_tables where schemaname = 'aurea_private') = 4,
        'schema/tabelas privados acessíveis ou sem RLS') $q$) || nl;
  r := r || pg_temp.t('P4 anon NÃO executa run_auto_conclusion (permissão negada no schema privado)', 'ok', null,
    $q$ do $d$ begin
         begin
           set local role anon;
           perform aurea_private.run_auto_conclusion();
           raise exception 'EXECUTOU';
         exception when insufficient_privilege then
           if sqlerrm not like '%aurea_private%' then raise exception 'outro erro: %', sqlerrm; end if;
         end;
       end $d$ $q$) || nl;
  r := r || pg_temp.t('P5 authenticated NÃO executa _run, regularize, activate, revert, set_enabled', 'ok', null,
    $q$ do $d$ declare f text; begin
         foreach f in array array[
           'select aurea_private._run(now(), null, null, true)',
           'select aurea_private.regularize(null, null, true, null)',
           'select aurea_private.activate_auto_conclusion(gen_random_uuid(), null)',
           'select aurea_private.revert_run(gen_random_uuid(), true)',
           'select aurea_private.set_auto_conclusion_enabled(false)'] loop
           begin
             set local role authenticated;
             execute f;
             raise exception 'EXECUTOU: %', f;
           exception when insufficient_privilege then
             if sqlerrm not like '%aurea_private%' then raise exception 'outro erro em %: %', f, sqlerrm; end if;
           end;
         end loop;
       end $d$ $q$) || nl;
  if v_can_service_role then
    r := r || pg_temp.t('P6 service_role NÃO executa run_auto_conclusion', 'ok', null,
      $q$ do $d$ begin
           begin
             set local role service_role;
             perform aurea_private.run_auto_conclusion();
             raise exception 'EXECUTOU';
           exception when insufficient_privilege then
             if sqlerrm not like '%aurea_private%' then raise exception 'outro erro: %', sqlerrm; end if;
           end;
         end $d$ $q$) || nl;
  else
    r := r || 'INFO P6 (pulado: esta sessão não pode assumir service_role; coberto por P2)' || nl;
  end if;
  r := r || pg_temp.t('P7 proteções da 0014 intactas (5 gatilhos ativos, funções presentes)', 'ok', null,
    $q$ select pg_temp.chk((select count(*) from pg_trigger where tgenabled = 'O' and tgname in (
          'trg_payments_track_origin','trg_appointments_guard_lifecycle','trg_appointments_payment_consistency_ins',
          'trg_appointments_payment_consistency_upd','trg_payments_appointment_consistency')) = 5
          and (select count(*) from pg_proc where proname in ('mark_appointment_payment_pending',
               'reclassify_appointment_as_no_show','get_appointment_no_show_eligibility')) = 3,
        '0014 alterada') $q$) || nl;
  r := r || pg_temp.t('P8 chave geral: run_auto_conclusion não faz nada enquanto desligada', 'ok', null,
    $q$ select pg_temp.chk(
          (select enabled from aurea_private.settings) = true
          or ((aurea_private.run_auto_conclusion() ->> 'status') = 'disabled'
              and not exists (select 1 from aurea_private.runs where kind = 'scheduled' and started_at = now())),
        'rodou com a chave desligada') $q$) || nl;

  -- ================================================== A. seleção e tolerância
  r := r || pg_temp.t('A1 tolerância: fim há EXATAMENTE 5 min entra; há 4 min 59 s não entra', 'ok', null,
    run_now,
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '5 minutes', 30)
              @@ select pg_temp.mkb(%L, %L::timestamptz - interval '4 minutes 59 seconds', 30) $q$, x1, T0, x2, T0),
    format($q$ select pg_temp.chk((select status from appointments where id = %L) = 'concluido', 'x1 deveria estar concluído')
              @@ select pg_temp.chk((select status from appointments where id = %L) = 'agendado', 'x2 não deveria')
              @@ select pg_temp.chk(not exists (select 1 from payments where appointment_id = %L), 'x2 sem pagamento') $q$,
      x1, x2, x2)) || nl;
  r := r || pg_temp.t('A2 nunca seleciona cancelado, falta ou futuro', 'ok', null,
    run_now,
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '3 hours', 60, 100, 'cancelado')
              @@ select pg_temp.mka(%L, %L::timestamptz - interval '2 hours', 60, 100, 'nao_compareceu')
              @@ select pg_temp.mka(%L, %L::timestamptz + interval '2 hours', 60) $q$, x1, T0, x2, T0, x3, T0),
    format($q$ select pg_temp.chk((select array_agg(status::text order by scheduled_end) from appointments where id in (%L, %L, %L))
                                  = array['cancelado','nao_compareceu','agendado'], 'status mudou')
              @@ select pg_temp.chk(not exists (select 1 from payments where appointment_id in (%L, %L, %L)), 'criou pagamento') $q$,
      x1, x2, x3, x1, x2, x3)) || nl;
  r := r || pg_temp.t('A3 confirmado e em_atendimento também são concluídos', 'ok', null,
    run_now,
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '3 hours', 60, 100, 'confirmado')
              @@ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60, 100, 'em_atendimento') $q$, x1, T0, x2, T0),
    format($q$ select pg_temp.chk((select count(*) from appointments where id in (%L, %L) and status = 'concluido') = 2, 'não concluiu') $q$, x1, x2)) || nl;
  r := r || pg_temp.t('A4 preço 0: não conclui e registra anomalia "price" uma única vez', 'ok', null,
    run_now || '@@' || run_now,
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60, 0) $q$, x1, T0),
    format($q$ select pg_temp.chk((select status from appointments where id = %L) = 'agendado', 'concluiu preço 0')
              @@ select pg_temp.chk((select status = 'anomaly' and reason = 'price' from aurea_private.appointment_state where appointment_id = %L), 'sem anomalia') $q$, x1, x1)) || nl;
  r := r || pg_temp.t('A5 aberto COM pagamento: não conclui, não cria 2º pagamento, não altera o existente', 'ok', null,
    -- janela só com este atendimento (a invariante dele já está violada de propósito)
    run_now,
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60, 100)
              @@ insert into payments (company_id, appointment_id, client_id, amount, method, status) values (%L, %L, %L, 100, 'dinheiro', 'pendente') $q$,
      x1, T0, v_A, x1, c_A),
    format($q$ select pg_temp.chk((select count(*) from payments where appointment_id = %L and method = 'dinheiro' and status = 'pendente' and modified_at is null) = 1, 'pagamento alterado/duplicado')
              @@ select pg_temp.chk((select status from appointments where id = %L) = 'agendado', 'concluiu')
              @@ select pg_temp.chk((select reason from aurea_private.appointment_state where appointment_id = %L) = 'has_payment', 'sem anomalia') $q$, x1, x1, x1)) || nl;
  r := r || pg_temp.t('A6 cancelado e REABERTO: nunca concluído (histórico + auditoria)', 'ok', null,
    run_now,
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60)
              @@ update appointments set status = 'cancelado' where id = %L
              @@ update appointments set status = 'agendado' where id = %L $q$, x1, T0, x1, x1),
    format($q$ select pg_temp.chk((select status from appointments where id = %L) = 'agendado', 'concluiu um reaberto')
              @@ select pg_temp.chk((select reason from aurea_private.appointment_state where appointment_id = %L) = 'history_cancel_or_no_show', 'motivo') $q$, x1, x1)) || nl;
  r := r || pg_temp.t('A7 falta e REABERTO, só a AUDITORIA como evidência (histórico removido): nunca concluído', 'ok', null,
    run_now,
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60, 100, 'nao_compareceu')
              @@ update appointments set status = 'agendado' where id = %L
              @@ delete from appointment_status_history where appointment_id = %L $q$, x1, T0, x1, x1),
    format($q$ select pg_temp.chk((select status from appointments where id = %L) = 'agendado', 'concluiu') $q$, x1)) || nl;
  r := r || pg_temp.t('A8 cancelado e REABERTO, só o HISTÓRICO como evidência (auditoria removida): nunca concluído', 'ok', null,
    run_now,
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60)
              @@ update appointments set status = 'cancelado' where id = %L
              @@ update appointments set status = 'agendado' where id = %L
              @@ delete from audit_logs where entity = 'appointments' and entity_id = %L $q$, x1, T0, x1, x1, x1),
    format($q$ select pg_temp.chk((select status from appointments where id = %L) = 'agendado', 'concluiu') $q$, x1)) || nl;
  r := r || pg_temp.t('A9 fim ANTES de process_from: nunca concluído nem marcado', 'ok', null,
    run_now,
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 second', 60) $q$, x1, PF),
    format($q$ select pg_temp.chk((select status from appointments where id = %L) = 'agendado', 'concluiu fora da janela')
              @@ select pg_temp.chk(not exists (select 1 from aurea_private.appointment_state where appointment_id = %L), 'marcou') $q$, x1, x1)) || nl;
  r := r || pg_temp.t('A10 atendimento excluído/bloqueado no controle: nunca concluído', 'ok', null,
    run_now,
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60)
              @@ select pg_temp.mka(%L, %L::timestamptz - interval '3 hours', 60)
              @@ insert into aurea_private.appointment_state (appointment_id, company_id, status, reason) values (%L, %L, 'excluded', 'reverted'), (%L, %L, 'blocked', 'error') $q$,
      x1, T0, x2, T0, x1, v_A, x2, v_A),
    format($q$ select pg_temp.chk((select count(*) from appointments where id in (%L, %L) and status = 'agendado') = 2, 'concluiu') $q$, x1, x2)) || nl;

  -- ====================================================== B. o que é gravado
  r := r || pg_temp.t('B1 atendimento: concluído, Pix, completed_at = término previsto', 'ok', null,
    run_now, format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60, 120) $q$, x1, T0),
    format($q$ select pg_temp.chk((select status = 'concluido' and payment_method = 'pix' and completed_at = scheduled_end from appointments where id = %L), 'campos') $q$, x1)) || nl;
  r := r || pg_temp.t('B2 recebimento: um só, pago, Pix, valor do atendimento, datas = término, origem auto', 'ok', null,
    run_now, format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60, 120) $q$, x1, T0),
    format($q$ select pg_temp.chk((select count(*) = 1 and bool_and(p.status = 'pago' and p.method = 'pix' and p.amount = 120 and p.paid_amount = 120
                 and p.paid_at = a.scheduled_end and p.created_at = a.scheduled_end and p.source = 'auto' and p.modified_at is null
                 and p.company_id = a.company_id and p.client_id = a.client_id)
              from payments p join appointments a on a.id = p.appointment_id where p.appointment_id = %L), 'pagamento') $q$, x1)) || nl;
  r := r || pg_temp.t('B3 visitas da cliente: primeira recua, última NÃO regride', 'ok', null,
    run_now,
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60)
              @@ update clients set first_visit_at = date '2020-06-20', last_visit_at = date '2020-06-25' where id = %L $q$, x1, T0, c_A),
    format($q$ select pg_temp.chk((select first_visit_at = date '2020-06-15' and last_visit_at = date '2020-06-25' from clients where id = %L), 'visitas') $q$, c_A)) || nl;
  r := r || pg_temp.t('B4 auditoria: histórico com nota, audit_logs do atendimento e do recebimento', 'ok', null,
    run_now, format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0),
    format($q$ select pg_temp.chk(exists (select 1 from appointment_status_history where appointment_id = %L and status = 'concluido' and note like 'Concluído automaticamente%%'), 'nota')
              @@ select pg_temp.chk(exists (select 1 from audit_logs where entity = 'appointments' and entity_id = %L and action = 'update' and metadata->'after'->>'status' = 'concluido'), 'audit atendimento')
              @@ select pg_temp.chk(exists (select 1 from audit_logs l join payments p on p.id = l.entity_id where l.entity = 'payments' and l.action = 'insert' and p.appointment_id = %L), 'audit pagamento') $q$, x1, x1, x1)) || nl;
  r := r || pg_temp.t('B5 log: execução ok com contagens; item com foto completa; batimento atualizado', 'ok', null,
    run_now, format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0),
    format($q$ select pg_temp.chk((select status = 'ok' and concluded = 1 and failed = 0 and total_amount = 100 from aurea_private.runs where id = %s), 'run')
              @@ select pg_temp.chk((select after_appt is not null and after_payment is not null and n_audit_appt > 0 and n_audit_payment > 0 and n_history > 0
                                            and before_status = 'agendado' from aurea_private.run_items where appointment_id = %L and outcome = 'concluded'), 'foto')
              @@ select pg_temp.chk((select last_run_status = 'ok' from aurea_private.settings), 'batimento') $q$, format(rid, x1), x1)) || nl;

  -- ======================================== C. integração com a 0014 (correções)
  r := r || pg_temp.t('C1 depois da automação, a API NÃO cancela/reabre/apaga o atendimento (22023)', 'fail:22023', v_user,
    format($q$ update appointments set status = 'cancelado' where id = %L $q$, x1),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0) || '@@' || run_now) || nl;
  r := r || pg_temp.t('C2 trocar a forma: MESMO recebimento, marcado como alterado', 'ok', v_user,
    format($q$ select update_appointment_payment(%L, 'dinheiro') $q$, x1),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0) || '@@' || run_now,
    format($q$ select pg_temp.chk((select count(*) = 1 and bool_and(method = 'dinheiro' and source = 'auto' and modified_at is not null) from payments where appointment_id = %L), 'forma') $q$, x1)) || nl;
  r := r || pg_temp.t('C3 pendente e depois recebido: sempre o MESMO recebimento', 'ok', v_user,
    format($q$ select mark_appointment_payment_pending(%L) @@ select update_appointment_payment(%L, 'pix', true) $q$, x1, x1),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0) || '@@' || run_now
      || format($q$ @@ create temp table zz_pid on commit drop as select id from payments where appointment_id = %L $q$, x1),
    format($q$ select pg_temp.chk((select count(*) = 1 and bool_and(status = 'pago' and id = (select id from zz_pid)) from payments where appointment_id = %L), 'mesmo pagamento') $q$, x1)) || nl;
  r := r || pg_temp.t('C4 "Cliente não compareceu" funciona; a automação NÃO reconclui depois', 'ok', v_user,
    format($q$ select 1 / (case when get_appointment_no_show_eligibility(%L) ->> 'reason' = 'ok' then 1 else 0 end)
              @@ select reclassify_appointment_as_no_show(%L) $q$, x1, x1),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0) || '@@' || run_now,
    format(run_at, T0 + interval '1 hour', PF)
      || format($q$ @@ select pg_temp.chk((select status from appointments where id = %L) = 'nao_compareceu' and not exists (select 1 from payments where appointment_id = %L), 'reconcluiu') $q$, x1, x1)) || nl;
  r := r || pg_temp.t('C5 falta DEPOIS de trocar a forma é recusada (AUR02, regra da 0014)', 'fail:AUR02', v_user,
    format($q$ select update_appointment_payment(%L, 'dinheiro') @@ select reclassify_appointment_as_no_show(%L) $q$, x1, x1),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0) || '@@' || run_now) || nl;
  r := r || pg_temp.t('C6 apagar o recebimento automático pela tela de Receitas: recusado no COMMIT (23514)', 'fail:23514', v_user,
    format($q$ delete from payments where appointment_id = %L @@ set constraints all immediate $q$, x1),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0) || '@@' || run_now) || nl;
  r := r || pg_temp.t('C7 "Excluir atendimento" (owner) continua funcionando', 'ok', v_user,
    format($q$ select delete_appointment(%L) @@ set constraints all immediate $q$, x1),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0) || '@@' || run_now,
    format($q$ select pg_temp.chk(not exists (select 1 from appointments where id = %L) and not exists (select 1 from payments where appointment_id = %L), 'não excluiu') $q$, x1, x1)) || nl;
  r := r || pg_temp.t('C8 a API não troca a origem auto do recebimento', 'ok', v_user,
    format($q$ update payments set source = 'manual' where appointment_id = %L $q$, x1),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0) || '@@' || run_now,
    format($q$ select pg_temp.chk((select source from payments where appointment_id = %L) = 'auto', 'origem mudou') $q$, x1)) || nl;
  r := r || pg_temp.t('C9 profissional dona corrige o recebimento automático (marca pendente)', 'ok', v_user,
    format($q$ select mark_appointment_payment_pending(%L) $q$, x1),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0) || '@@' || run_now
      || format($q$ @@ update company_members set role = 'professional' where id = %L $q$, v_mem),
    format($q$ select pg_temp.chk((select status from payments where appointment_id = %L) = 'pendente', 'não marcou') $q$, x1)) || nl;
  r := r || pg_temp.t('C10 isolamento: membro inativo NÃO corrige recebimento automático de outra empresa (P0002)', 'fail:P0002', v_user,
    format($q$ select mark_appointment_payment_pending(%L) $q$, x1),
    format($q$ select pg_temp.mkb(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0) || '@@' || run_now) || nl;

  -- ============================================ D. idempotência e duplicidade
  r := r || pg_temp.t('D1 segunda execução não altera nada (1 recebimento, 1 item concluído)', 'ok', null,
    run_now || '@@' || run_now || '@@' || format(run_at, T0 + interval '1 day', PF),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0),
    format($q$ select pg_temp.chk((select count(*) from payments where appointment_id = %L) = 1, 'duplicou')
              @@ select pg_temp.chk((select count(*) from aurea_private.run_items where appointment_id = %L and outcome = 'concluded') = 1, 'item duplicado') $q$, x1, x1)) || nl;
  r := r || pg_temp.t('D2 concluído à mão antes: a automação não toca (origem manual preservada)', 'ok', null,
    run_now,
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60)
              @@ select set_config('request.jwt.claim.sub', %L, true)
              @@ select conclude_appointment(%L, 90, 'dinheiro', 'pendente')
              @@ select set_config('request.jwt.claim.sub', '', true) $q$, x1, T0, v_user, x1),
    format($q$ select pg_temp.chk((select count(*) = 1 and bool_and(source = 'manual' and amount = 90 and method = 'dinheiro' and status = 'pendente') from payments where appointment_id = %L), 'tocou') $q$, x1)) || nl;
  r := r || pg_temp.t('D3 núcleo chamado de novo sobre concluído: recusa por status, sem mudança', 'ok', null,
    run_now || format($q$ @@ select pg_temp.chk(aurea_private._conclude_one(%L, gen_random_uuid(), 'auto', %L, %L, false) = 'status', 'motivo') $q$, x1, T0, PF),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0),
    format($q$ select pg_temp.chk((select count(*) from payments where appointment_id = %L) = 1, 'duplicou') $q$, x1)) || nl;
  r := r || pg_temp.t('D4 o índice impede uma 2ª conclusão registrada para o mesmo atendimento (23505)', 'fail:23505', null,
    format($q$ with nr as (insert into aurea_private.runs (kind, now_ref) values ('scheduled', now()) returning id)
              insert into aurea_private.run_items (run_id, appointment_id, company_id, outcome) select id, %L, %L, 'concluded' from nr $q$, x1, v_A),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0) || '@@' || run_now) || nl;
  r := r || pg_temp.t('D5 lote: 5 pendentes com lote 3 -> 3, depois 2, depois 0; nunca 2 pagamentos', 'ok', null,
    format($q$ select pg_temp.chk((aurea_private._run(%1$L, %2$L, 3, true) ->> 'concluded')::int = 3, 'lote 1')
              @@ select pg_temp.chk((aurea_private._run(%1$L, %2$L, 3, true) ->> 'concluded')::int = 2, 'lote 2')
              @@ select pg_temp.chk((aurea_private._run(%1$L, %2$L, 3, true) ->> 'status') = 'idle', 'lote 3') $q$, T0, PF),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '5 hours', 30) @@ select pg_temp.mka(%L, %L::timestamptz - interval '4 hours', 30)
              @@ select pg_temp.mka(%L, %L::timestamptz - interval '3 hours', 30) @@ select pg_temp.mka(%L, %L::timestamptz - interval '2 hours', 30)
              @@ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 30) $q$, x1, T0, x2, T0, x3, T0, x4, T0, x5, T0),
    format($q$ select pg_temp.chk(not exists (select 1 from payments where appointment_id in (%L,%L,%L,%L,%L) group by appointment_id having count(*) > 1)
                                  and (select count(*) from payments where appointment_id in (%L,%L,%L,%L,%L)) = 5, 'duplicidade') $q$,
      x1, x2, x3, x4, x5, x1, x2, x3, x4, x5)) || nl;

  -- ================================================================ F. falhas
  -- ========================================================= G. recuperação
  r := r || pg_temp.t('G1 pausa de 3 dias: tudo recuperado numa execução, cada um no SEU dia', 'ok', null,
    format(run_at, T0, PF - interval '3 days'),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '3 days' + interval '11 hours', 60, 10)
              @@ select pg_temp.mka(%L, %L::timestamptz - interval '2 days' + interval '11 hours', 60, 20)
              @@ select pg_temp.mka(%L, %L::timestamptz - interval '1 day' + interval '11 hours', 60, 30) $q$, x1, PF, x2, PF, x3, PF),
    format($q$ select pg_temp.chk((select recebido from get_period_indicators(%1$L, date '2020-06-12', date '2020-06-12')) = 10
                                  and (select recebido from get_period_indicators(%1$L, date '2020-06-13', date '2020-06-13')) = 20
                                  and (select recebido from get_period_indicators(%1$L, date '2020-06-14', date '2020-06-14')) = 30, 'dias errados') $q$, v_A)) || nl;

  -- ================================================== K. isolamento entre empresas
  r := r || pg_temp.t('K1 empresas A e B na mesma execução: cada recebimento com a empresa/cliente do atendimento', 'ok', null,
    run_now,
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) @@ select pg_temp.mkb(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0, x2, T0),
    format($q$ select pg_temp.chk((select count(*) from payments p join appointments a on a.id = p.appointment_id
                                   where p.appointment_id in (%L, %L) and p.company_id = a.company_id and p.client_id = a.client_id) = 2, 'cruzou empresas') $q$, x1, x2)) || nl;
  -- ======================================================== L. Financeiro e fuso
  r := r || pg_temp.t('L1 Financeiro do dia: faturado e recebido +100, realizados +1', 'ok', null,
    run_now, format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0),
    format($q$ select pg_temp.chk((select faturado = 100 and recebido = 100 and atendimentos_realizados = 1 from get_period_indicators(%L, date '2020-06-15', date '2020-06-15')), 'indicadores') $q$, v_A)) || nl;
  r := r || pg_temp.t('L2 termina 23:58 e é processado 00:03 do dia seguinte: conta no dia do atendimento', 'ok', null,
    format(run_at, timestamptz '2020-06-16 00:03:00-03', PF),
    format($q$ select pg_temp.mka(%L, timestamptz '2020-06-15 23:58:00-03', 58) $q$, x1),
    format($q$ select pg_temp.chk((select recebido from get_period_indicators(%1$L, date '2020-06-15', date '2020-06-15')) = 100
                                  and (select recebido from get_period_indicators(%1$L, date '2020-06-16', date '2020-06-16')) = 0, 'dia errado') $q$, v_A)) || nl;
  r := r || pg_temp.t('L3 sessão do banco em Asia/Tokyo: mesmo resultado (datas em São Paulo)', 'ok', null,
    $q$ set local timezone = 'Asia/Tokyo' @@ $q$ || format(run_at, timestamptz '2020-06-16 00:03:00-03', PF),
    format($q$ select pg_temp.mka(%L, timestamptz '2020-06-15 23:58:00-03', 58) $q$, x1),
    format($q$ select pg_temp.chk((select (created_at at time zone 'America/Sao_Paulo')::date from payments where appointment_id = %L) = date '2020-06-15', 'data') $q$, x1)) || nl;
  r := r || pg_temp.t('L4 depois de marcar pendente: recebido do dia cai, pendente sobe', 'ok', v_user,
    format($q$ select mark_appointment_payment_pending(%L) $q$, x1),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0) || '@@' || run_now,
    format($q$ select pg_temp.chk((select faturado = 100 and recebido = 0 and pendente = 100 from get_period_indicators(%L, date '2020-06-15', date '2020-06-15')), 'indicadores') $q$, v_A)) || nl;

  -- ================================================= M. legado (como o de R$ 90)
  r := r || pg_temp.t('M1 concluído SEM recebimento: nunca selecionado nem marcado; continua igual', 'ok', null,
    run_now,
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60, 90, 'concluido')
              @@ create temp table zz_leg on commit drop as select to_jsonb(a) j from appointments a where id = %L $q$, x1, T0, x1),
    format($q$ select pg_temp.chk((select to_jsonb(a) from appointments a where id = %L) = (select j from zz_leg), 'legado mudou')
              @@ select pg_temp.chk(not exists (select 1 from payments where appointment_id = %L), 'criou pagamento')
              @@ select pg_temp.chk(not exists (select 1 from aurea_private.run_items where appointment_id = %L), 'entrou no log')
              @@ select pg_temp.chk(aurea_private.appointment_ineligibility(%L, %L, %L) = 'status', 'motivo') $q$, x1, x1, x1, x1, T0, PF)) || nl;

  -- ============================================================ V. reversão
  r := r || pg_temp.t('V1 reversão limpa (dry run): reversível e nada muda', 'ok', null,
    run_now || format($q$ @@ create temp table zz_h on commit drop as select %s h $q$, s_hash)
      || format($q$ @@ select pg_temp.chk((aurea_private.revert_run(%s, true) ->> 'reversivel')::boolean, 'não reversível') $q$, format(rid, x1)),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0),
    format($q$ select pg_temp.chk(%s = (select h from zz_h), 'dry run alterou dados') $q$, s_hash)) || nl;
  r := r || pg_temp.t('V2 reversão limpa: recebimento apagado, estado e visitas anteriores restaurados, histórico acrescido', 'ok', null,
    run_now || format($q$ @@ select pg_temp.chk((aurea_private.revert_run(%s, false) ->> 'status') = 'ok', 'não reverteu') $q$, format(rid, x1)),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60, 100, 'confirmado')
              @@ update clients set first_visit_at = date '2020-01-01', last_visit_at = date '2020-02-01' where id = %L $q$, x1, T0, c_A),
    format($q$ select pg_temp.chk(not exists (select 1 from payments where appointment_id = %L), 'pagamento ficou')
              @@ select pg_temp.chk((select status = 'confirmado' and completed_at is null and payment_method is null from appointments where id = %L), 'estado')
              @@ select pg_temp.chk((select first_visit_at = date '2020-01-01' and last_visit_at = date '2020-02-01' from clients where id = %L), 'visitas')
              @@ select pg_temp.chk(exists (select 1 from appointment_status_history where appointment_id = %L and note like 'Revertido%%'), 'histórico')
              @@ select pg_temp.chk((select status = 'excluded' from aurea_private.appointment_state where appointment_id = %L), 'controle') $q$, x1, x1, c_A, x1, x1)) || nl;
  r := r || pg_temp.t('V3 depois de revertido, a automação NUNCA reconclui', 'ok', null,
    run_now || format($q$ @@ select aurea_private.revert_run(%s, false) $q$, format(rid, x1)) || '@@' || format(run_at, T0 + interval '1 day', PF),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0),
    format($q$ select pg_temp.chk((select status from appointments where id = %L) = 'agendado' and not exists (select 1 from payments where appointment_id = %L), 'reconcluiu') $q$, x1, x1)) || nl;
  -- cada correção posterior bloqueia (o sinal esperado é conferido)
  r := r || pg_temp.t('V4a trocou a forma -> bloqueia (pagamento_modificado)', 'ok', v_user,
    format($q$ select update_appointment_payment(%L, 'dinheiro') $q$, x1),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0) || '@@' || run_now,
    format($q$ select pg_temp.chk((select (j->>'status') = 'bloqueada' and (j->'bloqueios'->0->'sinais') ? 'pagamento_modificado' from (select aurea_private.revert_run(%s, false) j) z), 'não bloqueou')
              @@ select pg_temp.chk((select count(*) from payments where appointment_id = %L) = 1, 'apagou') $q$, format(rid, x1), x1)) || nl;
  r := r || pg_temp.t('V4b marcou pendente -> bloqueia', 'ok', v_user,
    format($q$ select mark_appointment_payment_pending(%L) $q$, x1),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0) || '@@' || run_now,
    format($q$ select pg_temp.chk((select (j->>'status') = 'bloqueada' and (j->'bloqueios'->0->'sinais') ? 'pagamento_modificado' from (select aurea_private.revert_run(%s, false) j) z), 'não bloqueou') $q$, format(rid, x1))) || nl;
  r := r || pg_temp.t('V4c editou só a observação -> bloqueia (auditoria_atendimento)', 'ok', v_user,
    format($q$ update appointments set notes = 'obs' where id = %L $q$, x1),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0) || '@@' || run_now,
    format($q$ select pg_temp.chk((select (j->>'status') = 'bloqueada' and (j->'bloqueios'->0->'sinais') ? 'auditoria_atendimento' from (select aurea_private.revert_run(%s, false) j) z), 'não bloqueou') $q$, format(rid, x1))) || nl;
  r := r || pg_temp.t('V4d reclassificou como falta -> bloqueia', 'ok', v_user,
    format($q$ select reclassify_appointment_as_no_show(%L) $q$, x1),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0) || '@@' || run_now,
    format($q$ select pg_temp.chk((select (j->>'status') = 'bloqueada' and (j->'bloqueios'->0->'sinais') ? 'pagamento_removido_ou_trocado' from (select aurea_private.revert_run(%s, false) j) z), 'não bloqueou')
              @@ select pg_temp.chk((select status from appointments where id = %L) = 'nao_compareceu', 'desfez a falta') $q$, format(rid, x1), x1)) || nl;
  r := r || pg_temp.t('V4e admin editou em Receitas -> bloqueia', 'ok', v_user,
    format($q$ update payments set description = 'ajuste' where appointment_id = %L $q$, x1),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0) || '@@' || run_now,
    format($q$ select pg_temp.chk((select (j->>'status') = 'bloqueada' from (select aurea_private.revert_run(%s, false) j) z), 'não bloqueou') $q$, format(rid, x1))) || nl;
  r := r || pg_temp.t('V4f outra visita da cliente depois -> bloqueia (visitas_cliente)', 'ok', v_user,
    format($q$ select conclude_appointment(%L, 100, 'pix') $q$, x2),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '3 hours', 60) @@ select pg_temp.mka(%L, %L::timestamptz + interval '2 days', 60) $q$, x1, T0, x2, T0) || '@@' || run_now,
    format($q$ select pg_temp.chk((select (j->>'status') = 'bloqueada' and j::text like '%%visitas_cliente%%' from (select aurea_private.revert_run(%s, false) j) z), 'não bloqueou') $q$, format(rid, x1))) || nl;
  r := r || pg_temp.t('V4g "Excluir atendimento" depois -> bloqueia (atendimento_removido)', 'ok', v_user,
    format($q$ select delete_appointment(%L) $q$, x1),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0) || '@@' || run_now,
    format($q$ select pg_temp.chk((select (j->>'status') = 'bloqueada' and (j->'bloqueios'->0->'sinais') ? 'atendimento_removido' from (select aurea_private.revert_run(%s, false) j) z), 'não bloqueou') $q$, format(rid, x1))) || nl;
  r := r || pg_temp.t('V5 tudo ou nada: 2 itens, 1 corrigido -> NENHUM é revertido', 'ok', v_user,
    format($q$ select update_appointment_payment(%L, 'dinheiro') $q$, x2),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '3 hours', 60, 100, 'agendado', %L) @@ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0, c_A2, x2, T0) || '@@' || run_now,
    format($q$ select pg_temp.chk((select (j->>'status') = 'bloqueada' from (select aurea_private.revert_run(%s, false) j) z), 'não bloqueou')
              @@ select pg_temp.chk((select count(*) from payments where appointment_id in (%L, %L)) = 2 and (select status from appointments where id = %L) = 'concluido', 'reverteu parcialmente') $q$, format(rid, x1), x1, x2, x1)) || nl;
  r := r || pg_temp.t('V6 reverter de novo é recusado (AUR32)', 'ok', null,
    run_now || format($q$ @@ select aurea_private.revert_run(%1$s, false) @@ select pg_temp.chk((aurea_private.revert_run(%1$s, false) ->> 'sqlstate') = 'AUR32', 'aceitou') $q$, format(rid, x1)),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0)) || nl;
  r := r || pg_temp.t('V7 mesma cliente com 2 itens na execução: reversão limpa restaura a visita de antes do 1º', 'ok', null,
    run_now || format($q$ @@ select pg_temp.chk((aurea_private.revert_run(%s, false) ->> 'status') = 'ok', 'bloqueou indevidamente') $q$, format(rid, x1)),
    format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '3 hours', 60) @@ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0, x2, T0),
    format($q$ select pg_temp.chk((select first_visit_at is null and last_visit_at is null from clients where id = %L), 'visitas') $q$, c_A)) || nl;

  -- ============================== R. regularização e H. ativação (só antes da ativação)
  if v_active then
    r := r || 'INFO R* e H* (pulados: a automação já foi ativada neste banco; regularização não é mais permitida)' || nl;
  else
    r := r || pg_temp.t('R1 dry run: lista exatamente os atendimentos e o total; NÃO altera nenhum dado', 'ok', null,
      format($q$ create temp table zz_h on commit drop as select %s h
                @@ create temp table zz_r on commit drop as select aurea_private.regularize(null, null, true, %L) j
                @@ select pg_temp.chk((select (j->>'quantidade')::int = 2 and (j->>'total')::numeric = 250 and j->>'status' = 'dry_run' from zz_r), 'lista/total')
                @@ select pg_temp.chk(%s = (select h from zz_h), 'dry run alterou dados') $q$, s_hash, T0, s_hash),
      format($q$ select pg_temp.mka(%L, %L, 60, 100) @@ select pg_temp.mkb(%L, %L, 60, 150) $q$, x1, D1, x2, D1)) || nl;
    r := r || pg_temp.t('R2 execução com IDs e total corretos: os 2 concluídos (origem backfill, datas do atendimento)', 'ok', null,
      format($q$ select pg_temp.chk((aurea_private.regularize(array[%L, %L]::uuid[], 250, false, %L) ->> 'status') = 'ok', 'não regularizou') $q$, x1, x2, T0),
      format($q$ select pg_temp.mka(%L, %L, 60, 100) @@ select pg_temp.mkb(%L, %L, 60, 150) $q$, x1, D1, x2, D1),
      format($q$ select pg_temp.chk((select count(*) from payments p join appointments a on a.id = p.appointment_id where p.appointment_id in (%L, %L)
                                     and p.source = 'backfill' and p.status = 'pago' and p.created_at = a.scheduled_end and a.status = 'concluido') = 2, 'resultado') $q$, x1, x2)) || nl;
    r := r || pg_temp.t('R3 falta um ID esperado -> abortada, nada alterado, tentativa registrada', 'ok', null,
      format($q$ create temp table zz_h on commit drop as select %s h
                @@ select pg_temp.chk((aurea_private.regularize(array[%L]::uuid[], 100, false, %L) ->> 'sqlstate') = 'AUR13', 'não abortou')
                @@ select pg_temp.chk(%s = (select h from zz_h), 'alterou dados')
                @@ select pg_temp.chk(exists (select 1 from aurea_private.runs where kind = 'regularization' and status = 'aborted' and now_ref = %L), 'sem registro') $q$, s_hash, x1, T0, s_hash, T0),
      format($q$ select pg_temp.mka(%L, %L, 60, 100) @@ select pg_temp.mkb(%L, %L, 60, 150) $q$, x1, D1, x2, D1)) || nl;
    r := r || pg_temp.t('R4 ID a mais -> abortada (AUR13), nada alterado', 'ok', null,
      format($q$ create temp table zz_h on commit drop as select %s h
                @@ select pg_temp.chk((aurea_private.regularize(array[%L, %L, %L]::uuid[], 250, false, %L) ->> 'sqlstate') = 'AUR13', 'não abortou')
                @@ select pg_temp.chk(%s = (select h from zz_h), 'alterou dados') $q$, s_hash, x1, x2, x3, T0, s_hash),
      format($q$ select pg_temp.mka(%L, %L, 60, 100) @@ select pg_temp.mkb(%L, %L, 60, 150) $q$, x1, D1, x2, D1)) || nl;
    r := r || pg_temp.t('R5 total diferente -> abortada (AUR14), nada alterado', 'ok', null,
      format($q$ create temp table zz_h on commit drop as select %s h
                @@ select pg_temp.chk((aurea_private.regularize(array[%L, %L]::uuid[], 249.99, false, %L) ->> 'sqlstate') = 'AUR14', 'não abortou')
                @@ select pg_temp.chk(%s = (select h from zz_h), 'alterou dados') $q$, s_hash, x1, x2, T0, s_hash),
      format($q$ select pg_temp.mka(%L, %L, 60, 100) @@ select pg_temp.mkb(%L, %L, 60, 150) $q$, x1, D1, x2, D1)) || nl;
    r := r || pg_temp.t('R6 IDs repetidos ou sem IDs/total -> abortada (AUR12)', 'ok', null,
      format($q$ select pg_temp.chk((aurea_private.regularize(array[%L, %L, %L]::uuid[], 250, false, %L) ->> 'sqlstate') = 'AUR12', 'repetidos')
                @@ select pg_temp.chk((aurea_private.regularize(null, null, false, %L) ->> 'sqlstate') = 'AUR12', 'sem parâmetros') $q$, x1, x1, x2, T0, T0),
      format($q$ select pg_temp.mka(%L, %L, 60, 100) @@ select pg_temp.mkb(%L, %L, 60, 150) $q$, x1, D1, x2, D1)) || nl;
    r := r || pg_temp.t('R7 repetir depois do sucesso -> abortada (AUR13), sem 2º pagamento', 'ok', null,
      format($q$ select aurea_private.regularize(array[%1$L, %2$L]::uuid[], 250, false, %3$L)
                @@ select pg_temp.chk((aurea_private.regularize(array[%1$L, %2$L]::uuid[], 250, false, %3$L) ->> 'sqlstate') = 'AUR13', 'repetiu')
                @@ select pg_temp.chk((select count(*) from payments where appointment_id in (%1$L, %2$L)) = 2, 'duplicou') $q$, x1, x2, T0),
      format($q$ select pg_temp.mka(%L, %L, 60, 100) @@ select pg_temp.mkb(%L, %L, 60, 150) $q$, x1, D1, x2, D1)) || nl;
    r := r || pg_temp.t('R9 anomalias (preço 0, reaberto, legado concluído sem pagamento) NÃO entram e ficam iguais', 'ok', null,
      format($q$ create temp table zz_h on commit drop as select %s h
                @@ create temp table zz_r on commit drop as select aurea_private.regularize(null, null, true, %L) j
                @@ select pg_temp.chk((select (j->>'quantidade')::int = 0 and jsonb_array_length(j->'anomalias_nao_tocadas') = 2 from zz_r), 'listou')
                @@ select pg_temp.chk(%s = (select h from zz_h), 'alterou') $q$, s_hash, T0, s_hash),
      format($q$ select pg_temp.mka(%L, %L, 60, 0) @@ select pg_temp.mka(%L, %L::timestamptz - interval '3 hours', 60)
                @@ update appointments set status = 'cancelado' where id = %L @@ update appointments set status = 'agendado' where id = %L
                @@ select pg_temp.mkb(%L, %L, 60, 90, 'concluido') $q$, x1, D1, x2, D1, x2, x2, x3, D1)) || nl;
    r := r || pg_temp.t('R10 sem nada a regularizar: IDs vazios e total 0 -> ok (permite ativar no mesmo dia)', 'ok', null,
      format($q$ select pg_temp.chk((aurea_private.regularize('{}'::uuid[], 0, false, %L) ->> 'status') = 'ok', 'recusou') $q$, T0)) || nl;

    r := r || pg_temp.t('H1 ativar com DRY RUN é recusado (AUR21) e a configuração não muda', 'ok', null,
      format($q$ create temp table zz_s on commit drop as select to_jsonb(s) j from aurea_private.settings s
                @@ create temp table zz_r on commit drop as select aurea_private.regularize(null, null, true, %L) j
                @@ do $d$ begin perform aurea_private.activate_auto_conclusion((select (j->>'run_id')::uuid from zz_r), %L);
                     raise exception 'ATIVOU'; exception when sqlstate 'AUR21' then null; end $d$
                @@ select pg_temp.chk((select to_jsonb(s) from aurea_private.settings s) = (select j from zz_s), 'configuração mudou') $q$, T0, T0)) || nl;
    r := r || pg_temp.t('H2 ativar com regularização ABORTADA é recusado (AUR21)', 'fail:AUR21', null,
      format($q$ create temp table zz_r on commit drop as select aurea_private.regularize(array[gen_random_uuid()]::uuid[], 1, false, %L) j
                @@ select aurea_private.activate_auto_conclusion((select (j->>'run_id')::uuid from zz_r), %L) $q$, T0, T0)) || nl;
    r := r || pg_temp.t('H3 ativar com regularização de OUTRO dia é recusado (AUR22)', 'fail:AUR22', null,
      format($q$ create temp table zz_r on commit drop as select aurea_private.regularize('{}'::uuid[], 0, false, %L::timestamptz - interval '1 day') j
                @@ select aurea_private.activate_auto_conclusion((select (j->>'run_id')::uuid from zz_r), %L) $q$, T0, T0)) || nl;
    r := r || pg_temp.t('H4 ativar com atendimento elegível restante antes do corte é recusado (AUR23)', 'fail:AUR23', null,
      format($q$ create temp table zz_r on commit drop as select aurea_private.regularize('{}'::uuid[], 0, false, %L) j
                @@ select pg_temp.mka(%L, %L, 60, 100)
                @@ select aurea_private.activate_auto_conclusion((select (j->>'run_id')::uuid from zz_r), %L) $q$, T0, x1, D1, T0)) || nl;
    r := r || pg_temp.t('H5 ativação correta: process_from = 00:00 SP do dia, chave ligada, dados da ativação gravados', 'ok', null,
      format($q$ create temp table zz_r on commit drop as select aurea_private.regularize(array[%L]::uuid[], 100, false, %L) j
                @@ select aurea_private.activate_auto_conclusion((select (j->>'run_id')::uuid from zz_r), %L)
                @@ select pg_temp.chk((select process_from = %L::timestamptz and enabled and activation_run_id = (select (j->>'run_id')::uuid from zz_r)
                                       and activated_at is not null and activated_by is not null from aurea_private.settings), 'ativação') $q$, x1, T0, T0, PF),
      format($q$ select pg_temp.mka(%L, %L, 60, 100) $q$, x1, D1)) || nl;
    r := r || pg_temp.t('H6 segunda ativação é recusada (AUR20)', 'fail:AUR20', null,
      format($q$ create temp table zz_r on commit drop as select aurea_private.regularize('{}'::uuid[], 0, false, %1$L) j
                @@ select aurea_private.activate_auto_conclusion((select (j->>'run_id')::uuid from zz_r), %1$L)
                @@ select aurea_private.activate_auto_conclusion((select (j->>'run_id')::uuid from zz_r), %1$L) $q$, T0)) || nl;
    r := r || pg_temp.t('H7 depois da ativação, process_from é imutável até para o dono do banco (55000)', 'fail:55000', null,
      format($q$ create temp table zz_r on commit drop as select aurea_private.regularize('{}'::uuid[], 0, false, %1$L) j
                @@ select aurea_private.activate_auto_conclusion((select (j->>'run_id')::uuid from zz_r), %1$L)
                @@ select set_config('aurea_private.activating', 'on', true)
                @@ update aurea_private.settings set process_from = process_from - interval '30 days' $q$, T0)) || nl;
    r := r || pg_temp.t('H8 antes da ativação, gravar process_from fora da função é recusado (55000)', 'fail:55000', null,
      $q$ update aurea_private.settings set process_from = now() $q$) || nl;
    r := r || pg_temp.t('H9 apagar a configuração é recusado (55000)', 'fail:55000', null,
      $q$ delete from aurea_private.settings $q$) || nl;
    r := r || pg_temp.t('H10 truncar a configuração é recusado (55000)', 'fail:55000', null,
      $q$ truncate aurea_private.settings $q$) || nl;
    r := r || pg_temp.t('H11 ligar a chave sem ativação é recusado (23514)', 'fail:23514', null,
      $q$ select aurea_private.set_auto_conclusion_enabled(true) $q$) || nl;
    r := r || pg_temp.t('H12 fuso: 16/06 02:30 UTC (= 15/06 23:30 SP) -> início 15/06 00:00 SP, em sessões UTC e Tokyo', 'ok', null,
      $q$ set local timezone = 'UTC'
         @@ select pg_temp.chk(aurea_private.sp_day_start(timestamptz '2020-06-16 02:30:00+00') = timestamptz '2020-06-15 00:00:00-03', 'UTC')
         @@ set local timezone = 'Asia/Tokyo'
         @@ select pg_temp.chk(aurea_private.sp_day_start(timestamptz '2020-06-16 02:30:00+00') = timestamptz '2020-06-15 00:00:00-03', 'Tokyo')
         @@ create temp table zz_r on commit drop as select aurea_private.regularize('{}'::uuid[], 0, false, timestamptz '2020-06-16 02:30:00+00') j
         @@ select aurea_private.activate_auto_conclusion((select (j->>'run_id')::uuid from zz_r), timestamptz '2020-06-16 02:30:00+00')
         @@ select pg_temp.chk((select process_from from aurea_private.settings) = timestamptz '2020-06-15 00:00:00-03', 'process_from') $q$) || nl;
    r := r || pg_temp.t('H13 depois de ativar, a regularização não é mais permitida (AUR10)', 'ok', null,
      format($q$ create temp table zz_r on commit drop as select aurea_private.regularize('{}'::uuid[], 0, false, %1$L) j
                @@ select aurea_private.activate_auto_conclusion((select (j->>'run_id')::uuid from zz_r), %1$L)
                @@ select pg_temp.chk((aurea_private.regularize(null, null, true, %1$L) ->> 'sqlstate') = 'AUR10', 'permitiu') $q$, T0)) || nl;
    r := r || pg_temp.t('H14 depois de ativar, a execução sem forçar usa o process_from gravado', 'ok', null,
      format($q$ create temp table zz_r on commit drop as select aurea_private.regularize('{}'::uuid[], 0, false, %1$L) j
                @@ select aurea_private.activate_auto_conclusion((select (j->>'run_id')::uuid from zz_r), %1$L)
                @@ select pg_temp.chk((aurea_private._run(%1$L) ->> 'concluded')::int = 1, 'não usou a configuração') $q$, T0),
      format($q$ select pg_temp.mka(%L, %L::timestamptz - interval '1 hour', 60) $q$, x1, T0)) || nl;
    r := r || pg_temp.t('V8 reverter a regularização: os 2 voltam ao estado anterior', 'ok', null,
      format($q$ create temp table zz_r on commit drop as select aurea_private.regularize(array[%L, %L]::uuid[], 250, false, %L) j
                @@ select pg_temp.chk((aurea_private.revert_run((select (j->>'run_id')::uuid from zz_r), false) ->> 'status') = 'ok', 'não reverteu')
                @@ select pg_temp.chk((select count(*) from appointments where id in (%L, %L) and status = 'agendado') = 2
                                      and not exists (select 1 from payments where appointment_id in (%L, %L)), 'estado') $q$, x1, x2, T0, x1, x2, x1, x2),
      format($q$ select pg_temp.mka(%L, %L, 60, 100) @@ select pg_temp.mkb(%L, %L, 60, 150) $q$, x1, D1, x2, D1)) || nl;
  end if;

  v_fail := (length(r) - length(replace(r, 'FAIL ', ''))) / 5;
  raise exception E'\n=== RESULTADO 0015 PRODUÇÃO SEM DDL (esta falha é intencional: desfaz os dados de teste) ===\n%\nLINHAS "FAIL": %\n', r, v_fail;
end
$do$;
