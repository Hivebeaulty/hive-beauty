// Dashboard inicial — definições PURAS dos indicadores (testadas em
// tests/dashboard.test.cjs). Nenhum número inventado: tudo sai das tabelas.

/** Próximos atendimentos: só o que ainda VAI acontecer e continua de pé. */
export const UPCOMING_STATUSES = ["agendado", "confirmado"] as const;
export const UPCOMING_DAYS = 7;

/** Janela: de AGORA (exclusivo: o que já começou não é "próximo") até agora + 7 dias. */
export function upcomingWindow(now: Date = new Date()): { from: string; to: string } {
  const to = new Date(now.getTime() + UPCOMING_DAYS * 24 * 60 * 60 * 1000);
  return { from: now.toISOString(), to: to.toISOString() };
}

/** Mesma regra aplicada a uma lista já carregada (usada nos testes e onde houver lista). */
export function isUpcoming(a: { status: string; scheduled_start: string }, now: Date = new Date()): boolean {
  const t = new Date(a.scheduled_start).getTime();
  const { to } = upcomingWindow(now);
  return (UPCOMING_STATUSES as readonly string[]).includes(a.status) && t > now.getTime() && t < new Date(to).getTime();
}
