// Importação de contatos por ARQUIVO (iPhone e qualquer outro aparelho):
// reconhece vCard (.vcf) e CSV pelo CONTEÚDO, não pela extensão — o iOS às
// vezes entrega arquivos sem extensão ou com tipo genérico.
import { contactsFromCSV, type ImportedContact } from "./csv";
import { contactsFromVCard, looksLikeVCard } from "./vcard";
import { pickBestPhone } from "./phone";

export function parseContactsFile(text: string): ImportedContact[] {
  return looksLikeVCard(text) ? contactsFromVCard(text) : contactsFromCSV(text);
}

// Vários arquivos de uma vez (ex.: vários .vcf salvos no app Arquivos).
export function parseContactsFiles(texts: string[]): ImportedContact[] {
  return texts.flatMap(parseContactsFile);
}

// Contact Picker (Android/Chrome): cada contato traz uma LISTA de telefones.
export function contactsFromPicker(
  selected: ReadonlyArray<{ name?: string[]; tel?: string[] }>
): ImportedContact[] {
  return selected.map((p) => ({
    name: (p.name?.[0] ?? "").trim(),
    // antes: sempre o 1º telefone. Agora o melhor para WhatsApp; com um único
    // telefone o resultado é idêntico ao de antes.
    phone: pickBestPhone(p.tel ?? []),
    // A API do navegador não expõe aniversário.
    birthDate: null,
  }));
}
