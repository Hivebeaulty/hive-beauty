-- ============================================================================
-- ÁUREA — APLICAÇÃO DA 0029 (central: sem rodapé de SAIR) NO SUPABASE — ROTEIRO
-- NÃO EXECUTE SEM AUTORIZAÇÃO. Troca só o texto da central; nada é enviado.
-- ============================================================================

-- [B0] ANTES (só leitura). Esperado: t | 0
select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'whatsapp_private' and p.proname = 'campaign_text' and p.prosrc like '%responda SAIR%') as tem_rodape,
       (select count(*) from whatsapp_private.outbox where body like '%responda SAIR.%' and status in ('pending','processing')) as na_fila_com_rodape;
-- [/B0]

-- [B3] DEPOIS (só leitura). Esperado: f | t | 0 | 13
select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname in ('whatsapp_private','public') and p.prosrc like '%responda SAIR%') as alguma_funcao_com_rodape,
       exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'whatsapp_private' and p.proname = 'record_inbound' and p.prosrc like '%''SAIR''%') as bloqueio_por_sair_ativo,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join unnest(array['anon','authenticated','service_role','wa_worker']) rl
         where n.nspname = 'whatsapp_private' and p.proname = 'campaign_text' and has_function_privilege(rl, p.oid, 'execute')) as quem_de_fora_executa,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'whatsapp_private' and has_function_privilege('wa_worker', p.oid, 'execute')) as funcoes_do_worker;
-- [/B3]

-- [BR] REVERSÃO: volta EXATAMENTE ao texto da 0028 (cópia literal).
-- [BR-SQL]
begin;
create or replace function whatsapp_private.campaign_text(p_body text, p_client_name text, p_company_name text)
returns text
language plpgsql immutable
set search_path = public, pg_temp
as $$
declare
  t text := btrim(coalesce(p_body, ''), E' \t\n\r');
  v_nome text := coalesce(nullif((regexp_split_to_array(btrim(coalesce(p_client_name, '')), '\s+'))[1], ''), coalesce(p_client_name, ''));
  m text[];
begin
  for m in select regexp_matches(t, '\{([A-Za-z_]+)\}', 'g') loop
    if lower(m[1]) = 'nome' then t := replace(t, '{' || m[1] || '}', v_nome);
    elsif lower(m[1]) = 'negocio' then t := replace(t, '{' || m[1] || '}', coalesce(p_company_name, ''));
    end if;
  end loop;
  return t || E'\n\nPara não receber mais mensagens, responda SAIR.';
end;
$$;
revoke all on function whatsapp_private.campaign_text(text, text, text) from public;
commit;
-- [/BR-SQL]
