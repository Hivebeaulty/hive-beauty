-- ---------------------------------------------------------------------------
-- 0038 — SUPERADMIN (Fases 1 e 2): acesso seguro, gestão das contas e auditoria.
--
-- QUEM É SUPERADMIN: só quem está na tabela superadmins (0001) E está numa sessão
-- com verificação em duas etapas (MFA TOTP, claim aal = 'aal2' do JWT do Supabase).
-- Ninguém entra na tabela por esta migration nem por nenhuma tela: o primeiro
-- cadastro é manual, no SQL Editor do Supabase (ver README, "Superadmin").
--
-- O QUE MUDA:
--   1. superadmins: anon/authenticated perdem INSERT/UPDATE/DELETE (o RLS já
--      barrava; agora o privilégio também). Fica só a leitura da própria linha.
--   2. RLS: a superadmin deixa de poder ESCREVER em companies/company_members
--      pela sessão do navegador (antes podia até apagar empresas). Leitura segue.
--      Toda ação administrativa passa a ser por funções admin_* auditadas.
--   3. admin_account_flags (suspensão), admin_notes (observações) e
--      admin_audit_log (somente inclusão: nem a service role altera ou apaga).
--   4. get_company_access: conta suspensa => bloqueada (status 'suspended').
--      Suspender NÃO apaga nada e NÃO mexe na assinatura nem no Mercado Pago.
--   5. Funções admin_* (security definer): cada uma confere superadmin + MFA
--      dentro do banco, a cada chamada. O navegador nunca recebe service role.
-- Não altera agenda, clientes, financeiro das profissionais, WhatsApp nem cobrança.
-- ---------------------------------------------------------------------------

-- 1. superadmins: só leitura da própria linha ------------------------------------
revoke all on superadmins from anon, authenticated;
grant select on superadmins to authenticated;

-- 2. RLS: superadmin não escreve mais direto nas tabelas das empresas -------------
drop policy if exists "companies_superadmin_all" on companies;
alter policy "companies_update" on companies using (is_company_admin(id));
alter policy "members_manage" on company_members with check (is_company_admin(company_id));
alter policy "members_update" on company_members using (is_company_admin(company_id));
alter policy "members_delete" on company_members using (is_company_admin(company_id));

-- 3. Tabelas administrativas -----------------------------------------------------
create table if not exists admin_account_flags (
  company_id       uuid primary key references companies (id) on delete cascade,
  suspended_at     timestamptz,
  suspended_reason text,
  suspended_by     uuid,
  updated_at       timestamptz not null default now()
);

create table if not exists admin_notes (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  author_id  uuid not null,
  body       text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists admin_notes_company_idx on admin_notes (company_id, created_at desc);

-- Sem FK para companies: o registro sobrevive mesmo se a empresa for excluída.
create table if not exists admin_audit_log (
  id             bigint generated always as identity primary key,
  at             timestamptz not null default now(),
  admin_id       uuid not null,
  action         text not null,
  company_id     uuid,
  result         text not null default 'ok' check (result in ('ok', 'noop', 'error')),
  reason         text,
  details        jsonb not null default '{}'::jsonb,
  correlation_id uuid not null default gen_random_uuid()
);
create index if not exists admin_audit_at_idx on admin_audit_log (at desc);
create index if not exists admin_audit_company_idx on admin_audit_log (company_id, at desc);

alter table admin_account_flags enable row level security;
alter table admin_notes enable row level security;
alter table admin_audit_log enable row level security;
revoke all on admin_account_flags, admin_notes, admin_audit_log from public, anon, authenticated;

create or replace function admin_audit_immutable() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'O registro de auditoria não pode ser alterado nem apagado.' using errcode = '42501';
end;
$$;
drop trigger if exists admin_audit_no_update on admin_audit_log;
create trigger admin_audit_no_update before update or delete on admin_audit_log
  for each row execute function admin_audit_immutable();

-- 4. Autorização -----------------------------------------------------------------
-- Quem sou eu? (só a própria situação; usada pelo app para decidir a tela)
create or replace function admin_whoami()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'is_superadmin', auth.uid() is not null and is_superadmin(),
    'aal', coalesce(auth.jwt() ->> 'aal', 'aal1'),
    'mfa_ok', coalesce(auth.jwt() ->> 'aal', '') = 'aal2');
$$;

-- Trava de TODA função admin_*: superadmin + sessão com MFA.
create or replace function admin_assert()
returns void language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  if not is_superadmin() then raise exception 'Acesso restrito.' using errcode = '42501'; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Confirme o acesso com a verificação em duas etapas.' using errcode = 'AUA01';
  end if;
end;
$$;

create or replace function admin_log(p_action text, p_company_id uuid, p_result text, p_reason text, p_details jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v uuid;
begin
  insert into admin_audit_log (admin_id, action, company_id, result, reason, details)
  values (auth.uid(), p_action, p_company_id, coalesce(p_result, 'ok'), nullif(btrim(coalesce(p_reason, '')), ''),
          coalesce(p_details, '{}'::jsonb))
  returning correlation_id into v;
  return v;
end;
$$;

-- 5. Acesso das contas: suspensão vence a assinatura (dados continuam guardados) --
create or replace function get_company_access(p_company_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_status text;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  if not is_company_member(p_company_id) then raise exception 'Empresa não encontrada.' using errcode = 'P0002'; end if;
  if exists (select 1 from admin_account_flags f where f.company_id = p_company_id and f.suspended_at is not null) then
    return jsonb_build_object('status', 'suspended', 'allowed', false, 'warning', false);
  end if;
  select b.status into v_status
  from company_members m join auth.users u on u.id = m.user_id join billing_accounts b on b.email = lower(u.email)
  where m.company_id = p_company_id and m.role = 'owner' and m.active
  order by array_position(array['free', 'active', 'trialing', 'past_due', 'pending', 'canceled'], b.status) limit 1;
  v_status := coalesce(v_status, 'none');
  return jsonb_build_object('status', v_status, 'allowed', v_status in ('free', 'trialing', 'active', 'past_due'),
                            'warning', v_status = 'past_due');
end;
$$;
revoke all on function get_company_access(uuid) from public, anon;
grant execute on function get_company_access(uuid) to authenticated;

-- 6. Base comum das consultas: uma linha por empresa -------------------------------
-- Situação da assinatura = a MESMA regra de get_company_access (pela dona ativa).
create or replace function admin_accounts_base()
returns table (
  company_id uuid, company_name text, is_demo boolean, created_at timestamptz,
  owner_id uuid, owner_name text, owner_email text, owner_last_sign_in timestamptz,
  billing_status text, billing_provider text, next_payment_at timestamptz, billing_updated_at timestamptz,
  suspended boolean, appointments_count bigint, clients_count bigint, services_count bigint,
  last_activity_at timestamptz, whatsapp_status text)
language sql stable security definer set search_path = public, pg_temp as $$
  select c.id, c.name, coalesce(c.is_demo, false), c.created_at,
         o.user_id, o.full_name, o.email, o.last_sign_in_at,
         coalesce(b.status, 'none'), b.provider, b.next_payment_at, b.updated_at,
         coalesce(f.suspended_at is not null, false),
         (select count(*) from appointments a where a.company_id = c.id),
         (select count(*) from clients cl where cl.company_id = c.id and cl.archived_at is null),
         (select count(*) from services s where s.company_id = c.id and s.active),
         (select max(a.created_at) from appointments a where a.company_id = c.id),
         (select ws.status from whatsapp_private.sessions ws where ws.company_id = c.id)
  from companies c
  left join lateral (
    select m.user_id, u.email::text as email, u.last_sign_in_at,
           coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(u.raw_user_meta_data ->> 'full_name'), '')) as full_name
    from company_members m join auth.users u on u.id = m.user_id left join profiles p on p.id = m.user_id
    where m.company_id = c.id and m.role = 'owner' and m.active
    order by m.created_at limit 1
  ) o on true
  left join lateral (
    select bb.* from company_members m join auth.users u on u.id = m.user_id join billing_accounts bb on bb.email = lower(u.email)
    where m.company_id = c.id and m.role = 'owner' and m.active
    order by array_position(array['free', 'active', 'trialing', 'past_due', 'pending', 'canceled'], bb.status) limit 1
  ) b on true
  left join admin_account_flags f on f.company_id = c.id;
$$;
revoke all on function admin_accounts_base() from public, anon, authenticated;

-- 7. Visão geral -------------------------------------------------------------------
-- MRR ESTIMADO = assinaturas 'active' (pagas, recorrentes) × preço do plano.
-- Cortesia (free), teste (trialing), atrasada (past_due), pendente e cancelada NÃO entram.
-- O preço vem do parâmetro (o app manda o preço do plano). Sem histórico de
-- pagamentos gravado ainda, receita RECEBIDA não é calculada aqui.
create or replace function admin_overview(p_from timestamptz, p_to timestamptz, p_plan_price numeric default 59.90)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_len interval := p_to - p_from;
  r jsonb;
begin
  perform admin_assert();
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'Período inválido.' using errcode = '22023';
  end if;
  with b as (select * from admin_accounts_base() where not is_demo)
  select jsonb_build_object(
    'total', (select count(*) from b),
    'demo', (select count(*) from admin_accounts_base() where is_demo),
    'suspended', (select count(*) from b where suspended),
    'by_status', (select coalesce(jsonb_object_agg(billing_status, n), '{}'::jsonb)
                  from (select billing_status, count(*) n from b group by 1) s),
    'trials_ending_3d', (select count(*) from b where billing_status = 'trialing'
                          and next_payment_at between now() and now() + interval '3 days'),
    'new_in_period', (select count(*) from b where created_at >= p_from and created_at < p_to),
    'new_prev_period', (select count(*) from b where created_at >= p_from - v_len and created_at < p_from),
    'mrr_estimated', round((select count(*) from b where billing_status = 'active') * p_plan_price, 2),
    'plan_price', p_plan_price,
    'signups_by_month', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'), 'count', n) order by m), '[]'::jsonb)
                         from (select gs as m, (select count(*) from b where date_trunc('month', b.created_at at time zone 'America/Sao_Paulo') = gs) n
                               from generate_series(date_trunc('month', (now() at time zone 'America/Sao_Paulo') - interval '11 months'),
                                                    date_trunc('month', now() at time zone 'America/Sao_Paulo'), interval '1 month') gs) x),
    'billing_since', (select min(updated_at) from billing_accounts where provider = 'mercadopago')
  ) into r;
  return r;
end;
$$;

-- 8. Lista de contas (busca, filtros, ordem, paginação) ------------------------------
create or replace function admin_list_accounts(
  p_search text default null, p_billing text default null, p_suspended boolean default null,
  p_from timestamptz default null, p_to timestamptz default null,
  p_order text default 'created_desc', p_limit int default 25, p_offset int default 0,
  p_include_demo boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_q text := nullif(btrim(coalesce(p_search, '')), '');
  v_limit int := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  r jsonb;
begin
  perform admin_assert();
  with f as (
    select * from admin_accounts_base() a
    where (v_q is null or a.company_name ilike '%' || v_q || '%' or a.owner_name ilike '%' || v_q || '%'
           or a.owner_email ilike '%' || v_q || '%')
      and (p_billing is null or a.billing_status = p_billing)
      and (p_suspended is null or a.suspended = p_suspended)
      and (p_from is null or a.created_at >= p_from)
      and (p_to is null or a.created_at < p_to)
      and (p_include_demo or not a.is_demo)   -- contas de demonstração só quando pedidas
  )
  select jsonb_build_object(
    'total', (select count(*) from f),
    'rows', coalesce((select jsonb_agg(to_jsonb(x)) from (
      select * from f
      order by
        case when p_order = 'created_asc' then created_at end asc,
        case when p_order = 'activity_desc' then coalesce(last_activity_at, owner_last_sign_in) end desc nulls last,
        case when p_order = 'name_asc' then lower(company_name) end asc,
        created_at desc
      limit v_limit offset v_offset) x), '[]'::jsonb)
  ) into r;
  return r;
end;
$$;

-- Exportação: mesmos filtros, até 5000 linhas, SEMPRE registrada na auditoria.
create or replace function admin_export_accounts(
  p_search text default null, p_billing text default null, p_suspended boolean default null,
  p_from timestamptz default null, p_to timestamptz default null, p_include_demo boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  perform admin_assert();
  r := admin_list_accounts(p_search, p_billing, p_suspended, p_from, p_to, 'created_desc', 100, 0, p_include_demo);
  -- admin_list_accounts limita a 100 por página; a exportação junta as páginas
  select jsonb_build_object('total', (r ->> 'total')::int, 'rows', coalesce(jsonb_agg(row_data), '[]'::jsonb))
  into r
  from (
    select jsonb_array_elements(admin_list_accounts(p_search, p_billing, p_suspended, p_from, p_to, 'created_desc', 100, off, p_include_demo) -> 'rows') as row_data
    from generate_series(0, least((r ->> 'total')::int, 5000) - 1, 100) off
  ) pages;
  perform admin_log('export_accounts', null, 'ok', null, jsonb_build_object(
    'rows', jsonb_array_length(r -> 'rows'),
    'filters', jsonb_strip_nulls(jsonb_build_object('search', p_search, 'billing', p_billing, 'suspended', p_suspended, 'from', p_from, 'to', p_to,
                                                'demo', nullif(p_include_demo, false)))));
  return r;
end;
$$;

-- 9. Ficha da conta ----------------------------------------------------------------
-- Minimização: nada das clientes finais além de contagens; equipe sem e-mail;
-- WhatsApp sem credenciais (só situação e datas). Cada abertura é auditada.
create or replace function admin_get_account(p_company_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a record;
  r jsonb;
begin
  perform admin_assert();
  select * into a from admin_accounts_base() where company_id = p_company_id;
  if not found then raise exception 'Conta não encontrada.' using errcode = 'P0002'; end if;

  select jsonb_build_object(
    'account', to_jsonb(a),
    'company', (select jsonb_build_object('phone', c.phone, 'email', c.email, 'plan', c.plan, 'legacy_status', c.status)
                from companies c where c.id = p_company_id),
    'owner', (select jsonb_build_object('created_at', u.created_at, 'email_confirmed_at', u.email_confirmed_at,
                                        'last_sign_in_at', u.last_sign_in_at, 'banned_until', u.banned_until)
              from auth.users u where u.id = a.owner_id),
    'billing', (select jsonb_build_object('status', b.status, 'provider', b.provider, 'preapproval_id', b.preapproval_id,
                                          'next_payment_at', b.next_payment_at, 'updated_at', b.updated_at)
                from billing_accounts b where b.email = lower(a.owner_email)),
    'suspension', (select jsonb_build_object('suspended_at', f.suspended_at, 'reason', f.suspended_reason, 'updated_at', f.updated_at)
                   from admin_account_flags f where f.company_id = p_company_id),
    'team', (select coalesce(jsonb_agg(jsonb_build_object(
                'role', m.role, 'active', m.active, 'since', m.created_at,
                'name', coalesce(nullif(btrim(p.full_name), ''), 'Sem nome')) order by m.created_at), '[]'::jsonb)
             from company_members m left join profiles p on p.id = m.user_id where m.company_id = p_company_id),
    'usage', jsonb_build_object(
      'appointments_total', (select count(*) from appointments x where x.company_id = p_company_id),
      'appointments_30d', (select count(*) from appointments x where x.company_id = p_company_id and x.created_at > now() - interval '30 days'),
      'appointments_upcoming', (select count(*) from appointments x where x.company_id = p_company_id
                                 and x.scheduled_start >= now() and x.status in ('agendado', 'confirmado')),
      'first_appointment_at', (select min(x.created_at) from appointments x where x.company_id = p_company_id),
      'last_appointment_at', (select max(x.created_at) from appointments x where x.company_id = p_company_id),
      'clients', (select count(*) from clients x where x.company_id = p_company_id and x.archived_at is null),
      'services', (select count(*) from services x where x.company_id = p_company_id and x.active),
      'team_active', (select count(*) from company_members x where x.company_id = p_company_id and x.active)),
    'whatsapp', (select jsonb_build_object('status', s.status, 'connected_at', s.connected_at, 'last_seen_at', s.last_seen_at,
                                           'auto_confirmation', s.auto_confirmation, 'reminder', s.reminder)
                 from whatsapp_private.sessions s where s.company_id = p_company_id),
    'notes', (select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'body', n.body, 'at', n.created_at) order by n.created_at desc), '[]'::jsonb)
              from admin_notes n where n.company_id = p_company_id),
    'audit', (select coalesce(jsonb_agg(jsonb_build_object('at', l.at, 'action', l.action, 'result', l.result, 'reason', l.reason,
                                                            'details', l.details) order by l.at desc), '[]'::jsonb)
              from (select * from admin_audit_log where company_id = p_company_id order by at desc limit 50) l)
  ) into r;
  perform admin_log('view_account', p_company_id, 'ok', null, '{}'::jsonb);
  return r;
end;
$$;

-- 10. Ações ------------------------------------------------------------------------
-- Suspender/reativar: só bloqueia/libera o acesso ao app. Não apaga dados, não
-- cancela nem cria cobrança no Mercado Pago, não altera billing_accounts.
create or replace function admin_set_suspension(p_company_id uuid, p_suspend boolean, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_was boolean;
  v_corr uuid;
begin
  perform admin_assert();
  if not exists (select 1 from companies where id = p_company_id) then
    raise exception 'Conta não encontrada.' using errcode = 'P0002';
  end if;
  if v_reason is null or char_length(v_reason) < 5 or char_length(v_reason) > 500 then
    raise exception 'Informe o motivo (de 5 a 500 caracteres).' using errcode = '22023';
  end if;
  select coalesce(suspended_at is not null, false) into v_was from admin_account_flags where company_id = p_company_id;
  v_was := coalesce(v_was, false);
  if v_was = p_suspend then
    v_corr := admin_log(case when p_suspend then 'suspend' else 'reactivate' end, p_company_id, 'noop', v_reason,
                        jsonb_build_object('was_suspended', v_was));
    return jsonb_build_object('suspended', v_was, 'changed', false, 'correlation_id', v_corr);
  end if;
  insert into admin_account_flags (company_id, suspended_at, suspended_reason, suspended_by, updated_at)
  values (p_company_id, case when p_suspend then now() end, case when p_suspend then v_reason end,
          case when p_suspend then auth.uid() end, now())
  on conflict (company_id) do update
    set suspended_at = excluded.suspended_at, suspended_reason = excluded.suspended_reason,
        suspended_by = excluded.suspended_by, updated_at = now();
  v_corr := admin_log(case when p_suspend then 'suspend' else 'reactivate' end, p_company_id, 'ok', v_reason,
                      jsonb_build_object('was_suspended', v_was));
  return jsonb_build_object('suspended', p_suspend, 'changed', true, 'correlation_id', v_corr);
end;
$$;

create or replace function admin_add_note(p_company_id uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_body text := btrim(coalesce(p_body, ''));
begin
  perform admin_assert();
  if not exists (select 1 from companies where id = p_company_id) then
    raise exception 'Conta não encontrada.' using errcode = 'P0002';
  end if;
  if char_length(v_body) < 1 or char_length(v_body) > 2000 then
    raise exception 'A observação precisa ter de 1 a 2000 caracteres.' using errcode = '22023';
  end if;
  insert into admin_notes (company_id, author_id, body) values (p_company_id, auth.uid(), v_body) returning id into v_id;
  perform admin_log('add_note', p_company_id, 'ok', null, jsonb_build_object('note_id', v_id));
  return jsonb_build_object('id', v_id);
end;
$$;

-- 11. Auditoria (leitura) ----------------------------------------------------------
create or replace function admin_list_audit(p_company_id uuid default null, p_action text default null,
                                            p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  perform admin_assert();
  with f as (
    select l.*, c.name as company_name, coalesce(nullif(btrim(p.full_name), ''), u.email::text) as admin_name
    from admin_audit_log l
    left join companies c on c.id = l.company_id
    left join auth.users u on u.id = l.admin_id
    left join profiles p on p.id = l.admin_id
    where (p_company_id is null or l.company_id = p_company_id) and (p_action is null or l.action = p_action)
  )
  select jsonb_build_object(
    'total', (select count(*) from f),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('at', at, 'action', action, 'result', result, 'reason', reason,
                                                          'company_id', company_id, 'company_name', company_name,
                                                          'admin_name', admin_name, 'details', details,
                                                          'correlation_id', correlation_id) order by at desc)
                      from (select * from f order by at desc
                            limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) x), '[]'::jsonb)
  ) into r;
  return r;
end;
$$;

-- 12. Permissões das funções -------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'admin_whoami()', 'admin_assert()', 'admin_overview(timestamptz, timestamptz, numeric)',
    'admin_list_accounts(text, text, boolean, timestamptz, timestamptz, text, int, int, boolean)',
    'admin_export_accounts(text, text, boolean, timestamptz, timestamptz, boolean)',
    'admin_get_account(uuid)', 'admin_set_suspension(uuid, boolean, text)', 'admin_add_note(uuid, text)',
    'admin_list_audit(uuid, text, int, int)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  -- internas: ninguém chama direto
  revoke all on function admin_log(text, uuid, text, text, jsonb) from public, anon, authenticated;
  revoke all on function admin_audit_immutable() from public, anon, authenticated;
end $$;

notify pgrst, 'reload schema';
