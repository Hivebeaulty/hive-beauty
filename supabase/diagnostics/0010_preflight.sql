-- DIAGNÓSTICO PRÉ-0010 — SOMENTE LEITURA. Esperado: 0 em todas as linhas de "BLOQUEANTE".
select 'BLOQUEANTE: atendimentos com mais de 1 pagamento' as verificacao, count(*) as qtd from (
  select appointment_id from payments where appointment_id is not null
  group by appointment_id having count(*) > 1) d
union all
select 'informativo: atendimentos concluidos sem pagamento', count(*) from appointments a
  where a.status = 'concluido' and not exists (select 1 from payments p where p.appointment_id = a.id)
union all
select 'informativo: pagamentos ligados a atendimento nao concluido', count(*) from payments p
  join appointments a on a.id = p.appointment_id where a.status <> 'concluido'
union all
select 'informativo: atendimentos em confirmado/em_atendimento', count(*) from appointments
  where status in ('confirmado', 'em_atendimento');
