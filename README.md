# Áurea — Fase 1 (Fundação) + Fase 2 (Core) + Fase 3 (Financeiro e indicadores) + Fase 4 (Produto/UX)

> O projeto era chamado "Hive Beauty" até a Fase 3. A partir da Fase 4 a marca
> é exclusivamente **Áurea** — sem referências a colmeia/favos. O histórico
> abaixo foi mantido por precisão, só com o nome atualizado.

**Fase 2 adicionou**: `supabase/migrations/0002_appointment_flow.sql`, e as
telas de Serviços, Clientes e Agenda/Agendamento.

**Fase 3 adicionou**: `supabase/migrations/0003_finance_and_audit.sql`
(rode na ordem: 0001 → 0002 → 0003), o módulo Financeiro completo
(Receitas/Despesas/Pendências), indicadores por período, auditoria
automática via trigger, e o fluxo de atendimento evoluído (iniciar rápido,
pagamento parcial). Veja a auditoria completa enviada junto com este código
na conversa.

**Correção pós-Fase 3** (`0004_secure_conclusion_and_finance_integrity.sql`,
rode depois da 0003): `conclude_appointment` virou `SECURITY DEFINER` com
validação explícita de papel/permissão (uma profissional só conclui os
próprios atendimentos, sem ganhar acesso geral a `payments`); integridade de
pagamento parcial agora é garantida por trigger + `CHECK CONSTRAINT` no
banco; e os indicadores separam **faturado** (gerado) de **recebido**
(caixa) — veja a auditoria na conversa.


Este é o esqueleto inicial da Áurea: schema completo do banco (com RLS
multi-tenant) e a estrutura base do app Next.js (auth, onboarding, shell
autenticado, painel SuperAdmin). As Fases 2-5 (agenda, clientes, financeiro,
relatórios, PWA, etc.) constroem em cima desta base, módulo por módulo.

## 1. Criar o projeto no Supabase
1. Crie um projeto em supabase.com.
2. No SQL Editor, rode os arquivos de `supabase/migrations/` **em ordem
   numérica** (0001 → 0002 → 0003 → 0004).
3. (Opcional) Crie um usuário de teste em Authentication → Users, copie o
   UUID dele para `:demo_user_id` em `supabase/seed.sql` e rode o arquivo.
4. Em Project Settings → API, copie a URL, a `anon key` e a `service_role key`.

## 2. Configurar o projeto local
```
cp .env.example .env.local
# preencha NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
# SUPABASE_SERVICE_ROLE_KEY

npm install
npm run dev
```

## 3. Tornar um usuário SuperAdmin (fora do fluxo normal)
No SQL Editor do Supabase:
```sql
insert into superadmins (user_id) values ('UUID-DO-USUARIO');
```

## 4. Deploy
- Suba o repositório no GitHub.
- Importe na Vercel; adicione as mesmas variáveis de ambiente do `.env.local`
  (a `SUPABASE_SERVICE_ROLE_KEY` só como variável de servidor, nunca com
  prefixo `NEXT_PUBLIC_`).

## Observação sobre este ambiente
Este código foi escrito neste chat, que não tem acesso à internet — não foi
possível rodar `npm install`, provisionar o projeto Supabase de verdade nem
testar o build aqui. Recomendo abrir esta pasta no Claude Code (ou seu editor)
para instalar as dependências, conectar ao seu projeto Supabase real e seguir
a implementação das Fases 2-5.

## Fase 5 — Clientes preparadas para comunicação (sem envio)

**Migration `0008_clients_archive_phone_consent.sql`** (aplicar ANTES de publicar o código novo; é aditiva e o código antigo continua funcionando depois dela):
arquivamento (`clients.archived_at`), telefone normalizado (`clients.phone_normalized`, coluna gerada), consentimento
(`comm_status*`) e as RPCs `get_client_history_summary` / `delete_client_without_history`.

- Excluir cliente: sem atendimentos e sem pagamentos → exclusão definitiva; com qualquer histórico → arquivar (reativável).
- `phone` continua como foi digitado/importado; `phone_normalized` (ex.: `5511999990000`) é calculado pelo banco.
  As regras estão em `normalize_br_phone()` (SQL) e `lib/hive/phone.ts` (TS) e **precisam ser mantidas iguais**.
- Consentimento: `unknown` (padrão) / `allowed` / `blocked`. Só `allowed` + celular válido entra na Central.
- Central de comunicação (`/clientes/comunicacao`): apenas prepara lista e mensagem. **Nada é enviado.**

### Testes da lógica pura (telefone, datas, segmentos, comunicação)

```bash
npm test   # Node 20+; usa node:test, sem dependências novas
```

## Migration 0009 — integridade multiempresa e exclusão com histórico

Antes de aplicar, rode `supabase/diagnostics/0009_preflight.sql` (somente leitura). A 0009 **aborta sem alterar nada**
se existir atendimento/pagamento ligado a cliente de outra empresa. Testes de staging (desfazem tudo ao final):
`supabase/tests/0009_multi_tenant_integrity_staging.sql` — rode antes e depois da migration.

- `appointments` e `payments` só aceitam `client_id` de cliente da **mesma** empresa (FK composta).
- Cliente com qualquer atendimento ou pagamento **não pode ser excluída** (use Arquivar). Vale para API, RPC e SQL.
- `clients.company_id` não pode ser alterado.

## Fluxo do atendimento (Agenda -> Atendimento -> Pagamento -> Financeiro)

`agendado -> atendimento realizado -> recebido (padrão)` ou `-> recebimento pendente`.
Não existem mais os passos "Confirmar" e "Iniciar atendimento" na interface (os valores `confirmado`
e `em_atendimento` seguem existindo no banco). O pagamento **só nasce** na RPC `conclude_appointment`
(uma transação: atendimento + pagamento); agendar, cancelar e marcar falta não criam pagamento.
Migration `0010`: no máximo 1 pagamento por atendimento e conclusão serializada. Regras de decisão em
`lib/hive/appointment-flow.ts`.

## Rodada de ajustes (migrations 0011 a 0013)

- **0011** formas de pagamento `cartao_credito` e `cartao_debito` (aplicar SOZINHA; `cartao` antigo é preservado).
- **0012** `get_appointment_payment`, `update_appointment_payment`, `delete_appointment` e um gatilho que impede
  pagamento órfão. Alterar a forma de pagamento atualiza o pagamento existente (nunca cria outro).
- **0013** `profiles.display_name` ("Como você quer ser chamada?") + `get_company_member_display_names`.
- Importação de contatos: Contact Picker (Android/Chrome) **ou** arquivo vCard `.vcf`/CSV (iPhone e demais). O iOS não tem API web de agenda.
- Confirmação de agendamento: tela de sucesso + link `wa.me` com a mensagem pronta (manual; nada é enviado pelo app).
- Ordem de deploy: migrations 0011, 0012, 0013 primeiro; depois o código. Testes: `supabase/tests/0012_appointment_payment_ops_staging.sql`.

## Migration 0014 — ciclo de vida do atendimento (proteções, pendência, falta)

**Ainda não aplicada em nenhum ambiente.** Não altera dados existentes (recebimentos atuais ficam `source = 'manual'`).

- Atendimento **concluído é imutável pela API** (status, valores, datas, cliente, serviço, profissional; só a observação muda)
  e não pode ser apagado direto. Concluir só pelas funções do banco (`conclude_appointment`).
- **Invariante no COMMIT** (qualquer papel, só nas linhas que mudam): concluído ⇔ tem recebimento; recebimento com a mesma
  empresa/cliente do atendimento. Registros antigos fora da regra (ex.: concluído sem recebimento) não são tocados.
- `payments.source` (`manual`/`auto`/`backfill`) e `modified_at/by`, gravados só pelo banco.
- `mark_appointment_payment_pending` (recebido → pendente, mesmo recebimento; parcial é recusado — `AUR03`).
- `reclassify_appointment_as_no_show` + `get_appointment_no_show_eligibility`: concluído **automaticamente** → não compareceu,
  removendo o recebimento automático só se ele nunca foi alterado (`AUR01` manual, `AUR02` alterado). Auditoria em `audit_logs`
  e nota em `appointment_status_history`.
- Tela: "Marcar como pendente" e "Cliente não compareceu" no atendimento; Receitas não exclui nem troca a cliente de recebimento
  de atendimento.

Ordem de deploy: aplicar a 0014 (sozinha) → rodar `supabase/tests/0014_appointment_lifecycle_staging.sql` (esperado 0 FAIL)
→ publicar o código. Testes locais (Postgres local, nunca o Supabase): `supabase/tests/local/run_all_local.sh`.

## Migrations 0015 e 0016 — conclusão automática (Pix presumido)

**Nenhuma das duas foi aplicada em produção.** A 0015 cria tudo DESLIGADO; a 0016 (cron) fica preparada e só é aplicada com autorização.

- Regra: 5 min após o término previsto, atendimento em aberto vira **concluído** com **um** recebimento **pago via Pix**, origem `auto`, datado do atendimento. Correções depois pelos recursos existentes (forma, pendente/recebido, "Cliente não compareceu").
- Nunca conclui: cancelado, falta, concluído, preço ≤ 0, atendimento com recebimento, atendimento que **já foi** falta/cancelado (histórico ou auditoria), antes da data de início (`process_from`), revertido ou bloqueado após 5 falhas.
- Tudo em `aurea_private` (fora da API; funções SECURITY INVOKER, `search_path` fixo, sem EXECUTE para anon/authenticated/service_role). O cron roda como `postgres`.
- Regularização (`aurea_private.regularize`): dry run + execução tudo-ou-nada com IDs e total exatos. Ativação (`activate_auto_conclusion`): única, exige regularização efetivada no mesmo dia (SP); grava `process_from` imutável.
- Reversão (`revert_run`): só se nada mudou depois (7 sinais, incluindo contagem de auditoria/histórico); tudo ou nada; o revertido sai da automação.
- Roteiro: `supabase/operations/0015_regularizacao_e_ativacao.sql`. Diagnóstico: `supabase/diagnostics/0015_*.sql`.
- Testes: `supabase/tests/0015_auto_conclusion_staging.sql` (Supabase, desfaz tudo) e `supabase/tests/local/run_all_local.sh` (Postgres local, inclui concorrência, privilégios no pior caso, ensaio do fluxo de produção e pg_cron real).

## Migration 0017 — WhatsApp W1 (base de dados) — **não aplicada em produção**

- Sessão por **empresa**; o app só fala com o banco (RPCs `wa_*`), o worker (W2) só com funções do schema privado `whatsapp_private`.
- Regra de envio: cliente da empresa, **não arquivada**, celular válido (13 dígitos) e `comm_status <> 'blocked'` (`unknown` recebe).
  "SAIR"/"PARAR"/"STOP" recebidos bloqueiam a cliente (origem `client_opt_out`), só naquela empresa.
- Conectar/QR/desconectar: owner/admin. Enviar: owner/admin/profissional. Ler conversa: membros.
- Idempotência por chave, limite de ritmo por empresa, fila com trava de posse por sessão, revalidação da cliente ao pegar a fila.
- Credenciais do Baileys só **cifradas** no banco (a chave fica no worker). Papel `wa_worker` criado **sem login** (W2 cria a credencial).
- Sem job agendado: "sem sinal" é calculado na leitura.
- Testes: `supabase/tests/0017_whatsapp_core_staging.sql` e `supabase/tests/local/0017_*`. Roteiro: `supabase/operations/0017_aplicacao_supabase.sql`.

## Worker de WhatsApp (W2) — `whatsapp-worker/` — **sem deploy**

Processo Node.js (Baileys 7.0.0-rc14) que mantém uma sessão por empresa, falando só com as funções de
`whatsapp_private` como papel `wa_worker`. Nesta etapa: conexão por QR, status, reconexão, encerramento limpo;
mensagens desligadas (`WA_MESSAGING_ENABLED=false`). Detalhes em `whatsapp-worker/README.md`.

## Estado da produção (Supabase `hsdrndcnqcqqgbloqozy`) — atualizado em 13/10/2026

- **0017 e 0018 APLICADAS** pelo histórico de migrations (`0017_whatsapp_core`, `0018_whatsapp_auto_confirmation`).
  Texto gravado idêntico aos arquivos (md5 `8fe966e9…` e `044efd5a…`); funções, colunas, constraints e permissões
  idênticas às do ambiente de teste; dados (atendimentos, recebimentos, clientes, auditoria, R$ 90, automação) intactos.
- Testes no Supabase real (todos desfeitos ao final): bateria 0017 S/C/E 42/42; worker como `wa_worker` 11/11;
  gatilho da 0018 com usuária autenticada 9/9.
- **Chave global da confirmação automática: DESLIGADA.** Papel `wa_worker`: **sem login** (senha só na implantação do worker).
- Código do app e worker: **ainda não publicados**.

## Migration 0018 — WhatsApp W5: confirmação automática de agendamento

- **Evento**: `AFTER INSERT` em `appointments` (agendamento NOVO). Editar, remarcar, cancelar ou repetir pedidos **nunca**
  cria outra confirmação: 1 registro por agendamento (`whatsapp_private.appointment_confirmations`) + chave
  `auto-confirmation:<id>` na fila. Tudo na mesma transação do agendamento; erro na confirmação **nunca** impede salvar.
- **Quem recebe**: regra da 0017 (cliente da empresa, não arquivada, celular válido, sem bloqueio/SAIR). Fora disso:
  `skipped` com motivo. WhatsApp desconectado ou sem sinal: `skipped (not_connected)` e a tela oferece o `wa.me`, como antes.
- **Na hora de enviar** (`claim_outbox` redefinida, mesmos parâmetros): cancela se o agendamento não está mais em aberto
  e no futuro ou trocou de cliente; refaz texto e telefone de confirmação pendente (remarcou → horário novo);
  envios só com a sessão `connected` (caiu → fica pendente sem gastar tentativa).
- **Texto**: montado no banco com a mesma regra de `lib/hive/appointment-message.ts` (paridade testada: 144 casos idênticos).
  Diferença deliberada: sem nome cadastrado, a assinatura é só a empresa (a tela usaria "Profissional").
- **Chaves**: global `whatsapp_private.settings.auto_confirmation_enabled` (nasce **false**; liga no roteiro) e por empresa
  (`wa_set_auto_confirmation`, owner/admin; interruptor em Configurações → WhatsApp, visível só com o recurso ligado).
- **Tela**: depois de agendar, se a confirmação foi para a fila, o botão `wa.me` some (evita mensagem em dobro) e aparece
  a situação; no detalhe do atendimento, a situação (na fila, enviando, enviada, entregue, lida, falhou, cancelada).
  Cliente que pediu para sair: nenhum caminho de envio é oferecido, nem o manual. Sem a 0018: tela exatamente como antes.
- Roteiro: `supabase/operations/0018_aplicacao_supabase.sql` (aplicar, ligar, desligar de emergência, reverter para a 0017).

### Testes (todos LOCAIS; nunca o Supabase)
```bash
su postgres -c supabase/tests/local/run_all_local.sh          # 0009–0018 (inclui 0018_auto_confirmation, paridade e ensaio do roteiro)
cd whatsapp-worker && npm test && bash test/integration/run-local.sh
npm test                                                      # lógica pura do app
cd tests/ui && npm ci && node build.mjs && npm test           # Chromium real com APIs simuladas
```
Ambiente local usado: Postgres 16 com `shared_preload_libraries='pg_cron'`, `cron.database_name='aurea_cron'` e
`cron.use_background_workers=on` (sem esta última o teste da 0016 falha por autenticação do pg_cron, não por código).

## Implantação W5 — ordem recomendada (cada passo exige autorização)

1. **Supabase**: aplicar a 0017 pelo roteiro dela (B0→B4); depois a 0018 pelo roteiro dela (B0→B3). Ambas sem efeito
   visível: nada é enfileirado (chave global desligada) e o envio do worker continua desligado.
2. **App (Vercel)**: publicar o código. Com a chave desligada nada muda para quem usa (o interruptor fica oculto e a
   tela de agendamento segue com o `wa.me`); o código também funciona se a 0018 ainda não estiver aplicada.
3. **Worker (Discloud)**: criar a senha do papel `wa_worker` (só no worker), `WA_MASTER_KEY` nova com cópia segura,
   certificado do Supabase em `certs/`, `WA_MESSAGING_ENABLED=false`. Subir e conectar um **número secundário** pelo QR.
   Conferir: status "Conectado"; reiniciar o worker e ver que volta **sem novo QR**.
4. **Teste controlado** (número secundário, clientes de teste com celulares da equipe):
   ligar `WA_MESSAGING_ENABLED=true` → reiniciar o worker → roteiro 0018 [B5] (liga a chave global) →
   criar um agendamento para cliente de teste → conferir no detalhe "Confirmação enviada" e a mensagem no celular →
   editar o agendamento (nada novo chega) → responder `SAIR` do celular de teste → novo agendamento mostra
   "Cliente não recebe mensagens" → derrubar o worker, agendar, subir o worker (envia uma vez) → conferir [B4].
5. Só então trocar para o número definitivo da empresa. Emergência: roteiro 0018 [B6] (desliga e cancela pendentes)
   e/ou `WA_MESSAGING_ENABLED=false`. Reversão completa da 0018: [BR-SQL].
