// ---------------------------------------------------------------------------
// EDIÇÃO de agendamento — lógica PURA (sem React, sem Supabase).
//
// A autoridade é o banco: update_appointment (migration 0022) roda com as
// permissões de quem está logada (RLS), recusa conflito de horário (exclusion
// constraint), recusa edição de agendamento que não está em aberto e recusa se
// outra pessoa alterou o agendamento desde que a tela abriu (p_expected).
// Aqui só decidimos o que MOSTRAR e traduzimos os erros.
// ---------------------------------------------------------------------------
import { isOpenStatus } from "./appointment-flow";

export type AppointmentSnapshot = {
  client_id: string;
  service_id: string;
  professional_member_id: string;
  scheduled_start: string;
  scheduled_end: string;
  price: number;
  status: string;
  notes: string | null;
};

export type EditForm = {
  clientId: string;
  serviceId: string;
  professionalId: string;
  start: Date;
  durationMinutes: number;
  price: number;
  notes: string;
};

/** Só agendamento em aberto (agendado, confirmado, em atendimento) é editável. */
export function canEditAppointment(status: string): boolean {
  return isOpenStatus(status);
}

/** O que a tela viu ao abrir: o banco recusa se algo disso mudou nesse meio-tempo. */
export function expectedFrom(a: AppointmentSnapshot) {
  return {
    client_id: a.client_id,
    service_id: a.service_id,
    professional_member_id: a.professional_member_id,
    scheduled_start: a.scheduled_start,
    scheduled_end: a.scheduled_end,
    price: Number(a.price),
    status: a.status,
  };
}

export function durationMinutesOf(a: Pick<AppointmentSnapshot, "scheduled_start" | "scheduled_end">): number {
  return Math.round((new Date(a.scheduled_end).getTime() - new Date(a.scheduled_start).getTime()) / 60000);
}

const norm = (s: string | null | undefined) => (s ?? "").trim();

/** Houve mudança de verdade em relação ao que está salvo? */
export function hasChanges(a: AppointmentSnapshot, f: EditForm): boolean {
  return (
    f.clientId !== a.client_id ||
    f.serviceId !== a.service_id ||
    f.professionalId !== a.professional_member_id ||
    f.start.getTime() !== new Date(a.scheduled_start).getTime() ||
    f.durationMinutes !== durationMinutesOf(a) ||
    Number(f.price) !== Number(a.price) ||
    norm(f.notes) !== norm(a.notes)
  );
}

/**
 * Horários oferecidos na edição: os livres da grade + o horário ATUAL sempre que o dia e a
 * profissional continuam os mesmos, mesmo que a duração ou o serviço mudem (antes o horário
 * atual sumia ao mudar a duração). Se a nova duração bater em outro atendimento, o banco
 * recusa ao salvar (23P01) e a tela explica.
 */
export function editTimeOptions(slots: string[], originalTime: string, sameDayAndProfessional: boolean): string[] {
  if (!sameDayAndProfessional || !originalTime || slots.includes(originalTime)) return slots;
  return [originalTime, ...slots].sort();
}

/** "HH:mm" válido (para o horário digitado em "Outro horário"). */
export function isValidTime(t: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}

/** A alteração muda o que a cliente sabe do agendamento (dia, horário ou serviço)? */
export function isReschedule(a: AppointmentSnapshot, f: EditForm): boolean {
  return f.serviceId !== a.service_id || f.start.getTime() !== new Date(a.scheduled_start).getTime();
}

/** Traduz o erro do banco. reload = recarregar os dados da tela; reloadSlots = recalcular horários. */
export function editErrorMessage(code: string | null | undefined): { message: string; reload: boolean; reloadSlots: boolean } {
  switch (code) {
    case "23P01":
      return { message: "Esse horário já está ocupado por outro atendimento da profissional (confira também a duração). Escolha outro horário ou ajuste a duração.", reload: false, reloadSlots: true };
    case "AUE01":
      return { message: "Este agendamento não está mais em aberto (foi concluído, cancelado ou marcado como falta). A tela foi atualizada.", reload: true, reloadSlots: false };
    case "AUE02":
      return { message: "Este agendamento foi alterado por outra pessoa enquanto você editava. Os dados foram atualizados: confira e salve de novo.", reload: true, reloadSlots: true };
    case "AUE03":
      return { message: "Essa cliente não pode ser usada: está arquivada ou não é desta empresa.", reload: false, reloadSlots: false };
    case "AUE04":
      return { message: "Esse serviço está inativo ou não é desta empresa.", reload: false, reloadSlots: false };
    case "AUE05":
      return { message: "Essa profissional está inativa ou não é desta empresa.", reload: false, reloadSlots: false };
    case "AUE06":
      return { message: "Confira o horário, a duração e o valor.", reload: false, reloadSlots: false };
    case "P0002":
      return { message: "Agendamento não encontrado.", reload: false, reloadSlots: false };
    case "42501":
      return { message: "Você não tem permissão para editar este agendamento.", reload: false, reloadSlots: false };
    case "28000":
      return { message: "Sua sessão expirou. Entre novamente.", reload: false, reloadSlots: false };
    default:
      return { message: "Não foi possível salvar as alterações. Nada foi alterado. Tente novamente.", reload: false, reloadSlots: true };
  }
}

// --- Atendimento CONCLUÍDO e LANÇAMENTO RETROATIVO (migration 0030) ----------
// Só a administração (dona/admin) mexe em atendimento concluído e lança
// atendimento que já aconteceu — mesma regra do banco. Nenhum dos dois envia
// mensagem para a cliente.

/** Quem edita atendimento concluído e faz lançamento retroativo. */
export function canManageConcluded(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** Horário escolhido já passou? (então é lançamento retroativo, não agendamento) */
export function isRetroactive(start: Date, now: Date = new Date()): boolean {
  return start.getTime() < now.getTime();
}

/** O que a tela viu de um concluído (o banco recusa se mudou, inclusive o recebimento). */
export function concludedExpectedFrom(a: AppointmentSnapshot, paymentStatus: string) {
  return {
    client_id: a.client_id,
    service_id: a.service_id,
    professional_member_id: a.professional_member_id,
    scheduled_start: a.scheduled_start,
    scheduled_end: a.scheduled_end,
    price: Number(a.price),
    status: a.status,
    payment_status: paymentStatus,
  };
}

/** Erros específicos do concluído/retroativo; o resto usa editErrorMessage. */
export function concludedErrorMessage(code: string | null | undefined, message?: string) {
  if (code === "AUR03") return { message: "Este recebimento é parcial. Ajuste o valor recebido pelo Financeiro.", reload: false, reloadSlots: false };
  if (code === "AUE06" && message) return { message, reload: false, reloadSlots: false };
  if (code === "42501") return { message: "Só a administração da empresa pode fazer isso.", reload: false, reloadSlots: false };
  return editErrorMessage(code);
}
