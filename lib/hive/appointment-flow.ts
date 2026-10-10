// ---------------------------------------------------------------------------
// Fluxo simplificado do atendimento — lógica PURA (sem React, sem Supabase).
//
//   agendado ──► atendimento realizado ──► recebido (padrão)
//                                      └─► recebimento pendente
//
// Não existem mais os passos "Confirmar" e "Iniciar atendimento" na interface.
// Os valores `confirmado` e `em_atendimento` continuam existindo no banco (a
// confirmação por WhatsApp do roadmap vai usar `confirmado`) e, se algum
// atendimento estiver neles, o fluxo abaixo também o trata como "em aberto".
//
// IMPORTANTE: nada aqui é segurança. A autoridade é a RPC conclude_appointment
// (papel, empresa, status) e as constraints do banco. Isto só decide o que
// MOSTRAR e traduz erros.
// ---------------------------------------------------------------------------

export type MemberRole = "owner" | "admin" | "professional" | "reception";

// Atendimento ainda sem desfecho: pode ser registrado como realizado,
// marcado como falta ou cancelado.
export const OPEN_STATUSES = ["agendado", "confirmado", "em_atendimento"] as const;

export function isOpenStatus(status: string): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(status);
}

export type ConcludeAvailability =
  | { state: "available" }
  | { state: "closed" } // já concluído, cancelado ou falta
  | { state: "no_permission" } // reception, ou profissional de outro atendimento
  | { state: "not_started"; startsAt: Date }; // ainda no futuro

export type FlowInput = {
  status: string;
  scheduledStart: string;
  professionalMemberId: string;
  role: MemberRole;
  memberId: string;
  now?: Date;
};

// Espelha a regra da RPC (owner/admin qualquer atendimento; profissional só o
// seu; reception nenhum) + a regra de produto "só a partir do horário".
export function concludeAvailability(i: FlowInput): ConcludeAvailability {
  if (!isOpenStatus(i.status)) return { state: "closed" };

  const permitted =
    i.role === "owner" ||
    i.role === "admin" ||
    (i.role === "professional" && i.professionalMemberId === i.memberId);
  if (!permitted) return { state: "no_permission" };

  const startsAt = new Date(i.scheduledStart);
  const now = i.now ?? new Date();
  if (now.getTime() < startsAt.getTime()) return { state: "not_started", startsAt };

  return { state: "available" };
}

export type ClosingAction = { status: "cancelado" | "nao_compareceu"; label: string };

// Cancelar vale a qualquer momento. "Não compareceu" só faz sentido depois do
// horário. Qualquer membro pode (a RLS de appointments permite).
export function closingActions(i: Pick<FlowInput, "status" | "scheduledStart" | "now">): ClosingAction[] {
  if (!isOpenStatus(i.status)) return [];
  const started = (i.now ?? new Date()).getTime() >= new Date(i.scheduledStart).getTime();
  const actions: ClosingAction[] = [];
  if (started) actions.push({ status: "nao_compareceu", label: "Não compareceu" });
  actions.push({ status: "cancelado", label: "Cancelar agendamento" });
  return actions;
}

// "Recebimento pendente" desligado (padrão) = recebido.
export function paymentStatusFor(pending: boolean): "pago" | "pendente" {
  return pending ? "pendente" : "pago";
}

// Traduz o erro da RPC em mensagem útil. `reload` = vale recarregar a tela
// (o estado real pode ter mudado, ex.: outro aparelho já registrou).
export function concludeErrorMessage(code: string | undefined | null): { message: string; reload: boolean } {
  switch (code) {
    case "22023":
      return { message: "Este atendimento já foi encerrado. A tela foi atualizada.", reload: true };
    case "23505":
      return { message: "Já existe um recebimento registrado para este atendimento. A tela foi atualizada.", reload: true };
    case "42501":
      return { message: "Você não tem permissão para registrar este atendimento.", reload: false };
    case "P0002":
      return { message: "Atendimento não encontrado.", reload: true };
    case "28000":
      return { message: "Sua sessão expirou. Entre novamente.", reload: false };
    default:
      return { message: "Não foi possível registrar o atendimento. Tente novamente.", reload: true };
  }
}

export type DayIndicator = "none" | "open" | "done";

// Ponto da grade do mês. Cancelados e faltas não contam. Qualquer atendimento
// ainda em aberto deixa o dia "em aberto" (dourado); só vira "concluído"
// (verde) quando TODOS os atendimentos do dia foram concluídos.
export function dayIndicator(statuses: string[]): DayIndicator {
  const active = statuses.filter((s) => s !== "cancelado" && s !== "nao_compareceu");
  if (active.length === 0) return "none";
  return active.every((s) => s === "concluido") ? "done" : "open";
}

// ---------------------------------------------------------------------------
// Recebimento de um atendimento JÁ concluído (alterar forma, marcar recebido,
// excluir). Espelha as RPCs get/update_appointment_payment e delete_appointment.
// ---------------------------------------------------------------------------

// owner/admin: qualquer atendimento; profissional: só o seu; reception: nenhum.
export function canManageAppointmentPayment(i: {
  role: MemberRole;
  memberId: string;
  professionalMemberId: string;
}): boolean {
  return (
    i.role === "owner" ||
    i.role === "admin" ||
    (i.role === "professional" && i.professionalMemberId === i.memberId)
  );
}

// Excluir atendimento concluído é destrutivo (remove também o recebimento):
// só a administração (mesma restrição de payments por RLS).
export function canDeleteAppointment(role: MemberRole): boolean {
  return role === "owner" || role === "admin";
}

export function paymentUpdateErrorMessage(code: string | undefined | null): string {
  switch (code) {
    case "22023":
      return "Só é possível alterar o recebimento de um atendimento concluído.";
    case "42501":
      return "Você não tem permissão para alterar este recebimento.";
    case "P0002":
      return "Este atendimento não tem recebimento registrado ou não foi encontrado.";
    case "28000":
      return "Sua sessão expirou. Entre novamente.";
    default:
      return "Não foi possível alterar o recebimento. Tente novamente.";
  }
}

export function deleteErrorMessage(code: string | undefined | null): string {
  switch (code) {
    case "22023":
      return "Só atendimentos concluídos podem ser excluídos.";
    case "42501":
      return "Somente a administração do negócio pode excluir atendimentos.";
    case "P0002":
      return "Atendimento não encontrado. Ele pode já ter sido excluído.";
    case "28000":
      return "Sua sessão expirou. Entre novamente.";
    default:
      return "Não foi possível excluir o atendimento. Nada foi alterado.";
  }
}
