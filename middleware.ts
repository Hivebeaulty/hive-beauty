// Protege rotas autenticadas e mantém a sessão do Supabase sincronizada
// entre requisições (necessário com @supabase/ssr no App Router).
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet: { name: string; value: string; options: CookieOptions }[]) => {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();

  const isAuthRoute = request.nextUrl.pathname.startsWith("/login") ||
    request.nextUrl.pathname.startsWith("/cadastro");

  if (!user && !isAuthRoute) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return response;
}

// O middleware NÃO pode rodar em arquivos estáticos de /public: um visitante
// deslogado (login/cadastro) pediria /logo-lockup.png, receberia um redirect para
// /login (HTML) e o <Image> do Next exibiria imagem quebrada. O otimizador
// /_next/image também busca o arquivo de origem sem cookies de sessão, então o
// mesmo redirect o quebrava. Manifest e ícones de PWA/favicon sofriam igual.
// Rotas de página (sem extensão) continuam protegidas normalmente.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|api|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|json|txt|xml|webmanifest)$).*)",
  ],
};
