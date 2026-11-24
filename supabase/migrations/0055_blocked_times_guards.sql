-- ---------------------------------------------------------------------------
-- 0055 — BLOQUEIO DE HORÁRIO NA AGENDA: travas na tabela blocked_times
--
-- A tabela blocked_times existe desde a 0001 (profissional ou toda a equipe,
-- início, fim e a observação em `reason`), está vazia e já tem RLS por empresa.
-- A tela "Bloquear horário" (folga, almoço, consulta, férias) usa essa tabela como
-- está: ESTA MIGRATION É OPCIONAL, o app funciona sem ela. Ela só garante no banco
-- o que a tela já confere, para que nenhuma gravação fora do app grave lixo:
--
--   * o fim tem que ser depois do início;
--   * a observação tem no máximo 200 caracteres (mesmo limite da tela);
--   * índice por empresa e período, que é como a agenda e a grade de horários
--     consultam (empresa + "começa antes do fim do período e termina depois do início").
--
-- Não muda dados nem políticas; idempotente. A tabela está vazia, então as
-- travas entram sem risco de recusar linha existente.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'blocked_times_end_after_start') then
    alter table blocked_times
      add constraint blocked_times_end_after_start check (end_at > start_at);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'blocked_times_reason_len') then
    alter table blocked_times
      add constraint blocked_times_reason_len check (reason is null or char_length(reason) <= 200);
  end if;
end
$$;

create index if not exists blocked_times_company_period_idx
  on blocked_times (company_id, start_at, end_at);
