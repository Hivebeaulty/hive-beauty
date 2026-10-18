// Ilustrações da Áurea em traço fino (fine line art) — desenhos ORIGINAIS no
// estilo da referência visual: figura feminina de perfil, traço único orgânico,
// disco suave (rosé / pêssego), poucas estrelas douradas.
// Claro: traço caramelo/dourado sobre rosé. Escuro: traço dourado suave sobre café.
// Use só em estados vazios / boas-vindas, uma por tela.
import { cn } from "@/lib/utils";

export type IllustrationKind = "perfil" | "pensativa" | "ramo";

// rosto de perfil (testa, nariz, lábios, queixo) e pescoço/ombro — base comum
const FACE =
  "M84 33 C90 37 93 44 93 51 C94 55 96 59 98 62 C96.5 63.5 94.5 64 93.5 64.5 C94.6 66 94.3 67.3 93 68 C94 69.6 93.6 71.5 92 72.5 C91.2 76 88.5 79 84 80.5";
const NECK = "M84 80.5 C83.5 86 84 92 86.5 96 C92 101 102 104 117 106";
const EYE = "M85.5 50.5 C87 52 89 52.3 90.8 51.4";
const SPARK = (x: number, y: number, r: number) => {
  const k = r * 0.18;
  return `M${x} ${y - r} C${x + k} ${y - k} ${x + k} ${y - k} ${x + r} ${y} C${x + k} ${y + k} ${x + k} ${y + k} ${x} ${y + r} C${x - k} ${y + k} ${x - k} ${y + k} ${x - r} ${y} C${x - k} ${y - k} ${x - k} ${y - k} ${x} ${y - r} Z`;
};

const HAIR_LONG = [
  "M84 33 C74 25.5 58 29 51.5 43 C46 55 51.5 66 49.5 78 C47.5 90 41.5 99 45.5 110 C48 116 55 119.5 63 118",
  "M71 35.5 C62.5 43 62 55 64 65.5 C66 76.5 60.5 86.5 58.5 97",
  "M78 38 C71.5 47 72.5 58 75.5 66",
];
const HAIR_BUN = [
  "M84 33 C76 28.5 66 30 60 36.5 C54.5 43 54.5 53 58 61 C61 68 66.5 74 72 77",
  "M60 36.5 C55 31 56.5 23.5 63 21.5 C69.5 19.5 75 24 74.5 30",
  "M64 26 C66.5 24.5 69.5 25 71 27.5",
  "M76 38.5 C70.5 45 70.5 54 73.5 61",
];

export function LineIllustration({
  kind = "perfil",
  className,
  title,
}: {
  kind?: IllustrationKind;
  className?: string;
  title?: string;
}) {
  const hair = kind === "ramo" ? HAIR_BUN : HAIR_LONG;
  return (
    <svg
      viewBox="0 0 160 136"
      className={cn("h-32 w-auto", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      data-illustration={kind}
    >
      <circle
        cx="80"
        cy="72"
        r="54"
        className={cn(kind === "ramo" ? "fill-[#F3E2D3]" : "fill-[#F1DFD8]", "dark:fill-[#2E241F]")}
      />
      <g fill="none" className="stroke-[#9C7048] dark:stroke-[#D8B88A]" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
        {hair.map((d) => (
          <path key={d} d={d} />
        ))}
        <path d={FACE} />
        <path d={kind === "pensativa" ? "M84 80.5 C83.5 86 84 92 86.5 96 C87.5 96.8 88.3 97.2 89 97.4" : NECK} />
        <path d={EYE} />
        {kind === "pensativa" && (
          <>
            {/* mão apoiando o queixo: dedos dobrados ao longo da mandíbula, palma e antebraço */}
            <path d="M88.5 76 C92.5 75.5 96.5 77.5 98.5 81" />
            <path d="M90.5 80 C94 80 96.8 82 98.2 85.2" />
            <path d="M98.5 81 C101 86 100.5 92 96.5 97" />
            <path d="M96.5 97 C101 105 106 113 112 121" />
            <path d="M89 96.5 C92.5 105 96.5 113 101.5 122" />
          </>
        )}
        {kind === "ramo" && (
          <>
            <path d="M118 124 C113 108 115 92 124 78" />
            <path d="M116.5 110 C110 108 106.5 103 106.5 98 C112 99 116 103.5 116.5 110 Z" />
            <path d="M118.5 96 C124.5 94.5 128.5 90 129 85 C123.5 86 119.5 90.5 118.5 96 Z" />
            <path d="M120 86 C114.5 84 112 79.5 112.5 75 C117.5 76.5 120.5 80.5 120 86 Z" />
          </>
        )}
      </g>
      <g className="fill-[#C9A876] dark:fill-[#D8B88A]">
        <path d={SPARK(106, 28, 7)} />
        <path d={SPARK(38, 52, 4)} />
        <path d={SPARK(122, 54, 2.6)} className="opacity-70" />
      </g>
    </svg>
  );
}
