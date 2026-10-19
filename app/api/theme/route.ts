// Guarda a escolha de tema num cookie do SERVIDOR (1 ano). O armazenamento local
// do navegador é apagado pelo iPhone em apps instalados na tela inicial; o cookie
// permanece, e o servidor já desenha a página no tema certo (sem "piscar").
import { NextResponse } from "next/server";
import { THEME_KEY, parseThemePref } from "@/lib/hive/theme";

export async function POST(req: Request) {
  let pref = "light";
  try {
    pref = parseThemePref((await req.json())?.pref);
  } catch {
    /* corpo inválido: claro */
  }
  const res = NextResponse.json({ ok: true, pref });
  res.cookies.set(THEME_KEY, pref, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax", secure: true, httpOnly: false });
  return res;
}
