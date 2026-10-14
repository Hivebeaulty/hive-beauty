-- ============================================================================
-- TESTES — 0017 (WhatsApp W1: banco, RPCs do app e funções do worker)
--
-- Nada persiste: o bloco DO termina com uma exceção INTENCIONAL que desfaz tudo.
-- O relatório vem na mensagem de erro. Esperado depois da 0017: ZERO "FAIL".
-- Testes que assumem o papel wa_worker exigem que a sessão possa fazer
-- SET ROLE wa_worker (localmente sim; no Supabase depende de permissão — se não
-- puder, aparecem como INFO).
-- Convenções iguais às da 0014/0015: "@@" separa instruções; p_pre/p_post rodam
-- como DONO; testes negativos declaram o código esperado ('fail:XXXXX').
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
    set constraints all deferred;
    if p_pre is not null then
      foreach v_stmt in array string_to_array(p_pre, '@@') loop execute v_stmt; end loop;
    end if;
    if p_uid is not null then
      perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
      perform set_config('request.jwt.claim.sub', p_uid::text, true);
      set local role authenticated;
    end if;
    foreach v_stmt in array string_to_array(p_sql, '@@') loop execute v_stmt; end loop;
    if p_post is not null then
      reset role;
      perform set_config('request.jwt.claim.sub', '', true);
      perform set_config('request.jwt.claims', '', true);
      foreach v_stmt in array string_to_array(p_post, '@@') loop execute v_stmt; end loop;
    end if;
    raise exception using errcode = 'P9999', message = '__sem_erro__';
  exception
    when sqlstate 'P9999' then
      return rpad(case when p_expect = 'ok' then 'PASS' when p_expect like 'fail%' then 'FAIL' else 'INFO' end, 5)
             || p_name
             || case when p_expect like 'fail%' then '   [executou SEM erro, mas DEVERIA ser bloqueado]' else '' end;
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

create or replace function pg_temp.chk(p_ok boolean, p_msg text)
returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'ASSERÇÃO: %', p_msg using errcode = 'P0099'; end if;
end $$;

do $do$
declare
  v_user uuid;
  v_A uuid; v_B uuid; v_mem uuid; v_memB uuid; v_svc uuid;
  cU uuid; cOK uuid; cBL uuid; cAR uuid; cNP uuid; cIP uuid; cLL uuid; cB1 uuid;
  aFut uuid; aPast uuid;
  v_can_worker boolean;
  s_conn text; s_connB text; s_role text;
  W text := $w$ set local role wa_worker $w$;
  v_fail int;
  r text := '';
  nl text := E'\n';
begin
  select id into v_user from auth.users order by created_at limit 1;
  if v_user is null then raise exception 'auth.users está vazio.'; end if;
  -- Postgres 16+: ser membro (ex.: quem criou o papel) não dá direito de assumi-lo; o que importa é SET
  v_can_worker := pg_has_role(current_user, 'wa_worker', 'SET')
                  or (select rolsuper from pg_roles where rolname = current_user);

  -- ---------------------------------------------------------------- fixtures
  insert into companies (name) values ('ZZ-TESTE-0017-A') returning id into v_A;
  insert into companies (name) values ('ZZ-TESTE-0017-B') returning id into v_B;
  insert into company_members (company_id, user_id, role) values (v_A, v_user, 'owner') returning id into v_mem;
  insert into company_members (company_id, user_id, role, active) values (v_B, v_user, 'owner', false) returning id into v_memB;
  insert into services (company_id, name, duration_minutes, price) values (v_A, 'ZZ servico', 60, 100) returning id into v_svc;
  insert into clients (company_id, name, phone) values (v_A, 'ZZ Unknown', '11987654321') returning id into cU;
  insert into clients (company_id, name, phone, comm_status) values (v_A, 'ZZ Allowed', '11987650002', 'allowed') returning id into cOK;
  insert into clients (company_id, name, phone, comm_status) values (v_A, 'ZZ Blocked', '11987650003', 'blocked') returning id into cBL;
  insert into clients (company_id, name, phone, archived_at) values (v_A, 'ZZ Arquivada', '11987650004', now()) returning id into cAR;
  insert into clients (company_id, name) values (v_A, 'ZZ Sem telefone') returning id into cNP;
  insert into clients (company_id, name, phone) values (v_A, 'ZZ Telefone ruim', '123') returning id into cIP;
  insert into clients (company_id, name, phone) values (v_A, 'ZZ Fixo', '1133334444') returning id into cLL;
  insert into clients (company_id, name, phone) values (v_B, 'ZZ Mesma pessoa na B', '11987654321') returning id into cB1;
  insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end)
    values (v_A, cU, v_svc, v_mem, 100, now() + interval '2 days', now() + interval '2 days 1 hour') returning id into aFut;
  insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end)
    values (v_A, cU, v_svc, v_mem, 100, now() - interval '2 days', now() - interval '2 days' + interval '1 hour') returning id into aPast;

  -- sessão conectada, posse do worker 'w1'
  s_conn := format($q$ insert into whatsapp_private.sessions (company_id, status, phone, last_seen_at, lease_owner, lease_until)
                       values (%L, 'connected', '5511900000000', now(), 'w1', now() + interval '1 minute') $q$, v_A);
  s_connB := format($q$ insert into whatsapp_private.sessions (company_id, status, last_seen_at, lease_owner, lease_until)
                        values (%L, 'connected', now(), 'w2', now() + interval '1 minute') $q$, v_B);
  s_role := $q$ update company_members set role = '%s' where id = '%s' $q$;

  -- ======================================================== S. estrutura e privilégios
  -- (0018 acrescenta appointment_confirmations: confere as 7 da 0017 pelo nome e RLS em TODAS do schema)
  r := r || pg_temp.t('S1 schema privado: as 7 tabelas da 0017 existem, todas as tabelas com RLS; nenhum papel da API com USAGE', 'ok', null,
    $q$ select pg_temp.chk((select count(*) from pg_tables where schemaname = 'whatsapp_private'
                              and tablename in ('settings','sessions','auth','qr','outbox','messages','workers')) = 7
          and (select bool_and(rowsecurity) from pg_tables where schemaname = 'whatsapp_private')
          and not exists (select 1 from unnest(array['anon','authenticated','service_role']) rl
                          where exists (select 1 from pg_roles where rolname = rl)
                            and has_schema_privilege(rl, 'whatsapp_private', 'usage')), 'estrutura/acesso') $q$) || nl;
  r := r || pg_temp.t('S2 RPCs do app: authenticated executa; anon e service_role não', 'ok', null,
    $q$ select pg_temp.chk(bool_and(has_function_privilege('authenticated', p.oid, 'execute'))
          and not bool_or(has_function_privilege('anon', p.oid, 'execute'))
          and not bool_or(has_function_privilege('service_role', p.oid, 'execute'))
          and count(*) = 7, 'grants RPCs')
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('wa_get_status','wa_request_connection','wa_get_qr','wa_disconnect',
              'wa_send_message','wa_send_confirmation','wa_get_conversation') $q$) || nl;
  r := r || pg_temp.t('S3 funções privadas: nenhuma para PUBLIC/API; wa_worker só as 13 do worker', 'ok', null,
    $q$ select pg_temp.chk(
          not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      cross join unnest(array['anon','authenticated','service_role']) rl
                      where n.nspname = 'whatsapp_private' and exists (select 1 from pg_roles where rolname = rl)
                        and has_function_privilege(rl, p.oid, 'execute'))
          and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
                          aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e
                          where n.nspname = 'whatsapp_private' and e.grantee = 0 and e.privilege_type = 'EXECUTE')
          and (select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'whatsapp_private' and has_function_privilege('wa_worker', p.oid, 'execute'))
              = array['acquire_lease','auth_read','auth_write','claim_outbox','complete_outbox','fail_outbox','put_qr',
                      'record_inbound','record_message_status','release_lease','sessions_to_run','set_session_state','worker_heartbeat'],
        'execução indevida') $q$) || nl;
  r := r || pg_temp.t('S4 wa_worker: sem login, sem acesso direto a tabela alguma (privada ou pública)', 'ok', null,
    $q$ select pg_temp.chk(not (select rolcanlogin from pg_roles where rolname = 'wa_worker')
          and not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                          where n.nspname in ('whatsapp_private','public','aurea_private') and c.relkind = 'r'
                            and has_table_privilege('wa_worker', c.oid, 'select,insert,update,delete'))
          and not has_schema_privilege('wa_worker', 'aurea_private', 'usage'), 'acesso do worker') $q$) || nl;
  r := r || pg_temp.t('S5 todas as funções novas com search_path fixo; donos não são papéis da API', 'ok', null,
    $q$ select pg_temp.chk(bool_and(exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
          and bool_and(pg_get_userbyid(p.proowner) not in ('anon','authenticated','service_role','wa_worker')), 'search_path/dono')
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'whatsapp_private' or (n.nspname = 'public' and p.proname like 'wa\_%') $q$) || nl;
  r := r || pg_temp.t('S6 0014 e 0015 intactas (5 gatilhos ativos; 10 funções privadas da automação)', 'ok', null,
    $q$ select pg_temp.chk((select count(*) from pg_trigger where tgenabled = 'O' and tgname in (
          'trg_payments_track_origin','trg_appointments_guard_lifecycle','trg_appointments_payment_consistency_ins',
          'trg_appointments_payment_consistency_upd','trg_payments_appointment_consistency')) = 5
          and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'aurea_private') = 10,
        '0014/0015 alteradas') $q$) || nl;
  r := r || pg_temp.t('S7 anon NÃO chama wa_get_status', 'fail:42501', null,
    format($q$ set local role anon @@ select wa_get_status(%L) $q$, v_A)) || nl;
  r := r || pg_temp.t('S8 authenticated NÃO lê tabela privada', 'fail:42501', v_user,
    $q$ select count(*) from whatsapp_private.sessions $q$) || nl;
  r := r || pg_temp.t('S9 authenticated NÃO chama função do worker', 'fail:42501', v_user,
    $q$ select * from whatsapp_private.claim_outbox('w1', 10, 60) $q$) || nl;

  -- ======================================================== C. conexão
  r := r || pg_temp.t('C1 owner pede conexão: sessão connect_requested + 1 pedido; repetir não duplica', 'ok', v_user,
    format($q$ select wa_request_connection(%1$L) @@ select wa_request_connection(%1$L) $q$, v_A), null,
    format($q$ select pg_temp.chk((select status from whatsapp_private.sessions where company_id = %1$L) = 'connect_requested'
                 and (select count(*) from whatsapp_private.outbox where company_id = %1$L and kind = 'connect' and status = 'pending') = 1, 'conexão') $q$, v_A)) || nl;
  r := r || pg_temp.t('C2 profissional NÃO pede conexão', 'fail:42501', v_user,
    format($q$ select wa_request_connection(%L) $q$, v_A), format(s_role, 'professional', v_mem)) || nl;
  r := r || pg_temp.t('C3 recepção NÃO pede conexão', 'fail:42501', v_user,
    format($q$ select wa_request_connection(%L) $q$, v_A), format(s_role, 'reception', v_mem)) || nl;
  r := r || pg_temp.t('C4 isolamento: membro inativo de outra empresa NÃO pede conexão (P0002)', 'fail:P0002', v_user,
    format($q$ select wa_request_connection(%L) $q$, v_B)) || nl;
  r := r || pg_temp.t('C5 status para profissional: sem gestão, sem QR, sem erro técnico', 'ok', v_user,
    format($q$ select pg_temp.chk((select (j->>'can_manage')::boolean = false and (j->>'qr_available')::boolean = false
                 and j->'last_error' = 'null'::jsonb and (j->>'can_send')::boolean from (select wa_get_status(%L) j) z), 'status') $q$, v_A),
    s_conn || format($q$ @@ update whatsapp_private.sessions set last_error = 'detalhe' where company_id = %L $q$, v_A)
      || '@@' || format(s_role, 'professional', v_mem)) || nl;
  r := r || pg_temp.t('C6 QR: owner lê; expirado volta vazio', 'ok', v_user,
    format($q$ select pg_temp.chk((wa_get_qr(%1$L) ->> 'qr') = 'QR-DE-TESTE-123', 'leu') $q$, v_A),
    s_conn || format($q$ @@ insert into whatsapp_private.qr (company_id, qr, expires_at) values (%L, 'QR-DE-TESTE-123', now() + interval '1 minute') $q$, v_A),
    format($q$ update whatsapp_private.qr set expires_at = now() - interval '1 second' where company_id = %1$L
              @@ select set_config('request.jwt.claim.sub', %2$L, true)
              @@ select pg_temp.chk((wa_get_qr(%1$L) -> 'qr') = 'null'::jsonb, 'expirado') $q$, v_A, v_user)) || nl;
  r := r || pg_temp.t('C7 profissional NÃO vê o QR', 'fail:42501', v_user,
    format($q$ select wa_get_qr(%L) $q$, v_A), s_conn || '@@' || format(s_role, 'professional', v_mem)) || nl;
  r := r || pg_temp.t('C8 desconectar: pedido criado, conexão pendente cancelada; repetir não duplica', 'ok', v_user,
    format($q$ select wa_disconnect(%1$L) @@ select wa_disconnect(%1$L) $q$, v_A),
    s_conn || format($q$ @@ insert into whatsapp_private.outbox (company_id, kind, idempotency_key) values (%L, 'connect', 'connect:x') $q$, v_A),
    format($q$ select pg_temp.chk((select status from whatsapp_private.sessions where company_id = %1$L) = 'disconnect_requested'
                 and (select count(*) from whatsapp_private.outbox where company_id = %1$L and kind = 'disconnect') = 1
                 and (select status from whatsapp_private.outbox where company_id = %1$L and kind = 'connect') = 'canceled', 'desconexão') $q$, v_A)) || nl;
  r := r || pg_temp.t('C9 sem sinal do worker há mais de 2 min: status "stale" e can_send = false', 'ok', v_user,
    format($q$ select pg_temp.chk((select j->>'status' = 'stale' and not (j->>'can_send')::boolean from (select wa_get_status(%L) j) z), 'stale') $q$, v_A),
    s_conn || format($q$ @@ update whatsapp_private.sessions set last_seen_at = now() - interval '3 minutes' where company_id = %L $q$, v_A)) || nl;

  -- ======================================================== E. regra de envio
  r := r || pg_temp.t('E1 comm_status unknown + celular válido: ENVIA (regra aprovada)', 'ok', v_user,
    format($q$ select pg_temp.chk((wa_send_message(%L, 'Olá!', 'k1') ->> 'created')::boolean, 'não enfileirou') $q$, cU), s_conn,
    format($q$ select pg_temp.chk((select count(*) = 1 and bool_and(to_phone = '5511987654321' and status = 'pending') from whatsapp_private.outbox where client_id = %L), 'fila') $q$, cU)) || nl;
  r := r || pg_temp.t('E2 comm_status allowed: envia', 'ok', v_user,
    format($q$ select wa_send_message(%L, 'Olá!', 'k2') $q$, cOK), s_conn) || nl;
  r := r || pg_temp.t('E3 bloqueada: NÃO envia (AUW02)', 'fail:AUW02', v_user, format($q$ select wa_send_message(%L, 'Olá!', 'k3') $q$, cBL), s_conn) || nl;
  r := r || pg_temp.t('E4 arquivada: NÃO envia (AUW02)', 'fail:AUW02', v_user, format($q$ select wa_send_message(%L, 'Olá!', 'k4') $q$, cAR), s_conn) || nl;
  r := r || pg_temp.t('E5 sem telefone: NÃO envia (AUW02)', 'fail:AUW02', v_user, format($q$ select wa_send_message(%L, 'Olá!', 'k5') $q$, cNP), s_conn) || nl;
  r := r || pg_temp.t('E6 telefone inválido: NÃO envia (AUW02)', 'fail:AUW02', v_user, format($q$ select wa_send_message(%L, 'Olá!', 'k6') $q$, cIP), s_conn) || nl;
  r := r || pg_temp.t('E7 telefone fixo: NÃO envia (AUW02)', 'fail:AUW02', v_user, format($q$ select wa_send_message(%L, 'Olá!', 'k7') $q$, cLL), s_conn) || nl;
  r := r || pg_temp.t('E8 WhatsApp não conectado: AUW01 (a tela usa o wa.me)', 'fail:AUW01', v_user, format($q$ select wa_send_message(%L, 'Olá!', 'k8') $q$, cU)) || nl;
  r := r || pg_temp.t('E9 conectado mas SEM SINAL: AUW01', 'fail:AUW01', v_user, format($q$ select wa_send_message(%L, 'Olá!', 'k9') $q$, cU),
    s_conn || format($q$ @@ update whatsapp_private.sessions set last_seen_at = now() - interval '3 minutes' where company_id = %L $q$, v_A)) || nl;
  r := r || pg_temp.t('E10 idempotência: mesma chave e mesmo texto -> MESMO pedido, 1 registro', 'ok', v_user,
    format($q$ create temp table zz_a on commit drop as select wa_send_message(%1$L, 'Oi', 'dup') j
              @@ select pg_temp.chk((select (j->>'created')::boolean = false and j->>'outbox_id' = (select j->>'outbox_id' from zz_a)
                                     from (select wa_send_message(%1$L, 'Oi', 'dup') j) z), 'idempotência') $q$, cU),
    s_conn,
    format($q$ select pg_temp.chk((select count(*) from whatsapp_private.outbox where company_id = %L and idempotency_key = 'dup') = 1, 'duplicou') $q$, v_A)) || nl;
  r := r || pg_temp.t('E11 mesma chave com OUTRO texto: recusado (AUW04)', 'fail:AUW04', v_user,
    format($q$ select wa_send_message(%1$L, 'Oi', 'dup') @@ select wa_send_message(%1$L, 'Outro texto', 'dup') $q$, cU), s_conn) || nl;
  r := r || pg_temp.t('E12 limite por minuto (ajustado para 2): o 3º é recusado (AUW03)', 'fail:AUW03', v_user,
    format($q$ select wa_send_message(%1$L, 'a', 'r1') @@ select wa_send_message(%1$L, 'b', 'r2') @@ select wa_send_message(%1$L, 'c', 'r3') $q$, cU),
    s_conn || $q$ @@ update whatsapp_private.settings set send_per_minute = 2 $q$) || nl;
  r := r || pg_temp.t('E13 profissional envia', 'ok', v_user, format($q$ select wa_send_message(%L, 'Olá!', 'kp') $q$, cU),
    s_conn || '@@' || format(s_role, 'professional', v_mem)) || nl;
  r := r || pg_temp.t('E14 recepção NÃO envia', 'fail:42501', v_user, format($q$ select wa_send_message(%L, 'Olá!', 'kr') $q$, cU),
    s_conn || '@@' || format(s_role, 'reception', v_mem)) || nl;
  r := r || pg_temp.t('E15 isolamento: cliente de outra empresa (membro inativo) -> P0002', 'fail:P0002', v_user,
    format($q$ select wa_send_message(%L, 'Olá!', 'kb') $q$, cB1), s_conn || '@@' || s_connB) || nl;
  r := r || pg_temp.t('E16 anon NÃO envia', 'fail:42501', null, format($q$ set local role anon @@ select wa_send_message(%L, 'x', 'ka') $q$, cU), s_conn) || nl;
  r := r || pg_temp.t('E17 texto vazio (AUW05)', 'fail:AUW05', v_user, format($q$ select wa_send_message(%L, '   ', 'kv') $q$, cU), s_conn) || nl;
  r := r || pg_temp.t('E18 texto longo demais (AUW05)', 'fail:AUW05', v_user, format($q$ select wa_send_message(%L, repeat('x', 4097), 'kl') $q$, cU), s_conn) || nl;
  r := r || pg_temp.t('E19 sem chave de envio (AUW05)', 'fail:AUW05', v_user, format($q$ select wa_send_message(%L, 'oi', ' ') $q$, cU), s_conn) || nl;
  r := r || pg_temp.t('E20 confirmação de agendamento futuro: enfileira; repetir o mesmo texto não duplica', 'ok', v_user,
    format($q$ select wa_send_confirmation(%1$L, 'Confirmando seu horário') @@ select wa_send_confirmation(%1$L, 'Confirmando seu horário') $q$, aFut),
    s_conn,
    format($q$ select pg_temp.chk((select count(*) from whatsapp_private.outbox where appointment_id = %L) = 1, 'duplicou') $q$, aFut)) || nl;
  r := r || pg_temp.t('E21 confirmação de atendimento passado: recusada (22023)', 'fail:22023', v_user,
    format($q$ select wa_send_confirmation(%L, 'x') $q$, aPast), s_conn) || nl;
  r := r || pg_temp.t('E22 confirmação para cliente bloqueada: recusada (AUW02)', 'fail:AUW02', v_user,
    format($q$ select wa_send_confirmation(%L, 'x') $q$, aFut), s_conn || format($q$ @@ update clients set comm_status = 'blocked' where id = %L $q$, cU)) || nl;
  r := r || pg_temp.t('E23 conversa: membro lê (inclui pendente); recepção também lê', 'ok', v_user,
    format($q$ select pg_temp.chk(jsonb_array_length(wa_get_conversation(%L) -> 'items') = 1, 'itens') $q$, cU),
    s_conn || format($q$ @@ insert into whatsapp_private.outbox (company_id, kind, client_id, to_phone, body, idempotency_key) values (%L, 'send_text', %L, '5511987654321', 'oi', 'kc')
                         @@ update company_members set role = 'reception' where id = %L $q$, v_A, cU, v_mem)) || nl;
  r := r || pg_temp.t('E24 conversa de cliente de outra empresa -> P0002', 'fail:P0002', v_user,
    format($q$ select wa_get_conversation(%L) $q$, cB1)) || nl;

  -- ======================================================== W. funções do worker
  if not v_can_worker then
    r := r || 'INFO W* (pulados: esta sessão não pode assumir o papel wa_worker)' || nl;
  else
    r := r || pg_temp.t('W1 posse: w1 pega; w2 NÃO pega enquanto válida; pega depois que expira', 'ok', null,
      W || format($q$ @@ select pg_temp.chk(whatsapp_private.acquire_lease(%1$L, 'w1', 60), 'w1')
                @@ select pg_temp.chk(not whatsapp_private.acquire_lease(%1$L, 'w2', 60), 'w2 pegou com posse válida') $q$, v_A),
      format($q$ insert into whatsapp_private.sessions (company_id) values (%L) $q$, v_A),
      format($q$ update whatsapp_private.sessions set lease_until = now() - interval '1 second' where company_id = %1$L
                @@ set local role wa_worker
                @@ select pg_temp.chk(whatsapp_private.acquire_lease(%1$L, 'w2', 60), 'w2 após expirar') $q$, v_A)) || nl;
    r := r || pg_temp.t('W2 sem a posse, o worker NÃO grava QR (AUW10)', 'fail:AUW10', null,
      W || format($q$ @@ select whatsapp_private.put_qr(%L, 'w2', 'QR-DE-TESTE-123') $q$, v_A), s_conn) || nl;
    r := r || pg_temp.t('W3 credenciais: grava, lê, apaga; o banco recusa dado curto demais para ser cifrado', 'ok', null,
      W || format($q$ @@ select whatsapp_private.auth_write(%1$L, 'w1', jsonb_build_array(jsonb_build_object('category','creds','key_id','creds','data', encode(gen_random_bytes(64), 'base64'))))
                @@ select pg_temp.chk((select count(*) from whatsapp_private.auth_read(%1$L, 'w1', 'creds', array['creds'])) = 1, 'leitura')
                @@ select whatsapp_private.auth_write(%1$L, 'w1', jsonb_build_array(jsonb_build_object('category','creds','key_id','creds','data', null)))
                @@ select pg_temp.chk((select count(*) from whatsapp_private.auth_read(%1$L, 'w1', 'creds', array['creds'])) = 0, 'apagou')
                @@ do $d$ begin
                     perform whatsapp_private.auth_write(%1$L, 'w1', jsonb_build_array(jsonb_build_object('category','creds','key_id','x','data', encode('texto puro'::bytea, 'base64'))));
                     raise exception 'ACEITOU TEXTO PURO';
                   exception when check_violation then null; end $d$ $q$, v_A), s_conn) || nl;
    r := r || pg_temp.t('W4 fila: só pega pedidos das empresas que detém; conta tentativa; retoma trava vencida', 'ok', null,
      W || format($q$ @@ create temp table zz_c on commit drop as select * from whatsapp_private.claim_outbox('w1', 10, 60)
                @@ select pg_temp.chk((select count(*) = 1 and bool_and(company_id = %1$L and attempts = 1) from zz_c), 'pegou errado') $q$, v_A),
      s_conn || '@@' || s_connB || format($q$ @@ insert into whatsapp_private.outbox (company_id, kind, client_id, to_phone, body, idempotency_key)
                values (%L, 'send_text', %L, '5511987654321', 'oi', 'a1'), (%L, 'send_text', %L, '5511987654321', 'oi', 'b1') $q$, v_A, cU, v_B, cB1),
      format($q$ update whatsapp_private.outbox set locked_until = now() - interval '1 second' where company_id = %1$L
                @@ set local role wa_worker
                @@ select pg_temp.chk((select count(*) = 1 and bool_and(attempts = 2) from whatsapp_private.claim_outbox('w1', 10, 60)), 'não retomou') $q$, v_A)) || nl;
    r := r || pg_temp.t('W5 conclusão de envio grava a mensagem UMA vez; repetir é inofensivo', 'ok', null,
      W || $q$ @@ create temp table zz_c on commit drop as select * from whatsapp_private.claim_outbox('w1', 10, 60)
               @@ select pg_temp.chk(whatsapp_private.complete_outbox((select id from zz_c), 'w1', 'WAMID-1'), 'concluiu')
               @@ select pg_temp.chk(not whatsapp_private.complete_outbox((select id from zz_c), 'w1', 'WAMID-1'), 'repetiu') $q$,
      s_conn || format($q$ @@ insert into whatsapp_private.outbox (company_id, kind, client_id, to_phone, body, idempotency_key, created_by)
                values (%L, 'send_text', %L, '5511987654321', 'oi', 'a1', %L) $q$, v_A, cU, v_user),
      format($q$ select pg_temp.chk((select count(*) = 1 and bool_and(direction = 'out' and client_id = %L and status = 'sent' and sent_by = %L)
                                     from whatsapp_private.messages where wa_message_id = 'WAMID-1'), 'mensagem')
                @@ select pg_temp.chk((select status from whatsapp_private.outbox where idempotency_key = 'a1') = 'sent', 'pedido') $q$, cU, v_user)) || nl;
    r := r || pg_temp.t('W6 outro worker NÃO conclui pedido que não é dele (AUW11)', 'fail:AUW11', null,
      W || $q$ @@ create temp table zz_c on commit drop as select * from whatsapp_private.claim_outbox('w1', 10, 60)
               @@ select whatsapp_private.complete_outbox((select id from zz_c), 'w9', 'WAMID-X') $q$,
      s_conn || format($q$ @@ insert into whatsapp_private.outbox (company_id, kind, client_id, to_phone, body, idempotency_key)
                values (%L, 'send_text', %L, '5511987654321', 'oi', 'a1') $q$, v_A, cU)) || nl;
    r := r || pg_temp.t('W7 falha temporária volta para a fila com espera; na última tentativa vira failed', 'ok', null,
      W || $q$ @@ create temp table zz_c on commit drop as select * from whatsapp_private.claim_outbox('w1', 10, 60)
               @@ select pg_temp.chk(whatsapp_private.fail_outbox((select id from zz_c), 'w1', 'rede', true) = 'pending', 'retentativa') $q$,
      s_conn || format($q$ @@ insert into whatsapp_private.outbox (company_id, kind, client_id, to_phone, body, idempotency_key, max_attempts)
                values (%L, 'send_text', %L, '5511987654321', 'oi', 'a1', 2) $q$, v_A, cU),
      $q$ select pg_temp.chk((select available_at > now() from whatsapp_private.outbox where idempotency_key = 'a1'), 'sem espera')
          @@ update whatsapp_private.outbox set available_at = now() where idempotency_key = 'a1'
          @@ set local role wa_worker
          @@ create temp table zz_d on commit drop as select * from whatsapp_private.claim_outbox('w1', 10, 60)
          @@ select pg_temp.chk(whatsapp_private.fail_outbox((select id from zz_d), 'w1', 'rede', true) = 'failed', 'não falhou na última') $q$) || nl;
    r := r || pg_temp.t('W8 recebida: liga à cliente pelo número (com e sem o 9º dígito); duplicada não grava', 'ok', null,
      W || format($q$ @@ select pg_temp.chk((whatsapp_private.record_inbound(%1$L, 'w1', 'IN-1', '5511987654321@s.whatsapp.net', 'Oi') ->> 'client_id') = %2$L, 'com 9')
                @@ select pg_temp.chk((whatsapp_private.record_inbound(%1$L, 'w1', 'IN-2', '551187654321@s.whatsapp.net', 'Oi') ->> 'client_id') = %2$L, 'sem 9')
                @@ select pg_temp.chk(not (whatsapp_private.record_inbound(%1$L, 'w1', 'IN-1', '5511987654321@s.whatsapp.net', 'Oi') ->> 'inserted')::boolean, 'duplicou') $q$, v_A, cU),
      s_conn) || nl;
    r := r || pg_temp.t('W9 grupo é ignorado; identificador sem número (LID) fica registrado sem cliente', 'ok', null,
      W || format($q$ @@ select pg_temp.chk((whatsapp_private.record_inbound(%1$L, 'w1', 'G-1', '120363000000000000@g.us', 'oi') ->> 'ignored')::boolean, 'grupo')
                @@ select pg_temp.chk((select j->>'client_id' is null and (j->>'inserted')::boolean from (select whatsapp_private.record_inbound(%1$L, 'w1', 'L-1', '12345678901234@lid', 'SAIR') j) z), 'lid') $q$, v_A),
      s_conn,
      format($q$ select pg_temp.chk((select comm_status from clients where id = %L) = 'unknown', 'LID não pode bloquear ninguém') $q$, cU)) || nl;
    r := r || pg_temp.t('W10 "Sair!" bloqueia a cliente (origem client_opt_out) só nesta empresa; envio passa a ser recusado', 'ok', null,
      W || format($q$ @@ select pg_temp.chk((whatsapp_private.record_inbound(%L, 'w1', 'IN-S', '5511987654321@s.whatsapp.net', ' Sair! ') ->> 'opted_out')::boolean, 'não saiu') $q$, v_A),
      s_conn,
      format($q$ select pg_temp.chk((select comm_status = 'blocked' and comm_status_source = 'client_opt_out' and comm_status_by is null from clients where id = %1$L), 'cliente A')
                @@ select pg_temp.chk((select comm_status from clients where id = %2$L) = 'unknown', 'vazou para a empresa B')
                @@ select set_config('request.jwt.claim.sub', %3$L, true)
                @@ do $d$ begin perform wa_send_message(%1$L, 'oi', 'depois-do-sair'); raise exception 'ENVIOU';
                     exception when sqlstate 'AUW02' then null; end $d$ $q$, cU, cB1, v_user)) || nl;
    r := r || pg_temp.t('W11 frase com "sair" no meio NÃO é pedido de saída', 'ok', null,
      W || format($q$ @@ select pg_temp.chk(not (whatsapp_private.record_inbound(%L, 'w1', 'IN-N', '5511987654321@s.whatsapp.net', 'posso sair mais cedo?') ->> 'opted_out')::boolean, 'saiu indevidamente') $q$, v_A),
      s_conn) || nl;
    r := r || pg_temp.t('W12 entrega/leitura só avança (sent -> delivered -> read; nunca volta)', 'ok', null,
      W || format($q$ @@ select pg_temp.chk(whatsapp_private.record_message_status(%1$L, 'w1', 'OUT-1', 'delivered'), 'delivered')
                @@ select pg_temp.chk(whatsapp_private.record_message_status(%1$L, 'w1', 'OUT-1', 'read'), 'read')
                @@ select pg_temp.chk(not whatsapp_private.record_message_status(%1$L, 'w1', 'OUT-1', 'delivered'), 'voltou') $q$, v_A),
      s_conn || format($q$ @@ insert into whatsapp_private.messages (company_id, direction, wa_message_id, remote_jid, status) values (%L, 'out', 'OUT-1', 'x@s.whatsapp.net', 'sent') $q$, v_A)) || nl;
    r := r || pg_temp.t('W13 desconectado pelo celular: apaga credenciais e QR, limpa número', 'ok', null,
      W || format($q$ @@ select whatsapp_private.set_session_state(%L, 'w1', 'logged_out') $q$, v_A),
      s_conn || format($q$ @@ insert into whatsapp_private.auth (company_id, category, key_id, data) values (%1$L, 'creds', 'creds', gen_random_bytes(64))
                          @@ insert into whatsapp_private.qr (company_id, qr, expires_at) values (%1$L, 'QR-DE-TESTE-123', now() + interval '1 minute') $q$, v_A),
      format($q$ select pg_temp.chk(not exists (select 1 from whatsapp_private.auth where company_id = %1$L)
                 and not exists (select 1 from whatsapp_private.qr where company_id = %1$L)
                 and (select status = 'logged_out' and phone is null from whatsapp_private.sessions where company_id = %1$L), 'logout') $q$, v_A)) || nl;
    r := r || pg_temp.t('W17 cliente respondeu SAIR com mensagem na fila: o worker NÃO pega, o pedido é cancelado', 'ok', null,
      W || $q$ @@ select pg_temp.chk((select count(*) from whatsapp_private.claim_outbox('w1', 10, 60)) = 0, 'pegou mensagem de quem saiu') $q$,
      s_conn || format($q$ @@ insert into whatsapp_private.outbox (company_id, kind, client_id, to_phone, body, idempotency_key)
                values (%L, 'send_text', %L, '5511987654321', 'oi', 'a1')
                @@ update clients set comm_status = 'blocked', comm_status_source = 'client_opt_out' where id = %L $q$, v_A, cU, cU),
      $q$ select pg_temp.chk((select status = 'canceled' and last_error like '%blocked%' from whatsapp_private.outbox where idempotency_key = 'a1'), 'não cancelou') $q$) || nl;
    r := r || pg_temp.t('W18 fila filtrada por tipo: o worker da W2 pega conectar/desconectar e deixa os envios na fila', 'ok', null,
      W || $q$ @@ select pg_temp.chk((select array_agg(kind order by kind) from whatsapp_private.claim_outbox('w1', 10, 60, array['connect','disconnect']))
                                     = array['connect'], 'pegou o tipo errado') $q$,
      s_conn || format($q$ @@ insert into whatsapp_private.outbox (company_id, kind, idempotency_key) values (%1$L, 'connect', 'c1')
                @@ insert into whatsapp_private.outbox (company_id, kind, client_id, to_phone, body, idempotency_key) values (%1$L, 'send_text', %2$L, '5511987654321', 'oi', 'a1') $q$, v_A, cU),
      $q$ select pg_temp.chk((select status from whatsapp_private.outbox where idempotency_key = 'a1') = 'pending', 'envio foi tocado') $q$) || nl;
    r := r || pg_temp.t('W19 desconectado pelo app: apaga credenciais e QR, limpa número', 'ok', null,
      W || format($q$ @@ select whatsapp_private.set_session_state(%L, 'w1', 'disconnected') $q$, v_A),
      s_conn || format($q$ @@ insert into whatsapp_private.auth (company_id, category, key_id, data) values (%1$L, 'creds', 'creds', gen_random_bytes(64)) $q$, v_A),
      format($q$ select pg_temp.chk(not exists (select 1 from whatsapp_private.auth where company_id = %1$L)
                 and (select status = 'disconnected' and phone is null from whatsapp_private.sessions where company_id = %1$L), 'desconexão') $q$, v_A)) || nl;
    r := r || pg_temp.t('W14 worker NÃO chama RPC do app (wa_send_message)', 'fail:42501', null,
      W || format($q$ @@ select wa_send_message(%L, 'oi', 'kw') $q$, cU), s_conn) || nl;
    r := r || pg_temp.t('W15 worker NÃO lê tabela de clientes diretamente', 'fail:42501', null,
      W || $q$ @@ select count(*) from clients $q$) || nl;
    r := r || pg_temp.t('W16 worker NÃO mexe na automação de atendimentos (aurea_private)', 'fail:42501', null,
      W || $q$ @@ select aurea_private.run_auto_conclusion() $q$) || nl;
  end if;

  v_fail := (length(r) - length(replace(r, 'FAIL ', ''))) / 5;
  raise exception E'\n=== RESULTADO 0017 (esta falha é intencional: desfaz os dados de teste) ===\n%\nLINHAS "FAIL": %\n', r, v_fail;
end
$do$;
