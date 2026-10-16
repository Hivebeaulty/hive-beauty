-- ---------------------------------------------------------------------------
-- 0029 — Central de comunicação: enviar SOMENTE a mensagem da profissional
--
-- Remove o rodapé "Para não receber mais mensagens, responda SAIR." que a 0028
-- acrescentava a cada envio da central. Troca SOMENTE whatsapp_private.campaign_text
-- (mesmo nome, parâmetros e retorno): as variáveis {nome}/{negocio} continuam.
--
-- NÃO muda o bloqueio de quem responde SAIR/PARAR/STOP (record_inbound, 0017) nem
-- o cancelamento na fila de quem saiu (claim_outbox): os dois continuam valendo.
-- Confirmação, lembrete, alteração e cancelamento nunca tiveram rodapé.
-- Cópia IDÊNTICA na tela: campaignMessage em lib/hive/communication.ts.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'whatsapp_private' and p.proname = 'campaign_text') then
    raise exception '0029 ABORTADA — nada foi alterado. Aplique antes a 0028.' using errcode = '55000';
  end if;
end $$;

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
  return t;   -- [0029] exatamente a mensagem da profissional: SEM rodapé acrescentado
end;
$$;

-- privilégios: create or replace preserva os da 0028; reforça que ninguém de fora executa
revoke all on function whatsapp_private.campaign_text(text, text, text) from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'wa_worker'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function whatsapp_private.campaign_text(text, text, text) from %I', r);
    end if;
  end loop;
end $$;
