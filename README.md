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
