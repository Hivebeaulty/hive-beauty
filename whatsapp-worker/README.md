# Worker de WhatsApp da Áurea (W2–W5)

Processo Node.js que mantém **uma sessão de WhatsApp por empresa** (Baileys).
Ele **só conversa com o banco**, pelas funções do schema `whatsapp_private`
(migration 0017), usando o papel `wa_worker`, que não tem acesso a nenhuma tabela.

## O que a W2 faz
- Conexão por QR Code: o QR vai para o banco (validade de 60 s) e só a owner/admin vê pelo app (W3).
- Status no banco: `connect_requested → qr_pending → connected`, `connecting` durante reconexão.
- Credenciais do Baileys **cifradas** (AES-256-GCM, chave por empresa) no banco. Reinício ou redeploy não pedem novo QR.
- Reconexão automática com espera crescente (2 s → 60 s). Para de vez em: desconectado pelo celular (401),
  sessão aberta em outro lugar (440), acesso negado (403), QR não lido a tempo.
- Trava de posse por sessão: dois processos nunca abrem o mesmo número. Sem confirmar a posse por quase
  todo o prazo (ex.: banco fora do ar), a sessão é fechada por segurança.
- Encerramento limpo (SIGTERM/SIGINT): fecha sem desvincular o aparelho, grava pendências e libera a posse.
- **Mensagens desligadas por padrão** (`WA_MESSAGING_ENABLED=false`): pedidos de envio ficam intactos na fila;
  mensagens recebidas são ignoradas. Receber e enviar só ligam **juntos** (nunca enviar sem ouvir SAIR).

## W4/W5 (com `WA_MESSAGING_ENABLED=true`)
- Recebidas: gravadas uma vez por id; ligadas à cliente pelo número (com/sem 9º dígito); grupos/canais ignorados.
  Contato identificado só por LID: o worker pergunta o número ao mapa LID do Baileys; sem mapa, grava sem cliente.
  "SAIR"/"PARAR"/"STOP" sozinhos bloqueiam a cliente **naquela empresa**.
- Envios: só com a sessão `connected`; ritmo mínimo por empresa (`SEND_INTERVAL_MS`); número sem WhatsApp falha de vez.
  **Id da mensagem determinístico por pedido da fila**: se o worker cair depois de enviar e antes de registrar,
  o reenvio usa o mesmo id (o banco não duplica; o WhatsApp trata como a mesma mensagem).
- Confirmação automática (migration 0018): o banco enfileira no momento do agendamento; o worker só envia.
- Logs: nunca telefone completo nem texto de mensagem.

## Sem "sincronizações" no celular (0.4.0, auditoria de 01/11/2026)
- O Baileys **não pede ao celular** cópia de mensagem que não conseguiu ler (`placeholderResendCache` que sempre
  responde "já pedido"). Cada pedido desses fazia o WhatsApp Business mostrar "A sincronização com o WhatsApp Business
  no Google Chrome (Ubuntu) foi concluída".
- Grupos, listas de transmissão, status e canais são ignorados **antes** de decifrar (`shouldIgnoreJid`):
  sem falhas de decifração de grupo nem chaves de grupo guardadas à toa. `WA_IGNORE_GROUPS=false` desliga.
- Reconexão reaproveita o mesmo estado de credenciais e espera as gravações do socket anterior.
- Logs: a libsignal escrevia no console objetos de sessão com chaves privadas; agora essas linhas são descartadas
  (`guardConsole`). Identificadores de contato dos erros do Baileys ficam ocultos.
- `whatsapp_private.workers.started_at` mostra a última subida do processo (migration 0047).

## Testes
- Unitários (sem banco, sem rede): `npm test`
- Integração (Postgres LOCAL com 0001–0018; senha de teste aleatória só local; desfaz tudo; inclui
  `auto-confirmation.test.js`, ponta a ponta da confirmação automática):
  `bash test/integration/run-local.sh` (como root, com o Postgres local no ar)

## Discloud (preparado, SEM deploy)
- `discloud.config`: `TYPE=bot`, `MAIN=src/index.js`, `RAM=512`, `AUTORESTART=true`.
- Enviar SÓ a pasta `whatsapp-worker` (o `discloud.config` precisa estar na raiz do envio), sem `node_modules`,
  com o `.env` preenchido (modelo em `.env.example`) e o certificado do Supabase em `certs/`.
