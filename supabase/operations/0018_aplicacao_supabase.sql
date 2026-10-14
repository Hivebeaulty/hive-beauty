-- ============================================================================
-- ÁUREA — APLICAÇÃO DA 0018 (WhatsApp W5: confirmação automática) NO SUPABASE — ROTEIRO
--
-- NÃO EXECUTE SEM AUTORIZAÇÃO EXPLÍCITA. Pré-requisito: 0017 aplicada (roteiro próprio).
-- A 0018 nasce DESLIGADA: aplicar não envia nada nem enfileira nada. Ligar é o
-- bloco [B5], só DEPOIS do teste com número secundário (ver README, "Implantação W5").
-- Cada bloco [Bx] é independente: selecione e use "Run selected".
-- ============================================================================

-- [B0] ANTES (só leitura). Esperado: t | f | f | 7 | 0
select exists (select 1 from pg_namespace where nspname = 'whatsapp_private') as tem_0017,
       exists (select 1 from pg_trigger where tgname = 'trg_appointments_wa_auto_confirmation') as tem_gatilho_0018,
       exists (select 1 from information_schema.columns where table_schema = 'whatsapp_private'
                 and table_name = 'settings' and column_name = 'auto_confirmation_enabled') as tem_chave_0018,
       (select count(*) from pg_tables where schemaname = 'whatsapp_private') as tabelas_whatsapp,
       (select count(*) from whatsapp_private.outbox where kind = 'send_text' and status in ('pending','processing')) as envios_na_fila;
-- [/B0]

-- [B1] FOTO (rode antes e depois; os valores precisam ser iguais)
select (select md5(coalesce(string_agg(to_jsonb(a)::text, '|' order by a.id), '')) from appointments a) as atendimentos,
       (select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.id), '')) from payments p) as recebimentos,
       (select md5(coalesce(string_agg(to_jsonb(c)::text, '|' order by c.id), '')) from clients c) as clientes,
       (select count(*) from audit_logs) as auditoria,
       (select md5(coalesce(string_agg(to_jsonb(a)::text, '|' order by a.id), '')) from appointments a
         where a.status = 'concluido' and not exists (select 1 from payments p where p.appointment_id = a.id)) as registro_r90,
       (select md5(string_agg(x, '|' order by x)) from (
          select to_jsonb(s)::text x from aurea_private.settings s
          union all select to_jsonb(r)::text from aurea_private.runs r where r.kind <> 'scheduled'
          union all select to_jsonb(i)::text from aurea_private.run_items i) z) as automacao,
       (select md5(coalesce(string_agg(to_jsonb(o)::text, '|' order by o.id), '')) from whatsapp_private.outbox o) as fila_whatsapp;
-- [/B1]

-- [B2] APLICAR: numa nova query, "begin;" + arquivo 0018_whatsapp_auto_confirmation.sql inteiro + "commit;"
--      e Run. Esperado: "Success. No rows returned". Qualquer erro desfaz tudo.

-- [B3] DEPOIS (só leitura). Esperado: 1 | f | 8 | 13 | 10 | 0 | 0
select (select count(*) from pg_trigger where tgname = 'trg_appointments_wa_auto_confirmation') as gatilho,
       (select auto_confirmation_enabled from whatsapp_private.settings) as automatica_ligada,
       (select count(*) from pg_tables where schemaname = 'whatsapp_private' and rowsecurity) as tabelas_com_rls,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'whatsapp_private' and has_function_privilege('wa_worker', p.oid, 'execute')) as funcoes_do_worker,
       (select count(*) from pg_proc where proname like 'wa\_%') as rpcs_app,
       (select count(*) from unnest(array['anon','authenticated','service_role']) rl
         where has_schema_privilege(rl, 'whatsapp_private', 'usage')) as papeis_api_no_schema,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         cross join unnest(array['anon','authenticated','service_role']) rl
         where n.nspname = 'whatsapp_private' and has_function_privilege(rl, p.oid, 'execute')) as funcoes_expostas;
-- [/B3]
-- Depois rode [B1] de novo: tudo igual (inclusive a fila: desligada, nada é enfileirado).

-- [B4] ACOMPANHAMENTO (só leitura; sem telefone nem texto). Rode quando quiser.
select c.status, coalesce(c.reason, o.status) as detalhe, count(*)
from whatsapp_private.appointment_confirmations c
left join whatsapp_private.outbox o on o.id = c.outbox_id
where c.created_at > now() - interval '7 days'
group by 1, 2 order by 1, 2;
-- [/B4]

-- [B5] LIGAR a confirmação automática (SÓ depois do teste com número secundário, com o
--      worker no ar e WA_MESSAGING_ENABLED=true). Vale para agendamentos criados DEPOIS
--      deste comando; não há envio retroativo. Esperado: true
update whatsapp_private.settings set auto_confirmation_enabled = true where id returning auto_confirmation_enabled;
-- [/B5]

-- [B6] DESLIGAR (emergência). Para de enfileirar na hora e cancela as confirmações
--      automáticas ainda não enviadas. Envios já feitos não são afetados.
begin;
update whatsapp_private.settings set auto_confirmation_enabled = false where id;
update whatsapp_private.outbox set status = 'canceled', last_error = 'confirmação automática desligada', updated_at = now()
where idempotency_key like 'auto-confirmation:%' and status = 'pending';
commit;
-- [/B6]

-- [BR] REVERSÃO da 0018 (volta exatamente ao estado da 0017; a 0017 continua aplicada).
--      Perde-se só o registro appointment_confirmations e a preferência por empresa.
--      Confirmações automáticas pendentes são canceladas antes (a regra da 0017 não
--      confere se o agendamento continua válido).
-- [BR-SQL]
begin;
drop trigger if exists trg_appointments_wa_auto_confirmation on appointments;
update whatsapp_private.outbox set status = 'canceled', last_error = '0018 revertida', locked_by = null, locked_until = null, updated_at = now()
where idempotency_key like 'auto-confirmation:%' and status in ('pending', 'processing');
drop function if exists public.wa_get_appointment_confirmation(uuid), public.wa_get_auto_confirmation(uuid),
  public.wa_set_auto_confirmation(uuid, boolean);
drop function if exists whatsapp_private.on_appointment_created(), whatsapp_private.confirmation_text(uuid, timestamptz);
drop table if exists whatsapp_private.appointment_confirmations;
alter table whatsapp_private.sessions drop column if exists auto_confirmation;
alter table whatsapp_private.settings drop column if exists auto_confirmation_enabled;
-- claim_outbox exatamente como na 0017 (cópia literal)
create or replace function whatsapp_private.claim_outbox(p_worker_id text, p_limit int default 10, p_lock_seconds int default 60,
                                                       p_kinds text[] default null)
returns setof whatsapp_private.outbox
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_limit int := greatest(1, least(p_limit, 100));
  v_lock interval := make_interval(secs => greatest(10, least(p_lock_seconds, 600)));
  v_n int;
begin
  update whatsapp_private.outbox o
  set status = 'canceled', last_error = 'cliente não pode mais receber: ' || whatsapp_private.recipient_block(c),
      updated_at = now()
  from clients c, whatsapp_private.sessions s
  where o.kind = 'send_text' and o.status = 'pending'
    and (p_kinds is null or 'send_text' = any (p_kinds))
    and c.id = o.client_id and c.company_id = o.company_id
    and s.company_id = o.company_id and s.lease_owner = p_worker_id and s.lease_until > now()
    and whatsapp_private.recipient_block(c) is not null;

  -- conectar / desconectar
  return query
  with c as (
    select o.id from whatsapp_private.outbox o
    join whatsapp_private.sessions s on s.company_id = o.company_id
    where o.kind <> 'send_text'
      and (p_kinds is null or o.kind = any (p_kinds))
      and s.lease_owner = p_worker_id and s.lease_until > now()
      and o.available_at <= now()
      and (o.status = 'pending' or (o.status = 'processing' and o.locked_until < now()))
    order by o.created_at
    limit v_limit
    for update of o skip locked
  )
  update whatsapp_private.outbox o
  set status = 'processing', locked_by = p_worker_id, locked_until = now() + v_lock,
      attempts = o.attempts + 1, updated_at = now()
  from c where o.id = c.id
  returning o.*;
  get diagnostics v_n = row_count;
  if v_n >= v_limit or (p_kinds is not null and not ('send_text' = any (p_kinds))) then
    return;
  end if;

  -- envios (cliente revalidada com trava compartilhada)
  return query
  with c as (
    select o.id from whatsapp_private.outbox o
    join whatsapp_private.sessions s on s.company_id = o.company_id
    join clients cl on cl.id = o.client_id and cl.company_id = o.company_id
    where o.kind = 'send_text'
      and s.lease_owner = p_worker_id and s.lease_until > now()
      and o.available_at <= now()
      and (o.status = 'pending' or (o.status = 'processing' and o.locked_until < now()))
      and whatsapp_private.recipient_block(cl) is null
    order by o.created_at
    limit v_limit - v_n
    for update of o skip locked
    for share of cl
  )
  update whatsapp_private.outbox o
  set status = 'processing', locked_by = p_worker_id, locked_until = now() + v_lock,
      attempts = o.attempts + 1, updated_at = now()
  from c where o.id = c.id
  returning o.*;
end;
$$;
notify pgrst, 'reload schema';
commit;
-- [/BR-SQL]
