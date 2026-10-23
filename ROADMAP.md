# Roadmap da Áurea

Atualizado em 23/10/2026. O que já está em produção fica no README; aqui só o que falta.

## Próximo: Fase 3 — pagamentos e histórico de assinaturas

- Simulação de aviso no painel do Mercado Pago: ok em 23/10 (assinatura secreta e token de produção conferidos).
- **Pendente:** assinatura real com e-mail novo (conta criada, e-mail de senha, acesso liberado, cancelamento).
- ~~Gravar cada pagamento e cada mudança de situação (0039 + `mp-webhook` v4).~~ Pronto, aguardando aplicação.
- ~~Painel: Assinaturas e Financeiro, cancelamento pelo painel e conciliação (0040 + `admin-billing`).~~ Pronto.
- Conciliação automática (agendada) além do botão manual.

## Pendências curtas

- Testar o "Esqueci minha senha" depois da correção do Site URL (os links de e-mail dependem dele).
- Decidir se a suspensão de conta (e o bloqueio por falta de assinatura) deve pausar as mensagens automáticas de WhatsApp.
- Decidir se "Sair" encerra a sessão só no aparelho atual (hoje encerra em todos).
- Configurar ESLint (o script `lint` existe, mas não há configuração).

## Melhorias visuais do painel administrativo

- ~~Logo, modo escuro e contraste (WCAG) do painel.~~ Pronto.
- Selos do app (`components/ui/badge.tsx`): tons success/warning/gold abaixo de 4,5:1 no claro e danger no Grafite.
  O painel usa um selo próprio; avaliar corrigir os do app.

## Fase 4 — site (Lovable): medição e documentos legais

- Política de Privacidade e Termos de Uso publicados no site da Áurea e linkados no rodapé, no checkout e no login.
  Devem descrever o que é coletado (inclusive a medição de visitas, se adotada), para que, por quanto tempo, com quem é
  compartilhado (Supabase, Vercel, Mercado Pago, WhatsApp, Brevo) e como pedir acesso ou exclusão (LGPD).
- Medição da landing sem dados pessoais: visitas, origem, cliques no botão de assinar e início do checkout, com UTM.
- Funil completo no painel: visita → clique → checkout → teste iniciado → primeiro pagamento → pagante ativa, por coorte.

## Fase 5 — uso, retenção e relatórios

- Contas que precisam de atenção (sem serviços, sem clientes, sem atendimentos, sem atividade recente), com motivo.
- Ativação e retenção por coorte.
- Relatórios por período com exportação CSV (crescimento, receita, inadimplência, cancelamentos, auditoria).
- Procedimento de exclusão de conta com confirmação e salvaguardas.
