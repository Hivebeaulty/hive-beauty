# Roadmap da Sócia

Atualizado em 31/10/2026. Objetivo do momento: **as primeiras assinantes pagantes**, que usam a Sócia na primeira
semana e continuam pagando. O que já está em produção fica no README.

## 0. Agora: marca Sócia (antes Áurea)

Feito:
- [x] **App com a nova marca** (PRs #39 e #40): logotipo S em traço duplo, ícone S cacau sobre creme, visual da Áurea
      (cores, botões dourados, ilustração dos estados vazios) e fonte Noto Serif hospedada no app.
- [x] **E-mails da assinatura** com as cores da Áurea e o nome Sócia (`billing-emails` publicada em 31/10, versão 6).
- [x] **Landing com a nova marca**: logotipos, favicon, nome em todos os textos, Termos e Política; CTA final
      "Sua parceira de negócio". Publicada no endereço novo **https://socia-beauty.lovable.app**.
- [x] **Endereço novo em todo o sistema** (31/10): links do app para o site, Termos e Política (`lib/hive/access.ts`);
      `signup-intent` e `track` aceitam só o endereço novo (o antigo foi liberado no Lovable e pode ser usado por outra
      pessoa); links de Termos e Política nos e-mails. Domínio próprio futuro previsto como `socia*.com.br`.

Falta:
- [ ] **Landing: capturas do celular** ainda mostram a marca Áurea. As telas novas estão prontas (`telas-socia.zip`);
      trocar pelo agente do Lovable quando houver créditos.
- [ ] **Landing: mensagem pronta do WhatsApp** (`src/lib/links.ts`) ainda diz "Quero saber mais sobre a Áurea".
- [x] **Mercado Pago**: endereço de retorno do plano trocado para o endereço novo (31/10).
- [x] **Supabase**: não há segredo `LANDING_URL`; vale o padrão do código (endereço novo).
- [x] **Instagram**: nome, foto de perfil e link da bio com o endereço novo e UTM
      (`?utm_source=instagram&utm_medium=bio&utm_campaign=perfil`) (31/10).
- [ ] **Outros links com o endereço antigo**: WhatsApp Business e materiais impressos, se houver.
- [x] **Edição de atendimento** (em aberto e concluído): cliente, serviço, duração e horário. O horário atual continua
      disponível ao mudar a duração ou o serviço, e dá para digitar um horário fora da grade ("Outro horário"); o banco
      continua recusando conflito com outro atendimento. Atendimento concluído atualiza o Financeiro junto (0030/0034).
- [x] **Previsão de faturamento**: hoje, esta semana e este mês no Início; previsão do período escolhido no Financeiro.
      Previsto = concluídos + agendados (cancelados e faltas ficam de fora), pelo dia de Brasília (`lib/hive/forecast.ts`).
- [ ] **Branding book da Sócia**: atualizar com o logotipo novo (S em traço duplo, versões e tamanhos mínimos), as cores
      da Áurea mantidas, a Noto Serif, o ícone do app e exemplos de uso certo e errado.
- [ ] **Linguagem da Sócia**: tom de voz e vocabulário da marca (a Sócia como parceira do negócio, não uma ferramenta),
      com palavras a usar e a evitar, e aplicar no app, nos e-mails, na landing e no Instagram.
- [ ] **Landing: nova abordagem**: apresentar as soluções que a Sócia traz para a rotina da nail designer (menos faltas,
      agenda cheia, clareza do dinheiro, tempo livre) em vez de listar funcionalidades técnicas. Depende da linguagem.
- [x] **Guia de uso com a nova marca** (`public/guia-socia.pdf`, 14 páginas, gerado por `scripts/guia/gerar_guia.py`):
      Noto Serif, telas novas, previsão de faturamento, edição de atendimento e o fluxo atual do atendimento
      (conclusão automática, sem "Confirmar" e "Iniciar"). O link antigo `/guia-aurea.pdf` redireciona; e-mails apontam
      para o novo.
- [ ] **Instagram**: destaques e os 3 carrosséis fixados com a nova marca.

## 1. Agora: lançamento e primeiras vendas

- [x] **Assinatura real de ponta a ponta** (25/10: falhou e foi corrigido; ver README, incidente)
- [ ] **Checkout pela API do Mercado Pago** (assinatura criada com o e-mail e uma referência nossa: webhook confiável e origem da cliente ligada à assinatura)
- [ ] Repetir o teste real com um e-mail NOVO (sem conta), pelo modal do site
- [ ] ~~Assinatura real de ponta a ponta~~ (pagar → e-mail → criar senha → entrar no app → cancelar). Nunca rodou com
      pagamento real; é o maior risco antes de divulgar.
- [x] **E-mail de confirmação da assinatura (boas-vindas)** (0042 + `billing-emails`), enviado pelo webhook quando a assinatura começa: o que foi
      contratado, quando acontece a primeira cobrança, como criar a senha, link para o app e o guia em PDF.
- [x] **Guia de uso em PDF** (hoje `public/guia-socia.pdf`; ver seção 0), com a identidade da Áurea e telas reais (anonimizadas): primeiros passos, agenda,
      clientes, WhatsApp, financeiro, relatórios, dúvidas frequentes e contato.
- [x] **Aviso antes da primeira cobrança** (0042 + `billing-emails`): e-mail no 5º dia do teste (data e valor da cobrança, como cancelar).
- [ ] **Conteúdo do Instagram**: 3 carrosséis fixados (dois prontos), calendário de 30 dias, perfil e link com UTM.

## 2. Próximos 30 dias: transformar teste em assinatura

- [ ] **Primeira semana guiada**: checklist na tela inicial (cadastrar serviços, importar clientes, conectar o WhatsApp,
      criar o primeiro atendimento).
- [ ] **Painel: contas que precisam de atenção** (teste sem configuração, sem atendimentos, WhatsApp desconectado),
      para contato pessoal com cada conta em teste.
- [ ] **Aviso de WhatsApp desconectado** para a profissional (hoje ela pode não perceber).
- [ ] **Depoimentos reais e autorizados** das profissionais que já usam (Ester, Diêne, Tainá) e entrevistas de 15 min.
- [ ] **Indicação**: "indique uma colega e ganhe um mês" (código de indicação + mês de cortesia com validade).

## 3. Planos em três níveis

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

## 4. Próximos 60 a 90 dias: agendamento online pela cliente

- [ ] Página de agendamento com link próprio (para a bio do Instagram): a cliente escolhe serviço, profissional e
      horário livre; a confirmação sai pelo WhatsApp.
- [ ] **A profissional ativa ou desativa** o agendamento online (desligado por padrão), escolhe quais serviços aparecem,
      antecedência mínima e se o horário entra confirmado ou aguardando aprovação.
- [ ] Proteção contra abuso (limite por telefone, confirmação por WhatsApp).
- [ ] Entra no plano Completo (ou Profissional, a decidir).

## 5. Obrigações e riscos conhecidos

- [ ] **Remetente de e-mail com domínio próprio**: `@gmail.com` enviado pelo Brevo tende a cair no spam (DMARC do Gmail).
      Registrar um domínio, autenticar no Brevo (SPF/DKIM) e trocar o segredo `EMAIL_FROM`; vale também para o SMTP do
      Supabase Auth (e-mail de senha).

- [ ] **Exclusão automática dos dados 90 dias após o fim do acesso** (prometida na Política e nos Termos). Precisa existir
      antes de o primeiro cancelamento completar 90 dias.
- [ ] Revisão dos documentos por um advogado; abrir MEI/CNPJ para tirar o CPF do site.
- [ ] Riscos aceitos por enquanto (decisão de 24/10: gerar receita antes):
  - Vercel no plano Hobby, que não permite uso comercial. Migrar para o Pro com as primeiras receitas.
  - Supabase no plano gratuito, sem backup diário. Migrar para o Pro com as primeiras receitas.
  - WhatsApp pelo WhatsApp Web (não oficial): risco de bloqueio de número. Estudar a API oficial no futuro.

## 6. Depois

- Conciliação automática (agendada) com o Mercado Pago.
- Relatórios do painel por período com exportação (crescimento, receita, cancelamentos).
- Selos do app com contraste abaixo do mínimo em um dos temas; configuração de ESLint.
- Hospedar as fontes no próprio site; checkout próprio pela API do Mercado Pago para ligar origem e assinatura.
- Plano anual, aplicativo nas lojas e novos módulos (estoque, comissões): só depois de medir custo de aquisição e
  permanência.

## Métricas da semana

1. Testes iniciados e quantos viraram pagantes.
2. Contas em teste que completaram o checklist da primeira semana.
3. Pagantes que cancelaram.
