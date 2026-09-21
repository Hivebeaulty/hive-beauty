-- ============================================================================
-- HIVE BEAUTY — SCHEMA INICIAL (Fase 1: Fundação)
-- Postgres (Supabase). Multi-tenant via company_id + Row Level Security.
-- ============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "btree_gist"; -- exclusion constraint em agenda

-- ---------------------------------------------------------------------------
-- ENUMS
-- ---------------------------------------------------------------------------
create type member_role as enum ('owner', 'admin', 'professional', 'reception');
create type appointment_status as enum (
  'agendado', 'confirmado', 'em_atendimento', 'concluido', 'cancelado', 'nao_compareceu'
);
create type payment_status as enum ('pago', 'pendente', 'parcial');
create type payment_method as enum ('pix', 'dinheiro', 'cartao', 'outro');
create type company_status as enum ('ativa', 'inativa', 'trial');

-- ---------------------------------------------------------------------------
-- NICHOS (catálogo global, não é multi-tenant)
-- ---------------------------------------------------------------------------
create table niches (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  sort_order int not null default 0
);

insert into niches (slug, name, sort_order) values
  ('nail_designer', 'Nail Designer', 1),
  ('lash_designer', 'Lash Designer', 2),
  ('sobrancelhas', 'Designer de Sobrancelhas', 3),
  ('estetica', 'Estética', 4),
  ('laser', 'Laser', 5),
  ('salao', 'Salão de Beleza', 6),
  ('maquiagem', 'Maquiagem', 7),
  ('cabeleireiro', 'Cabeleireiro', 8),
  ('outro', 'Outro', 9);

-- ---------------------------------------------------------------------------
-- PERFIS (1:1 com auth.users)
-- ---------------------------------------------------------------------------
create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  phone text,
  avatar_url text,
  created_at timestamptz not null default now()
);

-- cria profile automaticamente quando um usuário se cadastra
create function handle_new_user() returns trigger as $$
begin
  insert into public.profiles (id, full_name) values (new.id, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------------------
-- SUPERADMIN (não pertence a nenhuma empresa)
-- ---------------------------------------------------------------------------
create table superadmins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- EMPRESAS (raiz do tenant)
-- ---------------------------------------------------------------------------
create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  niche_id uuid references niches (id),
  status company_status not null default 'trial',
  is_demo boolean not null default false,
  plan text not null default 'free',
  created_at timestamptz not null default now()
);

create table company_members (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role member_role not null default 'professional',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, user_id)
);

create index on company_members (user_id);
create index on company_members (company_id);

-- ---------------------------------------------------------------------------
-- FUNÇÕES DE SEGURANÇA (usadas nas policies de RLS)
-- SECURITY DEFINER: evita recursão de RLS ao consultar company_members
-- ---------------------------------------------------------------------------
create function is_company_member(target_company_id uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from company_members
    where company_id = target_company_id
      and user_id = auth.uid()
      and active = true
  );
$$;

create function member_role_in(target_company_id uuid) returns member_role
language sql security definer stable set search_path = public as $$
  select role from company_members
  where company_id = target_company_id and user_id = auth.uid() and active = true
  limit 1;
$$;

create function is_company_admin(target_company_id uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from company_members
    where company_id = target_company_id
      and user_id = auth.uid()
      and role in ('owner', 'admin')
      and active = true
  );
$$;

create function is_superadmin() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from superadmins where user_id = auth.uid());
$$;

-- RPC transacional: cria empresa + torna o criador owner (usado no onboarding)
create function create_company_with_owner(company_name text, niche_slug text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  new_company_id uuid;
  target_niche_id uuid;
begin
  select id into target_niche_id from niches where slug = niche_slug;

  insert into companies (name, niche_id) values (company_name, target_niche_id)
  returning id into new_company_id;

  insert into company_members (company_id, user_id, role)
  values (new_company_id, auth.uid(), 'owner');

  return new_company_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- SERVIÇOS
-- ---------------------------------------------------------------------------
create table service_categories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  name text not null,
  sort_order int not null default 0
);

create table services (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  category_id uuid references service_categories (id) on delete set null,
  name text not null,
  description text,
  duration_minutes int not null default 60,
  price numeric(10, 2) not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index on services (company_id);

-- ---------------------------------------------------------------------------
-- CLIENTES
-- ---------------------------------------------------------------------------
create table clients (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  name text not null,
  phone text,
  instagram text,
  birth_date date,
  notes text,
  preferences text,
  first_visit_at date,
  last_visit_at date,
  created_at timestamptz not null default now()
);

create index on clients (company_id);
create index on clients (company_id, birth_date);

-- ---------------------------------------------------------------------------
-- HORÁRIOS DE FUNCIONAMENTO E BLOQUEIOS
-- ---------------------------------------------------------------------------
create table business_hours (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  professional_member_id uuid references company_members (id) on delete cascade, -- null = horário padrão da empresa
  weekday int not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null
);

create table blocked_times (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  professional_member_id uuid references company_members (id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  reason text
);

-- ---------------------------------------------------------------------------
-- AGENDA / ATENDIMENTOS
-- ---------------------------------------------------------------------------
create table appointments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  client_id uuid not null references clients (id) on delete restrict,
  service_id uuid not null references services (id) on delete restrict,
  professional_member_id uuid not null references company_members (id) on delete restrict,
  scheduled_start timestamptz not null,
  scheduled_end timestamptz not null,
  status appointment_status not null default 'agendado',
  price numeric(10, 2) not null default 0,
  payment_method payment_method,
  notes text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  check (scheduled_end > scheduled_start)
);

-- impede conflito de horário para o mesmo profissional, a nível de banco
alter table appointments add constraint no_overlap_per_professional
  exclude using gist (
    professional_member_id with =,
    tstzrange(scheduled_start, scheduled_end) with &&
  ) where (status not in ('cancelado', 'nao_compareceu'));

create index on appointments (company_id, scheduled_start);
create index on appointments (client_id);

create table appointment_status_history (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments (id) on delete cascade,
  status appointment_status not null,
  changed_by uuid references auth.users (id),
  note text,
  changed_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- FINANCEIRO
-- ---------------------------------------------------------------------------
create table payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  appointment_id uuid references appointments (id) on delete set null,
  client_id uuid references clients (id) on delete set null,
  amount numeric(10, 2) not null,
  method payment_method not null default 'outro',
  status payment_status not null default 'pendente',
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create table expense_categories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  name text not null
);

create table expenses (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  category_id uuid references expense_categories (id) on delete set null,
  description text not null,
  amount numeric(10, 2) not null,
  payment_method payment_method,
  status payment_status not null default 'pago',
  due_date date,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create index on payments (company_id);
create index on expenses (company_id);

-- ---------------------------------------------------------------------------
-- AUDITORIA
-- ---------------------------------------------------------------------------
create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies (id) on delete cascade,
  user_id uuid references auth.users (id),
  action text not null,
  entity text not null,
  entity_id uuid,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index on audit_logs (company_id, created_at desc);

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
alter table profiles enable row level security;
alter table companies enable row level security;
alter table company_members enable row level security;
alter table service_categories enable row level security;
alter table services enable row level security;
alter table clients enable row level security;
alter table business_hours enable row level security;
alter table blocked_times enable row level security;
alter table appointments enable row level security;
alter table appointment_status_history enable row level security;
alter table payments enable row level security;
alter table expense_categories enable row level security;
alter table expenses enable row level security;
alter table audit_logs enable row level security;
alter table superadmins enable row level security;

-- profiles: cada usuário vê/edita o próprio perfil
create policy "profiles_self" on profiles for select using (id = auth.uid());
create policy "profiles_self_update" on profiles for update using (id = auth.uid());

-- companies: membros veem a própria empresa; superadmin vê todas
create policy "companies_select" on companies for select
  using (is_company_member(id) or is_superadmin());
create policy "companies_update" on companies for update
  using (is_company_admin(id) or is_superadmin());
create policy "companies_superadmin_all" on companies for all
  using (is_superadmin());

-- company_members: visível para membros da mesma empresa
create policy "members_select" on company_members for select
  using (is_company_member(company_id) or is_superadmin());
create policy "members_manage" on company_members for insert
  with check (is_company_admin(company_id) or is_superadmin());
create policy "members_update" on company_members for update
  using (is_company_admin(company_id) or is_superadmin());
create policy "members_delete" on company_members for delete
  using (is_company_admin(company_id) or is_superadmin());

-- padrão para as demais tabelas de tenant: leitura para qualquer membro ativo,
-- escrita para qualquer membro ativo (permissões finas por função ficam na
-- camada de aplicação/RPCs na Fase 2, ex.: reception não edita financeiro)
create policy "service_categories_all" on service_categories for all
  using (is_company_member(company_id)) with check (is_company_member(company_id));
create policy "services_all" on services for all
  using (is_company_member(company_id)) with check (is_company_member(company_id));
create policy "clients_all" on clients for all
  using (is_company_member(company_id)) with check (is_company_member(company_id));
create policy "business_hours_all" on business_hours for all
  using (is_company_member(company_id)) with check (is_company_member(company_id));
create policy "blocked_times_all" on blocked_times for all
  using (is_company_member(company_id)) with check (is_company_member(company_id));
create policy "appointments_all" on appointments for all
  using (is_company_member(company_id)) with check (is_company_member(company_id));
create policy "appt_history_select" on appointment_status_history for select
  using (is_company_member((select company_id from appointments where id = appointment_id)));
create policy "appt_history_insert" on appointment_status_history for insert
  with check (is_company_member((select company_id from appointments where id = appointment_id)));
create policy "payments_all" on payments for all
  using (is_company_member(company_id)) with check (is_company_member(company_id));
create policy "expense_categories_all" on expense_categories for all
  using (is_company_member(company_id)) with check (is_company_member(company_id));
create policy "expenses_all" on expenses for all
  using (is_company_member(company_id)) with check (is_company_member(company_id));

-- auditoria: só leitura para admins da empresa; escrita feita via funções/backend
create policy "audit_select" on audit_logs for select
  using (is_company_admin(company_id) or is_superadmin());

-- superadmins: só o próprio superadmin (via service role) gerencia essa tabela
create policy "superadmins_self_select" on superadmins for select
  using (user_id = auth.uid());

-- niches: catálogo público de leitura para qualquer usuário autenticado
alter table niches enable row level security;
create policy "niches_read_all" on niches for select using (true);
