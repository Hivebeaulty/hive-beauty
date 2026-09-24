"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Avatar } from "@/components/ui/avatar";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";

type Role = "owner" | "admin" | "professional" | "reception";
type Member = { id: string; role: Role; active: boolean; name: string };

const ROLE_LABEL: Record<Role, string> = {
  owner: "Proprietária",
  admin: "Administradora",
  professional: "Profissional",
  reception: "Recepção",
};

export function TeamCard({ companyId, currentMemberId }: { companyId: string; currentMemberId: string }) {
  const toast = useToast();
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    Promise.all([
      supabase.from("company_members").select("id, role, active").eq("company_id", companyId),
      supabase.rpc("get_company_member_names", { p_company_id: companyId }),
    ]).then(([{ data: rows }, { data: names }]) => {
      const nameById = new Map<string, string>(
        ((names as { member_id: string; full_name: string }[]) ?? []).map((n) => [n.member_id, n.full_name])
      );
      const list = ((rows as { id: string; role: Role; active: boolean }[]) ?? []).map((m) => ({
        id: m.id,
        role: m.role,
        active: m.active,
        name: nameById.get(m.id) ?? "Profissional",
      }));
      list.sort((a, b) => (a.role === "owner" ? -1 : b.role === "owner" ? 1 : a.name.localeCompare(b.name, "pt-BR")));
      setMembers(list);
      setLoading(false);
    });
  }, [companyId]);

  async function updateRole(memberId: string, role: Role) {
    setMembers((prev) => prev.map((m) => (m.id === memberId ? { ...m, role } : m)));
    const { error } = await createClient().from("company_members").update({ role }).eq("id", memberId);
    if (error) toast.error("Não foi possível atualizar a função.");
    else toast.success("Função atualizada.");
  }

  async function updateActive(memberId: string, active: boolean) {
    setMembers((prev) => prev.map((m) => (m.id === memberId ? { ...m, active } : m)));
    const { error } = await createClient().from("company_members").update({ active }).eq("id", memberId);
    if (error) toast.error("Não foi possível atualizar.");
    else toast.success(active ? "Reativada." : "Desativada.");
  }

  return (
    <div className="space-y-4 rounded-lg border border-ink-100 bg-surface p-5">
      <div>
        <h2 className="text-sm font-semibold text-ink-700">Equipe</h2>
        <p className="text-xs text-ink-400">
          Quem está ativa aparece nos seletores de profissional da Agenda. Convite por e-mail ainda não existe —
          novas integrantes precisam ser adicionadas diretamente no banco por enquanto.
        </p>
      </div>

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : (
        <div className="space-y-1">
          {members.map((m) => {
            const isOwner = m.role === "owner";
            const isSelf = m.id === currentMemberId;
            return (
              <div key={m.id} className="flex items-center gap-3 rounded-md py-2">
                <Avatar name={m.name} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink-800">
                    {m.name}
                    {isSelf && <span className="font-normal text-ink-400"> (você)</span>}
                  </p>
                </div>
                {isOwner ? (
                  <span className="text-xs font-medium text-ink-400">{ROLE_LABEL.owner}</span>
                ) : (
                  <select
                    value={m.role}
                    onChange={(e) => updateRole(m.id, e.target.value as Role)}
                    className="rounded border border-ink-200 bg-surface px-2 py-1 text-xs font-medium text-ink-700 outline-none focus:border-ink-800"
                  >
                    <option value="admin">Administradora</option>
                    <option value="professional">Profissional</option>
                    <option value="reception">Recepção</option>
                  </select>
                )}
                <Switch
                  checked={m.active}
                  onChange={(v) => updateActive(m.id, v)}
                  disabled={isOwner || isSelf}
                  label={`${m.name} ativa`}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
