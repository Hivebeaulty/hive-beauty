-- ---------------------------------------------------------------------------
-- Clientes: arquivamento, telefone normalizado e consentimento de comunicação.
--
-- 100% ADITIVA e retrocompatível: o código web anterior continua funcionando
-- depois desta migration (aplique a migration ANTES de publicar o código novo).
-- Não altera RLS, constraints existentes, nem dados já gravados. `clients.phone`
-- NÃO é reescrito: continua exatamente como foi digitado.
--
-- 1. archived_at ........ arquivamento (cliente com histórico nunca é apagada)
-- 2. phone_normalized ... número canônico (só dígitos, com DDI 55) para evitar
--                         duplicidade por formato e servir o futuro WhatsApp.
--                         COLUNA GERADA: calculada pelo banco, não pode ser
--                         forjada pelo frontend e preenche as linhas antigas
--                         sem disparar o gatilho de auditoria.
-- 3. comm_status* ....... consentimento de comunicação (permitir/bloquear)
-- 4. RPCs ............... resumo do histórico + exclusão segura
-- ---------------------------------------------------------------------------

-- 1. Arquivamento ------------------------------------------------------------
alter table clients
  add column if not exists archived_at timestamptz;

-- 2. Telefone normalizado ----------------------------------------------------
-- Regras (espelhadas em lib/hive/phone.ts — mantenha os dois em sincronia):
--   * só dígitos; remove prefixo internacional "00" e o zero de tronco ("011...")
--   * com DDI: 55 + 10/11 dígitos; sem DDI: 10/11 dígitos
--   * DDD precisa existir no Brasil
--   * 9 dígitos após o DDD: precisa começar com 9 (celular)
--   * 8 dígitos após o DDD: precisa começar com 2-5 (fixo)
--   * qualquer outra coisa (inclui celular de 8 dígitos, sem o 9) => NULL
--     (inválido). Não "chutamos" o 9: errar o número é pior do que pedir
--     correção, pois a mensagem iria para outra pessoa.
-- Retorna NULL para número inválido ou vazio; nunca lança erro.
create or replace function normalize_br_phone(p text)
returns text
language plpgsql
immutable
as $$
declare
  d text;
  ddd text;
  sub text;
begin
  if p is null then
    return null;
  end if;

  d := regexp_replace(p, '\D', '', 'g');

  if left(d, 2) = '00' then
    d := substr(d, 3);
  end if;

  if length(d) in (11, 12) and left(d, 1) = '0' then
    d := substr(d, 2);
  end if;

  if length(d) in (12, 13) and left(d, 2) = '55' then
    d := substr(d, 3);
  end if;

  if length(d) not in (10, 11) then
    return null;
  end if;

  ddd := left(d, 2);
  sub := substr(d, 3);

  if ddd not in (
    '11','12','13','14','15','16','17','18','19',
    '21','22','24','27','28',
    '31','32','33','34','35','37','38',
    '41','42','43','44','45','46','47','48','49',
    '51','53','54','55',
    '61','62','63','64','65','66','67','68','69',
    '71','73','74','75','77','79',
    '81','82','83','84','85','86','87','88','89',
    '91','92','93','94','95','96','97','98','99'
  ) then
    return null;
  end if;

  if length(sub) = 9 then
    if left(sub, 1) <> '9' then
      return null;
    end if;
  elsif length(sub) = 8 then
    if left(sub, 1) not in ('2', '3', '4', '5') then
      return null;
    end if;
  else
    return null;
  end if;

  return '55' || ddd || sub;
end;
$$;

alter table clients
  add column if not exists phone_normalized text
  generated always as (normalize_br_phone(phone)) stored;

-- Índice NÃO único de propósito: bases existentes podem já ter números
-- repetidos (e familiares podem legitimamente compartilhar um número).
-- A duplicidade é sinalizada pela aplicação, sem bloquear.
create index if not exists clients_company_phone_normalized_idx
  on clients (company_id, phone_normalized)
  where phone_normalized is not null;

-- 3. Consentimento de comunicação ---------------------------------------------
--   unknown = não informado (padrão; tratado como NÃO autorizado para envios)
--   allowed = autorizou receber mensagens
--   blocked = não quer receber (inclui opt-out feito pela própria cliente)
-- comm_status_source: 'manual' (profissional), 'import', 'client_opt_out'
-- (reservado: o futuro serviço de WhatsApp registrará aqui o "SAIR").
alter table clients
  add column if not exists comm_status text not null default 'unknown'
    check (comm_status in ('unknown', 'allowed', 'blocked')),
  add column if not exists comm_status_at timestamptz,
  add column if not exists comm_status_by uuid references auth.users (id) on delete set null,
  add column if not exists comm_status_source text not null default 'manual'
    check (comm_status_source in ('manual', 'import', 'client_opt_out'));

-- Quem/quando/origem é registrado PELO BANCO e não pode ser editado à mão por
-- usuária logada (auth.uid() não nulo):
--   * mudou o status  -> grava now()/auth.uid() e origem 'manual'
--   * não mudou       -> qualquer tentativa de alterar a trilha é descartada
--   * INSERT 'unknown'-> nada foi "registrado": trilha zerada; origem só 'manual'
--                        ou 'import' (valores que o app realmente usa)
-- O serviço de WhatsApp (service role / SQL Editor => auth.uid() nulo) pode gravar
-- 'client_opt_out' e demais origens. Histórico completo: audit_logs (trg_audit_clients,
-- que traz company_id e id da cliente).
create or replace function clients_track_comm_status()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    if new.comm_status <> 'unknown' then
      new.comm_status_at := now();
      new.comm_status_by := v_uid;
      if v_uid is not null then
        new.comm_status_source := 'manual';
      end if;
    elsif v_uid is not null then
      new.comm_status_at := null;
      new.comm_status_by := null;
      if new.comm_status_source not in ('manual', 'import') then
        new.comm_status_source := 'manual';
      end if;
    end if;
  elsif new.comm_status is distinct from old.comm_status then
    new.comm_status_at := now();
    new.comm_status_by := v_uid;
    if v_uid is not null then
      new.comm_status_source := 'manual';
    end if;
  elsif v_uid is not null then
    new.comm_status_at := old.comm_status_at;
    new.comm_status_by := old.comm_status_by;
    new.comm_status_source := old.comm_status_source;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_clients_comm_status on clients;
create trigger trg_clients_comm_status
  before insert or update on clients
  for each row execute function clients_track_comm_status();

-- 4. RPCs: histórico e exclusão segura ----------------------------------------
-- Por que RPC e não contar no navegador: payments é restrito a owner/admin por
-- RLS (0004). Uma profissional comum veria 0 pagamentos e a tela concluiria,
-- errado, que a cliente "não tem histórico". Estas funções contam sem expor
-- valores (só quantidades) e sempre validam a empresa a partir da PRÓPRIA linha
-- da cliente — nenhum company_id vem do frontend.
--
-- Endurecimento (funções SECURITY DEFINER):
--   * search_path = public, pg_temp: pg_temp por ÚLTIMO, senão uma tabela
--     temporária com o nome "payments"/"appointments" criada pela usuária
--     esconderia o histórico real da checagem.
--   * "não existe" e "é de outra empresa" dão o MESMO erro (P0002), para não
--     servir de oráculo de existência de ids.
--   * A trava de linha (for update) só acontece DEPOIS de provar que a cliente
--     é da empresa da usuária.
create or replace function get_client_history_summary(p_client_id uuid)
returns table (
  appointments_total bigint,
  appointments_upcoming bigint,
  payments_total bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Não autenticado.' using errcode = '28000';
  end if;

  select company_id into v_company_id from clients where id = p_client_id;
  if v_company_id is null or not is_company_member(v_company_id) then
    raise exception 'Cliente não encontrada.' using errcode = 'P0002';
  end if;

  -- Só linhas da PRÓPRIA empresa são contadas aqui (o que a tela mostra). A
  -- exclusão, abaixo, é mais rígida e olha qualquer linha que referencie a cliente.
  return query
  select
    (select count(*) from appointments a
       where a.client_id = p_client_id and a.company_id = v_company_id),
    (select count(*) from appointments a
       where a.client_id = p_client_id and a.company_id = v_company_id
         and a.status in ('agendado', 'confirmado')
         and a.scheduled_start >= now()),
    (select count(*) from payments p
       where p.client_id = p_client_id and p.company_id = v_company_id);
end;
$$;

revoke all on function get_client_history_summary(uuid) from public, anon;
grant execute on function get_client_history_summary(uuid) to authenticated;

-- Exclui a cliente SOMENTE se NENHUMA linha (de qualquer empresa) referenciar
-- a cliente em appointments ou payments — são as duas únicas FKs para clients.
-- A trava (for update) impede que um pagamento/atendimento criado ao mesmo
-- tempo escape da checagem (FKs pedem lock "for key share" nesta linha).
create or replace function delete_client_without_history(p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Não autenticado.' using errcode = '28000';
  end if;

  select company_id into v_company_id from clients where id = p_client_id;
  if v_company_id is null or not is_company_member(v_company_id) then
    raise exception 'Cliente não encontrada.' using errcode = 'P0002';
  end if;

  perform 1 from clients where id = p_client_id for update;
  if not found then
    raise exception 'Cliente não encontrada.' using errcode = 'P0002';
  end if;

  if exists (select 1 from appointments where client_id = p_client_id)
     or exists (select 1 from payments where client_id = p_client_id) then
    raise exception 'Esta cliente tem histórico e não pode ser excluída. Arquive-a.'
      using errcode = '23503';
  end if;

  delete from clients where id = p_client_id;
end;
$$;

revoke all on function delete_client_without_history(uuid) from public, anon;
grant execute on function delete_client_without_history(uuid) to authenticated;

-- Garante que a API (PostgREST) enxergue as colunas e RPCs novas imediatamente.
notify pgrst, 'reload schema';
