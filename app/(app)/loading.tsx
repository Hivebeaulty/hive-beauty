import { Skeleton, SkeletonListItem } from "@/components/ui/skeleton";

// Tela de transição entre as abas do app. O Next mostra isto NA HORA em que a
// pessoa toca no menu (e já deixa pré-carregado), enquanto busca a tela nova.
// Sem este arquivo, o toque não dava retorno nenhum até o servidor responder.
// O menu e o cabeçalho continuam fixos; só o conteúdo vira esqueleto.
export default function AppLoading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Carregando">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-9 w-24 rounded-full" />
      </div>
      <Skeleton className="h-28 w-full rounded-xl" />
      <div className="space-y-3">
        <SkeletonListItem />
        <SkeletonListItem />
        <SkeletonListItem />
      </div>
    </div>
  );
}
