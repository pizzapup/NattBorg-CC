import type {
  DiceBinOp,
  DiceCombineStep,
  DicePipeline,
  DiceRollStage,
  RandomDicePreset,
  RpgSystem,
  StatGenerationMethod,
  StatModifier,
  StatModifierDerive,
  StatPostProcess,
} from "../types";
import { evaluateDiceFormula } from "./diceFormula";

const perm = "permanent" as const;

/** Migrated from removed `nattborg_lesser` method / preset (same math as the old special-case). */
export const LEGACY_NATTBORG_LESSER_PIPELINE: DicePipeline = {
  stages: [
    { dice: 2, sides: 4, label: "2d4", use: { kind: "all" }, aggregate: "min" },
    { dice: 2, sides: 6, label: "2d6", use: { kind: "all" }, aggregate: "min" },
  ],
  combine: { left: 1, right: 0, op: "sub" },
};

function d(sides: number): number {
  return Math.floor(Math.random() * sides) + 1;
}

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
}

export const DEFAULT_POINT_BUY_COSTS: Record<number, number> = {
  8: 0,
  9: 1,
  10: 2,
  11: 3,
  12: 4,
  13: 5,
  14: 7,
  15: 9,
};

function mergeCosts(base: Record<number, number>, partial?: Partial<Record<number, number>>): Record<number, number> {
  if (!partial) return { ...base };
  const out = { ...base };
  for (const [k, v] of Object.entries(partial)) {
    const score = Number(k);
    if (!Number.isFinite(score) || !Number.isFinite(v)) continue;
    out[score] = Math.floor(v as number);
  }
  return out;
}

function costForScore(score: number, costs: Record<number, number>): number {
  const c = costs[score];
  return c === undefined ? 9999 : c;
}

/** Try to build `nStats` scores with total point cost === budget. */
function randomValidPointBuyScores(
  nStats: number,
  budget: number,
  minScore: number,
  maxScore: number,
  costs: Record<number, number>
): number[] | null {
  const out: number[] = new Array(nStats).fill(minScore);
  const choices: number[] = [];
  for (let s = minScore; s <= maxScore; s++) choices.push(s);

  function bt(idx: number, spent: number): boolean {
    if (idx === nStats) return spent === budget;
    const opts = [...choices];
    shuffleInPlace(opts);
    for (const s of opts) {
      const c = costForScore(s, costs);
      if (c > 9998 || spent + c > budget) continue;
      out[idx] = s;
      if (bt(idx + 1, spent + c)) return true;
    }
    return false;
  }

  for (let attempt = 0; attempt < 80; attempt++) {
    if (bt(0, 0)) return out;
  }
  return null;
}

export function dicePipelineFromPreset(preset: RandomDicePreset): DicePipeline {
  switch (preset) {
    case "4d6_drop_lowest":
      return {
        stages: [{ dice: 4, sides: 6, use: { kind: "highest", k: 3 }, aggregate: "sum" }],
      };
    case "3d6":
      return {
        stages: [{ dice: 3, sides: 6, use: { kind: "all" }, aggregate: "sum" }],
      };
    case "2d6_plus_6":
      return {
        stages: [{ dice: 2, sides: 6, use: { kind: "all" }, aggregate: "sum" }],
        postOffset: 6,
      };
    default:
      return dicePipelineFromPreset("4d6_drop_lowest");
  }
}

function resolvePipeline(method: Extract<StatGenerationMethod, { kind: "random_dice" }>): DicePipeline {
  if (method.pipeline?.stages?.length) return method.pipeline;
  const preset = method.preset ?? "4d6_drop_lowest";
  return dicePipelineFromPreset(preset);
}

function rollStage(stage: DiceRollStage, verbose: boolean): { value: number; short: string; long: string } {
  const rolls: number[] = [];
  for (let i = 0; i < stage.dice; i++) rolls.push(d(stage.sides));
  const sorted = [...rolls].sort((a, b) => a - b);
  let picked: number[];
  let pickDesc: string;
  if (stage.use.kind === "all") {
    picked = rolls;
    pickDesc = `[${rolls.join(",")}]`;
  } else if (stage.use.kind === "highest") {
    const k = stage.use.k;
    const hi = sorted.slice(-k).reverse();
    picked = hi;
    pickDesc = `highest ${k} of [${sorted.join(",")}] → [${hi.join(",")}]`;
  } else {
    const k = stage.use.k;
    const lo = sorted.slice(0, k);
    picked = lo;
    pickDesc = `lowest ${k} of [${sorted.join(",")}] → [${lo.join(",")}]`;
  }
  let value: number;
  if (stage.aggregate === "sum") value = picked.reduce((a, b) => a + b, 0);
  else if (stage.aggregate === "min") value = Math.min(...picked);
  else value = Math.max(...picked);

  const label = stage.label ?? `${stage.dice}d${stage.sides}`;
  const short = `${label} → ${value}`;
  const long = `${label}: rolled ${pickDesc}; ${stage.aggregate} = ${value}`;
  return { value, short: verbose ? long : short, long };
}

function diceBinOp(L: number, R: number, op: DiceBinOp): number {
  switch (op) {
    case "add":
      return L + R;
    case "sub":
      return L - R;
    case "mul":
      return L * R;
    case "div":
      return R === 0 ? L : Math.trunc(L / R);
    default:
      return L;
  }
}

function combineStepsFromPipeline(p: DicePipeline): DiceCombineStep[] {
  if (p.combines?.length) return p.combines;
  if (p.combine) return [{ left: p.combine.left, right: p.combine.right, op: p.combine.op }];
  return [];
}

function isPairCombineStep(s: DiceCombineStep): s is { left: number; right: number; op: DiceBinOp } {
  return "left" in s && typeof (s as { left?: number }).left === "number";
}

function applyCombineSteps(
  stageValues: number[],
  steps: DiceCombineStep[],
  verbose: boolean,
  lines: string[]
): number {
  if (!steps.length) return stageValues[stageValues.length - 1] ?? 0;
  const first = steps[0]!;
  if (!isPairCombineStep(first)) {
    return stageValues[stageValues.length - 1] ?? 0;
  }
  let acc = diceBinOp(
    stageValues[first.left] ?? 0,
    stageValues[first.right] ?? 0,
    first.op
  );
  lines.push(
    verbose
      ? `Combine stage ${first.left + 1} (${stageValues[first.left] ?? 0}) ${first.op} stage ${first.right + 1} (${stageValues[first.right] ?? 0}) = ${acc}`
      : `→ ${acc}`
  );
  for (let i = 1; i < steps.length; i++) {
    const st = steps[i]!;
    const Rval = stageValues[st.right] ?? 0;
    const prev = acc;
    if (isPairCombineStep(st)) {
      acc = diceBinOp(stageValues[st.left] ?? 0, stageValues[st.right] ?? 0, st.op);
      lines.push(
        verbose
          ? `Combine stage ${st.left + 1} (${stageValues[st.left] ?? 0}) ${st.op} stage ${st.right + 1} (${Rval}) = ${acc}`
          : `→ ${acc}`
      );
    } else {
      acc = diceBinOp(prev, Rval, st.op);
      lines.push(
        verbose
          ? `Then ${st.op} stage ${st.right + 1} (${Rval}): ${prev} ${st.op} ${Rval} = ${acc}`
          : `${st.op} st${st.right + 1} → ${acc}`
      );
    }
  }
  return acc;
}

function runPipeline(
  pipeline: DicePipeline,
  verbose: boolean
): { value: number; lines: string[] } {
  const lines: string[] = [];
  const stageValues: number[] = [];
  for (let i = 0; i < pipeline.stages.length; i++) {
    const st = pipeline.stages[i]!;
    const { value, short, long } = rollStage(st, verbose);
    stageValues.push(value);
    lines.push(verbose ? long : short);
  }
  const cSteps = combineStepsFromPipeline(pipeline);
  let value =
    stageValues.length === 0
      ? 0
      : cSteps.length >= 1 && isPairCombineStep(cSteps[0]!)
        ? applyCombineSteps(stageValues, cSteps, verbose, lines)
        : stageValues[stageValues.length - 1]!;

  const off = pipeline.postOffset ?? 0;
  if (off !== 0) {
    const prev = value;
    value += off;
    lines.push(verbose ? `Add offset ${off >= 0 ? "+" : ""}${off}: ${prev} → ${value}` : `+ ${off} → ${value}`);
  }
  return { value, lines };
}

export type StatGenResult = {
  statValues: Record<string, number>;
  statBreakdown: StatModifier[];
  statRollLog: string[];
};

/** Core stats = rows without <code>extra.parentStatId</code> (sub-stats/skills are derived rows). */
function isCoreStatRow(s: RpgSystem["stats"][number]): boolean {
  const p = s.extra?.parentStatId;
  return p === undefined || p === null || String(p).trim() === "";
}

export function applyStatGeneration(
  sys: RpgSystem,
  method: StatGenerationMethod,
  verbose: boolean
): StatGenResult {
  const statRollLog: string[] = [];
  const statBreakdown: StatModifier[] = [];
  const statValues: Record<string, number> = {};

  const stats = sys.stats;
  const coreStats = stats.filter(isCoreStatRow);
  const derivedStats = stats.filter((s) => !isCoreStatRow(s));

  function fillDerivedFromDefaults(sourceLabel: string): void {
    for (const s of derivedStats) {
      statValues[s.id] = s.defaultValue;
      statBreakdown.push({
        statId: s.id,
        amount: s.defaultValue,
        source: sourceLabel,
        scope: perm,
      });
    }
  }

  if (method.kind === "fixed_defaults") {
    for (const s of stats) {
      statValues[s.id] = s.defaultValue;
      statBreakdown.push({
        statId: s.id,
        amount: s.defaultValue,
        source: "Starting value",
        scope: perm,
      });
    }
    return { statValues, statBreakdown, statRollLog };
  }

  if (method.kind === "standard_array") {
    const vals = method.values;
    const desc = method.description?.trim();
    const pool = vals.map((x) => Math.floor(x)).filter((n) => Number.isFinite(n));
    shuffleInPlace(pool);
    if (derivedStats.length) {
      statRollLog.push(
        `Sub-stats / skills (${derivedStats.length}): left at row defaults; array applies to ${coreStats.length} core stat(s) only.`
      );
    }
    statRollLog.push(
      `Standard array: ${pool.length} value(s) are shuffled and assigned in random order to core stats (not locked to table row order).${desc ? ` Note: ${desc}` : ""}`
    );
    for (let i = 0; i < coreStats.length; i++) {
      const s = coreStats[i]!;
      const v = pool[i] !== undefined ? pool[i]! : s.defaultValue;
      statValues[s.id] = v;
      statBreakdown.push({
        statId: s.id,
        amount: v,
        source: pool[i] !== undefined ? "Standard array (shuffled)" : "Standard array (fallback: row default)",
        scope: perm,
      });
    }
    fillDerivedFromDefaults("Sub-stat (not in array)");
    if (pool.length < coreStats.length) {
      statRollLog.push(
        `Note: only ${pool.length} array value(s) for ${coreStats.length} core stat(s); extra stats use row defaults.`
      );
    }
    return { statValues, statBreakdown, statRollLog };
  }

  if (method.kind === "point_buy") {
    const minScore = method.minScore ?? 8;
    const maxScore = method.maxScore ?? 15;
    const costs = mergeCosts(DEFAULT_POINT_BUY_COSTS, method.costs);
    const tbl = method.tableDescription?.trim();
    if (tbl) statRollLog.push(`Point buy table: ${tbl}`);
    statRollLog.push(`Point buy: ${method.budget} points (scores ${minScore}–${maxScore}).`);
    if (derivedStats.length) {
      statRollLog.push(
        `Sub-stats / skills (${derivedStats.length}): left at row defaults; point buy applies to ${coreStats.length} core stat(s) only.`
      );
    }

    if (method.autoMode === "random_valid") {
      const rolled = randomValidPointBuyScores(coreStats.length, method.budget, minScore, maxScore, costs);
      if (rolled) {
        let spent = 0;
        for (let i = 0; i < coreStats.length; i++) {
          const s = coreStats[i]!;
          const v = rolled[i]!;
          spent += costForScore(v, costs);
          statValues[s.id] = v;
          statBreakdown.push({
            statId: s.id,
            amount: v,
            source: "Point buy (random legal spread)",
            scope: perm,
          });
        }
        statRollLog.push(`Auto assignment spent ${spent}/${method.budget} points.${verbose ? ` Scores: [${rolled.join(", ")}]` : ""}`);
        fillDerivedFromDefaults("Sub-stat (not in point buy)");
      } else {
        statRollLog.push("Could not sample a legal random spread; falling back to row defaults.");
        for (const s of stats) {
          statValues[s.id] = s.defaultValue;
          statBreakdown.push({
            statId: s.id,
            amount: s.defaultValue,
            source: "Point buy (fallback: row default)",
            scope: perm,
          });
        }
      }
    } else {
      let spent = 0;
      let ok = true;
      for (const s of coreStats) {
        const v = Math.floor(s.defaultValue);
        if (v < minScore || v > maxScore) ok = false;
        const c = costForScore(v, costs);
        if (c > 9998) ok = false;
        spent += c;
        statValues[s.id] = v;
        statBreakdown.push({
          statId: s.id,
          amount: v,
          source: "Point buy (row default)",
          scope: perm,
        });
      }
      fillDerivedFromDefaults("Sub-stat (not in point buy)");
      if (spent !== method.budget || !ok) {
        statRollLog.push(
          `Warning: core stat defaults spend ${spent}/${method.budget} points or are out of range—adjust defaults or use random legal.`
        );
      }
    }
    return { statValues, statBreakdown, statRollLog };
  }

  if (method.kind === "random_dice") {
    const repeat = method.repeatPerStat;
    if (method.description?.trim()) statRollLog.push(method.description.trim());

    if (derivedStats.length) {
      statRollLog.push(
        `Sub-stats / skills (${derivedStats.length}): left at row defaults; dice apply to ${coreStats.length} core stat(s) only.`
      );
    }

    const formula = method.formula?.trim();
    if (formula) {
      if (repeat) {
        for (const s of coreStats) {
          const r = evaluateDiceFormula(formula, verbose);
          if (!r.ok) {
            statRollLog.push(`Formula error (${s.name}): ${r.error}`);
            statValues[s.id] = s.defaultValue;
            statBreakdown.push({
              statId: s.id,
              amount: s.defaultValue,
              source: "Formula error (row default)",
              scope: perm,
            });
          } else {
            const detail = `${s.name}: ${r.lines.join(verbose ? "\n    " : " · ")} = ${r.value}`;
            statRollLog.push(detail);
            statValues[s.id] = r.value;
            statBreakdown.push({
              statId: s.id,
              amount: r.value,
              source: "Rolled (formula)",
              scope: perm,
            });
          }
        }
      } else {
        const r = evaluateDiceFormula(formula, verbose);
        if (!r.ok) {
          statRollLog.push(`Formula error: ${r.error}; using row defaults for core stats.`);
          for (const s of coreStats) {
            statValues[s.id] = s.defaultValue;
            statBreakdown.push({
              statId: s.id,
              amount: s.defaultValue,
              source: "Formula error (row default)",
              scope: perm,
            });
          }
        } else {
          statRollLog.push(`Formula (shared): ${r.lines.join(verbose ? "\n  " : " · ")} = ${r.value}`);
          for (const s of coreStats) {
            statValues[s.id] = r.value;
            statBreakdown.push({
              statId: s.id,
              amount: r.value,
              source: "Rolled (formula, shared)",
              scope: perm,
            });
          }
        }
      }
      fillDerivedFromDefaults("Sub-stat (not rolled)");
      return { statValues, statBreakdown, statRollLog };
    }

    const pipeline = resolvePipeline(method);
    if (repeat) {
      for (const s of coreStats) {
        const { value, lines } = runPipeline(pipeline, verbose);
        const detail = `${s.name}: ${lines.join(verbose ? "\n    " : " · ")} = ${value}`;
        statRollLog.push(detail);
        statValues[s.id] = value;
        statBreakdown.push({
          statId: s.id,
          amount: value,
          source: "Rolled",
          scope: perm,
        });
      }
      fillDerivedFromDefaults("Sub-stat (not rolled)");
    } else {
      const { value, lines } = runPipeline(pipeline, verbose);
      statRollLog.push(`One pool for all core stats: ${lines.join(verbose ? "\n  " : " · ")} = ${value}`);
      for (const s of coreStats) {
        statValues[s.id] = value;
        statBreakdown.push({
          statId: s.id,
          amount: value,
          source: "Rolled (shared pool)",
          scope: perm,
        });
      }
      fillDerivedFromDefaults("Sub-stat (not rolled)");
    }
    return { statValues, statBreakdown, statRollLog };
  }

  if (method.kind === "placeholder") {
    for (const s of stats) {
      statValues[s.id] = s.defaultValue;
      statBreakdown.push({
        statId: s.id,
        amount: s.defaultValue,
        source: "Placeholder method — using defaults",
        scope: perm,
      });
    }
    statRollLog.push(`Stat method placeholder: ${method.note}`);
    return { statValues, statBreakdown, statRollLog };
  }

  return applyStatGeneration(sys, { kind: "fixed_defaults" }, verbose);
}

function modifierFromTable(score: number, rows: { score: number; modifier: number }[]): number {
  if (!rows.length) return 0;
  const sorted = [...rows].sort((a, b) => a.score - b.score);
  const exact = sorted.find((r) => r.score === score);
  if (exact) return exact.modifier;
  let chosen = sorted[0]!;
  for (const r of sorted) {
    if (score >= r.score) chosen = r;
    else break;
  }
  return chosen.modifier;
}

function modifierFromDerive(score: number, derive: StatModifierDerive): { mod: number; label: string } {
  switch (derive.kind) {
    case "preset":
      switch (derive.preset) {
        case "dnd_floor":
          return { mod: Math.floor((score - 10) / 2), label: "floor((score−10)/2)" };
        case "identity":
          return { mod: score, label: "same as score" };
        case "score_minus_10":
          return { mod: score - 10, label: "score − 10" };
        default:
          return { mod: Math.floor((score - 10) / 2), label: "floor((score−10)/2)" };
      }
    case "linear": {
      const m = Math.floor(score * derive.slope + derive.intercept);
      return { mod: m, label: `floor(${derive.slope}×score${derive.intercept >= 0 ? "+" : ""}${derive.intercept})` };
    }
    case "table":
      return { mod: modifierFromTable(score, derive.rows), label: "table" };
    default:
      return { mod: Math.floor((score - 10) / 2), label: "derived" };
  }
}

/** Apply score → modifier mapping; removes prior permanent rows for each modifier id. */
export function applyStatPostProcess(
  statValues: Record<string, number>,
  statBreakdown: StatModifier[],
  post: StatPostProcess | undefined
): void {
  if (!post || post.kind !== "score_to_modifier") return;
  for (const { scoreStatId, modifierStatId, derive } of post.pairs) {
    const score = statValues[scoreStatId];
    if (score === undefined) continue;
    const { mod, label } = modifierFromDerive(score, derive);
    statValues[modifierStatId] = mod;
    for (let i = statBreakdown.length - 1; i >= 0; i--) {
      const m = statBreakdown[i]!;
      if (m.statId === modifierStatId && m.scope === "permanent") statBreakdown.splice(i, 1);
    }
    statBreakdown.push({
      statId: modifierStatId,
      amount: mod,
      source: `From ${scoreStatId} (${score}) → ${label}`,
      scope: perm,
    });
  }
}
