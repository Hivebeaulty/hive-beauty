-- ---------------------------------------------------------------------------
-- 0047 — WhatsApp: início real do processo do worker
--
-- worker_heartbeat (0017) cria a linha do worker na primeira vez e depois só atualiza
-- last_seen_at: com WORKER_ID fixo, started_at ficava para sempre com a data do primeiro
-- início e os reinícios do processo eram invisíveis. worker_started é chamada UMA vez,
-- quando o processo sobe (worker 0.4.0), e grava started_at = agora.
-- Não muda sessões, credenciais, posses, fila nem mensagens.
-- ---------------------------------------------------------------------------
create or replace function whatsapp_private.worker_started(p_worker_id text, p_version text default null)
returns void
language sql security definer
set search_path = public, pg_temp
as $$
  insert into whatsapp_private.workers (worker_id, version) values (p_worker_id, p_version)
  on conflict (worker_id) do update
    set started_at = now(), last_seen_at = now(),
        version = coalesce(excluded.version, whatsapp_private.workers.version)
$$;

revoke all on function whatsapp_private.worker_started(text, text) from public;
grant execute on function whatsapp_private.worker_started(text, text) to wa_worker;
