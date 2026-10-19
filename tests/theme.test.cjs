// Tema (claro / Grafite / automático): regra pura + script do <head>.
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const t = load("lib/hive/theme.ts");

test("preferência: claro é o padrão; valores desconhecidos viram claro", () => {
  for (const v of [null, undefined, "", "x", "light"]) assert.equal(t.parseThemePref(v), "light");
  assert.equal(t.parseThemePref("dark"), "dark");
  assert.equal(t.parseThemePref("auto"), "auto");
});

test("resolução: Grafite sempre escuro; Automático segue o celular", () => {
  assert.equal(t.resolveTheme("light", true), "light");
  assert.equal(t.resolveTheme("dark", false), "dark");
  assert.equal(t.resolveTheme("auto", true), "dark");
  assert.equal(t.resolveTheme("auto", false), "light");
});

test("script do <head>: aplica a MESMA regra antes de pintar", () => {
  const run = (stored, systemDark, cookie = "") => {
    const attrs = {};
    const ctx = { localStorage: { getItem: () => stored }, window: { matchMedia: () => ({ matches: systemDark }) },
      document: { cookie, documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } } };
    new Function("localStorage", "window", "document", t.THEME_BOOT_SCRIPT)(ctx.localStorage, ctx.window, ctx.document);
    return attrs["data-theme"];
  };
  assert.equal(run(null, true), "light");
  assert.equal(run("dark", false), "dark");
  assert.equal(run("auto", true), "dark");
  assert.equal(run("auto", false), "light");
});

test("applyTheme: escolher Claro / Automático com celular claro deixa CLARO (não fica preso no escuro)", () => {
  const attrs = {};
  global.document = { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } };
  for (const [pref, sysDark, want] of [["light", true, "light"], ["dark", false, "dark"], ["auto", false, "light"], ["auto", true, "dark"]]) {
    global.window = { matchMedia: () => ({ matches: sysDark }) };
    t.applyTheme(pref);
    assert.equal(attrs["data-theme"], want, `${pref} / celular ${sysDark ? "escuro" : "claro"}`);
  }
  delete global.document; delete global.window;
});

test("PERSISTÊNCIA: iPhone apagou o armazenamento local, mas o cookie guarda a escolha", () => {
  const run = (stored, cookie, systemDark = false) => {
    const attrs = {};
    new Function("localStorage", "window", "document", t.THEME_BOOT_SCRIPT)(
      { getItem: () => stored }, { matchMedia: () => ({ matches: systemDark }) },
      { cookie, documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } });
    return attrs["data-theme"];
  };
  assert.equal(run(null, "sb-x=1; aurea-theme=dark; outro=2"), "dark", "reabriu sem armazenamento local: continua escuro");
  assert.equal(run(null, "aurea-theme=light"), "light");
  assert.equal(run(null, "aurea-theme=auto", true), "dark");
  assert.equal(run("light", "aurea-theme=dark"), "light", "o armazenamento local, quando existe, vale");
  assert.equal(run(null, ""), "light", "nunca escolheu: claro (padrão)");
  assert.equal(run(null, "xaurea-theme=dark"), "light", "não confunde com outro cookie");
  assert.equal(t.themeFromCookie("a=1; aurea-theme=dark"), "dark");
  assert.equal(t.themeFromCookie("aurea-theme=roxo"), null);
});
