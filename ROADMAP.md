# Roadmap da Sócia

Atualizado em 01/11/2026. Objetivo do momento: **as primeiras assinantes pagantes**, que usam a Sócia na primeira
semana e continuam pagando. O que já está em produção fica no README; o que foi concluído há pouco está no fim deste
arquivo.

## 0. Esta semana (prioridade)

### 0.1 WhatsApp: sincronizações repetidas no celular

**Auditoria concluída (01/11).** Causa: o Baileys pedia ao celular principal cópia de cada mensagem que não
conseguia ler (pedido "placeholder resend"); nos logs, falhas `No session found to decrypt message` em mensagens de
**grupos** da conta da Diêne, uma a cada poucos minutos. Cada pedido gera a notificação no celular. Também encontrado:
reconexão relendo credenciais do banco sem esperar as gravações pendentes, e chaves privadas da libsignal nos logs da
Discloud. Correção no worker 0.4.0 (branch `worker-sincronizacao`) + migration 0047; aplicar e acompanhar uma semana.
Itens investigados na auditoria (todos respondidos):

O celular da profissional recebe repetidamente o aviso "A sincronização com o WhatsApp Business no Google Chrome
(Ubuntu) foi concluída". A conexão usa Baileys no serviço Node.js separado (`whatsapp-worker/`, hospedado na Discloud
conforme `discloud.config`), fora do Next.js na Vercel. Cada aviso indica um novo pareamento ou login da sessão, o que
incomoda a profissional e aumenta o risco de bloqueio do número.

Primeira etapa: **auditoria técnica, sem modificar arquivos**. Investigar:
- [x] Como a sessão Baileys é inicializada.
- [x] Como as credenciais são persistidas e atualizadas (`creds.update`).
- [x] Como funciona o tratamento de `connection.update`.
- [x] Se existem reconexões desnecessárias ou loops de reconexão.
- [x] Se há possibilidade de múltiplas instâncias ou sockets simultâneos.
- [x] Se o serviço está reiniciando com frequência (logs da Discloud).
- [x] Se o armazenamento da sessão é persistente entre reinicializações.
- [x] Se existe watchdog ou monitor externo provocando reinicializações.
- [x] Se o código cria um socket novo mesmo com uma conexão ativa.

Regras: não desconectar a conta, não apagar, recriar ou sobrescrever credenciais, não pedir QR Code novo e não mudar
mensagens, agendamentos ou notificações.

Entrega: causa provável, evidências no código e nos logs, arquivos e funções envolvidos e a correção recomendada com o
menor impacto, preservando a sessão atual. Só depois disso, a correção (segunda etapa, com aprovação).
- [ ] Aplicar a migration 0047 e publicar o worker 0.4.0 na Discloud (um reinício, sem QR).
- [ ] Acompanhar por uma semana: nenhuma notificação de sincronização e nenhuma linha `Closing session` nos logs.

### 0.2 Endereço do app com o nome Sócia

Trocar `hive-beauty.vercel.app` por **`socia-beauty.vercel.app`** (livre em 01/11, igual ao da landing
`socia-beauty.lovable.app`). O endereço antigo continua funcionando e redireciona para o novo, para não quebrar links de
e-mails já enviados nem o atalho instalado no celular de quem já usa.
- [ ] Vercel: adicionar `socia-beauty.vercel.app` ao projeto e redirecionar o endereço antigo (308) para o novo.
- [ ] Supabase Auth: Site URL e URLs de redirecionamento com o endereço novo (sem remover o antigo até o fim da migração).
- [ ] Edge Functions: `APP_URL` em `mp-webhook` e `mp-sync`, padrão de `APP_URL` e `GUIDE_URL` em `billing-emails` e o CORS
      de `admin-billing`; republicar as quatro e ajustar os testes locais.
- [ ] Landing (Lovable): links para o app e para o login.
- [ ] Guia em PDF: endereço do app no texto (`scripts/guia/gerar_guia.py`) e gerar de novo.
- [ ] README e materiais (bio, WhatsApp Business) com o endereço novo.
- [ ] Avisar as profissionais que já usam: o atalho antigo continua abrindo, mas vale instalar de novo.
- [ ] Opcional: renomear o projeto na Vercel e o repositório no GitHub para `socia`.
- Depois: domínio próprio (`socia*.com.br`, ver seção 5), com o app em `app.` e a landing no domínio principal.

### 0.3 Primeira cobrança real (01/11)

- [ ] Conferir a primeira cobrança da assinatura em teste (Tainá, prevista para 01/11): status `active` no painel, sem
      alerta de "assinatura sem dona" e nenhum e-mail indevido. É a primeira passagem real do fluxo teste → pagamento.

### 0.4 Pendências da marca Sócia

- [ ] **Landing: capturas do celular** ainda com a marca Áurea. Telas novas prontas (`telas-socia.zip`); trocar pelo
      agente do Lovable quando houver créditos.
- [ ] **Landing: mensagem pronta do WhatsApp** (`src/lib/links.ts`) ainda diz "Quero saber mais sobre a Áurea".
- [ ] **Outros links com o endereço antigo**: WhatsApp Business e materiais impressos, se houver.
- [ ] Conferir o **e-mail de senha do Supabase Auth** e o **nome do remetente no Brevo** com o nome Sócia.

## 1. Lançamento e primeiras vendas

- [ ] Repetir o teste real com um **e-mail NOVO** (sem conta), pelo modal do site: pagar → e-mails → criar senha →
      entrar no app → cancelar.
- [ ] **Checkout pela API do Mercado Pago** (assinatura criada com o e-mail e uma referência nossa): webhook confiável e
      origem da cliente ligada à assinatura.
- [ ] **Instagram**: calendário de 30 dias (carrosséis fixados e destaques já estão com a marca Sócia).

## 2. Próximos 30 dias: transformar teste em assinatura

- [ ] **Primeira semana guiada**: checklist na tela inicial (cadastrar serviços, importar clientes, conectar o WhatsApp,
      criar o primeiro atendimento).
- [ ] **Painel: contas que precisam de atenção** (teste sem configuração, sem atendimentos, WhatsApp desconectado), para
      contato pessoal com cada conta em teste.
- [ ] **Aviso de WhatsApp desconectado** para a profissional (hoje ela pode não perceber). Fazer depois da 0.1.
- [ ] **Depoimentos reais e autorizados** das profissionais que já usam (Ester, Diêne, Tainá) e entrevistas de 15 min.
- [ ] **Indicação**: "indique uma colega e ganhe um mês" (código de indicação + mês de cortesia com validade).
- [ ] **Funil de vendas no painel**: visitas da landing → testes iniciados → pagantes, com os eventos que a função `track`
      já registra e a origem (UTM).

## 3. Marca e comunicação

- [ ] **Branding book da Sócia**: logotipo S em traço duplo (versões e tamanhos mínimos), cores da Áurea mantidas, Noto
      Serif, ícone do app e exemplos de uso certo e errado.
- [ ] **Linguagem da Sócia**: tom de voz e vocabulário (a Sócia como parceira do negócio, não uma ferramenta), palavras a
      usar e a evitar; aplicar no app, nos e-mails, na landing e no Instagram.
- [ ] **Landing: nova abordagem**: as soluções para a rotina da nail designer (menos faltas, agenda cheia, clareza do
      dinheiro, tempo livre) em vez da lista de funcionalidades. Depende da linguagem.

## 4. Planos em três níveis

Proposta de pacotes (nomes e preços a definir):

| Nível | Inclui |
|---|---|
| Essencial | Agenda, clientes e serviços. Sem WhatsApp automático e sem financeiro. |
| Profissional | Tudo do Essencial + WhatsApp automático (confirmação, lembrete, avisos, aniversários) + financeiro. |
| Completo | Tudo do Profissional + relatórios + as novas funcionalidades (ex.: agendamento online pela cliente). |

O que precisa para lançar:
- [ ] Definir nomes e preços. O plano do meio deve ser o mais atraente (é o que se quer vender); o de cima serve de
      âncora. O preço atual (R$ 59,90) é uma boa referência para o plano do meio.
- [ ] Um plano de assinatura por nível no Mercado Pago (um link de checkout para cada).
- [ ] Banco: o nível contratado na conta e as permissões de cada funcionalidade por nível (no servidor, não só na tela).
- [ ] App: funções fora do plano aparecem bloqueadas com convite para mudar de plano; troca de plano pelo app.
- [ ] Landing: seção de preços com os três níveis; Termos de Uso com os planos (avisar as assinantes antes de mudar).
- [ ] Assinantes e cortesias atuais: definir em qual nível ficam.

## 5. Agendamento online pela cliente (60 a 90 dias)

- [ ] Página de agendamento com link próprio (para a bio do Instagram): a cliente escolhe serviço, profissional e horário
      livre; a confirmação sai pelo WhatsApp.
- [ ] **A profissional ativa ou desativa** o agendamento online (desligado por padrão), escolhe quais serviços aparecem,
      antecedência mínima e se o horário entra confirmado ou aguardando aprovação.
- [ ] Proteção contra abuso (limite por telefone, confirmação por WhatsApp).
- [ ] Entra no plano Completo (ou Profissional, a decidir).

## 6. Infraestrutura, obrigações e riscos

- [ ] **Domínio próprio** (`socia*.com.br`): app, landing e remetente de e-mail. O `@gmail.com` enviado pelo Brevo tende a
      cair no spam (DMARC do Gmail): autenticar o domínio no Brevo (SPF/DKIM), trocar o segredo `EMAIL_FROM` e usar o
      mesmo domínio no SMTP do Supabase Auth (e-mail de senha).
- [ ] **Exclusão automática dos dados 90 dias após o fim do acesso** (prometida na Política e nos Termos). Precisa existir
      antes de o primeiro cancelamento completar 90 dias.
- [ ] **Monitoramento**: alerta ao suporte quando o `whatsapp-worker` cair ou reconectar demais, e quando houver erros no
      app ou nas Edge Functions (hoje só a assinatura sem dona gera alerta).
- [ ] Revisão dos documentos por um advogado; abrir MEI/CNPJ para tirar o CPF do site.
- [ ] Limpeza: apagar a Edge Function `mp-diag` (desativada e sem uso).
- [ ] Riscos aceitos por enquanto (decisão de 24/10: gerar receita antes):
  - Vercel no plano Hobby, que não permite uso comercial. Migrar para o Pro com as primeiras receitas.
  - Supabase no plano gratuito, sem backup diário. Migrar para o Pro com as primeiras receitas.
  - WhatsApp pelo WhatsApp Web (não oficial): risco de bloqueio de número. Estudar a API oficial no futuro.

## 7. Depois

- Conciliação automática (agendada) com o Mercado Pago.
- Relatórios do painel por período com exportação (crescimento, receita, cancelamentos).
- Selos do app com contraste abaixo do mínimo em um dos temas; configuração de ESLint.
- Plano anual, aplicativo nas lojas e novos módulos (estoque, comissões): só depois de medir custo de aquisição e
  permanência.

## Métricas da semana

1. Testes iniciados e quantos viraram pagantes.
2. Contas em teste que completaram o checklist da primeira semana.
3. Pagantes que cancelaram.
4. Contas com o WhatsApp desconectado ou com reconexões repetidas.

## Concluído recentemente (outubro de 2026)

- Marca Sócia no app (PRs #39 e #40): logotipo S em traço duplo, ícone S cacau sobre creme, visual da Áurea e fonte Noto
  Serif hospedada no próprio app.
- E-mails da assinatura com as cores da Áurea e o nome Sócia (`billing-emails` versão 6).
- Landing com a nova marca em `socia-beauty.lovable.app`; endereço novo em todo o sistema (links, Termos, Política,
  `signup-intent` e `track`); Mercado Pago com o endereço de retorno novo; Instagram com nome, foto e link novos.
- Instagram: carrosséis fixados e destaques com a marca Sócia.
- Edição de atendimento (cliente, serviço, duração e horário, inclusive fora da grade) e previsão de faturamento no
  Início e no Financeiro.
- Guia de uso da Sócia (`public/guia-socia.pdf`, 14 páginas); `/guia-aurea.pdf` redireciona.
- Assinatura sem webhook (incidente de 25/10): `mp-sync`, `signup-intent` e ligação manual no painel; e-mails de
  boas-vindas e de aviso antes da primeira cobrança.
