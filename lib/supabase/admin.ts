// Cliente com SERVICE ROLE — ignora RLS. Uso restrito a rotas de SuperAdmin,
// sempre no servidor (Route Handler / Server Action). NUNCA importar este
// arquivo em um Client Component nem expor a chave no bundle do navegador.
import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}
