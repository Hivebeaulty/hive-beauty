import { clsx, type ClassValue } from "clsx";

// Sem tailwind-merge (evita dependência nova) — para os componentes deste
// design system isso não é um problema porque nenhum consumidor precisa
// sobrescrever classes de cor/espaçamento internas, só adicionar (ex.:
// className="mt-4" em cima de um <Card />).
export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}
