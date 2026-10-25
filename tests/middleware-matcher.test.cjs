// Quais caminhos passam pelo middleware de login (matcher do Next).
// Arquivos estáticos de /public (imagens, manifest e o guia em PDF dos e-mails) precisam
// abrir SEM login; as páginas do app continuam protegidas.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "middleware.ts"), "utf8");
const raw = src.match(/matcher:\s*\[\s*"([^"]+)"/)[1];
// No arquivo TS, "\\\\." vira "\\." na string; o Next transforma o padrão em ^padrão$.
const re = new RegExp("^" + raw.replace(/\\\\/g, "\\") + "$");
const protegido = (p) => re.test(p);

test("o guia em PDF (link dos e-mails) abre sem login", () => {
  assert.equal(protegido("/guia-aurea.pdf"), false);
});
test("imagens, manifest e ícones abrem sem login", () => {
  for (const p of ["/logo-lockup.png", "/illustrations/agenda-vazia-claro.webp", "/manifest.webmanifest", "/favicon.ico", "/icon-512.png"]) {
    assert.equal(protegido(p), false, p);
  }
});
test("as páginas do app continuam protegidas", () => {
  for (const p of ["/", "/agenda", "/clientes", "/admin/financeiro", "/guia-aurea", "/assinatura"]) {
    assert.equal(protegido(p), true, p);
  }
});
