// Painel "Hoje" do início: o ponto de foco da tela (cartão em cacau).
// Só apresentação — a página busca os números e passa por props.
//
// Disposição (corrige a sobreposição no celular):
//   estreito  | R$ 12.345,67          |   valor recebido na linha inteira
//             | 8 atend.  | 14 próx.  |   contagens lado a lado
//   >= sm     | R$ 12.345,67 | 8 | 14 |   três colunas, a do valor mais larga
// Sem quem veja o financeiro: só as duas contagens, lado a lado.
import { Card } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { formatMoney } from "@/lib/hive/format";
import { UPCOMING_DAYS } from "@/lib/hive/dashboard";
import { cn } from "@/lib/utils";

export interface TodaySummaryProps {
  loading: boolean;
  canSeeFinance: boolean;
  received: number | null | undefined;
  appointmentsToday: number;
  upcoming: number;
  dateLabel: string;
}

function Placeholder({ wide }: { wide?: boolean }) {
  return (
    <div className="space-y-2" aria-hidden="true">
      <div className={cn("h-8 animate-pulse rounded bg-feature-line", wide ? "w-40" : "w-12")} />
      <div className="h-3 w-20 animate-pulse rounded bg-feature-line" />
    </div>
  );
}

export function TodaySummary({ loading, canSeeFinance, received, appointmentsToday, upcoming, dateLabel }: TodaySummaryProps) {
  return (
    <Card tone="feature" className="p-5 sm:p-6" data-testid="today-summary">
      <div className="mb-5 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-feature-ink">Hoje</h2>
        <span className="truncate text-xs text-feature-soft">{dateLabel.charAt(0).toUpperCase() + dateLabel.slice(1)}</span>
      </div>

      <div
        className={cn(
          "grid gap-x-5 gap-y-6",
          canSeeFinance ? "grid-cols-2 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)]" : "grid-cols-2"
        )}
      >
        {canSeeFinance && (
          <div className="col-span-2 min-w-0 border-b border-feature-line pb-5 sm:col-span-1 sm:border-b-0 sm:border-r sm:pb-0 sm:pr-5">
            {loading ? <Placeholder wide /> : <Stat size="lg" onDark accent value={formatMoney(received)} label="Recebido hoje" />}
          </div>
        )}
        {loading ? (
          <Placeholder />
        ) : (
          <Stat onDark value={appointmentsToday} label={appointmentsToday === 1 ? "Atendimento hoje" : "Atendimentos hoje"} />
        )}
        {loading ? (
          <Placeholder />
        ) : (
          <Stat onDark value={upcoming} label="Próximos atendimentos" hint={`nos próximos ${UPCOMING_DAYS} dias`} />
        )}
      </div>
    </Card>
  );
}
