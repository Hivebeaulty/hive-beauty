// Ilustração em traço fino (design system "Áurea"): mulher em perfil sereno,
// cabelo em onda, e a estrela de quatro pontas do logotipo. Desenho original.
// Traço único dourado (gold) sobre disco rosé (rose); acompanha o tema pelas
// cores do Tailwind. Só em estados vazios / boas-vindas, uma por tela.
import { cn } from "@/lib/utils";

export function LineIllustration({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 120 120"
      className={cn("size-28", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <circle cx="60" cy="62" r="46" className="fill-[#EFDDD6] dark:fill-gold-50" />
      <g fill="none" className="stroke-gold-600" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        {/* perfil: testa, nariz, lábios, queixo */}
        <path d="M66 33 C71 35 74 39 74.5 44 C75 47 77 50 79.5 53 C78.5 54.5 77 55 76 55.5 C77 57 76.6 58.4 75.4 59 C76.2 60.6 75.6 62.4 73.8 63.4 C71.6 66.2 68.4 67.6 65 67.6" />
        {/* pescoço e ombro */}
        <path d="M65.5 67.6 L65.5 77 C66.5 82 73 85.5 86 88" />
        {/* cabelo: contorno da cabeça caindo em onda pelas costas */}
        <path d="M66 33 C55 29 43.5 35.5 42 48 C40.6 59 46.5 66 43 77 C40.6 84.5 43.5 90 49 93" />
        <path d="M60 38.5 C52 44 51.5 54 53.5 62 C55.2 69 51.5 75 49.5 80" />
        <path d="M49 93 C44 95.5 40 99 38 104" />
        {/* olho fechado, sereno */}
        <path d="M68.6 47.6 C69.8 48.6 71.2 48.8 72.4 48" />
      </g>
      {/* a estrela de quatro pontas do logotipo */}
      <path
        d="M90 22 C91.2 28.4 92.6 29.8 99 31 C92.6 32.2 91.2 33.6 90 40 C88.8 33.6 87.4 32.2 81 31 C87.4 29.8 88.8 28.4 90 22 Z"
        className="fill-gold-500"
      />
    </svg>
  );
}
