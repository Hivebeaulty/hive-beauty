// ---------------------------------------------------------------------------
// Leitor de vCard (.vcf) — o formato que o iPhone (app Contatos, iCloud) e o
// Android/Google Contatos realmente exportam.
//
// POR QUE EXISTE: o Safari/iOS (e todo navegador no iPhone, que usa WebKit) NÃO
// implementa a Contact Picker API, e a Apple não oferece nenhuma API web para
// ler a agenda. O caminho real no iPhone é por ARQUIVO: "Compartilhar contato" >
// "Salvar em Arquivos" e escolher o .vcf aqui.
//
// Suporta vCard 2.1, 3.0 e 4.0: vários cartões no mesmo arquivo, dobra de linha
// (folding), QUOTED-PRINTABLE com acentos, prefixo de grupo ("item1.TEL"),
// vários TEL por contato e BDAY nos formatos mais comuns. Sem dependência nova.
// ---------------------------------------------------------------------------
import type { ImportedContact } from "./csv";
import { pickBestPhone } from "./phone";

export function looksLikeVCard(text: string): boolean {
  return /BEGIN:VCARD/i.test(text);
}

type Prop = { name: string; params: string[]; value: string };

// 1) Desdobra linhas, em DUAS passagens (a ordem importa):
//    a) QUOTED-PRINTABLE: linha terminada em "=" continua na seguinte e a
//       continuação entra INTEIRA (um espaço no começo dela é conteúdo, não dobra);
//    b) dobra comum (RFC): linha que começa com espaço/tab continua a anterior.
function unfold(text: string): string[] {
  const raw = text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);

  const qpJoined: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    let cur = raw[i];
    const head = cur.slice(0, Math.max(cur.indexOf(":"), 0));
    if (/QUOTED-PRINTABLE/i.test(head)) {
      while (cur.endsWith("=") && i + 1 < raw.length) {
        cur = cur.slice(0, -1) + raw[++i];
      }
    }
    qpJoined.push(cur);
  }

  const out: string[] = [];
  for (const l of qpJoined) {
    if ((l.startsWith(" ") || l.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += l.slice(1);
    } else {
      out.push(l);
    }
  }
  return out;
}

function parseLine(line: string): Prop | null {
  const idx = line.indexOf(":");
  if (idx <= 0) return null;
  const parts = line.slice(0, idx).split(";");
  let name = parts[0].trim().toUpperCase();
  const dot = name.lastIndexOf("."); // "item1.TEL" -> "TEL"
  if (dot >= 0) name = name.slice(dot + 1);
  return { name, params: parts.slice(1).map((p) => p.trim().toUpperCase()), value: line.slice(idx + 1) };
}

function decodeQuotedPrintable(value: string, charset: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(value.slice(i + 1, i + 3))) {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      // caractere comum (ASCII); outros viram UTF-8 para não se perderem
      for (const b of new TextEncoder().encode(ch)) bytes.push(b);
    }
  }
  try {
    return new TextDecoder(charset).decode(new Uint8Array(bytes));
  } catch {
    return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
  }
}

function propText(p: Prop): string {
  let v = p.value;
  if (p.params.some((x) => x.includes("QUOTED-PRINTABLE"))) {
    const cs = p.params.find((x) => x.startsWith("CHARSET="))?.slice(8).toLowerCase() ?? "utf-8";
    v = decodeQuotedPrintable(v, cs);
  }
  return v;
}

// Escapes do vCard: \, \; \\ e \n (vira espaço: nome/telefone não têm quebra)
function unescapeText(v: string): string {
  return v.replace(/\\([,;\\nN])/g, (_m, c: string) => (c === "n" || c === "N" ? " " : c)).trim();
}

// Aceita 1990-03-15, 19900315 e 1990-03-15T00:00:00Z. Sem ano (--0315) ou com
// ano-marcador (1604 etc.) vira null: melhor deixar em branco do que errar.
function parseBirthday(raw: string): string | null {
  const m = raw.trim().match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function cleanTel(v: string): string {
  return v.replace(/^tel:/i, "").trim();
}

export function contactsFromVCard(text: string): ImportedContact[] {
  const contacts: ImportedContact[] = [];
  let card: { fn: string; n: string; tels: string[]; bday: string | null } | null = null;

  for (const line of unfold(text)) {
    const prop = parseLine(line);
    if (!prop) continue;

    if (prop.name === "BEGIN" && /^VCARD$/i.test(prop.value.trim())) {
      card = { fn: "", n: "", tels: [], bday: null };
      continue;
    }
    if (prop.name === "END" && /^VCARD$/i.test(prop.value.trim())) {
      if (card) {
        const name = card.fn || card.n;
        const phone = pickBestPhone(card.tels);
        if (name || phone) contacts.push({ name, phone, birthDate: card.bday });
      }
      card = null;
      continue;
    }
    if (!card) continue;

    switch (prop.name) {
      case "FN":
        if (!card.fn) card.fn = unescapeText(propText(prop));
        break;
      case "N": {
        // N:Sobrenome;Nome;Adicionais;Prefixo;Sufixo
        const parts = propText(prop).split(";").map((x) => unescapeText(x));
        const joined = [parts[1], parts[0]].filter(Boolean).join(" ").trim();
        if (!card.n) card.n = joined;
        break;
      }
      case "TEL": {
        const t = cleanTel(unescapeText(propText(prop)));
        if (t) card.tels.push(t);
        break;
      }
      case "BDAY":
        if (!card.bday) card.bday = parseBirthday(propText(prop));
        break;
    }
  }
  return contacts;
}
