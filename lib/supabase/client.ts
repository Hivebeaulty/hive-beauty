// Cliente Supabase para uso no navegador (Client Components).
// Usa a chave anônima — a segurança dos dados é garantida pelo RLS no banco,
// nunca por lógica no frontend.
import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
