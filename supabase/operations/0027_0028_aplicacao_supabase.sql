-- ============================================================================
-- ÁUREA — APLICAÇÃO DA 0027 (confirmação: sistema ou mensagem própria) + 0028
-- (central de comunicação: envio para várias clientes) NO SUPABASE — ROTEIRO
--
-- NÃO EXECUTE SEM AUTORIZAÇÃO. Pré-requisito: 0026 aplicada.
-- Ao aplicar, a confirmação de TODAS as empresas volta às mensagens variadas do
-- sistema (opção 1, padrão). Nada é enviado por aplicar.
-- ============================================================================

-- [B0] ANTES (só leitura). Esperado: t | f | f
select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'whatsapp_private' and p.proname = 'confirmation_text'
                 and p.prosrc like '%prazo mínimo é de 24h%') as confirmacao_formato_padrao_0025,
       exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'whatsapp_private' and c.relname = 'message_templates') as tem_0027,
       exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'whatsapp_private' and c.relname = 'campaigns') as tem_0028;
-- [/B0]

-- [B2] APLICAR: 0027_whatsapp_confirmation_choice.sql e depois 0028_whatsapp_campaigns.sql.

-- [B3] DEPOIS (só leitura). Esperado: t | t | t | 13 | 0 | 15
select exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'whatsapp_private' and c.relname = 'message_templates') as tem_0027,
       exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'whatsapp_private' and c.relname = 'campaigns') as tem_0028,
       exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'whatsapp_private' and p.proname = 'system_confirmation_text'
                 and p.prosrc like '%Te espero com carinho%') as variacoes_do_sistema,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'whatsapp_private' and has_function_privilege('wa_worker', p.oid, 'execute')) as funcoes_do_worker,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         cross join unnest(array['anon','authenticated','service_role']) rl
         where n.nspname = 'whatsapp_private' and has_function_privilege(rl, p.oid, 'execute')) as funcoes_expostas,
       (select count(*) from pg_proc where proname like 'wa\_%') as rpcs_app;
-- [/B3]

-- [B4] ACOMPANHAMENTO dos envios em massa (só leitura; sem telefone nem texto)
select c.created_at::date as dia, co.name as empresa, c.queued as enfileiradas, c.skipped as puladas,
       (select count(*) from whatsapp_private.outbox o where o.campaign_id = c.id and o.status = 'sent') as enviadas,
       (select count(*) from whatsapp_private.outbox o where o.campaign_id = c.id and o.status in ('pending','processing')) as aguardando
from whatsapp_private.campaigns c join companies co on co.id = c.company_id
where c.created_at > now() - interval '7 days' order by c.created_at desc;
-- [/B4]

-- [BR] REVERSÃO da 0028 + 0027 (volta exatamente ao estado da 0026).
-- [BR-SQL]
begin;
update whatsapp_private.outbox set status = 'canceled', last_error = '0028 revertida', locked_by = null, locked_until = null, updated_at = now()
where campaign_id is not null and status in ('pending', 'processing');
drop function if exists public.wa_send_campaign(uuid, uuid[], text, uuid), public.wa_get_campaign(uuid);
drop function if exists whatsapp_private.campaign_text(text, text, text);
create or replace function whatsapp_private.enqueue_send(
  p_company_id uuid, p_client_id uuid, p_appointment_id uuid, p_to_phone text, p_body text, p_key text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  st whatsapp_private.settings%rowtype;
  o whatsapp_private.outbox%rowtype;
  v_min int;
  v_day int;
begin
  select * into st from whatsapp_private.settings where id;

  -- idempotência: mesma chave devolve o MESMO pedido; chave reaproveitada com outro conteúdo é erro
  select * into o from whatsapp_private.outbox where company_id = p_company_id and idempotency_key = p_key;
  if found then
    if o.kind <> 'send_text' or o.client_id is distinct from p_client_id or o.body is distinct from p_body
       or o.appointment_id is distinct from p_appointment_id then
      raise exception 'Esta chave de envio já foi usada com outro conteúdo.' using errcode = 'AUW04';
    end if;
    return jsonb_build_object('outbox_id', o.id, 'status', o.status, 'created', false);
  end if;

  -- ritmo por empresa (o worker ainda espaça os envios na W2)
  perform pg_advisory_xact_lock(hashtext('wa_send:' || p_company_id::text));
  select count(*) filter (where created_at > now() - interval '1 minute'),
         count(*) filter (where created_at > now() - interval '1 day')
  into v_min, v_day
  from whatsapp_private.outbox
  where company_id = p_company_id and kind = 'send_text' and created_at > now() - interval '1 day';
  if v_min >= st.send_per_minute or v_day >= st.send_per_day then
    raise exception 'Limite de envios atingido. Tente de novo em instantes.' using errcode = 'AUW03';
  end if;

  insert into whatsapp_private.outbox (company_id, kind, client_id, appointment_id, to_phone, body,
                                       idempotency_key, max_attempts, created_by)
  values (p_company_id, 'send_text', p_client_id, p_appointment_id, p_to_phone, p_body,
          p_key, st.outbox_max_attempts, auth.uid())
  on conflict (company_id, idempotency_key) do nothing
  returning * into o;
  if o.id is null then   -- corrida com o mesmo pedido: devolve o que venceu
    select * into o from whatsapp_private.outbox where company_id = p_company_id and idempotency_key = p_key;
    return jsonb_build_object('outbox_id', o.id, 'status', o.status, 'created', false);
  end if;
  return jsonb_build_object('outbox_id', o.id, 'status', o.status, 'created', true);
end;
$$;
drop table if exists whatsapp_private.campaigns;
drop index if exists whatsapp_private.wa_outbox_campaign_idx;
alter table whatsapp_private.outbox drop column if exists campaign_id;
alter table whatsapp_private.settings drop column if exists campaign_max_recipients, drop column if exists campaign_spacing_seconds;
create or replace function whatsapp_private.confirmation_text(p_appointment_id uuid, p_now timestamptz default now())
returns text
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  a appointments%rowtype;
  v_client text; v_service text; v_local timestamp; v_nome text; v_sv text; v_hora text;
  wd constant text[] := array['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
begin
  select * into a from appointments where id = p_appointment_id;
  if not found then return null; end if;
  select c.name into v_client from clients c where c.id = a.client_id and c.company_id = a.company_id;
  select s.name into v_service from services s where s.id = a.service_id;

  v_local := a.scheduled_start at time zone 'America/Sao_Paulo';
  v_hora := extract(hour from v_local)::int::text || 'h'
            || case when extract(minute from v_local)::int = 0 then '' else lpad(extract(minute from v_local)::int::text, 2, '0') end;
  v_nome := nullif((regexp_split_to_array(btrim(coalesce(v_client, '')), '\s+'))[1], '');
  v_sv := btrim(coalesce(v_service, ''));

  return case when v_nome is not null then 'Olá, ' || v_nome || '!' else 'Olá!' end
      || E'\n\n' || 'Horário agendado: ' || wd[extract(dow from v_local)::int + 1] || ', ' || to_char(v_local, 'DD/MM') || ', às ' || v_hora
      || case when v_sv <> '' then E'\nServiço: ' || v_sv else '' end
      || E'\n\nPara remarcações, o prazo mínimo é de 24h.\n\nObrigada!';
end;
$$;
drop function if exists public.wa_get_message_settings(uuid), public.wa_set_message_settings(uuid, text, text);
drop function if exists whatsapp_private.custom_confirmation_text(uuid, text), whatsapp_private.template_problems(text),
  whatsapp_private.normalize_variable(text), whatsapp_private.system_confirmation_text(uuid, timestamptz);
drop table if exists whatsapp_private.message_templates;
revoke all on function whatsapp_private.confirmation_text(uuid, timestamptz), whatsapp_private.enqueue_send(uuid, uuid, uuid, text, text, text) from public;
notify pgrst, 'reload schema';
commit;
-- [/BR-SQL]
