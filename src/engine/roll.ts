import type { RollTable, TableOption } from "../types";

function totalWeight(options: TableOption[]): number {
  return options.reduce((s, o) => s + (o.weight ?? 1), 0);
}

export type RollTableSubset = {
  /** Inclusive 0-based indices; when set, roll only within this subset */
  onlyIndices?: ReadonlySet<number>;
  excludeIndices?: ReadonlySet<number>;
};

function subsetOptions(table: RollTable, subset?: RollTableSubset): { opts: TableOption[]; indexMap: number[] } {
  const opts = table.options;
  if (!subset || (!subset.onlyIndices?.size && !subset.excludeIndices?.size)) {
    return { opts, indexMap: opts.map((_, i) => i) };
  }
  const indexMap: number[] = [];
  const out: TableOption[] = [];
  for (let i = 0; i < opts.length; i++) {
    if (subset.excludeIndices?.has(i)) continue;
    if (subset.onlyIndices?.size && !subset.onlyIndices.has(i)) continue;
    out.push(opts[i]);
    indexMap.push(i);
  }
  if (out.length === 0) throw new Error(`Table "${table.name}" has no options after filter`);
  return { opts: out, indexMap };
}

export function rollTableOption(table: RollTable): { option: TableOption; index: number } {
  const opts = table.options;
  if (opts.length === 0) throw new Error(`Table "${table.name}" has no options`);
  const t = totalWeight(opts);
  let r = Math.random() * t;
  for (let i = 0; i < opts.length; i++) {
    const w = opts[i].weight ?? 1;
    if (r < w) return { option: opts[i], index: i };
    r -= w;
  }
  return { option: opts[opts.length - 1], index: opts.length - 1 };
}

export function rollTableOptionSubset(
  table: RollTable,
  subset?: RollTableSubset): { option: TableOption; index: number } {
  const { opts, indexMap } = subsetOptions(table, subset);
  if (opts.length === 0) throw new Error(`Table "${table.name}" has no options`);
  const t = totalWeight(opts);
  let r = Math.random() * t;
  for (let i = 0; i < opts.length; i++) {
    const w = opts[i].weight ?? 1;
    if (r < w) return { option: opts[i], index: indexMap[i] };
    r -= w;
  }
  const last = opts.length - 1;
  return { option: opts[last], index: indexMap[last] };
}
