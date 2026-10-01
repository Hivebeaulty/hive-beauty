-- ---------------------------------------------------------------------------
-- Configurações → Dados da empresa: telefone e e-mail do negócio.
--
-- Auditoria: companies só tinha `name`. O nome do negócio/da empresa já existe
-- (companies.name) e continua sendo o único nome — não criamos um segundo campo
-- de "razão social" para não duplicar. Telefone e e-mail do NEGÓCIO não
-- existiam em lugar nenhum (profiles.phone é o telefone pessoal de cada
-- usuária, não o do negócio) e são pré-requisito do WhatsApp por empresa.
--
-- Aditiva: duas colunas opcionais, sem default, sem alterar RLS. A policy
-- existente companies_update (is_company_admin) já cobre as novas colunas;
-- companies_select continua liberando leitura apenas para membros da empresa.
-- ---------------------------------------------------------------------------
alter table companies
  add column if not exists phone text,
  add column if not exists email text;
