// Substitui next/image no palco (fora do Next, o carregador padrão não funciona).
export default function Image(p: { src: string; alt?: string; width?: number; height?: number; className?: string; priority?: boolean }) {
  return <img src={String(p.src).replace(/^\//, "")} alt={p.alt ?? ""} width={p.width} height={p.height} className={p.className} />;
}
