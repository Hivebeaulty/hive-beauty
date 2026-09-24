"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { LogOut } from "lucide-react";
import { cn } from "@/lib/utils";

// Usado tanto na sidebar (desktop) quanto em Mais (mobile). Zera a sessão do
// Supabase de verdade e força reload completo pra /login — não usa
// router.push porque o layout do app (que decide se redireciona pro
// onboarding/login) roda no servidor e precisa reavaliar os cookies do zero.
export function LogoutButton({ className, variant = "block" }: { className?: string; variant?: "block" | "sidebar" }) {
  const [loading, setLoading] = useState(false);

  async function handleLogout() {
    setLoading(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  if (variant === "sidebar") {
    return (
      <button
        onClick={handleLogout}
        disabled={loading}
        className={cn(
          "flex w-full items-center gap-3 rounded-md border-l-2 border-transparent py-2.5 pl-3.5 pr-3 text-sm font-medium text-ink-500 transition-colors hover:bg-ink-50 hover:text-danger disabled:opacity-50",
          className
        )}
      >
        <LogOut className="size-[18px]" />
        {loading ? "Saindo..." : "Sair"}
      </button>
    );
  }

  return (
    <button
      onClick={handleLogout}
      disabled={loading}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg border border-ink-100 bg-surface p-4 text-sm font-medium text-danger transition-colors hover:bg-danger/5 disabled:opacity-50",
        className
      )}
    >
      <LogOut className="size-[18px]" />
      {loading ? "Saindo..." : "Sair da conta"}
    </button>
  );
}
