-- ---------------------------------------------------------------------------
-- 0013 — "Como você quer ser chamada?"
--
-- profiles.display_name: nome de exibição preferido (ex.: "Paty"). NÃO
-- substitui full_name nem o nome de login. Opcional: vazio = o app usa o nome
-- cadastrado (profiles.full_name) como antes.
--
-- A policy profiles_self_update (0001) já deixa cada usuária atualizar a
-- PRÓPRIA linha; nenhuma policy é criada ou alterada.
-- ---------------------------------------------------------------------------
alter table profiles
  add column if not exists display_name text
    check (display_name is null or char_length(btrim(display_name)) between 1 and 40);

-- Nome de exibição das profissionais da MESMA empresa, para assinar mensagens
-- (ex.: confirmação de agendamento). Função NOVA: get_company_member_names
-- (0005) continua devolvendo só o nome cadastrado, sem mudar nenhuma tela que
-- já a usa. profiles.phone/avatar_url continuam sem vazar entre colegas.
create or replace function get_company_member_display_names(p_company_id uuid)
returns table (member_id uuid, display_name text, full_name text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select cm.id, nullif(btrim(p.display_name), ''), p.full_name
  from company_members cm
  join profiles p on p.id = cm.user_id
  where cm.company_id = p_company_id
    and is_company_member(p_company_id);
$$;

revoke all on function get_company_member_display_names(uuid) from public, anon;
grant execute on function get_company_member_display_names(uuid) to authenticated;

notify pgrst, 'reload schema';
