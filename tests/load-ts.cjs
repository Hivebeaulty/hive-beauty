// Carregador mínimo: transpila um .ts de lib/ para CommonJS em memória, para
// testar a lógica pura com `node --test` sem instalar nenhum runner novo.
// Só funciona com arquivos que importam por caminho RELATIVO (é de propósito
// que lib/hive/{phone,format,relationship,communication}.ts fazem isso).
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const cache = new Map();

function load(file) {
  const abs = path.resolve(file);
  if (cache.has(abs)) return cache.get(abs).exports;
  const src = fs.readFileSync(abs, "utf8");
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  cache.set(abs, mod);
  const localRequire = (spec) => {
    if (spec.startsWith(".")) return load(path.resolve(path.dirname(abs), spec.endsWith(".ts") ? spec : spec + ".ts"));
    return require(spec);
  };
  new Function("exports", "require", "module", "__filename", "__dirname", out)(mod.exports, localRequire, mod, abs, path.dirname(abs));
  return mod.exports;
}

module.exports = { load };
