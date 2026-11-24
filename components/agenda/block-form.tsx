"use client";

// Bloquear horário na Agenda (folga, almoço, consulta, férias...). Serve para criar
// (/agenda/bloquear) e para editar ou remover (/agenda/bloquear/[id]).
//
// O bloqueio impede NOVOS agendamentos no período: a grade de horários de
// "Novo atendimento" já não oferece horários bloqueados. Atendimentos que já
// estavam marcados ali continuam na agenda; a tela só avisa quantos são.
// A observação aparece na Agenda (Dia, Semana e Mês).
// Também serve de agenda pessoal: o compromisso pode avisar no celular com antecedência (0056).
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";
import { getActiveProfessionals, type Professional } from "@/lib/hive/schedule";
import { dayParam, parseDayParam } from "@/lib/hive/agenda-url";
import {
  BLOCK_SELECT,
  BLOCK_SELECT_WITH_REMINDER,
  REASON_MAX,
  blockRange,
  blockToForm,
  cleanReason,
  reasonProblem,
  remindAfterModeChange,
  remindOptions,
  type BlockedTime,
} from "@/lib/hive/blocked-times";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { AlertTriangle, Bell, Info } from "lucide-react";

const TEAM = "all"; // "toda a equipe" (professional_member_id nulo)

export function BlockForm({ blockId }: { blockId?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { companyId, memberId, role } = useCompany();
  const toast = useToast();
  const editing = !!blockId;
  // profissional só mexe na própria agenda; administração e recepção, em qualquer uma
  const ownAgendaOnly = role === "professional";

  const [professionals, setProfessionals] = useState<Professional[]>([]);
  const [profsLoaded, setProfsLoaded] = useState(false);
  const [blockLoaded, setBlockLoaded] = useState(!editing);
  const [notFound, setNotFound] = useState(false);
  const [original, setOriginal] = useState<BlockedTime | null>(null);

  const [target, setTarget] = useState<string>(ownAgendaOnly ? memberId : TEAM);
  const [date, setDate] = useState(() => dayParam(parseDayParam(searchParams?.get("data")) ?? new Date()));
  const [endDate, setEndDate] = useState(date);
  const [allDay, setAllDay] = useState(false);
  const [start, setStart] = useState("12:00");
  const [end, setEnd] = useState("13:00");
  const [reason, setReason] = useState("");
  // Lembrete no celular, em minutos antes do início (null = sem lembrete). Ver lib/hive/blocked-times.ts.
  const [remind, setRemind] = useState<number | null>(null);
  const [locked, setLocked] = useState(false); // período que o formulário não reescreve: só observação e remoção

  const [conflicts, setConflicts] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDelete, setShowDelete] = useState(false);

  // profissionais ativas + valor inicial de "quem" (só na criação)
  useEffect(() => {
    let alive = true;
    getActiveProfessionals(createClient(), companyId).then((list) => {
      if (!alive) return;
      setProfessionals(list);
      setProfsLoaded(true);
      if (editing || ownAgendaOnly) return;
      const fromAgenda = searchParams?.get("prof") ?? "";
      if (list.length === 1) setTarget(list[0].id);
      else if (list.some((p) => p.id === fromAgenda)) setTarget(fromAgenda);
      else if (list.some((p) => p.id === memberId)) setTarget(memberId);
      else setTarget(TEAM);
    });
    return () => {
      alive = false;
    };
    // só na montagem: a escolha da usuária não pode ser sobrescrita depois
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  // edição: carrega o bloqueio (e o lembrete; se o banco ainda não tem a coluna da 0056, lê sem ele)
  useEffect(() => {
    if (!blockId) return;
    let alive = true;
    (async () => {
      const supabase = createClient();
      let res = await supabase.from("blocked_times").select(BLOCK_SELECT_WITH_REMINDER).eq("id", blockId).maybeSingle();
      if (res.error) res = await supabase.from("blocked_times").select(BLOCK_SELECT).eq("id", blockId).maybeSingle();
      if (!alive) return;
      const b = res.data as BlockedTime | null;
      if (!b) {
        setNotFound(true);
        setBlockLoaded(true);
        return;
      }
      const f = blockToForm(b);
      setOriginal(b);
      setTarget(b.professional_member_id ?? TEAM);
      setDate(f.date);
      setEndDate(f.endDate);
      setAllDay(f.allDay);
      setStart(f.start);
      setEnd(f.end);
      setReason(b.reason ?? "");
      setRemind(typeof b.remind_before_minutes === "number" ? b.remind_before_minutes : null);
      setLocked(!f.representable);
      setBlockLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, [blockId]);

  const range = locked && original
    ? { start: new Date(original.start_at), end: new Date(original.end_at) }
    : blockRange({ date, endDate, allDay, start, end });
  const rangeKey = "error" in range ? "" : `${range.start.getTime()}-${range.end.getTime()}`;

  // aviso (não bloqueia): atendimentos em aberto que já estão dentro do período
  useEffect(() => {
    if (!blockLoaded || !rangeKey) {
      setConflicts(0);
      return;
    }
    const [s, e] = rangeKey.split("-").map(Number);
    let alive = true;
    let q = createClient()
      .from("appointments")
      .select("id")
      .eq("company_id", companyId)
      .in("status", ["agendado", "confirmado", "em_atendimento"])
      .lt("scheduled_start", new Date(e).toISOString())
      .gt("scheduled_end", new Date(s).toISOString());
    if (target !== TEAM) q = q.eq("professional_member_id", target);
    q.then(({ data }: { data: unknown }) => {
      if (alive) setConflicts(Array.isArray(data) ? data.length : 0);
    });
    return () => {
      alive = false;
    };
  }, [blockLoaded, rangeKey, target, companyId]);

  // administração mexe em tudo; profissional só nos bloqueios da própria agenda
  const readOnly = ownAgendaOnly && !!original && original.professional_member_id !== memberId;
  const showTargetSelect = !ownAgendaOnly && professionals.length > 1;

  function goToAgenda(day: string) {
    router.push(`/agenda?data=${day}`);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (saving || readOnly) return;
    const rp = reasonProblem(reason);
    if (rp) return setError(rp);
    if ("error" in range) return setError(range.error);
    setSaving(true);
    setError(null);
    const supabase = createClient();
    const text = cleanReason(reason);
    // O lembrete só vai na gravação quando há um escolhido (ou quando se está tirando um que existia):
    // assim salvar SEM lembrete continua funcionando mesmo antes da atualização do banco (0056).
    const reminder =
      remind !== null || (original?.remind_before_minutes ?? null) !== null ? { remind_before_minutes: remind } : {};
    const fields = locked
      ? { reason: text, ...reminder }
      : {
          professional_member_id: target === TEAM ? null : target,
          start_at: range.start.toISOString(),
          end_at: range.end.toISOString(),
          reason: text,
          ...reminder,
        };
    let ok = false;
    let code: string | undefined;
    if (editing) {
      const { data, error: err } = await supabase.from("blocked_times").update(fields).eq("id", blockId).select("id");
      // a RLS pode filtrar a linha sem devolver erro: só é sucesso se uma linha mudou
      ok = !err && Array.isArray(data) && data.length > 0;
      code = err?.code;
    } else {
      const { data, error: err } = await supabase
        .from("blocked_times")
        .insert({ company_id: companyId, ...fields })
        .select("id")
        .single();
      ok = !err && !!data;
      code = err?.code;
    }
    setSaving(false);
    if (!ok) {
      setError(
        code === "42501"
          ? "Você não tem permissão para fazer isso."
          : (code === "42703" || code === "PGRST204") && remind !== null
            ? "O lembrete ainda não está disponível: falta aplicar a atualização do banco. Salve sem lembrete por enquanto."
            : "Não foi possível salvar o bloqueio. Tente de novo."
      );
      return;
    }
    toast.success(editing ? "Bloqueio atualizado." : allDay ? "Dia bloqueado." : "Horário bloqueado.");
    goToAgenda(date);
  }

  async function handleDelete() {
    if (saving || !blockId) return;
    setSaving(true);
    setError(null);
    const { data, error: err } = await createClient().from("blocked_times").delete().eq("id", blockId).select("id");
    setSaving(false);
    setShowDelete(false);
    if (err || !Array.isArray(data) || data.length === 0) {
      setError(
        err?.code === "42501"
          ? "Você não tem permissão para fazer isso."
          : "Não foi possível remover o bloqueio. Tente de novo."
      );
      return;
    }
    toast.success("Bloqueio removido. Os horários voltaram a ficar livres.");
    goToAgenda(date);
  }

  if (!blockLoaded || (!profsLoaded && !ownAgendaOnly)) {
    return (
      <div className="space-y-4" data-testid="block-loading">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (notFound) {
    return (
      <div className="space-y-4">
        <p className="py-10 text-center text-sm text-ink-500">Bloqueio não encontrado. Ele pode já ter sido removido.</p>
        <Button variant="secondary" className="w-full" onClick={() => goToAgenda(dayParam(new Date()))}>
          Voltar para a agenda
        </Button>
      </div>
    );
  }

  const who =
    target === TEAM ? "toda a equipe" : professionals.find((p) => p.id === target)?.name ?? "a profissional escolhida";

  return (
    <div className="space-y-5 pb-4" data-testid="block-form">
      <div>
        <h1 className="page-title">{editing ? "Bloqueio de horário" : "Bloquear horário"}</h1>
        <p className="mt-1 text-sm text-ink-500">
          Para folga, almoço, consulta ou qualquer compromisso seu. Ninguém consegue marcar novos atendimentos nesse
          período, a observação aparece na agenda e você pode pedir um lembrete no celular.
        </p>
      </div>

      {readOnly && (
        <div className="flex items-start gap-2.5 rounded-lg border border-ink-200 bg-ink-50/60 px-4 py-3 text-sm text-ink-600" role="status">
          <Info className="mt-0.5 size-4 shrink-0 text-ink-400" aria-hidden="true" />
          <span>Este bloqueio não é da sua agenda. Só a administração da empresa pode alterá-lo ou removê-lo.</span>
        </div>
      )}
      {locked && !readOnly && (
        <div className="flex items-start gap-2.5 rounded-lg border border-ink-200 bg-ink-50/60 px-4 py-3 text-sm text-ink-600" role="status">
          <Info className="mt-0.5 size-4 shrink-0 text-ink-400" aria-hidden="true" />
          <span>Este bloqueio atravessa mais de um dia com horário marcado. Aqui você pode mudar a observação ou removê-lo.</span>
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-4">
        {showTargetSelect && (
          <Select label="Para quem" value={target} onChange={(e) => setTarget(e.target.value)} disabled={locked || readOnly}>
            <option value={TEAM}>Toda a equipe</option>
            {professionals.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}

        <div className="flex items-start justify-between gap-4 rounded-lg border border-ink-100 bg-sand/60 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink-800">Dia todo</p>
            <p className="mt-0.5 text-xs text-ink-500">
              {allDay ? "Bloqueia o dia inteiro. Para vários dias (férias), escolha também a data final." : "Desligado: você escolhe o horário de início e de fim."}
            </p>
          </div>
          <div className="pt-0.5">
            <Switch
              checked={allDay}
              onChange={(v) => {
                setAllDay(v);
                setRemind((r) => remindAfterModeChange(v, r)); // "30 min antes" não existe para dia todo, e vice-versa
              }}
              disabled={locked || readOnly}
              label="Dia todo"
            />
          </div>
        </div>

        {allDay ? (
          <div className="grid grid-cols-2 gap-3">
            <Input
              type="date"
              label="De"
              required
              value={date}
              disabled={locked || readOnly}
              onChange={(e) => {
                setDate(e.target.value);
                if (endDate < e.target.value) setEndDate(e.target.value);
              }}
            />
            <Input type="date" label="Até" required value={endDate} min={date} disabled={locked || readOnly} onChange={(e) => setEndDate(e.target.value)} />
          </div>
        ) : (
          <>
            <Input
              type="date"
              label="Data"
              required
              value={date}
              disabled={locked || readOnly}
              onChange={(e) => {
                setDate(e.target.value);
                setEndDate(e.target.value);
              }}
            />
            <div className="grid grid-cols-2 gap-3">
              <Input type="time" label="Das" required value={start} disabled={locked || readOnly} onChange={(e) => setStart(e.target.value)} />
              <Input type="time" label="Até" required value={end} disabled={locked || readOnly} onChange={(e) => setEnd(e.target.value)} />
            </div>
          </>
        )}

        <Textarea
          label="Observação (aparece na agenda)"
          placeholder="Ex.: Folga, almoço, consulta médica"
          value={reason}
          maxLength={REASON_MAX}
          rows={2}
          disabled={readOnly}
          onChange={(e) => setReason(e.target.value)}
        />

        <div className="space-y-1.5">
          <Select
            label="Lembrete no celular"
            value={remind === null ? "" : String(remind)}
            disabled={readOnly}
            onChange={(e) => setRemind(e.target.value === "" ? null : Number(e.target.value))}
          >
            {remindOptions(allDay).map((o) => (
              <option key={String(o.value)} value={o.value === null ? "" : String(o.value)}>
                {o.label}
              </option>
            ))}
          </Select>
          {remind !== null && (
            <p className="flex items-start gap-1.5 text-xs text-ink-500" data-testid="remind-hint">
              <Bell className="mt-0.5 size-3.5 shrink-0 text-ink-400" aria-hidden="true" />
              <span>
                O aviso chega no celular de {who}, para quem ativou os avisos.{" "}
                <Link href="/mais/configuracoes" className="font-semibold text-ink-700 underline underline-offset-2">
                  Ativar avisos no celular
                </Link>
              </span>
            </p>
          )}
        </div>

        {conflicts > 0 && (
          <div
            className="flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-ink-700"
            role="status"
            data-testid="block-conflicts"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
            <span>
              {conflicts === 1 ? "Já existe 1 atendimento marcado" : `Já existem ${conflicts} atendimentos marcados`} nesse período para {who}. Eles
              continuam na agenda; o bloqueio só impede novos agendamentos.
            </span>
          </div>
        )}

        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}

        {!readOnly && (
          <div className="flex gap-2">
            <Button type="button" variant="secondary" className="flex-1" onClick={() => router.back()} disabled={saving}>
              Cancelar
            </Button>
            <Button type="submit" loading={saving} className="flex-1">
              {saving ? "Salvando..." : editing ? "Salvar" : "Bloquear"}
            </Button>
          </div>
        )}
        {readOnly && (
          <Button type="button" variant="secondary" className="w-full" onClick={() => router.back()}>
            Voltar
          </Button>
        )}
      </form>

      {editing && !readOnly && (
        <div className="border-t border-ink-100 pt-4">
          <Button variant="ghost" size="sm" className="text-danger" onClick={() => setShowDelete(true)} disabled={saving}>
            Remover bloqueio
          </Button>
        </div>
      )}

      <Modal open={showDelete} onClose={() => !saving && setShowDelete(false)} title="Remover bloqueio">
        <div className="space-y-4">
          <p className="text-sm text-ink-700">Os horários desse período voltam a ficar livres para novos agendamentos.</p>
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => setShowDelete(false)} disabled={saving}>
              Manter
            </Button>
            <Button variant="danger" className="flex-1" onClick={handleDelete} loading={saving}>
              Remover
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
