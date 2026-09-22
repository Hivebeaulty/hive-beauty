-- ---------------------------------------------------------------------------
-- Fase 4 — Agenda/Calendário: nomes das profissionais para seletor e filtro
-- ---------------------------------------------------------------------------
-- Motivação: company_members já é visível para toda a equipe da empresa
-- (policy "members_select"), mas profiles.full_name só é visível para o
-- próprio usuário (policy "profiles_self"). Sem isso, o seletor/filtro de
-- profissional da Agenda só conseguiria mostrar o nome de quem está logado.
--
-- Em vez de abrir a tabela profiles inteira para a equipe (ela também tem
-- phone e avatar_url, que não precisam vazar entre colegas), criamos uma
-- função security definer que devolve só member_id + full_name — e apenas
-- das profissionais da MESMA empresa de quem está chamando. Nenhuma policy
-- existente é alterada ou removida.
-- ---------------------------------------------------------------------------
create function get_company_member_names(p_company_id uuid)
returns table (member_id uuid, full_name text)
language sql
security definer
set search_path = public
as $$
  select cm.id, coalesce(p.full_name, 'Profissional')
  from company_members cm
  join profiles p on p.id = cm.user_id
  where cm.company_id = p_company_id
    and is_company_member(p_company_id);
$$;

revoke all on function get_company_member_names(uuid) from public;
grant execute on function get_company_member_names(uuid) to authenticated;
