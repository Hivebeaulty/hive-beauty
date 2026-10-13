#!/usr/bin/env bash
# ============================================================================
# 0015 — ensaio do fluxo de PRODUÇÃO, ponta a ponta. SOMENTE LOCAL.
#
# 1. Banco com o perfil de produção (diagnóstico de 10/10/2026): 2 atendimentos
#    a regularizar (R$ 100 + R$ 150), o concluído sem recebimento de R$ 90,
#    22 concluídos, 5 cancelados/faltas, 6 futuros; migrations até a 0014.
# 2. Aplica a 0015 e prova que NENHUM dado e NENHUMA função/gatilho existente
#    (incluindo as proteções da 0014) foi alterado.
# 3. Ensaia a regularização (dry run, tentativas erradas, falha simulada,
#    execução certa, repetição) e a ativação (recusas e ativação única).
# 4. Confere o caso de R$ 90 e o diagnóstico v2 no fim.
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DB="aurea_flow_0015"
export PGOPTIONS="-c client_min_messages=warning"
"$HERE/fresh_db.sh" "$DB" 0013 >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
Q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d "$DB" -c "$1"; }
UID_A="$(Q "select id from auth.users order by created_at limit 1")"

Q "
do \$\$
declare c1 uuid; c2 uuid; m1 uuid; m2 uuid; s1 uuid; s2 uuid; k1 uuid; k2 uuid; a uuid; i int;
  hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  insert into companies (name) values ('Studio 1') returning id into c1;
  insert into companies (name) values ('Studio 2') returning id into c2;
  insert into company_members (company_id, user_id, role) values (c1, '$UID_A', 'owner') returning id into m1;
  insert into company_members (company_id, user_id, role) values (c2, '$UID_A', 'owner') returning id into m2;
  insert into services (company_id, name, price) values (c1, 'Mão', 100) returning id into s1;
  insert into services (company_id, name, price) values (c2, 'Pé', 150) returning id into s2;
  insert into clients (company_id, name) values (c1, 'Cliente 1') returning id into k1;
  insert into clients (company_id, name) values (c2, 'Cliente 2') returning id into k2;

  -- concluídos e recebidos, pelo fluxo real (RPC como a usuária)
  perform set_config('request.jwt.claim.sub', '$UID_A', true);
  for i in 1..11 loop
    insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end)
      values (c1, k1, s1, m1, 100, now() - (i + 2) * interval '1 day', now() - (i + 2) * interval '1 day' + interval '1 hour') returning id into a;
    perform conclude_appointment(a, 100, 'pix');
    insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end)
      values (c2, k2, s2, m2, 150, now() - (i + 2) * interval '1 day', now() - (i + 2) * interval '1 day' + interval '1 hour') returning id into a;
    perform conclude_appointment(a, 150, 'dinheiro');
  end loop;

  -- o caso de R\$ 90: concluído pela RPC e recebimento apagado depois (Receitas > Excluir)
  insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end, notes)
    values (c1, k1, s1, m1, 90, now() - interval '9 days 3 hours', now() - interval '9 days 2 hours', 'LEGADO-90') returning id into a;
  perform conclude_appointment(a, 90, 'pix');
  delete from payments where appointment_id = a;

  -- os 2 a regularizar: em aberto, terminaram antes de hoje
  insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end, notes)
    values (c1, k1, s1, m1, 100, (hoje - 14 + time '17:00') at time zone 'America/Sao_Paulo',
            (hoje - 14 + time '18:00') at time zone 'America/Sao_Paulo', 'REGULARIZAR-100'),
           (c2, k2, s2, m2, 150, (hoje - 10 + time '08:00') at time zone 'America/Sao_Paulo',
            (hoje - 10 + time '09:00') at time zone 'America/Sao_Paulo', 'REGULARIZAR-150');

  -- cancelados/faltas e futuros
  for i in 1..5 loop
    insert into appointments (company_id, client_id, service_id, professional_member_id, price, status, scheduled_start, scheduled_end)
      values (c1, k1, s1, m1, 100, case when i % 2 = 0 then 'cancelado' else 'nao_compareceu' end::appointment_status,
              now() - (i + 20) * interval '1 day', now() - (i + 20) * interval '1 day' + interval '1 hour');
  end loop;
  for i in 1..6 loop
    insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end)
      values (c2, k2, s2, m2, 120, now() + i * interval '1 day', now() + i * interval '1 day' + interval '1 hour');
  end loop;
end \$\$;"
psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/0014_appointment_lifecycle_guards.sql" >/dev/null || { echo "FALHA: 0014"; exit 1; }

DATA="select md5(string_agg(x, '|' order by x)) from (
  select 'a' || to_jsonb(t)::text x from appointments t union all select 'p' || to_jsonb(t)::text from payments t
  union all select 'c' || to_jsonb(t)::text from clients t union all select 'h' || to_jsonb(t)::text from appointment_status_history t
  union all select 'l' || count(*)::text from audit_logs) z"
DEFS="select md5(string_agg(d, '|' order by d)) from (
  select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
  union all select pg_get_triggerdef(t.oid) || t.tgenabled::text from pg_trigger t join pg_class c on c.oid = t.tgrelid
            join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal
  union all select pol.polname || pg_get_expr(pol.polqual, pol.polrelid) from pg_policy pol
  union all select conname || pg_get_constraintdef(oid) from pg_constraint where connamespace = 'public'::regnamespace) z"
LEG="select md5(to_jsonb(a)::text) from appointments a where notes = 'LEGADO-90'"
SET="select md5(to_jsonb(s)::text) from aurea_private.settings s"

pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
ko() { echo "FAIL $1"; fail=$((fail+1)); }
check() { [[ "$(Q "select ($2)")" == "t" ]] && ok "$1" || ko "$1"; }

D0="$(Q "$DATA")"; F0="$(Q "$DEFS")"; L0="$(Q "$LEG")"
psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/0015_auto_conclusion.sql" >/dev/null || { echo "FAIL: 0015 não aplicou"; exit 1; }
[[ ${#D0} -eq 32 && ${#F0} -eq 32 && ${#L0} -eq 32 ]] || { echo "FAIL: fotos iniciais vazias"; exit 1; }
[[ "$(Q "$DATA")" == "$D0" ]] && ok "M1 aplicar a 0015 não alterou nenhum dado (atendimentos, recebimentos, clientes, histórico, auditoria)" || ko "M1"
[[ "$(Q "$DEFS")" == "$F0" ]] && ok "M2 nenhuma função, gatilho, policy ou constraint existente foi alterada (0014 intacta)" || ko "M2"
check "M3 automação desligada e sem data de início" "(select not enabled and process_from is null from aurea_private.settings)"

ID100=$(Q "select id from appointments where notes = 'REGULARIZAR-100'"); ID150=$(Q "select id from appointments where notes = 'REGULARIZAR-150'")
S0="$(Q "$SET")"

# ---- dry run
DRY="$(Q "select aurea_private.regularize()")"
check "R1 dry run: exatamente os 2 (R\$ 100 + R\$ 150), total 250, nenhuma anomalia" \
  "('$DRY'::jsonb ->> 'quantidade')::int = 2 and ('$DRY'::jsonb ->> 'total')::numeric = 250
   and (select array_agg(x->>'appointment_id' order by x->>'appointment_id') from jsonb_array_elements('$DRY'::jsonb -> 'candidatos') x)
       = (select array_agg(i order by i) from unnest(array['$ID100', '$ID150']) i)
   and jsonb_array_length('$DRY'::jsonb -> 'anomalias_nao_tocadas') = 0"
check "R1 o caso de R\$ 90 não aparece no dry run" "position((select id::text from appointments where notes = 'LEGADO-90') in '$DRY') = 0"
[[ "$(Q "$DATA")" == "$D0" ]] && ok "R1 dry run não alterou nenhum dado" || ko "R1 dados"

# ---- tentativas erradas: nada muda
for args in "array['$ID100']::uuid[], 100" "array['$ID100','$ID150']::uuid[], 249.99" "array['$ID100','$ID150','$ID100']::uuid[], 250" "null, null"; do
  RES="$(Q "select aurea_private.regularize($args, false)")"
  if [[ "$(Q "select ('$RES'::jsonb ->> 'status') = 'aborted'")" == t && "$(Q "$DATA")" == "$D0" ]]; then
    ok "R2 tentativa errada ($args) abortada sem alterar dados ($(Q "select '$RES'::jsonb ->> 'sqlstate'"))"
  else ko "R2 ($args): $RES"; fi
done
# ---- falha simulada no meio: nada muda (o R$ 100 também não)
Q "create function zz_fail() returns trigger language plpgsql as \$b\$ begin raise exception 'zz falha simulada'; end \$b\$;
   create trigger zz_fail before insert on payments for each row when (new.amount = 150) execute function zz_fail();" >/dev/null
RES="$(Q "select aurea_private.regularize(array['$ID100','$ID150']::uuid[], 250, false)")"
[[ "$(Q "select ('$RES'::jsonb ->> 'status') = 'aborted'")" == t && "$(Q "$DATA")" == "$D0" ]] \
  && ok "R3 falha no 2º atendimento: abortada e o 1º TAMBÉM ficou intacto" || ko "R3: $RES"
Q "drop trigger zz_fail on payments; drop function zz_fail();" >/dev/null
[[ "$(Q "$SET")" == "$S0" ]] && ok "R4 nenhuma tentativa abortada alterou a configuração" || ko "R4"
check "R4 todas as tentativas ficaram registradas como 'aborted'" \
  "(select count(*) from aurea_private.runs where kind = 'regularization' and status = 'aborted') = 5"

# ---- execução certa
REG="$(Q "select aurea_private.regularize(array['$ID150','$ID100']::uuid[], 250.00, false)")"
RUN_REG="$(Q "select '$REG'::jsonb ->> 'run_id'")"
check "R5 execução certa: 2 concluídos, total 250" "('$REG'::jsonb ->> 'status') = 'ok' and ('$REG'::jsonb ->> 'concluidos')::int = 2 and ('$REG'::jsonb ->> 'total')::numeric = 250"
check "R5 recebimentos: Pix, pago, origem backfill, datados do atendimento" \
  "(select count(*) from payments p join appointments a on a.id = p.appointment_id where a.notes like 'REGULARIZAR-%'
     and p.status = 'pago' and p.method = 'pix' and p.source = 'backfill' and p.created_at = a.scheduled_end and p.paid_at = a.scheduled_end
     and a.status = 'concluido' and a.completed_at = a.scheduled_end) = 2"
RES="$(Q "select aurea_private.regularize(array['$ID150','$ID100']::uuid[], 250.00, false)")"
check "R6 repetir a regularização é recusado (AUR13) e não cria 2º recebimento" \
  "('$RES'::jsonb ->> 'sqlstate') = 'AUR13' and (select count(*) from payments p join appointments a on a.id = p.appointment_id where a.notes like 'REGULARIZAR-%') = 2"

# ---- ativação
S1="$(Q "$SET")"
DRY_ID="$(Q "select id from aurea_private.runs where kind = 'regularization_dry_run' order by started_at limit 1")"
ABT_ID="$(Q "select id from aurea_private.runs where kind = 'regularization' and status = 'aborted' order by started_at limit 1")"
for c in "'$DRY_ID', null:AUR21" "'$ABT_ID', null:AUR21" "'$RUN_REG', now() + interval '1 day':AUR22"; do
  args="${c%:*}"; code="${c##*:}"
  out="$(psql -X -q -d "$DB" -c "\\set VERBOSITY verbose" -c "select aurea_private.activate_auto_conclusion($args)" 2>&1)"
  if grep -q "$code" <<<"$out" && [[ "$(Q "$SET")" == "$S1" ]]; then ok "A1 ativação recusada ($code) sem alterar a configuração"; else ko "A1 ($args): $out"; fi
done
ACT="$(Q "select aurea_private.activate_auto_conclusion('$RUN_REG')")"
check "A2 ativação: início = 00:00 de hoje em São Paulo, chave ligada, amarrada à regularização" \
  "(select process_from = aurea_private.sp_day_start(now()) and enabled and activation_run_id = '$RUN_REG' from aurea_private.settings)"
out="$(psql -X -q -d "$DB" -c "\\set VERBOSITY verbose" -c "select aurea_private.activate_auto_conclusion('$RUN_REG')" 2>&1)"
grep -q AUR20 <<<"$out" && ok "A3 segunda ativação recusada (AUR20)" || ko "A3: $out"
check "A4 depois da ativação a regularização é recusada (AUR10)" "(aurea_private.regularize() ->> 'sqlstate') = 'AUR10'"
out="$(psql -X -q -d "$DB" -c "\\set VERBOSITY verbose" -c "update aurea_private.settings set process_from = process_from - interval '90 days'" 2>&1)"
grep -q 55000 <<<"$out" && ok "A5 process_from imutável (55000)" || ko "A5: $out"

# ---- primeira execução real da automação (como o cron faria)
RUNA="$(Q "select aurea_private.run_auto_conclusion()")"
check "A6 primeira execução real: nada antes do início é tocado; futuros intactos" \
  "('$RUNA'::jsonb ->> 'status') in ('idle','ok') and (select count(*) from appointments where scheduled_end > now() and status = 'agendado') = 6"

# ---- o caso de R$ 90
[[ "$(Q "$LEG")" == "$L0" ]] && ok "L1 o atendimento de R\$ 90 continua idêntico (hash)" || ko "L1"
check "L2 o de R\$ 90 continua sem recebimento e fora de qualquer log da automação" \
  "not exists (select 1 from payments p join appointments a on a.id = p.appointment_id where a.notes = 'LEGADO-90')
   and not exists (select 1 from aurea_private.run_items i join appointments a on a.id = i.appointment_id where a.notes = 'LEGADO-90')
   and not exists (select 1 from aurea_private.appointment_state s join appointments a on a.id = s.appointment_id where a.notes = 'LEGADO-90')"
REV="$(Q "select aurea_private.revert_run('$RUN_REG', true)")"
check "V1 a regularização é reversível (dry run da reversão; nada alterado)" "('$REV'::jsonb ->> 'status') = 'dry_run'"
check "G  invariante: só o legado de R\$ 90 é concluído sem recebimento" \
  "(select count(*) from appointments a where a.status = 'concluido' and not exists (select 1 from payments p where p.appointment_id = a.id)) = 1"

if [[ -n "${DIAG:-}" && -f "$DIAG" ]]; then
  echo "--- diagnóstico v2, seção 1, depois da regularização:"
  psql -X -q -A -d "$DB" -c "$(sed -n '/SEÇÃO 1 /,/order by 1;/p' "$DIAG")" | grep -a -E "^(0[0-9]|10|TOTAL)" | sed 's/^/   /'
fi
echo "RESULTADO fluxo de produção 0015: PASS=$pass FAIL=$fail"
dropdb --force "$DB"
[[ $fail -eq 0 ]]
