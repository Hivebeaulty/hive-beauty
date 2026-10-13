const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const vc = load("lib/hive/vcard.ts");
const imp = load("lib/hive/contact-import.ts");
const phone = load("lib/hive/phone.ts");

// iPhone: Contatos > Compartilhar contato (vCard 3.0, como o iOS/iCloud gera)
const IOS = [
  "BEGIN:VCARD", "VERSION:3.0", "PRODID:-//Apple Inc.//iPhone OS 17.5//EN",
  "N:Silva;Maria;;;", "FN:Maria Silva",
  "TEL;type=pref;type=CELL;type=VOICE:(11) 99999-0000",
  "TEL;type=HOME;type=VOICE:(11) 3222-1234",
  "BDAY:1990-03-15",
  "PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/",
  " 2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/",
  "END:VCARD", ""].join("\r\n");

// Android antigo: vCard 2.1 com acentos em QUOTED-PRINTABLE e linha longa quebrada
const ANDROID21 = [
  "BEGIN:VCARD", "VERSION:2.1",
  "N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Concei=C3=A7=C3=A3o;Jos=C3=A9;;;",
  "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Jos=C3=A9 Concei=C3=A7=C3=A3o=",
  " da Silva",
  "TEL;CELL:11 98888-7777",
  "END:VCARD"].join("\n");

test("vCard do iPhone: nome, celular preferido (não o fixo) e aniversário", () => {
  const [c] = vc.contactsFromVCard(IOS);
  assert.equal(c.name, "Maria Silva");
  assert.equal(c.phone, "(11) 99999-0000");           // celular escolhido, mesmo o fixo vindo depois
  assert.equal(c.birthDate, "1990-03-15");
});

test("vCard 2.1 do Android: QUOTED-PRINTABLE com acentos e dobra de linha", () => {
  const [c] = vc.contactsFromVCard(ANDROID21);
  assert.equal(c.name, "José Conceição da Silva");
  assert.equal(c.phone, "11 98888-7777");
});

test("vários cartões no mesmo arquivo + grupo item1.TEL + prefixo tel:", () => {
  const text = [
    "BEGIN:VCARD", "VERSION:3.0", "FN:Ana", "item1.TEL;type=CELL:+55 31 99999-9999", "END:VCARD",
    "BEGIN:VCARD", "VERSION:4.0", "FN:Bia", "TEL;VALUE=uri;TYPE=cell:tel:+55-21-98888-7777", "END:VCARD",
    "BEGIN:VCARD", "VERSION:3.0", "FN:Sem Telefone", "END:VCARD",
  ].join("\r\n");
  const cs = vc.contactsFromVCard(text);
  assert.deepEqual(cs.map((c) => c.name), ["Ana", "Bia", "Sem Telefone"]);
  assert.equal(phone.normalizeBrazilPhone(cs[0].phone), "5531999999999");
  assert.equal(phone.normalizeBrazilPhone(cs[1].phone), "5521988887777");
  assert.equal(cs[2].phone, "");
});

test("nome vem de N quando não há FN; escapes e BOM", () => {
  const text = "\uFEFFBEGIN:VCARD\nVERSION:3.0\nN:Souza\\, Jr.;Joana;;;\nTEL:11977776666\nEND:VCARD\n";
  const [c] = vc.contactsFromVCard(text);
  assert.equal(c.name, "Joana Souza, Jr.");
  assert.equal(c.phone, "11977776666");
});

test("aniversário: aceita 3 formatos; descarta sem ano, ano-marcador e datas inválidas", () => {
  const bd = (v) => vc.contactsFromVCard(`BEGIN:VCARD\nFN:X\nBDAY:${v}\nEND:VCARD`)[0].birthDate;
  assert.equal(bd("1990-03-15"), "1990-03-15");
  assert.equal(bd("19900315"), "1990-03-15");
  assert.equal(bd("1990-03-15T00:00:00Z"), "1990-03-15");
  assert.equal(bd("--0315"), null);
  assert.equal(bd("1604-03-15"), null);
  assert.equal(bd("1990-13-40"), null);
});

test("vários telefones: escolhe celular válido; sem celular, o 1º válido; senão o 1º texto", () => {
  assert.equal(phone.pickBestPhone(["(11) 3222-1234", "(11) 99999-0000"]), "(11) 99999-0000");
  assert.equal(phone.pickBestPhone(["(11) 3222-1234", "123"]), "(11) 3222-1234");
  assert.equal(phone.pickBestPhone(["ramal 5", "123"]), "ramal 5");
  assert.equal(phone.pickBestPhone([]), "");
  assert.equal(phone.pickBestPhone([null, undefined, "  "]), "");
  // um único telefone: sempre ele (comportamento anterior do Android preservado)
  assert.equal(phone.pickBestPhone(["11999990000"]), "11999990000");
  assert.equal(phone.pickBestPhone(["(11) 3222-1234"]), "(11) 3222-1234");
});

test("Contact Picker (Android): nome, melhor telefone, sem aniversário", () => {
  const out = imp.contactsFromPicker([
    { name: ["Maria Silva"], tel: ["11999990000"] },                      // igual ao comportamento antigo
    { name: ["Joana"], tel: ["(11) 3222-1234", "(11) 98888-7777"] },      // agora escolhe o celular
    { tel: ["11977776666"] },                                             // sem nome
    { name: ["Sem fone"] },
  ]);
  assert.equal(out[0].phone, "11999990000");
  assert.equal(out[1].phone, "(11) 98888-7777");
  assert.equal(out[2].name, "");
  assert.equal(out[3].phone, "");
  assert.ok(out.every((c) => c.birthDate === null));
});

test("arquivo é reconhecido pelo CONTEÚDO: vCard ou CSV (iOS pode entregar sem extensão)", () => {
  assert.equal(imp.parseContactsFile(IOS)[0].name, "Maria Silva");
  const csv = "nome,telefone,aniversario\nMaria Silva,11999990000,15/03/1990\n";
  const [c] = imp.parseContactsFile(csv);
  assert.equal(c.name, "Maria Silva");
  assert.equal(c.birthDate, "1990-03-15");
  // vários arquivos de uma vez, de tipos diferentes
  const all = imp.parseContactsFiles([IOS, ANDROID21, csv]);
  assert.equal(all.length, 3);
});

test("vCard: telefone inválido e duplicado seguem para a revisão com o texto original", () => {
  const text = "BEGIN:VCARD\nFN:Ruim\nTEL:12345\nEND:VCARD\nBEGIN:VCARD\nFN:Maria Silva 2\nTEL:+55 11 99999-0000\nEND:VCARD";
  const cs = vc.contactsFromVCard(text);
  assert.equal(cs[0].phone, "12345");                                    // mantido; a tela marca "telefone inválido"
  assert.equal(phone.normalizeBrazilPhone(cs[1].phone), phone.normalizeBrazilPhone("(11) 99999-0000")); // mesma pessoa => duplicidade
});

test("arquivo sem nada reconhecível não gera contatos", () => {
  assert.deepEqual(vc.contactsFromVCard("isso não é um vcard"), []);
  assert.deepEqual(imp.parseContactsFile(""), []);
});

test("link do WhatsApp com texto pré-preenchido (codificado) e sem texto", () => {
  const base = "https://wa.me/5511999990000";
  assert.equal(phone.whatsappChatLink("(11) 99999-0000"), base);
  assert.equal(phone.whatsappChatLink("(11) 99999-0000", null, "Oi, Ana!\nÀs 14h"), base + "?text=" + encodeURIComponent("Oi, Ana!\nÀs 14h"));
  assert.equal(phone.whatsappChatLink("(11) 3222-1234", null, "oi"), null);     // fixo: sem link
  assert.equal(phone.whatsappChatLink("123", null, "oi"), null);                // inválido: sem link
  assert.equal(phone.whatsappChatLink(null, null, "oi"), null);
  assert.equal(phone.whatsappChatLink("(11) 99999-0000", null, "   "), base);   // texto vazio = sem ?text
});
