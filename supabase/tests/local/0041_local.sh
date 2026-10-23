#!/usr/bin/env bash
# ============================================================================
# 0041 — medição da landing. SOMENTE LOCAL (banco descartável).
# Sal diário (apaga os antigos), lista fechada de eventos, limpeza dos campos,
# limite por visitante, funil com dados da cobrança e permissões.
# ============================================================================
set -uo pipefail
export PGOPTIONS="-c client_min_messages=warning"; DB=aurea_0041; R="$(cd "$(dirname "$0")/../.." && pwd)"
bash $R/tests/local/fresh_db.sh $DB 0040 >/dev/null
Q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d $DB -c "$1" 2>&1; }
SR() { psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d $DB -c "begin; set local role service_role; $1; commit;" 2>&1; }
U() { psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d $DB -c "begin;
  set local \"request.jwt.claims\" = '{\"sub\":\"$1\",\"aal\":\"$2\",\"role\":\"authenticated\"}';
  set local role authenticated; $3; commit;" 2>&1; }
AN() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d $DB -c "begin; set local role anon; $1; commit;" 2>&1; }
pass=0; fail=0; ok() { echo "PASS $1"; pass=$((pass+1)); }; ko() { echo "FAIL $1"; fail=$((fail+1)); }
has() { [[ "$1" == *"$2"* ]]; }

Q "do \$\$ declare adm uuid; begin
  insert into auth.users (email) values ('admin@x.com') returning id into adm; insert into superadmins (user_id) values (adm);
  insert into auth.users (email) values ('comum@x.com'); end \$\$" >/dev/null
psql -X -q -1 -v ON_ERROR_STOP=1 -d $DB -f $R/migrations/0041_landing_analytics.sql >/dev/null 2>/tmp/0041.err && ok "0041 aplicada" || ko "0041: $(cat /tmp/0041.err)"
ADM=$(Q "select id from auth.users where email = 'admin@x.com'"); CO=$(Q "select id from auth.users where email = 'comum@x.com'")

# --- permissões -------------------------------------------------------------------------
for f in "analytics_daily_salt()" "analytics_ingest('{}')"; do
  has "$(AN "select $f")" "permission denied" && ok "visitante anônima não chama ${f%%(*} direto" || ko "anon: $f"
  has "$(U $CO aal2 "select $f")" "permission denied" && ok "usuária logada não chama ${f%%(*}" || ko "auth: $f"
done
has "$(AN "select count(*) from analytics_events")" "permission denied" && ok "eventos não são legíveis pela API" || ko "eventos expostos"
has "$(AN "select count(*) from analytics_salts")" "permission denied" && ok "sal não é legível pela API" || ko "sal exposto"
has "$(U $CO aal2 "select admin_funnel(now() - interval '1 day', now())")" 42501 && ok "funil: só superadmin" || ko "funil aberto"
has "$(U $ADM aal1 "select admin_funnel(now() - interval '1 day', now())")" AUA01 && ok "funil: exige MFA" || ko "funil sem MFA"

# --- sal do dia ---------------------------------------------------------------------------
S1=$(SR "select analytics_daily_salt()"); S2=$(SR "select analytics_daily_salt()")
[[ ${#S1} == 64 && "$S1" == "$S2" ]] && ok "sal do dia: 64 caracteres, o mesmo o dia todo" || ko "sal: $S1 / $S2"
Q "delete from analytics_salts; insert into analytics_salts values ((now() at time zone 'America/Sao_Paulo')::date - 5, 'velho'), ((now() at time zone 'America/Sao_Paulo')::date - 1, 'ontem')" >/dev/null
SR "select analytics_daily_salt()" >/dev/null
[[ "$(Q "select string_agg(salt, ',' order by day) from analytics_salts where salt in ('velho','ontem')")" == "ontem" ]] && ok "sal antigo apagado (identificador não pode ser refeito); ontem fica para a virada do dia" || ko "sal antigo ficou"
[[ "$(Q "select count(*) from analytics_salts")" == 2 ]] && ok "só existem os sais de hoje e de ontem" || ko "sais: $(Q "select count(*) from analytics_salts")"

# --- gravação ---------------------------------------------------------------------------------
ing() { SR "select analytics_ingest('$1')"; }
V=0123456789abcdef
[[ "$(ing "{\"event\":\"pageview\",\"visitor\":\"$V\",\"path\":\"/\",\"utm_source\":\"Instagram\",\"device\":\"mobile\"}")" == t ]] && ok "visita gravada" || ko "pageview"
[[ "$(ing "{\"event\":\"compra\",\"visitor\":\"$V\",\"path\":\"/\"}")" == f ]] && ok "evento fora da lista: recusado" || ko "evento livre aceito"
[[ "$(ing "{\"event\":\"pageview\",\"visitor\":\"ana@x.com\",\"path\":\"/\"}")" == f ]] && ok "identificador que não é hash: recusado (e-mail não entra)" || ko "visitor livre"
ing "{\"event\":\"cta_click\",\"visitor\":\"$V\",\"path\":\"/<script>?email=ana@x.com\",\"referrer_host\":\"https://evil.com/x?y\",\"cta\":\"Hero Botão!\",\"device\":\"tv\"}" >/dev/null
[[ "$(Q "select path||'|'||referrer_host||'|'||cta||'|'||device from analytics_events where event = 'cta_click'")" == "/scriptemailanaxcom|httpsevil.comxy|heroboto|desktop" ]] && ok "campos limpos: sem caracteres estranhos, aparelho desconhecido vira desktop" || ko "limpeza: $(Q "select path||'|'||referrer_host||'|'||cta||'|'||device from analytics_events where event = 'cta_click'")"
[[ "$(Q "select utm_source from analytics_events where event = 'pageview'")" == instagram ]] && ok "UTM normalizada em minúsculas" || ko "utm"
Q "insert into analytics_events (event, path, visitor, device) select 'pageview', '/', 'ffffffffffffffff', 'desktop' from generate_series(1, 300)" >/dev/null
[[ "$(ing '{"event":"pageview","visitor":"ffffffffffffffff","path":"/"}')" == f ]] && ok "limite de 300 eventos por visitante por dia" || ko "sem limite"
Q "delete from analytics_events where visitor = 'ffffffffffffffff'" >/dev/null
Q "insert into analytics_events (at, day, event, path, visitor, device) values (now() - interval '25 months', (now() - interval '25 months')::date, 'pageview', '/', 'aaaaaaaaaaaaaaaa', 'desktop')" >/dev/null
Q "delete from analytics_salts" >/dev/null; SR "select analytics_daily_salt()" >/dev/null
[[ "$(Q "select count(*) from analytics_events where visitor = 'aaaaaaaaaaaaaaaa'")" == 0 ]] && ok "retenção: eventos com mais de 24 meses apagados" || ko "retenção"

# --- funil -------------------------------------------------------------------------------------
Q "truncate analytics_events" >/dev/null
for v in 1111111111111111 2222222222222222 3333333333333333 4444444444444444; do
  ing "{\"event\":\"pageview\",\"visitor\":\"$v\",\"path\":\"/\",\"utm_source\":\"instagram\",\"utm_campaign\":\"lancamento\",\"device\":\"mobile\"}" >/dev/null; done
ing '{"event":"pageview","visitor":"1111111111111111","path":"/"}' >/dev/null   # recarregou: mesma visitante
ing '{"event":"pageview","visitor":"5555555555555555","path":"/","referrer_host":"google.com","device":"desktop"}' >/dev/null
ing '{"event":"pageview","visitor":"5555555555555555","path":"/privacidade"}' >/dev/null
ing '{"event":"cta_click","visitor":"1111111111111111","path":"/","cta":"hero","utm_source":"instagram"}' >/dev/null
ing '{"event":"cta_click","visitor":"1111111111111111","path":"/","cta":"plano","utm_source":"instagram"}' >/dev/null
ing '{"event":"cta_click","visitor":"5555555555555555","path":"/","cta":"plano","referrer_host":"google.com"}' >/dev/null
ing '{"event":"whatsapp_click","visitor":"2222222222222222","path":"/"}' >/dev/null
SR "select billing_sync('{\"email\":\"n@x.com\",\"status\":\"trialing\",\"preapproval_id\":\"P1\",\"last_modified\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}')" >/dev/null
F="$(U $ADM aal2 "select admin_funnel(now() - interval '1 day', now() + interval '1 minute')::text")"
chk() { has "$F" "$1" && ok "$2" || ko "$2 (esperado $1)"; }
chk '"visitors": 5' "5 visitantes na página inicial (recarregar não conta duas vezes)"
chk '"pageviews": 7' "7 visualizações de página"
chk '"clickers": 2' "2 visitantes clicaram para assinar"
chk '"cta_clicks": 3' "3 cliques no total"
chk '"whatsapp_clicks": 1' "clique no WhatsApp separado"
chk '"trials_started": 1' "testes iniciados vêm da cobrança"
chk '"origin": "instagram", "clickers": 1, "visitors": 4' "origem instagram: 4 visitantes, 1 clicou"
chk '"origin": "google.com", "clickers": 1, "visitors": 1' "origem pelo site de onde veio (google.com)"
chk '"mobile": 4' "por aparelho"
chk '"plano": 2' "por botão"
chk '"campaign": "lancamento"' "por campanha (UTM)"
has "$(U $ADM aal2 "select admin_funnel(now(), now() - interval '1 day')")" 22023 && ok "período invertido recusado" || ko "período"

# --- cancelamento: acesso até o fim do período pago -----------------------------------------
Q "do \$\$ declare u uuid; c uuid; n text; i int := 0; begin
  foreach n in array array['Paga', 'Teste', 'Antiga', 'Reembolsada'] loop i := i + 1;
    insert into auth.users (email) values ('c' || i || '@x.com') returning id into u;
    insert into companies (name) values (n) returning id into c;
    insert into company_members (company_id, user_id, role) values (c, u, 'owner'); end loop; end \$\$" >/dev/null
cancel_with() {  # email preapproval pagamento(paid_at ou vazio) reembolso
  SR "select billing_sync('{\"email\":\"$1\",\"status\":\"active\",\"preapproval_id\":\"$2\",\"last_modified\":\"2026-01-01T00:00:00Z\"}')" >/dev/null
  [[ -n "$3" ]] && SR "select billing_record_payment('{\"authorized_payment_id\":\"AP$2\",\"preapproval_id\":\"$2\",\"email\":\"$1\",\"status\":\"approved\",\"amount\":59.90,\"refunded_amount\":${4:-0},\"paid_at\":\"$3\"}')" >/dev/null
  SR "select billing_sync('{\"email\":\"$1\",\"status\":\"canceled\",\"preapproval_id\":\"$2\",\"mp_status\":\"cancelled\"}')" >/dev/null; }
cancel_with c1@x.com G1 "$(date -u -d '-10 days' +%Y-%m-%dT%H:%M:%SZ)"
cancel_with c2@x.com G2 ""
cancel_with c3@x.com G3 "$(date -u -d '-40 days' +%Y-%m-%dT%H:%M:%SZ)"
cancel_with c4@x.com G4 "$(date -u -d '-10 days' +%Y-%m-%dT%H:%M:%SZ)" 59.90
acc() { local u c; u=$(Q "select id from auth.users where email = '$1'"); c=$(Q "select company_id from company_members where user_id = '$u'"); U $u aal1 "select get_company_access('$c')::text"; }
A1="$(acc c1@x.com)"; has "$A1" '"status": "ending"' && has "$A1" '"allowed": true' && has "$A1" '"until"' && ok "cancelou com mês pago: acesso até o fim do período, com aviso" || ko "período pago: $A1"
has "$(acc c2@x.com)" '"status": "canceled", "allowed": false' && ok "cancelou no teste grátis (nada pago): bloqueia na hora" || ko "teste: $(acc c2@x.com)"
has "$(acc c3@x.com)" '"status": "canceled", "allowed": false' && ok "período pago já acabou: bloqueia" || ko "antiga: $(acc c3@x.com)"
has "$(acc c4@x.com)" '"status": "canceled", "allowed": false' && ok "pagamento reembolsado por inteiro não dá período de acesso" || ko "reembolsada: $(acc c4@x.com)"

echo "RESULTADO 0041: PASS=$pass FAIL=$fail"; dropdb --force $DB
