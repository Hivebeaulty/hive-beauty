// Parser de CSV pequeno e sem dependência nova — suficiente pro formato
// simples de importação de clientes (nome, telefone, aniversário opcional).
// Suporta campos entre aspas com vírgula/aspas escapadas (RFC 4180 básico).
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    if (row.some((f) => f.trim() !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      pushField();
    } else if (c === "\n") {
      pushRow();
    } else if (c === "\r") {
      // ignora — trata \r\n como \n
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

export type ImportedContact = { name: string; phone: string; birthDate: string | null };

const NAME_KEYS = ["nome", "name"];
const PHONE_KEYS = ["telefone", "phone", "tel", "celular"];
const BIRTH_KEYS = ["aniversario", "aniversário", "birthday", "nascimento", "data de nascimento"];

function normalizeHeader(h: string) {
  return h
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// Aceita cabeçalho em qualquer ordem/idioma (nome/name, telefone/phone...).
// Se não reconhecer cabeçalho nenhum, assume a ordem fixa nome,telefone,aniversário.
export function contactsFromCSV(text: string): ImportedContact[] {
  const rows = parseCSV(text);
  if (rows.length === 0) return [];

  const header = rows[0].map(normalizeHeader);
  const nameIdx = header.findIndex((h) => NAME_KEYS.includes(h));
  const phoneIdx = header.findIndex((h) => PHONE_KEYS.includes(h));
  const birthIdx = header.findIndex((h) => BIRTH_KEYS.some((k) => normalizeHeader(k) === h));
  const hasRecognizedHeader = nameIdx !== -1 && phoneIdx !== -1;

  const dataRows = hasRecognizedHeader ? rows.slice(1) : rows;
  const [nI, pI, bI] = hasRecognizedHeader ? [nameIdx, phoneIdx, birthIdx] : [0, 1, 2];

  return dataRows
    .map((r) => ({
      name: (r[nI] ?? "").trim(),
      phone: (r[pI] ?? "").trim(),
      birthDate: bI >= 0 ? normalizeBirthDate(r[bI]) : null,
    }))
    .filter((c) => c.name || c.phone);
}

// Aceita DD/MM/AAAA ou AAAA-MM-DD; qualquer outra coisa vira null (melhor
// deixar em branco do que gravar uma data errada).
function normalizeBirthDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const br = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2].padStart(2, "0")}-${br[1].padStart(2, "0")}`;
  return null;
}
