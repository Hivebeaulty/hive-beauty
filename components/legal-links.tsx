// Links para os Termos de Uso e a Política de Privacidade (publicados no site da Áurea).
import { PRIVACY_URL, TERMS_URL } from "@/lib/hive/access";
import { cn } from "@/lib/utils";

export function LegalLinks({ className }: { className?: string }) {
  return (
    <p className={cn("text-center text-xs text-ink-500", className)}>
      <a href={TERMS_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-ink-800">Termos de Uso</a>
      {" · "}
      <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-ink-800">Política de Privacidade</a>
    </p>
  );
}
