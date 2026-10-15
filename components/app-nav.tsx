"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { Home, CalendarDays, Users, Wallet, MoreHorizontal, type LucideIcon } from "lucide-react";
import { LogoutButton } from "@/components/logout-button";
import { cn } from "@/lib/utils";

const ICONS: Record<string, LucideIcon> = {
  "/inicio": Home,
  "/agenda": CalendarDays,
  "/clientes": Users,
  "/financeiro": Wallet,
  "/mais": MoreHorizontal,
};

export type NavItem = { href: string; label: string };

function isActive(pathname: string, href: string) {
  return href === "/inicio" ? pathname === href : pathname.startsWith(href);
}

export function AppNav({ items, companyName }: { items: NavItem[]; companyName: string }) {
  const pathname = usePathname();

  return (
    <>
      {/* Desktop — sidebar fixa à esquerda */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-ink-100 bg-surface p-6 md:sticky md:top-0 md:flex md:h-screen md:self-start md:overflow-y-auto">
        <div className="mb-8 flex items-center gap-2">
          <Image src="/logo-icon.png" alt="" width={26} height={26} priority />
          <Image src="/logo-wordmark.png" alt="Áurea" width={72} height={17} priority className="mt-0.5" />
        </div>
        <p className="mb-6 -mt-5 truncate pl-[34px] text-xs text-ink-400">{companyName}</p>
        <nav className="space-y-0.5">
          {items.map((item) => {
            const Icon = ICONS[item.href] ?? Home;
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 rounded-md border-l-2 py-2.5 pl-3.5 pr-3 text-sm font-medium transition-colors",
                  active
                    ? "border-gold-500 bg-sand font-semibold text-ink-800"
                    : "border-transparent text-ink-500 hover:bg-sand/60 hover:text-ink-800"
                )}
              >
                <Icon className="size-[18px]" strokeWidth={active ? 2.25 : 2} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Local mais natural pra Sair no desktop: fim da navegação principal. */}
        <div className="mt-auto border-t border-ink-100 pt-2">
          <LogoutButton variant="sidebar" />
        </div>
      </aside>

      {/* Mobile — barra inferior */}
      <nav className="fixed inset-x-0 bottom-0 z-10 flex border-t border-ink-100 bg-surface/95 pb-[env(safe-area-inset-bottom,0px)] shadow-[0_-4px_16px_-8px_rgba(42,29,22,0.12)] backdrop-blur md:hidden">
        {items.map((item) => {
          const Icon = ICONS[item.href] ?? Home;
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex min-h-[56px] flex-1 flex-col items-center justify-center gap-1 py-2 text-[11px] transition-colors",
                active ? "font-semibold text-ink-800" : "font-medium text-ink-400"
              )}
            >
              {/* indicador do item ativo: traço dourado no topo + ícone sobre areia */}
              <span
                aria-hidden="true"
                className={cn("absolute inset-x-5 top-0 h-[3px] rounded-b-full", active ? "bg-gold-500" : "bg-transparent")}
              />
              <span className={cn("flex h-7 w-11 items-center justify-center rounded-full", active && "bg-sand")}>
                <Icon className="size-5" strokeWidth={active ? 2.25 : 2} />
              </span>
              {item.label}
            </Link>
          );
        })}
      </nav>
    </>
  );
}
