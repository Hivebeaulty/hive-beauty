// Lógica pura das ações em massa na lista de Clientes (sem React nem Supabase),
// para poder ser testada com `node --test`.

export const BULK_CHUNK = 100;

export function chunk<T>(items: T[], size = BULK_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Roda `fn` em todos os itens com no máximo `limit` chamadas ao mesmo tempo,
// mantendo a ordem do resultado. Usado para consultar o histórico de cada
// cliente selecionada sem disparar centenas de requisições de uma vez.
export async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Quem continua selecionada depois de a lista mudar (busca, filtro, recarga):
// só entra quem ainda está visível — nunca uma ação em massa sobre cliente
// que a usuária não está vendo.
export function keepVisibleSelection(selected: ReadonlySet<string>, visibleIds: readonly string[]): Set<string> {
  const visible = new Set(visibleIds);
  const next = new Set<string>();
  selected.forEach((id) => {
    if (visible.has(id)) next.add(id);
  });
  return next;
}

export type HistoryInfo = {
  id: string;
  archived: boolean;
  appointments: number;
  payments: number;
};

export type DeletePlan = {
  // sem atendimentos e sem pagamentos: exclusão definitiva
  toDelete: string[];
  // com histórico e ainda ativas: não podem ser excluídas, viram inativas
  toInactivate: string[];
  // com histórico e já inativas: nada a fazer (o histórico fica preservado)
  untouched: string[];
};

// Mesma regra da exclusão de uma cliente só (components/cliente-remover.tsx),
// que é decidida pelo banco: sem histórico -> exclui; com histórico -> inativa.
export function planBulkDelete(rows: HistoryInfo[]): DeletePlan {
  const plan: DeletePlan = { toDelete: [], toInactivate: [], untouched: [] };
  for (const r of rows) {
    if (r.appointments === 0 && r.payments === 0) plan.toDelete.push(r.id);
    else if (r.archived) plan.untouched.push(r.id);
    else plan.toInactivate.push(r.id);
  }
  return plan;
}

export function plural(n: number, one: string, many: string) {
  return n === 1 ? one : many;
}
