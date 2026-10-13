-- ============================================================================
-- ÁUREA — 0015: REGULARIZAÇÃO DOS ATENDIMENTOS ANTIGOS E ATIVAÇÃO
--
-- NÃO EXECUTE NADA DESTE ARQUIVO SEM AUTORIZAÇÃO EXPLÍCITA, PASSO A PASSO.
-- Pré-requisito: migration 0015 aplicada e teste 0015 com ZERO "FAIL".
-- Cada PASSO é independente: selecione só aquele trecho e use "Run selected".
-- Tudo roda como postgres (o papel do SQL Editor). Nada aqui é acessível pela API.
-- ============================================================================


-- PASSO 1 — DRY RUN (não altera atendimentos, recebimentos nem clientes;
-- só registra a própria execução no log privado)
select jsonb_pretty(aurea_private.regularize());
-- Esperado (diagnóstico de 10/10/2026):
--   "quantidade": 2, "total": 250.00, "anomalias_nao_tocadas": []
--   candidatos: f077bf3d-5507-441a-8114-b3493ebd640b (Diêne, R$ 100)
--               674b1ea5-3bbc-46dd-bd39-2799f0f51a35 (Ester, R$ 150)
-- Se a lista ou o total forem diferentes: PARE e envie o resultado.


-- PASSO 2 — REGULARIZAÇÃO (tudo ou nada; exige os IDs e o total exatos)
select jsonb_pretty(aurea_private.regularize(
  p_expected_ids   => array['f077bf3d-5507-441a-8114-b3493ebd640b',
                            '674b1ea5-3bbc-46dd-bd39-2799f0f51a35']::uuid[],
  p_expected_total => 250.00,
  p_dry_run        => false));
-- Esperado: "status": "ok", "concluidos": 2, "total": 250.00  -> GUARDE o "run_id".
-- Se vier "status": "aborted": NADA foi alterado. Copie "sqlstate" e "mensagem" e pare.


-- PASSO 3 — VERIFICAÇÃO (só leitura)
select co.name as empresa, a.id, a.status,
       to_char(a.scheduled_end at time zone 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI') as fim_sp,
       p.amount, p.method, p.status as recebimento, p.source,
       to_char(p.created_at at time zone 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI') as data_no_financeiro_sp
from appointments a
join companies co on co.id = a.company_id
left join payments p on p.appointment_id = a.id
where a.id in ('f077bf3d-5507-441a-8114-b3493ebd640b', '674b1ea5-3bbc-46dd-bd39-2799f0f51a35');
-- Esperado: 2 linhas, concluido, 100/150, pix, pago, backfill, datas 30/09 09:00 e 26/09 18:00.
-- Depois rode as seções 1 e 8 do diagnostico_regularizacao_atendimentos_v2.sql:
--   categoria 01 = 0, 06 = 1 (o de R$ 90, intocado), 09 = anterior + 2; seção 8 toda zero.


-- PASSO 4 — ATIVAÇÃO (SOMENTE com autorização explícita para ligar a automação)
-- Precisa ser no MESMO dia (São Paulo) do PASSO 2. Se for outro dia, repita o
-- PASSO 1 e, se não houver nada novo, rode a regularização vazia:
--   select jsonb_pretty(aurea_private.regularize('{}'::uuid[], 0, false));
-- e use o run_id dela abaixo.
select jsonb_pretty(aurea_private.activate_auto_conclusion('COLE-AQUI-O-RUN_ID-DO-PASSO-2'));
-- Esperado: "status": "ativada" e "process_from_sp" = hoje 00:00.
-- A data de início fica gravada para sempre. A automação só conclui de fato
-- quando o cron (migration 0016) estiver agendado.


-- DESLIGAR A AUTOMAÇÃO (efeito imediato; o cron continua agendado, mas não faz nada)
select aurea_private.set_auto_conclusion_enabled(false);

-- RELIGAR (só depois da ativação)
select aurea_private.set_auto_conclusion_enabled(true);


-- REVERTER UMA EXECUÇÃO (regularização ou automação). Sempre o dry run primeiro.
-- Só reverte se NADA tiver sido alterado depois (forma, pendente, falta,
-- observação, exclusão, visitas da cliente); caso contrário devolve "bloqueada"
-- com os motivos e não altera nada.
select jsonb_pretty(aurea_private.revert_run('COLE-AQUI-O-RUN_ID', true));
select jsonb_pretty(aurea_private.revert_run('COLE-AQUI-O-RUN_ID', false));
