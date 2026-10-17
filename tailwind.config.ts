import type { Config } from "tailwindcss";

// ============================================================================
// Design System — Áurea
// Tokens derivados por amostragem de pixel do logo oficial da marca.
// Ver docs/design-system.md para a justificativa de cada decisão.
// ============================================================================
const config: Config = {
  // tema escuro (Grafite) por atributo no <html>, escolhido pela usuária
  darkMode: ["selector", '[data-theme="dark"]'],
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // TEMAS (claro e Grafite): cada cor é uma variável definida em app/globals.css
        // (:root = claro; [data-theme="dark"] = Grafite). Valores e contraste: design system "Áurea".
        cream: { DEFAULT: "rgb(var(--c-cream-DEFAULT) / <alpha-value>)", 50: "rgb(var(--c-cream-50) / <alpha-value>)", 100: "rgb(var(--c-cream-100) / <alpha-value>)" },
        surface: "rgb(var(--c-surface) / <alpha-value>)",
        ink: { 50: "rgb(var(--c-ink-50) / <alpha-value>)", 100: "rgb(var(--c-ink-100) / <alpha-value>)", 200: "rgb(var(--c-ink-200) / <alpha-value>)", 300: "rgb(var(--c-ink-300) / <alpha-value>)", 400: "rgb(var(--c-ink-400) / <alpha-value>)", 500: "rgb(var(--c-ink-500) / <alpha-value>)", 600: "rgb(var(--c-ink-600) / <alpha-value>)", 700: "rgb(var(--c-ink-700) / <alpha-value>)", 800: "rgb(var(--c-ink-800) / <alpha-value>)", 900: "rgb(var(--c-ink-900) / <alpha-value>)" },
        gold: { 50: "rgb(var(--c-gold-50) / <alpha-value>)", 100: "rgb(var(--c-gold-100) / <alpha-value>)", 300: "rgb(var(--c-gold-300) / <alpha-value>)", 500: "rgb(var(--c-gold-500) / <alpha-value>)", 600: "rgb(var(--c-gold-600) / <alpha-value>)", 700: "rgb(var(--c-gold-700) / <alpha-value>)" },
        wine: { 50: "rgb(var(--c-wine-50) / <alpha-value>)", 100: "rgb(var(--c-wine-100) / <alpha-value>)", 300: "rgb(var(--c-wine-300) / <alpha-value>)", 500: "rgb(var(--c-wine-500) / <alpha-value>)", 700: "rgb(var(--c-wine-700) / <alpha-value>)" },
        sand: { DEFAULT: "rgb(var(--c-sand-DEFAULT) / <alpha-value>)", 200: "rgb(var(--c-sand-200) / <alpha-value>)" },
        success: "rgb(var(--c-success) / <alpha-value>)",
        warning: "rgb(var(--c-warning) / <alpha-value>)",
        danger: "rgb(var(--c-danger) / <alpha-value>)",
        primary: { DEFAULT: "rgb(var(--c-primary) / <alpha-value>)", hover: "rgb(var(--c-primary-hover) / <alpha-value>)", ink: "rgb(var(--c-primary-ink) / <alpha-value>)" },
        feature: { DEFAULT: "rgb(var(--c-feature-DEFAULT) / <alpha-value>)", line: "rgb(var(--c-feature-line) / <alpha-value>)", ink: "rgb(var(--c-feature-ink) / <alpha-value>)", muted: "rgb(var(--c-feature-muted) / <alpha-value>)", soft: "rgb(var(--c-feature-soft) / <alpha-value>)", accent: "rgb(var(--c-feature-accent) / <alpha-value>)", border: "rgb(var(--c-feature-border) / <alpha-value>)" },
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
        // Cartões: borda quente + sombra curta e quente (não a sombra cinza genérica).
        card: "0 1px 0 rgba(58, 42, 34, 0.04), 0 2px 6px -2px rgba(58, 42, 34, 0.08)",
        // Painel em destaque (cartão "Hoje"): profundidade só onde está o foco.
        feature: "0 12px 28px -12px rgba(42, 29, 22, 0.45)",
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
