import type { Metadata, Viewport } from "next";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";
import { THEME_BOOT_SCRIPT, THEME_KEY, parseThemePref } from "@/lib/hive/theme";
import { cookies } from "next/headers";
import { ThemeSync } from "@/components/theme-sync";

export const metadata: Metadata = {
  title: "Sócia",
  description: "Seu negócio em boas mãos.",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

// viewport-fit=cover é o que faz env(safe-area-inset-*) valer de verdade em
// celulares com notch/barra de gestos; theme-color pinta a barra do sistema com
// o creme da marca quando o app é aberto como PWA.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FBF4EC" },
    { media: "(prefers-color-scheme: dark)", color: "#1F232C" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // o servidor já desenha no tema salvo (cookie); "auto" decide no aparelho (script)
  const pref = parseThemePref((await cookies()).get(THEME_KEY)?.value);
  return (
    <html lang="pt-BR" data-theme={pref === "dark" ? "dark" : "light"} suppressHydrationWarning>
      <head>
        {/* fonte da interface hospedada no próprio app (public/fonts): carrega sempre, sem depender do Google */}
        <link rel="preload" href="/fonts/plus-jakarta-sans.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        {/* aplica o tema escolhido ANTES de pintar (sem "piscar" claro no escuro) */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-cream font-sans text-ink-800 antialiased">
        <ThemeSync />
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
