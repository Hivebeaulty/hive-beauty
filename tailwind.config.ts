import type { Config } from "tailwindcss";

// ============================================================================
// Design System — Áurea
// Tokens derivados por amostragem de pixel do logo oficial da marca.
// Ver docs/design-system.md para a justificativa de cada decisão.
// ============================================================================
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Fundo de app (creme quente do logo). Cards continuam brancos
        // (bg-surface) para manter a camada de profundidade que já existia.
        cream: {
          DEFAULT: "#FAF6F1",
          50: "#FDFBF9",
          100: "#FAF6F1",
        },
        surface: "#FFFFFF",

        // Escala neutra derivada do marrom-café do wordmark (#3A2A22),
        // substitui "charcoal" (cinza frio) por uma família quente coerente
        // com fundo e tipografia. ink-800 é a cor primária aprovada.
        ink: {
          50: "#F3EDE6",
          100: "#E9E0D6",
          200: "#D6CABE",
          300: "#B0A093",
          400: "#8C7A6B",
          500: "#6F5B4C",
          600: "#5C4A3D",
          700: "#4A382E",
          800: "#3A2A22", // primária aprovada
          900: "#2A1D16",
        },

        // Dourado do brilho do logo. Uso pontual — nunca como fundo grande.
        gold: {
          50: "#FBF3E7",
          100: "#F3E4CC",
          300: "#E3CBA0",
          500: "#C9A876", // accent aprovado
          600: "#B08F5E",
          700: "#8F7349",
        },

        // Semânticas — já eram tons terrosos e discretos, mantidas.
        success: "#7A9B76",
        warning: "#C98A4B",
        danger: "#B85C5C",

        // --- LEGADO (Hive Beauty) -------------------------------------
        // Mantido de propósito para não quebrar telas que ainda não foram
        // migradas para os tokens novos acima. Cada uso de blush/plum/
        // charcoal deve ser trocado por cream/ink/gold na Etapa 2 —
        // depois disso, remover este bloco inteiro.
        blush: { 50: "#FBF1EA", 100: "#F5DDCF", 200: "#EFCBB8" },
        plum: { 400: "#9C6E7B", 500: "#885563", 600: "#6E4451", 700: "#563441" },
        charcoal: { 500: "#6B6570", 700: "#524C54", 900: "#464248" },
      },
      fontFamily: {
        // Corpo/UI: Plus Jakarta Sans (via next/font, ver app/layout.tsx).
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        // Serifada de uso pontual (saudações, títulos de destaque). Nunca
        // usar como fonte dominante da interface.
        serif: ["var(--font-serif)", "Georgia", "serif"],
      },
      borderRadius: {
        // Escala mais contida que a anterior (tudo era 1rem/1.5rem) —
        // reduz a sensação de "app fofo" mantendo componentes macios.
        sm: "0.375rem", // 6px — checkbox, chips pequenos
        DEFAULT: "0.5rem", // 8px — inputs, botões
        md: "0.625rem", // 10px
        lg: "0.75rem", // 12px — cards
        xl: "1rem", // 16px — modais, sheets
      },
      boxShadow: {
        // Sombra quente e discreta — reservada para elementos flutuantes
        // (modal, dropdown, toast, FAB). O resto usa borda 1px (ink-100).
        elevated:
          "0 8px 24px -4px rgba(42, 29, 22, 0.12), 0 2px 8px -2px rgba(42, 29, 22, 0.08)",
      },
      keyframes: {
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "slide-up": {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in-right": {
          "0%": { opacity: "0", transform: "translateX(12px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
      },
      animation: {
        shimmer: "shimmer 1.6s ease-in-out infinite",
        "fade-in": "fade-in 0.15s ease-out",
        "slide-up": "slide-up 0.18s ease-out",
        "slide-in-right": "slide-in-right 0.2s ease-out",
      },
    },
  },
  plugins: [],
};

export default config;
