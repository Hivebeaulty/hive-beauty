-- ---------------------------------------------------------------------------
-- 0009 — Integridade multiempresa de clientes + proteção de exclusão com histórico
--
-- Fecha duas lacunas estruturais, ambas anteriores à Fase 5:
--
--   1. appointments/payments de uma empresa podiam apontar para a cliente de
--      OUTRA empresa (a FK só olhava client_id; a RLS só olha o company_id da
--      linha). Agora o BANCO exige  registro.company_id = cliente.company_id.
--
--   2. DELETE direto de cliente que só tem pagamentos funcionava e apagava o
--      vínculo (payments.client_id era ON DELETE SET NULL). Agora o banco recusa
--      a exclusão de cliente com QUALQUER atendimento ou pagamento.
--
-- Não altera RLS, PKs, nem migrations anteriores. Não corrige dados: se existir
-- registro inconsistente a migration ABORTA no início, sem alterar nada.
-- (Rode antes supabase/diagnostics/0009_preflight.sql.)
-- ---------------------------------------------------------------------------

-- 0. PREFLIGHT ---------------------------------------------------------------
-- Aborta (e portanto não altera NADA) se já houver vínculo entre empresas.
do $$
declare
  v_appt bigint;
  v_pay  bigint;
begin
  select count(*) into v_appt
  from appointments a join clients c on c.id = a.client_id
  where a.company_id <> c.company_id;

  select count(*) into v_pay
  from payments p join clients c on c.id = p.client_id
  where p.company_id <> c.company_id;

  if v_appt > 0 or v_pay > 0 then
    raise exception '0009 ABORTADA — nada foi alterado. Há registros ligados a cliente de OUTRA empresa: appointments=%, payments=%. Rode supabase/diagnostics/0009_preflight.sql para listá-los e decida o que fazer antes de repetir.', v_appt, v_pay
      using errcode = '23514';
  end if;
end $$;

-- 1. FK COMPOSTA (tenant-safe) -----------------------------------------------
-- Para referenciar (company_id, id) o Postgres exige uma chave única nessas
-- colunas. id já é PK, então a unicidade é trivial; a constraint só existe para
-- poder ser alvo da FK composta. A PK de clients NÃO é alterada.
alter table clients
  add constraint clients_company_id_id_key unique (company_id, id);

-- As FKs simples antigas (client_id -> clients.id) são SUBSTITUÍDAS, não
-- somadas: a composta já implica a simples, e duas relações entre as mesmas
-- tabelas tornariam ambíguo o embed do PostgREST (clients(name)) usado pela
-- Agenda, Início e Financeiro (erro PGRST201). Os nomes são descobertos pelo
-- catálogo, pois podem diferir entre ambientes.
do $$
declare
  r record;
begin
  for r in
    select c.conrelid::regclass as tbl, c.conname
    from pg_constraint c
    where c.contype = 'f'
      and c.confrelid = 'public.clients'::regclass
      and c.conrelid in ('public.appointments'::regclass, 'public.payments'::regclass)
      and c.conkey = array[(
        select a.attnum from pg_attribute a
        where a.attrelid = c.conrelid and a.attname = 'client_id'
      )]::smallint[]
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;

-- MATCH SIMPLE (padrão): payments.client_id continua opcional (receita avulsa,
-- sem cliente) — com client_id nulo a FK não é avaliada.
-- ON DELETE RESTRICT nas duas: appointments já era RESTRICT; payments deixa de
-- ser SET NULL (esse era o buraco). O gatilho do item 3 dá a mensagem amigável;
-- a FK é a rede de segurança caso o gatilho seja desativado.
alter table appointments
  add constraint appointments_client_same_company_fkey
  foreign key (company_id, client_id) references clients (company_id, id)
  on delete restrict;

alter table payments
  add constraint payments_client_same_company_fkey
  foreign key (company_id, client_id) references clients (company_id, id)
  on delete restrict;

-- Garantia: sobrou exatamente UMA relação entre cada par (senão o PostgREST
-- ficaria ambíguo e a Agenda quebraria).
do $$
begin
  if (select count(*) from pg_constraint
        where contype = 'f' and conrelid = 'public.appointments'::regclass
          and confrelid = 'public.clients'::regclass) <> 1
     or (select count(*) from pg_constraint
        where contype = 'f' and conrelid = 'public.payments'::regclass
          and confrelid = 'public.clients'::regclass) <> 1 then
    raise exception '0009 ABORTADA: esperava exatamente 1 FK de appointments e 1 de payments para clients.';
  end if;
end $$;

-- A busca de histórico (gatilho abaixo e verificação da FK ao excluir cliente)
-- filtra payments por client_id; só havia índice em company_id.
create index if not exists payments_client_id_idx
  on payments (client_id) where client_id is not null;

-- 2. company_id DE CLIENTE É IMUTÁVEL ------------------------------------------
-- A policy clients_all (0001) tem  with check (is_company_member(company_id)),
-- então um membro de DUAS empresas podia dar UPDATE clients SET company_id = B e
-- mover a cliente (e, sem histórico, escapar da FK composta). Sem mexer na RLS:
-- o gatilho recusa qualquer troca, para qualquer papel (inclui service role).
-- Cliente com histórico já ficaria presa também pela FK (ON UPDATE NO ACTION).
create or replace function clients_company_id_is_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.company_id is distinct from old.company_id then
    raise exception 'A empresa de uma cliente não pode ser alterada.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger trg_clients_company_id_immutable
  before update of company_id on clients
  for each row execute function clients_company_id_is_immutable();

-- 3. CLIENTE COM HISTÓRICO NÃO PODE SER EXCLUÍDA -------------------------------
-- Vale para QUALQUER caminho: API, RPC, SQL Editor, service role.
--
--  * SECURITY DEFINER é necessário: payments é restrito a owner/admin por RLS
--    (0004); sem isso, uma profissional comum "enxergaria" 0 pagamentos e o
--    gatilho deixaria a exclusão passar. Só lê (exists); nenhum SQL dinâmico.
--  * search_path com pg_temp por último (tabela temporária não esconde histórico).
--  * Sem auth.uid(): é uma regra de integridade, não de permissão; vale também
--    para auth.uid() nulo (service role / SQL Editor).
--  * Corrida: antes de disparar um gatilho BEFORE ROW o Postgres já trava a
--    linha da cliente; um pagamento/atendimento novo (FK pede lock "for key
--    share" nesta linha) espera a exclusão terminar e então falha por falta da
--    cliente, em vez de escapar da checagem.
--  * NÃO há exceção para exclusão em cascata de empresa. Ver relatório: hoje a
--    exclusão física de empresa já não é suportada (o gatilho de auditoria de
--    company_members falha ao gravar audit_logs de uma empresa em remoção). Se um
--    dia existir um procedimento oficial de remoção de empresa, ele deve apagar
--    pagamentos/atendimentos explicitamente antes dos clientes.
create or replace function prevent_client_delete_with_history()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from appointments where client_id = old.id)
     or exists (select 1 from payments where client_id = old.id) then
    raise exception 'Esta cliente tem histórico (atendimentos ou pagamentos) e não pode ser excluída. Arquive-a.'
      using errcode = '23503';
  end if;
  return old;
end;
$$;

create trigger trg_clients_block_delete_with_history
  before delete on clients
  for each row execute function prevent_client_delete_with_history();

-- Garante que a API (PostgREST) recarregue as relações (FKs) imediatamente.
notify pgrst, 'reload schema';
