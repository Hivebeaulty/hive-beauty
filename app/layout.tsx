import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans, Fraunces } from "next/font/google";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";
import { THEME_BOOT_SCRIPT, THEME_KEY, parseThemePref } from "@/lib/hive/theme";
import { cookies } from "next/headers";
import { ThemeSync } from "@/components/theme-sync";

// Fonte de UI — corpo, labels, botões, tabelas. Domina a interface.
const sans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

// Fonte serifada — uso pontual apenas (saudações, títulos de destaque).
// Nunca aplicada em corpo de texto, formulários ou tabelas.
const serif = Fraunces({
  subsets: ["latin"],
  variable: "--font-serif",
  weight: ["500", "600"],
  style: ["normal", "italic"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Áurea",
  description: "Sua assistente de negócio.",
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
  themeColor: "#FAF6F1",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // o servidor já desenha no tema salvo (cookie); "auto" decide no aparelho (script)
  const pref = parseThemePref((await cookies()).get(THEME_KEY)?.value);
  return (
    <html lang="pt-BR" className={`${sans.variable} ${serif.variable}`} data-theme={pref === "dark" ? "dark" : "light"} suppressHydrationWarning>
      <head>
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
