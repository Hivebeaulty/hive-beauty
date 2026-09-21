"use client";

import { createContext, useContext } from "react";
import type { Membership } from "@/lib/hive/membership";

const CompanyContext = createContext<Membership | null>(null);

export function CompanyProvider({
  membership,
  children,
}: {
  membership: Membership;
  children: React.ReactNode;
}) {
  return <CompanyContext.Provider value={membership}>{children}</CompanyContext.Provider>;
}

// Lança erro se usado fora do shell autenticado — evita bugs silenciosos de
// company_id undefined em telas que dependem de multi-tenant.
export function useCompany(): Membership {
  const ctx = useContext(CompanyContext);
  if (!ctx) throw new Error("useCompany() precisa estar dentro de <CompanyProvider>.");
  return ctx;
}
