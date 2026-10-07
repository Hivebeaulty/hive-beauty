-- ============================================================================
-- DIAGNÓSTICO PRÉ-0009 — SOMENTE LEITURA (nenhum INSERT/UPDATE/DELETE/DDL).
-- Rode no SQL Editor ANTES de aplicar a 0009. Não é uma migration.
--
-- A 0009 cria FKs compostas (company_id, client_id). Elas só podem ser criadas
-- se NENHUM registro já aponta para cliente de outra empresa. A própria 0009
-- confere isso e ABORTA sem alterar nada, mas rode este diagnóstico antes para
-- saber exatamente o que existe. Este script NÃO corrige dados.
-- ============================================================================

-- 0. Quais FKs apontam hoje para clients? (esperado: exatamente 2)
select conrelid::regclass as tabela, conname, pg_get_constraintdef(oid) as definicao
from pg_constraint
where contype = 'f' and confrelid = 'public.clients'::regclass
order by 1;

-- 0b. Qualquer outra coluna chamada client_id, com ou sem FK (esperado: appointments e payments)
select table_name, column_name
from information_schema.columns
where table_schema = 'public' and column_name = 'client_id'
order by 1;

-- A. BLOQUEANTE — o que a 0009 vai impor. Esperado: 0 e 0.
select
  (select count(*) from appointments a join clients c on c.id = a.client_id
    where a.company_id <> c.company_id) as appointments_com_cliente_de_outra_empresa,
  (select count(*) from payments p join clients c on c.id = p.client_id
    where p.company_id <> c.company_id) as payments_com_cliente_de_outra_empresa;

-- A1. Detalhe (vazio = ok)
select 'appointment' as tipo, a.id as registro_id, a.company_id as empresa_do_registro,
       c.id as client_id, c.company_id as empresa_da_cliente
from appointments a join clients c on c.id = a.client_id
where a.company_id <> c.company_id
union all
select 'payment', p.id, p.company_id, c.id, c.company_id
from payments p join clients c on c.id = p.client_id
where p.company_id <> c.company_id;

-- B. INFORMATIVO — outras relações entre tabelas com company_id que o banco também
-- não protege (a 0009 NÃO as altera; ver relatório). Esperado: tudo 0.
select
  (select count(*) from appointments a join services s on s.id = a.service_id
    where a.company_id <> s.company_id)                                   as appt_servico_outra_empresa,
  (select count(*) from appointments a join company_members m on m.id = a.professional_member_id
    where a.company_id <> m.company_id)                                   as appt_profissional_outra_empresa,
  (select count(*) from payments p join appointments a on a.id = p.appointment_id
    where p.company_id <> a.company_id)                                   as pgto_atendimento_outra_empresa,
  (select count(*) from payments p join appointments a on a.id = p.appointment_id
    where p.client_id is not null and p.client_id <> a.client_id)         as pgto_cliente_difere_do_atendimento,
  (select count(*) from services s join service_categories k on k.id = s.category_id
    where s.company_id <> k.company_id)                                   as servico_categoria_outra_empresa,
  (select count(*) from expenses e join expense_categories k on k.id = e.category_id
    where e.company_id <> k.company_id)                                   as despesa_categoria_outra_empresa,
  (select count(*) from business_hours b join company_members m on m.id = b.professional_member_id
    where b.company_id <> m.company_id)                                   as horario_profissional_outra_empresa,
  (select count(*) from blocked_times b join company_members m on m.id = b.professional_member_id
    where b.company_id <> m.company_id)                                   as bloqueio_profissional_outra_empresa;

-- C. Volumes (contexto)
select (select count(*) from clients) as clients, (select count(*) from appointments) as appointments,
       (select count(*) from payments) as payments, (select count(*) from companies) as companies;
