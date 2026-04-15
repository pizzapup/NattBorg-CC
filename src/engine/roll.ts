import type { RollTable, TableOption } from "../types";

function totalWeight(options: TableOption[]): number {
  return options.reduce((s, o) => s + (o.weight ?? 1), 0);
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
