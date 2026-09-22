import type { Metadata } from "next";
import { Plus_Jakarta_Sans, Fraunces } from "next/font/google";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={`${sans.variable} ${serif.variable}`}>
      <body className="min-h-screen bg-cream font-sans text-ink-800 antialiased">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
