-- ---------------------------------------------------------------------------
-- 0049 — Aviso semanal de clientes sumidas (notificação push).
--
-- Toda segunda-feira, a partir das 9h (Brasília), cada membro que tem aparelho inscrito recebe UM
-- aviso com quantas clientes passaram da hora de voltar ("Sumidas" da tela de Clientes), orientando
-- a abrir a lista e entrar em contato. Só se houver pelo menos 1 sumida. Cada pessoa pode desligar
-- (push_prefs.overdue_clients_alert). A contagem usa a MESMA regra de lib/hive/relationship.ts e é
-- feita pela Edge Function push-appointment-alerts; aqui ficam a reserva semanal (sem repetir) e as
-- chamadas de ligar/desligar. Idempotente; nenhum dado existente é alterado.
--
--   push_weekly_log : avisos semanais já reservados (membro + tipo + segunda-feira da semana).
--   push_claim_weekly_overdue(p_force_member) : quem deve receber agora (service_role). Com
--     p_force_member, ignora o dia/hora e o limite semanal e devolve só esse membro (teste manual).
-- ---------------------------------------------------------------------------

alter table push_prefs add column if not exists overdue_clients_alert boolean not null default true;

create table if not exists push_weekly_log (
  member_id  uuid not null references company_members(id) on delete cascade,
  kind       text not null,
  week_start date not null,
  sent_at    timestamptz not null default now(),
  primary key (member_id, kind, week_start)
);
alter table push_weekly_log enable row level security;
revoke all on push_weekly_log from public, anon, authenticated;

-- --- Chamadas da profissional (sessão logada) ------------------------------------------------

create or replace function push_get_overdue_alert(p_member_id uuid)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v boolean;
begin
  if auth.uid() is null then raise exception 'Não autenticado'; end if;
  if not exists (select 1 from company_members m where m.id = p_member_id and m.user_id = auth.uid() and m.active) then
    raise exception 'Sem permissão';
  end if;
  select pp.overdue_clients_alert into v from push_prefs pp where pp.member_id = p_member_id;
  return coalesce(v, true);
end;
$$;

create or replace function push_set_overdue_alert(p_member_id uuid, p_enabled boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Não autenticado'; end if;
  if not exists (select 1 from company_members m where m.id = p_member_id and m.user_id = auth.uid() and m.active) then
    raise exception 'Sem permissão';
  end if;
  insert into push_prefs (member_id, overdue_clients_alert, updated_at)
  values (p_member_id, coalesce(p_enabled, true), now())
  on conflict (member_id) do update set overdue_clients_alert = excluded.overdue_clients_alert, updated_at = now();
end;
$$;

-- --- Chamada da Edge Function (service_role) --------------------------------------------------

-- Segunda-feira (Brasília), das 9h às 20h: reserva (na mesma instrução) o aviso da semana de cada
-- membro ativo com aparelho inscrito e que não desligou, e devolve os aparelhos. Duas execuções ao
-- mesmo tempo não reservam o mesmo aviso. Se a função ficar fora do ar na segunda, a semana passa.
create or replace function push_claim_weekly_overdue(p_force_member uuid default null)
returns table (out_member_id uuid, out_company_id uuid, subs jsonb)
language sql security definer set search_path = public, pg_temp as $$
  with lt as (select (now() at time zone 'America/Sao_Paulo') as t),
  gate as (
    select (extract(isodow from t) = 1 and t::time >= time '09:00' and t::time < time '20:00') as ok,
           (t::date - (extract(isodow from t)::int - 1)) as week_start
    from lt
  ),
  due as (
    select m.id as mid, m.company_id as cid, m.user_id as uid, g.week_start as wk
    from company_members m
    join companies co on co.id = m.company_id and co.status <> 'inativa'
    left join push_prefs pp on pp.member_id = m.id
    cross join gate g
    where m.active
      and coalesce(pp.overdue_clients_alert, true)
      and exists (select 1 from push_subscriptions ps where ps.user_id = m.user_id)
      and (
        (p_force_member is null and g.ok
          and not exists (select 1 from push_weekly_log w where w.member_id = m.id and w.kind = 'overdue_clients' and w.week_start = g.week_start))
        or (p_force_member is not null and m.id = p_force_member)
      )
  ),
  claimed as (
    insert into push_weekly_log (member_id, kind, week_start)
    select mid, 'overdue_clients', wk from due where p_force_member is null
    on conflict do nothing
    returning member_id
  )
  select d.mid, d.cid,
         (select jsonb_agg(jsonb_build_object('id', ps.id, 'endpoint', ps.endpoint, 'p256dh', ps.p256dh, 'auth_key', ps.auth_key))
            from push_subscriptions ps where ps.user_id = d.uid)
  from due d
  left join claimed k on k.member_id = d.mid
  where p_force_member is not null or k.member_id is not null;
$$;

revoke all on function push_get_overdue_alert(uuid) from public, anon, authenticated;
revoke all on function push_set_overdue_alert(uuid, boolean) from public, anon, authenticated;
revoke all on function push_claim_weekly_overdue(uuid) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function push_get_overdue_alert(uuid) to authenticated;
    grant execute on function push_set_overdue_alert(uuid, boolean) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function push_claim_weekly_overdue(uuid) to service_role;
  end if;
end $$;
