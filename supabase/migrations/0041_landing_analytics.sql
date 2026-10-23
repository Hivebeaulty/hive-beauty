-- ---------------------------------------------------------------------------
-- 0041 — FASE 4: medição da landing (sem cookies, sem dados pessoais) e funil.
--
-- O site envia eventos para a função `track` (Edge Function pública). Ela calcula
-- um identificador de visitante DO DIA: sha256(sal do dia + IP + navegador),
-- truncado. O sal é aleatório, muda todo dia e o de ontem é apagado no dia
-- seguinte: depois disso ninguém (nem nós) consegue refazer o identificador.
-- NÃO é gravado: IP, navegador completo, nome, e-mail, telefone, endereço completo
-- da página de origem nem cookie. Só: evento, página, domínio de origem, UTM,
-- tipo de aparelho e botão clicado.
-- Retenção: 24 meses (limpeza diária).
--
-- Funil no painel (admin_funnel): visitantes → cliques para assinar → testes
-- iniciados → primeiro pagamento → pagantes ativas. As três últimas etapas vêm da
-- cobrança (0039). O link do checkout é o mesmo para todas, então o funil compara
-- TOTAIS do período; a origem (UTM/site) fica medida até o clique.
--
-- Também: cancelamento mantém o acesso até o fim do período já pago (ver o fim do arquivo).
-- ---------------------------------------------------------------------------

create table if not exists analytics_salts (
  day  date primary key,
  salt text not null
);

create table if not exists analytics_events (
  id            bigint generated always as identity primary key,
  at            timestamptz not null default now(),
  day           date not null default (now() at time zone 'America/Sao_Paulo')::date,
  event         text not null check (event in ('pageview', 'cta_click', 'whatsapp_click', 'login_click')),
  path          text not null check (char_length(path) <= 120),
  visitor       text not null check (visitor ~ '^[0-9a-f]{16}$'),
  referrer_host text check (char_length(referrer_host) <= 100),
  utm_source    text check (char_length(utm_source) <= 60),
  utm_medium    text check (char_length(utm_medium) <= 60),
  utm_campaign  text check (char_length(utm_campaign) <= 100),
  device        text not null check (device in ('mobile', 'tablet', 'desktop')),
  cta           text check (char_length(cta) <= 40)
);
create index if not exists analytics_events_day_idx on analytics_events (day, event);
create index if not exists analytics_events_visitor_idx on analytics_events (day, visitor);

alter table analytics_salts enable row level security;
alter table analytics_events enable row level security;
revoke all on analytics_salts, analytics_events from public, anon, authenticated;

-- Sal do dia (fuso de Brasília). Cria se não existir, apaga os anteriores a ontem
-- (ontem fica só para eventos que cruzam a meia-noite) e aplica a retenção.
create or replace function analytics_daily_salt()
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_day date := (now() at time zone 'America/Sao_Paulo')::date;
  v text;
begin
  select salt into v from analytics_salts where day = v_day;
  if v is null then
    insert into analytics_salts (day, salt) values (v_day, encode(sha256((gen_random_uuid()::text || gen_random_uuid()::text)::bytea), 'hex'))
    on conflict (day) do nothing;
    select salt into v from analytics_salts where day = v_day;
    delete from analytics_salts where day < v_day - 1;
    delete from analytics_events where at < now() - interval '24 months';
  end if;
  return v;
end;
$$;

-- Grava um evento já validado pela função `track`. Revalida tudo aqui (lista fechada
-- de eventos, tamanhos, formato do visitante) e limita 300 eventos por visitante/dia.
create or replace function analytics_ingest(p jsonb)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_day date := (now() at time zone 'America/Sao_Paulo')::date;
  v_visitor text := p ->> 'visitor';
  v_event text := p ->> 'event';
  clean text;
begin
  if v_event is null or v_event not in ('pageview', 'cta_click', 'whatsapp_click', 'login_click') then return false; end if;
  if v_visitor is null or v_visitor !~ '^[0-9a-f]{16}$' then return false; end if;
  if (select count(*) from analytics_events where day = v_day and visitor = v_visitor) >= 300 then return false; end if;
  insert into analytics_events (event, path, visitor, referrer_host, utm_source, utm_medium, utm_campaign, device, cta)
  values (
    v_event,
    left(coalesce(nullif(regexp_replace(coalesce(p ->> 'path', '/'), '[^a-zA-Z0-9/_-]', '', 'g'), ''), '/'), 120),
    v_visitor,
    nullif(left(lower(regexp_replace(coalesce(p ->> 'referrer_host', ''), '[^a-zA-Z0-9.-]', '', 'g')), 100), ''),
    nullif(left(lower(btrim(coalesce(p ->> 'utm_source', ''))), 60), ''),
    nullif(left(lower(btrim(coalesce(p ->> 'utm_medium', ''))), 60), ''),
    nullif(left(btrim(coalesce(p ->> 'utm_campaign', '')), 100), ''),
    case when p ->> 'device' in ('mobile', 'tablet', 'desktop') then p ->> 'device' else 'desktop' end,
    nullif(left(regexp_replace(lower(coalesce(p ->> 'cta', '')), '[^a-z0-9_-]', '', 'g'), 40), '')
  );
  return true;
end;
$$;

revoke all on function analytics_daily_salt() from public, anon, authenticated;
revoke all on function analytics_ingest(jsonb) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function analytics_daily_salt() to service_role;
    grant execute on function analytics_ingest(jsonb) to service_role;
  end if;
end $$;

-- Funil do painel ----------------------------------------------------------------------
-- Origem de uma visita: utm_source, senão o domínio de onde veio, senão "direto".
-- Visitante = identificador do dia; "visitantes" no período = soma dos únicos de cada dia.
create or replace function admin_funnel(p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  perform admin_assert();
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'Período inválido.' using errcode = '22023';
  end if;
  with
  ev as (select *, coalesce(utm_source, referrer_host, 'direto') as origin from analytics_events where at >= p_from and at < p_to),
  vis as (select distinct day, visitor from ev where event = 'pageview' and path = '/'),
  clk as (select distinct day, visitor from ev where event = 'cta_click'),
  first_ev as (select distinct on (preapproval_id) preapproval_id, status, occurred_at
               from billing_subscription_events order by preapproval_id, occurred_at, id),
  first_pay as (select preapproval_id, min(paid_at) as at from billing_payments
                where status in ('approved', 'refunded', 'charged_back') group by preapproval_id)
  select jsonb_build_object(
    'measuring_since', (select min(at) from analytics_events),
    'visitors', (select count(*) from vis),
    'pageviews', (select count(*) from ev where event = 'pageview'),
    'clickers', (select count(*) from clk),
    'cta_clicks', (select count(*) from ev where event = 'cta_click'),
    'whatsapp_clicks', (select count(*) from ev where event = 'whatsapp_click'),
    'login_clicks', (select count(*) from ev where event = 'login_click'),
    'trials_started', (select count(*) from first_ev where status = 'trialing' and occurred_at >= p_from and occurred_at < p_to),
    'first_payments', (select count(*) from first_pay where at >= p_from and at < p_to),
    'paying_now', (select count(*) from billing_accounts where provider = 'mercadopago' and status = 'active'),
    'by_origin', (select coalesce(jsonb_agg(x order by x ->> 'visitors' desc), '[]'::jsonb) from (
        select jsonb_build_object('origin', o.origin,
          'visitors', (select count(distinct (e.day, e.visitor)) from ev e where e.origin = o.origin and e.event = 'pageview' and e.path = '/'),
          'clickers', (select count(distinct (e.day, e.visitor)) from ev e where e.origin = o.origin and e.event = 'cta_click')) x
        from (select distinct origin from ev) o) t),
    'by_device', (select coalesce(jsonb_object_agg(device, n), '{}'::jsonb) from (
        select device, count(distinct (day, visitor)) n from ev where event = 'pageview' and path = '/' group by 1) d),
    'by_cta', (select coalesce(jsonb_object_agg(cta, n), '{}'::jsonb) from (
        select coalesce(cta, 'sem_nome') cta, count(*) n from ev where event = 'cta_click' group by 1) c),
    'by_campaign', (select coalesce(jsonb_agg(jsonb_build_object('campaign', utm_campaign, 'source', utm_source,
                        'visitors', v, 'clickers', c) order by v desc), '[]'::jsonb) from (
        select utm_campaign, utm_source,
               count(distinct (day, visitor)) filter (where event = 'pageview' and path = '/') v,
               count(distinct (day, visitor)) filter (where event = 'cta_click') c
        from ev where utm_campaign is not null group by 1, 2) k),
    'by_day', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'visitors', v, 'clickers', c) order by d), '[]'::jsonb) from (
        select day d, count(distinct visitor) filter (where event = 'pageview' and path = '/') v,
               count(distinct visitor) filter (where event = 'cta_click') c
        from ev group by day) z)
  ) into r;
  return r;
end;
$$;
revoke all on function admin_funnel(timestamptz, timestamptz) from public, anon;
grant execute on function admin_funnel(timestamptz, timestamptz) to authenticated;

-- Cancelamento com acesso até o fim do período pago -------------------------------------
-- Termos de Uso: cancelar não gera reembolso proporcional, então o acesso continua até
-- o fim do mês já pago (último pagamento aprovado + 1 mês). Cancelou no teste grátis
-- (nada pago): bloqueia na hora, como antes. Status novo para o app: 'ending' (liberado,
-- com aviso e a data 'until').
create or replace function get_company_access(p_company_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_status text; v_email text; v_until timestamptz;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  if not is_company_member(p_company_id) then raise exception 'Empresa não encontrada.' using errcode = 'P0002'; end if;
  if exists (select 1 from admin_account_flags f where f.company_id = p_company_id and f.suspended_at is not null) then
    return jsonb_build_object('status', 'suspended', 'allowed', false, 'warning', false);
  end if;
  select b.status, b.email into v_status, v_email
  from company_members m join auth.users u on u.id = m.user_id join billing_accounts b on b.email = lower(u.email)
  where m.company_id = p_company_id and m.role = 'owner' and m.active
  order by array_position(array['free', 'active', 'trialing', 'past_due', 'pending', 'canceled'], b.status) limit 1;
  v_status := coalesce(v_status, 'none');
  if v_status = 'canceled' then
    select max(paid_at) + interval '1 month' into v_until from billing_payments
    where email = v_email and status in ('approved', 'refunded') and amount > refunded_amount;
    if v_until > now() then
      return jsonb_build_object('status', 'ending', 'allowed', true, 'warning', true, 'until', v_until);
    end if;
  end if;
  return jsonb_build_object('status', v_status, 'allowed', v_status in ('free', 'trialing', 'active', 'past_due'),
                            'warning', v_status = 'past_due');
end;
$$;
revoke all on function get_company_access(uuid) from public, anon;
grant execute on function get_company_access(uuid) to authenticated;

notify pgrst, 'reload schema';
