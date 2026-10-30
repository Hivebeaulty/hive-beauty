// Tema do app (design system "Sócia"): Claro (padrão), Escuro ou Automático
// (segue o celular). A escolha fica NO APARELHO (localStorage) e é aplicada no
// <html data-theme> antes da tela aparecer (script em app/layout.tsx), para não
// "piscar" claro ao abrir no escuro.
export type ThemePref = "light" | "dark" | "auto";
export const THEME_KEY = "aurea-theme";
export const THEME_OPTIONS: { value: ThemePref; label: string; hint: string }[] = [
  { value: "light", label: "Claro", hint: "Creme e framboesa" },
  { value: "dark", label: "Escuro", hint: "Grafite, confortável à noite" },
  { value: "auto", label: "Automático", hint: "Segue o tema do celular" },
];

export function parseThemePref(v: string | null | undefined): ThemePref {
  return v === "dark" || v === "auto" ? v : "light";
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): "light" | "dark" {
  return pref === "dark" || (pref === "auto" && systemDark) ? "dark" : "light";
}

/** Lê a preferência do cookie (texto de document.cookie ou do cabeçalho). */
export function themeFromCookie(cookie: string | null | undefined): ThemePref | null {
  const m = (cookie ?? "").match(new RegExp(`(?:^|;\\s*)${THEME_KEY}=(light|dark|auto)`));
  return m ? (m[1] as ThemePref) : null;
}

/**
 * Script do <head>: mesma regra, sem depender do bundle (roda antes de pintar).
 * Fonte: armazenamento local OU cookie (o iPhone apaga o primeiro em apps
 * instalados; o cookie do servidor permanece).
 */
export const THEME_BOOT_SCRIPT =
  `(function(){try{var p=null;try{p=localStorage.getItem("${THEME_KEY}")}catch(e){}` +
  `if(p!=="light"&&p!=="dark"&&p!=="auto"){var m=document.cookie.match(/(?:^|;\\s*)${THEME_KEY}=(light|dark|auto)/);p=m?m[1]:null}` +
  `var d=p==="dark"||(p==="auto"&&window.matchMedia("(prefers-color-scheme: dark)").matches);` +
  `document.documentElement.setAttribute("data-theme",d?"dark":"light");}catch(e){}})();`;

export function readThemePref(): ThemePref {
  let v: string | null = null;
  try {
    v = localStorage.getItem(THEME_KEY);
  } catch {
    /* sem armazenamento local */
  }
  if (v !== "light" && v !== "dark" && v !== "auto") v = typeof document !== "undefined" ? themeFromCookie(document.cookie) : null;
  return parseThemePref(v);
}

export function applyTheme(pref: ThemePref) {
  const systemDark = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  document.documentElement.setAttribute("data-theme", resolveTheme(pref, systemDark));
}

export function saveThemePref(pref: ThemePref) {
  applyTheme(pref); // na hora
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* navegação privada */
  }
  try {
    document.cookie = `${THEME_KEY}=${pref}; path=/; max-age=31536000; samesite=lax`;
  } catch {
    /* sem cookies */
  }
  // cookie do SERVIDOR: o que sobrevive a fechar/reabrir o app instalado no iPhone
  void fetch("/api/theme", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pref }) }).catch(() => {});
}
