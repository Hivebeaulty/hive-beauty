// Cadastro livre desligado: a conta agora nasce da assinatura (Mercado Pago ->
// mp-webhook cria a usuária e envia o e-mail para criar a senha). Quem tiver o
// link antigo /cadastro salvo vai para a landing, onde está o checkout.
import { redirect } from "next/navigation";
import { LANDING_URL } from "@/lib/hive/access";

export default function CadastroPage() {
  redirect(LANDING_URL);
}
