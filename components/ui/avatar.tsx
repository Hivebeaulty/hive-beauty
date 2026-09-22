import { cn } from "@/lib/utils";

// Paleta de fundo para as iniciais — tons da própria família ink/gold,
// nunca cores aleatórias saturadas. Escolhida de forma determinística a
// partir do nome, então a mesma cliente sempre cai na mesma cor.
const TINTS = [
  "bg-gold-100 text-gold-700",
  "bg-ink-100 text-ink-700",
  "bg-gold-50 text-gold-600",
  "bg-ink-50 text-ink-600",
];

function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function tintFor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return TINTS[hash % TINTS.length];
}

const SIZE_CLASSES = {
  sm: "size-8 text-xs",
  md: "size-10 text-sm",
  lg: "size-14 text-base",
};

export interface AvatarProps {
  name: string;
  src?: string | null;
  size?: keyof typeof SIZE_CLASSES;
  className?: string;
}

// Usado no lugar de imagem genérica. Sem foto -> iniciais elegantes.
// A busca automática de foto via Instagram não é implementada (ver
// auditoria — a API oficial exige conta Business + OAuth por cliente,
// não é viável aqui); isto já prevê um `src` manual para o futuro.
export function Avatar({ name, src, size = "md", className }: AvatarProps) {
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={src}
        alt={name}
        className={cn("rounded-full object-cover", SIZE_CLASSES[size], className)}
      />
    );
  }
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-full font-semibold",
        SIZE_CLASSES[size],
        tintFor(name),
        className
      )}
      aria-hidden="true"
    >
      {initialsOf(name)}
    </div>
  );
}
