"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { LayoutDashboard, Users, ScrollText, Wallet } from "lucide-react";

// Só as áreas que já funcionam com dados reais. Aquisição e relatórios entram
// aqui quando as próximas fases tiverem dados de verdade.
const ITEMS = [
  { href: "/admin", label: "Visão geral", icon: LayoutDashboard, exact: true },
  { href: "/admin/profissionais", label: "Profissionais", icon: Users },
  { href: "/admin/financeiro", label: "Assinaturas e financeiro", icon: Wallet },
  { href: "/admin/auditoria", label: "Auditoria", icon: ScrollText },
];

export function AdminNav() {
  const path = usePathname();
  const active = (i: (typeof ITEMS)[number]) => (i.exact ? path === i.href : path === i.href || path.startsWith(`${i.href}/`));
  return (
    <nav aria-label="Painel administrativo" className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
      {ITEMS.map((i) => (
        <Link
          key={i.href}
          href={i.href}
          aria-current={active(i) ? "page" : undefined}
          className={cn(
            "flex shrink-0 items-center gap-2.5 rounded px-3 py-2 text-sm font-medium transition-colors",
            active(i)
              ? "bg-primary text-primary-ink"
              : "text-ink-700 hover:bg-ink-50 hover:text-ink-800"
          )}
        >
          <i.icon className="size-4" />
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
