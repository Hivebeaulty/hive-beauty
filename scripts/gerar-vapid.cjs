// Gera o par de chaves VAPID (Web Push) só com o Node, sem instalar nada.
// Uso: node scripts/gerar-vapid.cjs
// A chave PRIVADA é um segredo: guarde só nos segredos do Supabase. Nunca no repositório, em chat ou e-mail.
const { generateKeyPairSync } = require("node:crypto");

const pad32 = (b) => (b.length >= 32 ? b : Buffer.concat([Buffer.alloc(32 - b.length), b]));
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pub = publicKey.export({ format: "jwk" });
const priv = privateKey.export({ format: "jwk" });

const publicB64 = Buffer.concat([
  Buffer.from([4]),
  pad32(Buffer.from(pub.x, "base64url")),
  pad32(Buffer.from(pub.y, "base64url")),
]).toString("base64url");
const privateB64 = pad32(Buffer.from(priv.d, "base64url")).toString("base64url");

console.log("");
console.log("VAPID_PUBLIC_KEY  (pública: vai no Supabase e na Vercel como NEXT_PUBLIC_VAPID_PUBLIC_KEY)");
console.log(publicB64);
console.log("");
console.log("VAPID_PRIVATE_KEY (SECRETA: só nos segredos do Supabase)");
console.log(privateB64);
console.log("");
