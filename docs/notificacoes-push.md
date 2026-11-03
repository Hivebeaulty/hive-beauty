# Aviso no celular antes do atendimento (notificação push)

A profissional ativa em **Mais → Configurações → Aviso antes do atendimento**, escolhe a antecedência
(15 min, 30 min, 1 h, 2 h ou desligado) e recebe no celular: **"Daqui a 30 min: Ana"** / **"Gel nas mãos às 14:30"**.
Ao tocar, abre a Agenda. Migration `0048`; função `push-appointment-alerts`; service worker `public/sw.js`.

## Como funciona

1. No aparelho, o navegador cria uma inscrição de push (precisa da permissão e da chave VAPID pública) e o app a
   grava em `push_subscriptions`. A antecedência fica em `push_prefs` (por membro; vazio = desligado).
2. A cada minuto o `pg_cron` (`aurea-push-alerts`) chama a Edge Function com o segredo `push_alerts_cron` (Vault).
3. A função chama `push_claim_due_alerts()`, que reserva em `push_alert_log` os avisos que chegaram na hora e devolve
   o que enviar. Depois envia o Web Push a cada aparelho. Aparelho recusado (404/410) é removido.

Regras: só atendimentos `agendado` ou `confirmado` que ainda não começaram; vai para a profissional responsável;
só se o horário do aviso chegou nos últimos 15 minutos (sem aviso atrasado); remarcar gera um aviso novo.

## Configuração (uma vez)

1. Gerar as chaves: `node scripts/gerar-vapid.cjs` (ou `npx web-push generate-vapid-keys`).
2. **Supabase → Edge Functions → Secrets:** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` e, se quiser, `VAPID_SUBJECT`
   (um `mailto:` ou `https:` de contato; o padrão é a landing). A chave privada vai SÓ aqui.
3. **Vercel → Settings → Environment Variables:** `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (a pública) em Production e Preview;
   depois faça um novo deploy (a variável é lida na hora do build).
4. Aplicar a migration `0048` e publicar a função `push-appointment-alerts` **sem JWT**.

## Como testar

- No celular: ativar os avisos e tocar em **Testar neste aparelho** (mostra a notificação localmente).
- De ponta a ponta: com os avisos em 15 min, criar um atendimento seu daqui a ~20 minutos e esperar o aviso.
- Logs da função (Supabase → Edge Functions → push-appointment-alerts): `{"alerts":1,"sent":1,"failed":0,"dropped":0}`.

## Limites conhecidos

- **iPhone:** o push só funciona com a Sócia instalada na tela inicial (iOS 16.4 ou mais novo).
- Se o navegador trocar a inscrição do aparelho, os avisos param até a profissional abrir
  Configurações (o card refaz o registro) ou ativar de novo.
- O aviso pode chegar com até ~1 minuto de diferença (o agendador roda por minuto).

## Desligar

Pela profissional: Configurações → "Desligado" (ou "Desativar neste aparelho").
Geral: `select cron.unschedule('aurea-push-alerts');`
