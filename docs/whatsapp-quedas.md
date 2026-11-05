# WhatsApp: quedas de conexão (04/11/2026)

## O que aconteceu
A conta da Diêne ficou `logged_out` em 03/11 às 21h11 e precisou ser reconectada por QR. O worker não reiniciou
nenhuma vez desde a 0.4.0 (01/11). Tainá e Ester não pedem conexão desde 14/10.

## Causa encontrada no código
`classifyClose` tratava o código **500** (e o **411**) como "desconectado pelo celular" e o worker **apagava as
credenciais**, obrigando a ler um QR novo. No Baileys, o 500 é o código genérico de erro do servidor/da sessão
(inclusive falha passageira no login do WhatsApp); só o **401** significa que o aparelho foi removido.

## Correção (worker 0.4.1 + migration 0050)
- **Só o 401 apaga credenciais.** 500 e 411 reconectam com espera crescente, mantendo as credenciais.
- Se 500/411 persistirem por `BAD_SESSION_MAX_RETRIES` quedas seguidas (padrão 10, ~6 min) sem conectar no meio, a
  sessão para em **"erro"** com o motivo, **sem apagar nada**: o botão Conectar reabre sem QR.
- Toda abertura e queda é gravada em `whatsapp_private.connection_events` (código e tipo, 30 dias). Quando o
  WhatsApp remove o aparelho (401), o motivo também fica em `sessions.last_error`.

## O que NÃO foi mudado
O filtro de grupos/status da 0.4.0 (`WA_IGNORE_GROUPS`) continua ligado: Tainá e Ester seguem estáveis com ele. Na
biblioteca, mensagens ignoradas recebem uma recusa (NACK) em vez de confirmação; não há evidência de que isso derrube
conexões, mas se o histórico mostrar quedas só em contas com muito grupo, `WA_IGNORE_GROUPS=false` volta ao
comportamento anterior sem mudar código (a notificação de "sincronização" pode voltar).

## Publicar
1. Aplicar as migrations 0049 e 0050 (antes do worker: o worker 0.4.1 chama a função de evento).
2. Enviar o worker 0.4.1 à Discloud (um reinício; Tainá e Ester reconectam sozinhas, sem QR).
3. A Diêne reconecta por QR **depois** da publicação (as credenciais dela já foram apagadas em 03/11).

## Como investigar uma queda
```sql
select (at at time zone 'America/Sao_Paulo') quando, event, code, kind, attempt
from whatsapp_private.connection_events where company_id = '<empresa>' order by at desc limit 50;
select status, last_error from whatsapp_private.sessions where company_id = '<empresa>';
```
Códigos: 401 aparelho removido pelo WhatsApp/celular · 500/411 erro do servidor/sessão (agora com nova tentativa) ·
440 sessão aberta em outro lugar · 403 acesso negado · 428/408/503/515 rede ou reinício (reconecta sozinho).
Se aparecer 401 repetido em uma conta só, peça à profissional para conferir em Aparelhos conectados se "Áurea"
continua na lista e quantos aparelhos há (o limite é 4).
