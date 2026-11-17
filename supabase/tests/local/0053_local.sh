#!/usr/bin/env bash
# ============================================================================
# 0053 — mais de uma cliente no mesmo horário (opcional, por profissional).
# SOMENTE LOCAL. Banco até a 0052.
# Prova: desligado = comportamento de hoje; ligado = pergunta (AOV01) e depois grava;
# a marca só vale com a opção ligada e com outro atendimento no horário; desligar
# depois não trava o que já existe; a constraint original segue protegendo; permissões;
# funções antigas seguem chamáveis; reversão exata (e travada se houver atendimento junto).
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DB="aurea_0053"
export PGOPTIONS="-c client_min_messages=warning"
bash "$HERE/fresh_db.sh" "$DB" 0052 >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
PSQL=(psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d "$DB")
Q() { "${PSQL[@]}" -c "$1"; }
U() { "${PSQL[@]}" -c "begin; set local \"request.jwt.claim.sub\" = '$1'; set local role authenticated; $2; commit;"; }
ANON() { "${PSQL[@]}" -c "begin; set local role anon; $1; commit;"; }
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
ko() { echo "FAIL $1"; fail=$((fail+1)); }
check() { [[ "$(Q "select ($2)")" == "t" ]] && ok "$1" || ko "$1"; }
errc() { local code="$1" name="$2"; shift 2; local out; out="$("$@" 2>&1)"; grep -q "ERROR:  $code" <<<"$out" && ok "$name" || ko "$name -> $(head -c 220 <<<"$out")"; }
good() { local name="$1"; shift; local out; out="$("$@" 2>&1)"; grep -q "ERROR" <<<"$out" && ko "$name -> $(head -c 220 <<<"$out")" || ok "$name"; }

eval "$(Q "do \$\$ declare uo uuid; up uuid; ux uuid; a uuid; b uuid; begin
  insert into auth.users (email) values ('own@m.local') returning id into uo;
  insert into auth.users (email) values ('pro@m.local') returning id into up;
  insert into auth.users (email) values ('outra@m.local') returning id into ux;
  insert into companies (name) values ('Studio A') returning id into a;
  insert into companies (name) values ('Studio B') returning id into b;
  insert into company_members (company_id, user_id, role) values (a, uo, 'owner'), (a, up, 'professional'), (b, ux, 'owner');
end \$\$;
select format('A=%s B=%s OWN=%s PRO=%s OUT=%s', (select id from companies where name = 'Studio A'), (select id from companies where name = 'Studio B'),
  (select id from auth.users where email = 'own@m.local'), (select id from auth.users where email = 'pro@m.local'), (select id from auth.users where email = 'outra@m.local'))")"
MO="$(Q "select cm.id from company_members cm join auth.users u on u.id = cm.user_id where u.email = 'own@m.local'")"
MP="$(Q "select cm.id from company_members cm join auth.users u on u.id = cm.user_id where u.email = 'pro@m.local'")"
MX="$(Q "select cm.id from company_members cm join auth.users u on u.id = cm.user_id where u.email = 'outra@m.local'")"
S1="$(Q "insert into services (company_id, name, duration_minutes, price) values ('$A', 'Manicure', 60, 50) returning id")"
K1="$(Q "insert into clients (company_id, name, phone, comm_status) values ('$A', 'Ana Lima', '11987654321', 'allowed') returning id")"
K2="$(Q "insert into clients (company_id, name, phone, comm_status) values ('$A', 'Bia Souza', '11987654322', 'allowed') returning id")"
K3="$(Q "insert into clients (company_id, name, phone, comm_status) values ('$A', 'Carla Dias', '11987654323', 'allowed') returning id")"
Q "create sequence zz_day; grant usage on sequence zz_day to authenticated" >/dev/null
# um dia novo por teste; dentro do dia: 10h–11h (T) e 10h30–11h30 (conflita)
DAY() { Q "select (date_trunc('day', now()) + interval '10 days' + nextval('zz_day') * interval '1 day')"; }
# ins <usuario> <membro> <cliente> <dia> <deslocamento> <min> [overlap_ok]
ins() { U "$1" "insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end, price, overlap_ok)
  values ('$A', '$3', '$S1', '$2', ('$4'::timestamptz + interval '$5'), ('$4'::timestamptz + interval '$5' + interval '$6 minutes'), 50, ${7:-false}) returning id"; }
# ins0: igual, sem a coluna overlap_ok (antes da 0053 e depois da reversão ela não existe)
ins0() { U "$1" "insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end, price)
  values ('$A', '$3', '$S1', '$2', ('$4'::timestamptz + interval '$5'), ('$4'::timestamptz + interval '$5' + interval '$6 minutes'), 50) returning id"; }
# CRT <cliente> <dia> <deslocamento> <min> [true]  — create_appointment_with_extras (dona, membro dela)
CRT() { U "$OWN" "select create_appointment_with_extras('$A','$1','$S1','$MO', ('$2'::timestamptz + interval '$3'), ('$2'::timestamptz + interval '$3' + interval '$4 minutes'), 50, null, '[]'::jsonb${5:+, $5})"; }

# ---- baseline (antes da 0053): sobreposição é recusada
D0="$(DAY)"
ins0 "$OWN" "$MO" "$K1" "$D0" "10 hours" 60 >/dev/null
errc "23P01" "P1 antes da 0053 a sobreposição é recusada" ins0 "$OWN" "$MO" "$K2" "$D0" "10 hours 30 minutes" 60

psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/0053_simultaneous_appointments.sql" >/dev/null 2>&1 && ok "B 0053 aplicada" || ko "B 0053 NÃO aplicou"
check "B1 atendimento que já existia ficou com overlap_ok = false" "(select count(*) from appointments where overlap_ok) = 0"

# ================================================================ D. desligado (padrão)
D1="$(DAY)"
ins "$OWN" "$MO" "$K1" "$D1" "10 hours" 60 >/dev/null
errc "23P01" "D1 desligado: sobreposição recusada, como antes" ins "$OWN" "$MO" "$K2" "$D1" "10 hours 30 minutes" 60
errc "23P01" "D2 desligado: mesmo com overlap_ok = true é recusada" ins "$OWN" "$MO" "$K2" "$D1" "10 hours 30 minutes" 60 true
good "D3 desligado: horário encostado (11h) é aceito" ins "$OWN" "$MO" "$K2" "$D1" "11 hours" 60
errc "23P01" "D4 desligado: RPC com p_allow_overlap = true também recusa" \
  CRT "$K3" "$D1" "10 hours 15 minutes" 60 true

# ================================================================ P. a preferência
[[ "$(U "$OWN" "select get_my_allow_simultaneous('$MO')" | head -1)" == "f" ]] && ok "P1 padrão desligado (get_my_allow_simultaneous = false)" || ko "P1"
errc "P0001: Sem permissão" "P2 outra pessoa da equipe não liga a opção da colega" U "$PRO" "select set_my_allow_simultaneous('$MO', true)"
errc "P0001: Sem permissão" "P3 outra empresa não liga" U "$OUT" "select set_my_allow_simultaneous('$MO', true)"
errc "P0001: Sem permissão" "P4 outra empresa não lê a opção de quem não é da empresa" U "$OUT" "select member_allows_simultaneous('$MO')"
errc "P0001: Valor inválido" "P5 valor nulo é recusado" U "$OWN" "select set_my_allow_simultaneous('$MO', null)"
good "P6 a própria profissional liga" U "$OWN" "select set_my_allow_simultaneous('$MO', true)"
[[ "$(U "$OWN" "select get_my_allow_simultaneous('$MO')" | head -1)" == "t" ]] && ok "P7 leitura devolve ligado" || ko "P7"
[[ "$(U "$PRO" "select member_allows_simultaneous('$MO')" | head -1)" == "t" ]] && ok "P8 a colega da empresa enxerga que está ligado (para agendar)" || ko "P8"
errc "42501" "P9 a tabela não é lida direto pela API" U "$OWN" "select * from member_scheduling_prefs"
errc "42501" "P10 anon não executa a função de leitura" ANON "select get_my_allow_simultaneous('$MO')"
check "P11 a outra profissional segue desligada" "coalesce((select allow_simultaneous from member_scheduling_prefs where member_id = '$MP'), false) = false"

# ================================================================ L. ligado
D2="$(DAY)"
A1="$(ins "$OWN" "$MO" "$K1" "$D2" "10 hours" 60)"
errc "AOV01" "L1 ligado, sem confirmar: pergunta (AOV01)" ins "$OWN" "$MO" "$K2" "$D2" "10 hours 30 minutes" 60
B1="$(ins "$OWN" "$MO" "$K2" "$D2" "10 hours 30 minutes" 60 true)"
[[ -n "$B1" ]] && ok "L2 ligado, confirmado: grava" || ko "L2"
check "L3 o atendimento fica marcado como junto" "(select overlap_ok from appointments where id = '$B1')"
check "L4 o primeiro continua sem marca" "not (select overlap_ok from appointments where id = '$A1')"
C1="$(ins "$OWN" "$MO" "$K3" "$D2" "10 hours" 60 true)"
[[ -n "$C1" ]] && ok "L5 uma terceira também entra, confirmando" || ko "L5"
D3="$(DAY)"
N1="$(ins "$OWN" "$MO" "$K1" "$D3" "10 hours" 60 true)"
check "L7 overlap_ok = true SEM outro atendimento no horário é zerado" "not (select overlap_ok from appointments where id = '$N1')"
D4="$(DAY)"
RP="$(CRT "$K1" "$D4" "10 hours" 60 | head -1)"
errc "AOV01" "L8 RPC sem p_allow_overlap: pergunta" CRT "$K2" "$D4" "10 hours 20 minutes" 60
RP2="$(CRT "$K2" "$D4" "10 hours 20 minutes" 60 true | head -1)"
check "L9 RPC com p_allow_overlap = true: grava e marca" "(select overlap_ok from appointments where id = '$RP2')"
good "L10 chamada ANTIGA (9 argumentos) segue funcionando" CRT "$K3" "$D4" "14 hours" 60
good "L11 outro profissional no mesmo horário nunca foi problema" ins "$PRO" "$MP" "$K3" "$D2" "10 hours" 60

# ================================================================ E. editar (update_appointment)
EXP() { Q "select jsonb_build_object('client_id', client_id, 'service_id', service_id, 'professional_member_id', professional_member_id, 'scheduled_start', scheduled_start, 'scheduled_end', scheduled_end, 'price', price, 'status', status) from appointments where id = '$1'"; }
UPD() { # id, dia, deslocamento, minutos, allow
  local id="$1" day="$2" off="$3" mins="$4" allow="$5"
  U "$OWN" "select update_appointment('$id', client_id, service_id, professional_member_id, ('$day'::timestamptz + interval '$off'), ('$day'::timestamptz + interval '$off' + interval '$mins minutes'), price, notes, '$(EXP "$id")'::jsonb, $allow) from appointments where id = '$id'"; }
D5="$(DAY)"
E1="$(ins "$OWN" "$MO" "$K1" "$D5" "10 hours" 60)"
E2="$(ins "$OWN" "$MO" "$K2" "$D5" "13 hours" 60)"
errc "AOV01" "E1 mover para cima de outro SEM confirmar: pergunta" UPD "$E2" "$D5" "10 hours 30 minutes" 60 false
good "E2 mover para cima de outro CONFIRMANDO: grava" UPD "$E2" "$D5" "10 hours 30 minutes" 60 true
check "E3 ficou marcado como junto" "(select overlap_ok from appointments where id = '$E2')"
good "E4 mudar só a observação de um atendimento junto (sem confirmar de novo)" U "$OWN" "select update_appointment('$E2', client_id, service_id, professional_member_id, scheduled_start, scheduled_end, price, 'obs nova', '$(EXP "$E2")'::jsonb) from appointments where id = '$E2'"
check "E5 a marca continuou" "(select overlap_ok from appointments where id = '$E2')"
good "E6 mover o atendimento junto para um horário livre" UPD "$E2" "$D5" "16 hours" 60 false
check "E7 a marca saiu (não há mais outro no horário)" "not (select overlap_ok from appointments where id = '$E2')"

# ================================================================ O. desligar depois não trava o que existe
good "O0 desliga a opção" U "$OWN" "select set_my_allow_simultaneous('$MO', false)"
check "O1 atendimento junto que já existia continua lá, marcado" "(select overlap_ok from appointments where id = '$B1')"
good "O2 confirmar o atendimento junto (muda só o status) funciona com a opção desligada" U "$OWN" "update appointments set status = 'confirmado' where id = '$B1'"
good "O3 editar a observação do atendimento junto funciona" U "$OWN" "update appointments set notes = 'oi' where id = '$B1'"
errc "23P01" "O4 novo atendimento por cima: recusado de novo" ins "$OWN" "$MO" "$K3" "$D2" "10 hours 10 minutes" 60
errc "23P01" "O5 mover o atendimento junto para outro horário ocupado: recusado" U "$OWN" "update appointments set scheduled_start = ('$D5'::timestamptz + interval '10 hours 20 minutes'), scheduled_end = ('$D5'::timestamptz + interval '11 hours 20 minutes') where id = '$B1'"
good "O6 cancelar o atendimento junto funciona" U "$OWN" "update appointments set status = 'cancelado' where id = '$B1'"
good "O7 cancelado libera o horário (volta a aceitar o horário dele, sem sobrepor outro)" ins "$OWN" "$MO" "$K3" "$D2" "12 hours" 60

# ================================================================ C. a constraint original segue valendo
Q "alter table appointments disable trigger trg_appointments_overlap_guard" >/dev/null
D6="$(DAY)"
ins "$OWN" "$MO" "$K1" "$D6" "10 hours" 60 >/dev/null
errc "23P01" "C1 sem o gatilho, a constraint ainda recusa duas gravações sem marca (corrida)" ins "$OWN" "$MO" "$K2" "$D6" "10 hours 30 minutes" 60
Q "alter table appointments enable trigger trg_appointments_overlap_guard" >/dev/null
check "C2 gatilho reativado" "(select tgenabled from pg_trigger where tgname = 'trg_appointments_overlap_guard') = 'O'"

# ================================================================ R. reversão
U "$OWN" "select set_my_allow_simultaneous('$MO', true)" >/dev/null
D7="$(DAY)"
ins "$OWN" "$MO" "$K1" "$D7" "10 hours" 60 >/dev/null
J="$(ins "$OWN" "$MO" "$K2" "$D7" "10 hours 30 minutes" 60 true)"
out="$(psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/operations/0053_reversao.sql" 2>&1)"; grep -q "agendados junto" <<<"$out" && ok "R1 reversão se recusa a rodar com atendimento junto aberto" || ko "R1 -> $(head -c 200 <<<"$out")"
check "R2 e não mudou nada" "exists (select 1 from information_schema.columns where table_name = 'appointments' and column_name = 'overlap_ok')"
Q "update appointments set status = 'cancelado' where overlap_ok" >/dev/null
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/operations/0053_reversao.sql" >/dev/null 2>&1 && ok "R3 reversão executada" || ko "R3 reversão FALHOU"
check "R4 coluna, tabela e gatilho removidos" "not exists (select 1 from information_schema.columns where table_name = 'appointments' and column_name = 'overlap_ok') and to_regclass('member_scheduling_prefs') is null and not exists (select 1 from pg_trigger where tgname = 'trg_appointments_overlap_guard')"
check "R5 assinaturas antigas de volta (9 argumentos)" "(select count(*) from pg_proc where proname in ('update_appointment','create_appointment_with_extras') and pronargs = 9) = 2 and (select count(*) from pg_proc where proname in ('update_appointment','create_appointment_with_extras') and pronargs = 10) = 0"
D8="$(DAY)"
ins0 "$OWN" "$MO" "$K1" "$D8" "10 hours" 60 >/dev/null
errc "23P01" "R6 depois da reversão a sobreposição volta a ser recusada" ins0 "$OWN" "$MO" "$K2" "$D8" "10 hours 30 minutes" 60

echo "RESULTADO 0053: PASS=$pass FAIL=$fail"
[[ $fail -eq 0 ]]
