export interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}

// Substitui o padrão "<h1 className='text-2xl font-bold ...'>" + botão
// repetido no topo de cada tela (agenda, clientes, financeiro...).
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-ink-800 sm:text-2xl">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-ink-400">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
