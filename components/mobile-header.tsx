import Image from "next/image";
import Link from "next/link";

// Barra de app do mobile: logo original (ícone + wordmark, os mesmos arquivos
// da sidebar) sempre visível, fixa no topo enquanto a página rola, com o nome
// do negócio à direita. Altura contida (~52px) para não roubar área útil.
// No desktop a sidebar já cumpre esse papel (md:hidden).
export function MobileHeader({ companyName }: { companyName: string }) {
  return (
    <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-ink-100 bg-cream px-4 pb-2.5 pt-[calc(0.625rem+env(safe-area-inset-top,0px))] md:hidden">
      <Link href="/inicio" aria-label="Áurea — início" className="flex items-center gap-2">
        <Image src="/logo-icon.png" alt="" width={28} height={28} priority />
        <Image src="/logo-wordmark.png" alt="Áurea" width={92} height={22} priority />
      </Link>
      <span className="max-w-[45%] truncate text-xs font-medium text-ink-400">{companyName}</span>
    </header>
  );
}
