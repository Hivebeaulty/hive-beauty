# Roadmap da Sócia

Atualizado em 07/11/2026. Objetivo do momento: **as primeiras assinantes pagantes**, que usam a Sócia na primeira
semana e continuam pagando. O que já está em produção fica no README; o que foi concluído há pouco está no fim deste
arquivo.

## 0. Esta semana (prioridade)

### 0.1 Projeção de faturamento na Agenda — feita em 05/11/2026

No topo da Agenda, nas visões **Dia**, **Semana** e **Mês**, o valor previsto do período exibido (como no app de
referência: logo abaixo da navegação de datas, alinhado à direita), acompanhando as setas de período, o "Hoje" e o
filtro de profissional.
- [x] Valor previsto do período na tela = concluídos + em aberto (agendado, confirmado, em atendimento); cancelados e
      faltas fora. Mesma regra e mesmo dia de Brasília da previsão do Início e do Financeiro (`lib/hive/forecast.ts`,
      período em `agendaPeriod`). Semana de segunda a domingo; no Mês, só os dias do mês.
- [x] Abaixo do valor, em texto menor: quanto já foi realizado e quanto está agendado.
- [x] Respeita o filtro de profissional; só a administração do negócio vê valores (`canSeeFinance`), como no Início.
- [x] Cabe de 320 a 1440 px nos dois temas (inclusive com R$ 123.456,78); testes da regra (`tests/forecast.test.cjs`)
      e de interface (U30 a U33 em `tests/ui`).
- [x] Guia em PDF atualizado (05/11): página da Agenda com a captura nova (visão Semana com o Previsto) e o texto da
      previsão; página do Início cita a previsão na Agenda.

### 0.2 WhatsApp: sincronizações repetidas no celular e quedas

**Resolvido no worker 0.4.0 (no ar desde 01/11).** Causa: o Baileys pedia ao celular principal cópia de cada mensagem que
não conseguia ler (pedido "placeholder resend"), principalmente de **grupos**; cada pedido gerava o aviso "A sincronização
com o WhatsApp Business no Google Chrome (Ubuntu) foi concluída". O 0.4.0 não faz mais esses pedidos, ignora grupos antes
de decifrar, reaproveita as credenciais na reconexão e tira as chaves da libsignal dos logs (migration 0047).
- [x] Auditoria técnica (01/11) e correção no worker 0.4.0 + migration 0047, publicados sem pedir QR.
- [x] Migrations 0049 (aviso semanal de clientes sumidas) e 0050 (histórico de quedas do WhatsApp) aplicadas em 05/11.
- [x] Diêne: conta caiu em 03/11 (21h11, motivo não registrado) e foi reconectada com QR novo em 05/11 (17h22).
- [ ] **Publicar o worker 0.4.1 na Discloud** (grava cada abertura e queda com o código em
      `whatsapp_private.connection_events`): Commit/Atualizar no mesmo app, com o `.env` e os `certs/` do backup.
- [ ] **Publicar a Edge Function `push-appointment-alerts`** com o aviso semanal das segundas (a versão no ar é de 03/11).
- [ ] Acompanhar uma semana: nenhuma notificação de sincronização, nenhuma linha `Closing session` nos logs e o motivo de
      qualquer queda registrado.

### 0.3 Endereço do app com o nome Sócia

Trocar `hive-beauty.vercel.app` por **`socia-beauty.vercel.app`** (livre em 01/11, igual ao da landing
`socia-beauty.lovable.app`). O endereço antigo continua funcionando e redireciona para o novo, para não quebrar links de
e-mails já enviados nem o atalho instalado no celular de quem já usa.
- [ ] Vercel: adicionar `socia-beauty.vercel.app` ao projeto e redirecionar o endereço antigo (308) para o novo.
- [ ] Supabase Auth: Site URL e URLs de redirecionamento com o endereço novo (sem remover o antigo até o fim da migração).
- [ ] Edge Functions: `APP_URL` em `mp-webhook` e `mp-sync`, padrão de `APP_URL` e `GUIDE_URL` em `billing-emails` (que
      ainda aponta para `guia-aurea.pdf`, que redireciona) e o CORS de `admin-billing`; republicar as quatro e ajustar os
      testes locais.
- [ ] Landing (Lovable): links para o app e para o login.
- [ ] Guia em PDF: endereço do app no texto (`scripts/guia/gerar_guia.py`) e gerar de novo.
- [ ] README e materiais (bio, WhatsApp Business) com o endereço novo.
- [ ] Avisar as profissionais que já usam: o atalho antigo continua abrindo, mas vale instalar de novo.
- [ ] Opcional: renomear o projeto na Vercel e o repositório no GitHub para `socia`.
- Depois: domínio próprio (`socia*.com.br`, ver seção 5), com o app em `app.` e a landing no domínio principal.

### 0.4 Primeira cobrança real (01/11)

- [ ] Conferir a primeira cobrança da assinatura em teste (Tainá, prevista para 01/11): status `active` no painel, sem
      alerta de "assinatura sem dona" e nenhum e-mail indevido. É a primeira passagem real do fluxo teste → pagamento.

### 0.5 Pendências da marca Sócia

- [x] **Landing: capturas do celular** com a marca Sócia e **mensagem pronta do WhatsApp** com "Sócia" (publicado em 01/11).
- [x] **Instagram**: os dois primeiros posts fixados atualizados para a marca Sócia (refeitos no Gemini).
- [ ] **Instagram: terceiro post fixado** com a marca Sócia.
- [ ] **Instagram: vídeos dos stories de destaques** ainda com a identidade Áurea. Foram criados no Claude; refazer no
      Claude com a marca Sócia (logotipo S em traço duplo, nome Sócia, mesmas cores da Áurea e Noto Serif), mantendo
      roteiro, duração e formato 9:16, e trocar as capas dos destaques.
- [ ] **Outros links com o endereço antigo**: WhatsApp Business e materiais impressos, se houver.
- [ ] Conferir o **e-mail de senha do Supabase Auth** e o **nome do remetente no Brevo** com o nome Sócia.

### 0.6 Assinatura no app (pedido de 07/11)

A dona vê e cancela a própria assinatura sem sair da Sócia (Mais > Assinatura). Os stories e o carrossel fixado dizem
hoje "cancele pelo app do Mercado Pago"; depois de publicado, passam a dizer "cancele direto na Sócia".
- [x] Código pronto (PR `assinatura-no-app`): tela com situação, teste, próxima cobrança, valor e histórico de cobranças;
      link para trocar a forma de pagamento no Mercado Pago; **Cancelar assinatura** com motivo opcional.
- [ ] Publicar: migration 0051, função `account-billing` (com verificação de JWT) e o app.
- [ ] Atualizar o guia em PDF (página Mais) e, no Instagram, a resposta "Posso cancelar?".

## 1. Lançamento e primeiras vendas

- [ ] Repetir o teste real com um **e-mail NOVO** (sem conta), pelo modal do site: pagar → e-mails → criar senha →
      entrar no app → cancelar.
- [ ] **Checkout pela API do Mercado Pago** (assinatura criada com o e-mail e uma referência nossa): webhook confiável e
      origem da cliente ligada à assinatura.
- [ ] **Instagram**: calendário de 30 dias (depois de fechar os fixados e os destaques da seção 0.5).

## 2. Próximos 30 dias: transformar teste em assinatura

- [ ] **Primeira semana guiada**: checklist na tela inicial (cadastrar serviços, importar clientes, conectar o WhatsApp,
      criar o primeiro atendimento).
- [ ] **Painel: contas que precisam de atenção** (teste sem configuração, sem atendimentos, WhatsApp desconectado), para
      contato pessoal com cada conta em teste.
- [ ] **Aviso de WhatsApp desconectado** para a profissional (hoje ela pode não perceber; a Diêne ficou dois dias sem
      envios em 03 a 05/11). Usar o histórico de quedas da 0050.
- [ ] **Depoimentos reais e autorizados** das profissionais que já usam (Ester, Diêne, Tainá) e entrevistas de 15 min.
- [ ] **Indicação**: "indique uma colega e ganhe um mês" (código de indicação + mês de cortesia com validade).
- [ ] **Funil de vendas no painel**: visitas da landing → testes iniciados → pagantes, com os eventos que a função `track`
      já registra e a origem (UTM).

### Relatórios e avisos (pedido de 07/11)

- [ ] **Comparativo mês a mês** em Relatórios: gráfico com os 12 meses do ano (faturamento realizado por mês; o mês atual
      mostra também o previsto) e comparação com o mesmo mês do ano anterior quando houver dados.
- [ ] **Ociosidade por dia da semana** em Relatórios: para cada dia da semana, a parte das horas de funcionamento sem
      atendimento nas últimas semanas, destacando os dias mais vazios.
- [ ] **Aviso de dia com agenda mais aberta que o normal**: quando um dia das próximas semanas tiver mais horas livres do
      que a média daquele dia da semana, a Sócia avisa (Início e notificação) e sugere chamar clientes atrasadas.
      Depende da ociosidade; usa a lista de clientes sumidas. Bom para lançar no começo de janeiro.

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

## Concluído recentemente (outubro e novembro de 2026)

- Marca Sócia no app (PRs #39 e #40): logotipo S em traço duplo, ícone S cacau sobre creme, visual da Áurea e fonte Noto
  Serif hospedada no próprio app.
- E-mails da assinatura com as cores da Áurea e o nome Sócia (`billing-emails` versão 6).
- Landing com a nova marca em `socia-beauty.lovable.app`; endereço novo em todo o sistema (links, Termos, Política,
  `signup-intent` e `track`); Mercado Pago com o endereço de retorno novo; Instagram com nome, foto e link novos.
- Edição de atendimento (cliente, serviço, duração e horário, inclusive fora da grade) e previsão de faturamento no
  Início e no Financeiro.
- Previsão do período no topo da Agenda (Dia, Semana e Mês), 05/11.
- Guia de uso da Sócia (`public/guia-socia.pdf`, 14 páginas); `/guia-aurea.pdf` redireciona.
- Assinatura sem webhook (incidente de 25/10): `mp-sync`, `signup-intent` e ligação manual no painel; e-mails de
  boas-vindas e de aviso antes da primeira cobrança.
- WhatsApp worker 0.4.0 (01/11): fim das notificações de sincronização no celular; migration 0047.
- Aviso no celular antes do atendimento (push, PR #45, migration 0048) e aviso semanal de clientes sumidas (PR #46,
  migration 0049, função a publicar).
