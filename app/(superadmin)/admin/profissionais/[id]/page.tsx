import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSuperadmin } from "@/lib/supabase/require-superadmin";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SuspensionControl, NoteForm } from "@/components/admin/account-actions";
import {
  BILLING_LABEL,
  BILLING_TONE,
  activationSteps,
  auditLabel,
  fmtDate,
  isBillingStatus,
  type BillingStatus,
} from "@/lib/hive/admin";
import { CheckCircle2, ChevronLeft, Circle } from "lucide-react";

export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<string, string> = { owner: "Dona", admin: "Administradora", professional: "Profissional", reception: "Recepção" };
const WA_LABEL: Record<string, string> = {
  connected: "Conectado",
  disconnected: "Desconectado",
  logged_out: "Desconectado pelo celular",
  qr_pending: "Aguardando leitura do QR",
  connecting: "Conectando",
  connect_requested: "Conexão pedida",
  disconnect_requested: "Desconexão pedida",
  error: "Com erro",
};

type Detail = {
  account: {
    company_name: string; owner_name: string | null; owner_email: string | null; created_at: string;
    billing_status: string; suspended: boolean; is_demo: boolean;
  };
  company: { phone: string | null; email: string | null } | null;
  owner: { created_at: string; email_confirmed_at: string | null; last_sign_in_at: string | null } | null;
  billing: { status: string; provider: string | null; preapproval_id: string | null; next_payment_at: string | null; updated_at: string } | null;
  suspension: { suspended_at: string | null; reason: string | null; updated_at: string } | null;
  team: { role: string; active: boolean; since: string; name: string }[];
  usage: {
    appointments_total: number; appointments_30d: number; appointments_upcoming: number;
    first_appointment_at: string | null; last_appointment_at: string | null; clients: number; services: number; team_active: number;
  };
  whatsapp: { status: string; connected_at: string | null; last_seen_at: string | null; auto_confirmation: boolean; reminder: boolean } | null;
  notes: { id: string; body: string; at: string }[];
  audit: { at: string; action: string; result: string; reason: string | null }[];
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <dt className="text-ink-400">{label}</dt>
      <dd className="text-right font-medium text-ink-800">{children}</dd>
    </div>
  );
}

export default async function AdminContaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await requireSuperadmin();
  const { data, error } = await supabase.rpc("admin_get_account", { p_company_id: id });
  if (error?.code === "P0002") notFound();
  const d = (error ? null : data) as Detail | null;
  if (!d) {
    return (
      <Card>
        <p className="text-sm text-ink-500">Não foi possível carregar esta conta. Recarregue a página.</p>
      </Card>
    );
  }

  const a = d.account;
  const status: BillingStatus = isBillingStatus(a.billing_status) ? a.billing_status : "none";
  const steps = activationSteps(d.usage);

  return (
    <div className="space-y-5">
      <Link href="/admin/profissionais" className="flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-ink-800">
        <ChevronLeft className="size-4" /> Profissionais
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">{a.company_name}</h1>
          <p className="text-sm text-ink-400">
            {a.owner_name ?? "Sem nome"}
            {a.owner_email && <>, {a.owner_email}</>}
          </p>
          <div className="mt-2 flex flex-wrap gap-1">
            <Badge tone={BILLING_TONE[status]}>{BILLING_LABEL[status]}</Badge>
            {a.suspended && <Badge tone="danger">Acesso suspenso</Badge>}
            {a.is_demo && <Badge tone="muted">Demonstração</Badge>}
          </div>
        </div>
        <SuspensionControl companyId={id} companyName={a.company_name} suspended={a.suspended} />
      </div>

      {a.suspended && d.suspension && (
        <p className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-ink-700">
          Suspensa em {fmtDate(d.suspension.suspended_at, true)}. Motivo: {d.suspension.reason ?? "não informado"}.
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <h2 className="mb-1 text-sm font-semibold text-ink-700">Conta</h2>
          <dl className="divide-y divide-ink-50">
            <Row label="Cadastro">{fmtDate(a.created_at)}</Row>
            <Row label="E-mail confirmado">{d.owner?.email_confirmed_at ? fmtDate(d.owner.email_confirmed_at) : "Não"}</Row>
            <Row label="Último acesso da dona">{fmtDate(d.owner?.last_sign_in_at, true)}</Row>
            <Row label="Telefone do negócio">{d.company?.phone || "—"}</Row>
            <Row label="E-mail do negócio">{d.company?.email || "—"}</Row>
          </dl>
        </Card>

        <Card>
          <h2 className="mb-1 text-sm font-semibold text-ink-700">Assinatura</h2>
          {d.billing ? (
            <dl className="divide-y divide-ink-50">
              <Row label="Situação">{BILLING_LABEL[status]}</Row>
              <Row label="Origem">{d.billing.provider === "cortesia" ? "Cortesia" : d.billing.provider === "mercadopago" ? "Mercado Pago" : d.billing.provider ?? "—"}</Row>
              <Row label={status === "trialing" ? "Fim do teste (1ª cobrança)" : "Próxima cobrança"}>{fmtDate(d.billing.next_payment_at)}</Row>
              <Row label="Último aviso do Mercado Pago">{d.billing.provider === "mercadopago" ? fmtDate(d.billing.updated_at, true) : "—"}</Row>
              {d.billing.preapproval_id && <Row label="Assinatura no Mercado Pago"><span className="break-all text-xs">{d.billing.preapproval_id}</span></Row>}
            </dl>
          ) : (
            <p className="text-sm text-ink-500">Nenhuma assinatura vinculada ao e-mail da dona.</p>
          )}
          <p className="mt-3 text-xs text-ink-400">
            Histórico de pagamentos e de mudanças de situação ainda não é gravado; chega na Fase 3. Cancelar a assinatura no
            Mercado Pago pelo painel também.
          </p>
        </Card>

        <Card>
          <h2 className="mb-1 text-sm font-semibold text-ink-700">Uso da Áurea</h2>
          <ul className="mb-3 space-y-1.5">
            {steps.map((s) => (
              <li key={s.key} className="flex items-center gap-2 text-sm">
                {s.done ? <CheckCircle2 className="size-4 text-success" /> : <Circle className="size-4 text-ink-300" />}
                <span className={s.done ? "text-ink-700" : "text-ink-400"}>{s.label}</span>
              </li>
            ))}
          </ul>
          <dl className="divide-y divide-ink-50">
            <Row label="Atendimentos (total)">{d.usage.appointments_total}</Row>
            <Row label="Criados nos últimos 30 dias">{d.usage.appointments_30d}</Row>
            <Row label="Agendados para a frente">{d.usage.appointments_upcoming}</Row>
            <Row label="Primeiro atendimento criado">{fmtDate(d.usage.first_appointment_at)}</Row>
            <Row label="Último atendimento criado">{fmtDate(d.usage.last_appointment_at, true)}</Row>
            <Row label="Clientes ativas">{d.usage.clients}</Row>
            <Row label="Serviços ativos">{d.usage.services}</Row>
          </dl>
        </Card>

        <Card>
          <h2 className="mb-1 text-sm font-semibold text-ink-700">WhatsApp</h2>
          {d.whatsapp ? (
            <dl className="divide-y divide-ink-50">
              <Row label="Situação">{WA_LABEL[d.whatsapp.status] ?? d.whatsapp.status}</Row>
              <Row label="Conectado em">{fmtDate(d.whatsapp.connected_at, true)}</Row>
              <Row label="Último sinal do celular">{fmtDate(d.whatsapp.last_seen_at, true)}</Row>
              <Row label="Confirmação automática">{d.whatsapp.auto_confirmation ? "Ligada" : "Desligada"}</Row>
              <Row label="Lembrete">{d.whatsapp.reminder ? "Ligado" : "Desligado"}</Row>
            </dl>
          ) : (
            <p className="text-sm text-ink-500">Nunca conectou o WhatsApp.</p>
          )}
          <h3 className="mb-1 mt-4 text-sm font-semibold text-ink-700">Equipe ({d.usage.team_active} ativas)</h3>
          <ul className="space-y-1 text-sm">
            {d.team.map((m, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span className={m.active ? "text-ink-700" : "text-ink-300 line-through"}>{m.name}</span>
                <span className="text-ink-400">{ROLE_LABEL[m.role] ?? m.role}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="space-y-4">
          <h2 className="text-sm font-semibold text-ink-700">Observações</h2>
          {d.notes.length > 0 && (
            <ul className="space-y-2.5">
              {d.notes.map((n) => (
                <li key={n.id} className="rounded-md bg-ink-50/70 px-3 py-2">
                  <p className="whitespace-pre-wrap text-sm text-ink-700">{n.body}</p>
                  <p className="mt-1 text-xs text-ink-400">{fmtDate(n.at, true)}</p>
                </li>
              ))}
            </ul>
          )}
          <NoteForm companyId={id} />
        </Card>

        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink-700">Histórico administrativo</h2>
          {d.audit.length === 0 ? (
            <p className="text-sm text-ink-500">Nenhuma ação registrada.</p>
          ) : (
            <ul className="space-y-2">
              {d.audit.map((l, i) => (
                <li key={i} className="text-sm">
                  <p className="text-ink-700">{auditLabel(l.action, l.result)}</p>
                  <p className="text-xs text-ink-400">
                    {fmtDate(l.at, true)}
                    {l.reason && <>, motivo: {l.reason}</>}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <Link href={`/admin/auditoria?conta=${id}`} className="mt-3 inline-block text-xs text-ink-500 underline">
            Ver tudo na auditoria
          </Link>
        </Card>
      </div>
    </div>
  );
}
