// Monta o palco: CSS do app (Tailwind do próprio projeto) + JS do painel REAL.
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const DIST = join(HERE, "dist");
mkdirSync(DIST, { recursive: true });

execSync(`npx tailwindcss -c tailwind.config.ts -i app/globals.css -o ${join(DIST, "app.css")} --minify`, { cwd: ROOT, stdio: "pipe" });

await build({
  absWorkingDir: ROOT,
  entryPoints: [join(HERE, "harness.tsx")],
  bundle: true,
  outfile: join(DIST, "bundle.js"),
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  tsconfig: join(ROOT, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "error",
  plugins: [
    {
      name: "stub-supabase",
      setup(b) {
        b.onResolve({ filter: /^@\/lib\/supabase\/client$/ }, () => ({ path: join(HERE, "supabase-client-stub.ts") }));
      },
    },
  ],
});

const THEME_SRC = readFileSync(new URL("../../lib/hive/theme.ts", import.meta.url), "utf8");
const THEME_KEY = THEME_SRC.match(/THEME_KEY = "([^"]+)"/)[1];
const bootExpr = THEME_SRC.match(/export const THEME_BOOT_SCRIPT =([\s\S]*?);\n/)[1];
const THEME_BOOT_SCRIPT = new Function("THEME_KEY", "return (" + bootExpr + ")")(THEME_KEY);
writeFileSync(
  join(DIST, "index.html"),
  `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><script>${THEME_BOOT_SCRIPT}</script>
<link rel="stylesheet" href="app.css"><style>/* next/font não carrega offline: aproximação sem serifa, só no palco */:root{--font-sans:ui-sans-serif,system-ui,"DejaVu Sans",sans-serif;--font-serif:Georgia,serif}</style></head><body class="min-h-screen bg-cream font-sans text-ink-800 antialiased"><div id="root"></div><script src="bundle.js"></script></body></html>`
);
console.log("palco montado em", DIST);
