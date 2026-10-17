// Tema do app (design system "Áurea"): Claro (padrão), Grafite ou Automático
// (segue o celular). A escolha fica NO APARELHO (localStorage) e é aplicada no
// <html data-theme> antes da tela aparecer (script em app/layout.tsx), para não
// "piscar" claro ao abrir no escuro.
export type ThemePref = "light" | "dark" | "auto";
export const THEME_KEY = "aurea-theme";
export const THEME_OPTIONS: { value: ThemePref; label: string; hint: string }[] = [
  { value: "light", label: "Claro", hint: "Creme e areia" },
  { value: "dark", label: "Grafite", hint: "Escuro, confortável à noite" },
  { value: "auto", label: "Automático", hint: "Segue o tema do celular" },
];

export function parseThemePref(v: string | null | undefined): ThemePref {
  return v === "dark" || v === "auto" ? v : "light";
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): "light" | "dark" {
  return pref === "dark" || (pref === "auto" && systemDark) ? "dark" : "light";
}

/** Script do <head>: mesma regra, sem depender do bundle (roda antes de pintar). */
export const THEME_BOOT_SCRIPT =
  `(function(){try{var p=localStorage.getItem("${THEME_KEY}");` +
  `var d=p==="dark"||(p==="auto"&&window.matchMedia("(prefers-color-scheme: dark)").matches);` +
  `document.documentElement.setAttribute("data-theme",d?"dark":"light");}catch(e){}})();`;

export function readThemePref(): ThemePref {
  try {
    return parseThemePref(localStorage.getItem(THEME_KEY));
  } catch {
    return "light";
  }
}

export function applyTheme(pref: ThemePref) {
  const systemDark = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  document.documentElement.setAttribute("data-theme", resolveTheme(pref, systemDark));
}

export function saveThemePref(pref: ThemePref) {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* navegação privada: vale só nesta sessão */
  }
  applyTheme(pref);
}
