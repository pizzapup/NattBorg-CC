import type { DiceBinOp } from "../types";

export type DiceFormulaEval =
  | { ok: true; value: number; lines: string[] }
  | { ok: false; error: string };

export type DicePoolSpan = {
  n: number;
  sides: number;
  agg: "sum" | "min" | "max" | "avg";
  keep?: { kind: "h" | "l"; k: number };
  /** Half-open range in the compact formula (whitespace stripped). */
  span: { start: number; end: number };
};

export type ParsedDiceFormula =
  | { ok: true; ast: DiceAst; compact: string }
  | { ok: false; error: string };

export type DiceAst =
  | { t: "num"; v: number }
  | {
      t: "dice";
      n: number;
      sides: number;
      agg: "sum" | "min" | "max" | "avg";
      keep?: { kind: "h" | "l"; k: number };
      span: { start: number; end: number };
    }
  | { t: "bin"; op: DiceBinOp; L: DiceAst; R: DiceAst }
  | { t: "neg"; x: DiceAst };

type CompactTok = { k: string; s: number; e: number };

function rollDie(sides: number, rng: () => number): number {
  return Math.floor(rng() * sides) + 1;
}

function evalAst(ast: DiceAst, rng: () => number, verbose: boolean, lines: string[], depth: number): number {
  const pad = verbose ? "  ".repeat(depth) : "";
  switch (ast.t) {
    case "num":
      return ast.v;
    case "neg": {
      const v = evalAst(ast.x, rng, verbose, lines, depth);
      const out = -v;
      if (verbose) lines.push(`${pad}neg → ${out}`);
      return out;
    }
    case "dice": {
      const rolls: number[] = [];
      for (let i = 0; i < ast.n; i++) rolls.push(rollDie(ast.sides, rng));
      let picked: number[];
      let desc: string;
      if (ast.keep) {
        const sorted = [...rolls].sort((a, b) => a - b);
        if (ast.keep.kind === "h") {
          picked = sorted.slice(-ast.keep.k);
          desc = `keep highest ${ast.keep.k} of [${sorted.join(",")}] → [${picked.join(",")}]`;
        } else {
          picked = sorted.slice(0, ast.keep.k);
          desc = `keep lowest ${ast.keep.k} of [${sorted.join(",")}] → [${picked.join(",")}]`;
        }
      } else {
        picked = rolls;
        desc = `[${rolls.join(",")}]`;
      }
      let v: number;
      if (ast.agg === "sum") v = picked.reduce((a, b) => a + b, 0);
      else if (ast.agg === "min") v = Math.min(...picked);
      else if (ast.agg === "max") v = Math.max(...picked);
      else v = Math.floor(picked.reduce((a, b) => a + b, 0) / picked.length);
      const label = `${ast.n}d${ast.sides}`;
      lines.push(verbose ? `${pad}${label}: rolled ${desc}; ${ast.agg} = ${v}` : `${label} → ${v}`);
      return v;
    }
    case "bin": {
      const L = evalAst(ast.L, rng, verbose, lines, depth + 1);
      const R = evalAst(ast.R, rng, verbose, lines, depth + 1);
      let v: number;
      switch (ast.op) {
        case "add":
          v = L + R;
          break;
        case "sub":
          v = L - R;
          break;
        case "mul":
          v = L * R;
          break;
        case "div":
          v = R === 0 ? L : Math.trunc(L / R);
          break;
        default:
          v = L;
      }
      if (verbose) lines.push(`${pad}combine: ${L} ${ast.op} ${R} = ${v}`);
      return v;
    }
  }
}

function tokenizeDiceFormulaCompact(input: string): { compact: string; tokens: CompactTok[] } {
  const compact = input.replace(/\s+/g, "");
  const tokens: CompactTok[] = [];
  let i = 0;
  while (i < compact.length) {
    const c = compact[i]!;
    if (/\d/.test(c)) {
      const start = i;
      let j = i;
      while (j < compact.length && /\d/.test(compact[j]!)) j++;
      tokens.push({ k: compact.slice(start, j), s: start, e: j });
      i = j;
    } else if ("+-*/()".includes(c)) {
      tokens.push({ k: c, s: i, e: i + 1 });
      i++;
    } else if (c === "d" || c === "D") {
      tokens.push({ k: "d", s: i, e: i + 1 });
      i++;
    } else if (/[a-zA-Z]/.test(c)) {
      const start = i;
      let j = i;
      while (j < compact.length && /[a-zA-Z]/.test(compact[j]!)) j++;
      tokens.push({ k: compact.slice(start, j).toLowerCase(), s: start, e: j });
      i = j;
    } else {
      throw new Error(`Invalid character “${c}” in dice formula`);
    }
  }
  return { compact, tokens };
}

class Parser {
  private i = 0;
  constructor(private readonly toks: CompactTok[]) {}

  private peek(): CompactTok | undefined {
    return this.toks[this.i];
  }

  private eat(): CompactTok {
    const t = this.toks[this.i++];
    if (t === undefined) throw new Error("Unexpected end of formula");
    return t;
  }

  isDone(): boolean {
    return this.i >= this.toks.length;
  }

  remaining(): string {
    return this.toks.slice(this.i).map((x) => x.k).join(" ");
  }

  parseExpr(): DiceAst {
    return this.parseAddSub();
  }

  private parseAddSub(): DiceAst {
    let L = this.parseMulDiv();
    for (;;) {
      const t = this.peek()?.k;
      if (t === "+") {
        this.eat();
        const R = this.parseMulDiv();
        L = { t: "bin", op: "add", L, R };
      } else if (t === "-") {
        this.eat();
        const R = this.parseMulDiv();
        L = { t: "bin", op: "sub", L, R };
      } else break;
    }
    return L;
  }

  private parseMulDiv(): DiceAst {
    let L = this.parseUnary();
    for (;;) {
      const t = this.peek()?.k;
      if (t === "*") {
        this.eat();
        const R = this.parseUnary();
        L = { t: "bin", op: "mul", L, R };
      } else if (t === "/") {
        this.eat();
        const R = this.parseUnary();
        L = { t: "bin", op: "div", L, R };
      } else break;
    }
    return L;
  }

  private parseUnary(): DiceAst {
    if (this.peek()?.k === "-") {
      this.eat();
      return { t: "neg", x: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): DiceAst {
    const t = this.peek();
    if (t?.k === "(") {
      this.eat();
      const e = this.parseExpr();
      if (this.peek()?.k !== ")") throw new Error("Expected closing )");
      this.eat();
      return e;
    }
    if (t === undefined) throw new Error("Expected value or (");
    if (!/^\d+$/.test(t.k)) throw new Error(`Expected number or (, got “${t.k}”`);
    const numTok = this.eat();
    const n = Number(numTok.k);
    if (this.peek()?.k === "d") {
      this.eat();
      const st = this.peek();
      if (st === undefined || !/^\d+$/.test(st.k)) throw new Error("Expected sides after d");
      const sidesTok = this.eat();
      const sides = Number(sidesTok.k);
      return this.parseDiceSuffix(n, sides, numTok.s, sidesTok.e);
    }
    return { t: "num", v: n };
  }

  private parseDiceSuffix(n: number, sides: number, spanStart: number, sidesEnd: number): DiceAst {
    let keep: { kind: "h" | "l"; k: number } | undefined;
    let agg: "sum" | "min" | "max" | "avg" = "sum";
    let spanEnd = sidesEnd;

    const id = this.peek()?.k;
    if (id === "kh") {
      this.eat();
      const kTok = this.eat();
      if (!/^\d+$/.test(kTok.k)) throw new Error("kh must be followed by a number");
      keep = { kind: "h", k: Number(kTok.k) };
      spanEnd = kTok.e;
    } else if (id === "kl") {
      this.eat();
      const kTok = this.eat();
      if (!/^\d+$/.test(kTok.k)) throw new Error("kl must be followed by a number");
      keep = { kind: "l", k: Number(kTok.k) };
      spanEnd = kTok.e;
    } else if (id === "min") {
      this.eat();
      agg = "min";
      spanEnd = this.toks[this.i - 1]!.e;
    } else if (id === "max") {
      this.eat();
      agg = "max";
      spanEnd = this.toks[this.i - 1]!.e;
    } else if (id === "avg") {
      this.eat();
      agg = "avg";
      spanEnd = this.toks[this.i - 1]!.e;
    }

    if (keep && (agg === "min" || agg === "max" || agg === "avg")) {
      throw new Error("Use either kh/kl or min/max/avg, not both");
    }

    return { t: "dice", n, sides, agg, keep, span: { start: spanStart, end: spanEnd } };
  }
}

export function parseDiceFormula(formula: string): ParsedDiceFormula {
  const raw = formula.trim();
  if (!raw) return { ok: false, error: "Empty formula" };
  try {
    const { compact, tokens } = tokenizeDiceFormulaCompact(raw);
    if (!tokens.length) return { ok: false, error: "Empty formula" };
    const p = new Parser(tokens);
    const ast = p.parseExpr();
    if (!p.isDone()) return { ok: false, error: `Unexpected “${p.remaining()}” after expression` };
    return { ok: true, ast, compact };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function listDicePools(ast: DiceAst): DicePoolSpan[] {
  const out: DicePoolSpan[] = [];
  const walk = (a: DiceAst) => {
    switch (a.t) {
      case "dice":
        out.push({
          n: a.n,
          sides: a.sides,
          agg: a.agg,
          keep: a.keep,
          span: a.span,
        });
        break;
      case "bin":
        walk(a.L);
        walk(a.R);
        break;
      case "neg":
        walk(a.x);
        break;
      default:
        break;
    }
  };
  walk(ast);
  return out;
}

/** Serialize one dice pool (no surrounding whitespace). */
export function formatDicePoolExpr(
  n: number,
  sides: number,
  agg: "sum" | "min" | "max" | "avg",
  keep?: { kind: "h" | "l"; k: number },
): string {
  let s = `${n}d${sides}`;
  if (keep) {
    s += keep.kind === "h" ? `kh${keep.k}` : `kl${keep.k}`;
  } else if (agg === "min") s += "min";
  else if (agg === "max") s += "max";
  else if (agg === "avg") s += "avg";
  return s;
}

/**
 * Map a half-open range in the compact formula to a half-open range in the original string * (preserving user spacing outside the replaced segment).
 */
export function compactRangeToOriginalRange(raw: string, cStart: number, cEnd: number): { start: number; end: number } {
  let c = 0;
  let start = -1;
  let end = -1;
  for (let i = 0; i < raw.length; i++) {
    if (/\s/.test(raw[i]!)) continue;
    if (c === cStart) start = i;
    c++;
    if (c === cEnd) {
      end = i + 1;
      break;
    }
  }
  if (start < 0) start = 0;
  if (end < 0) end = raw.length;
  return { start, end };
}

export function replaceFormulaRange(raw: string, span: { start: number; end: number }, replacement: string): string {
  const t = raw.trim();
  const { start, end } = compactRangeToOriginalRange(t, span.start, span.end);
  return t.slice(0, start) + replacement + t.slice(end);
}

/**
 * Apply a structural edit to one dice pool by index (left-to-right in the AST).
 * Returns updated formula (trimmed) or null if the index is invalid or the formula does not parse.
 */
export function replaceDicePoolByIndex(
  formula: string,
  poolIndex: number,
  next: { n: number; sides: number; agg: "sum" | "min" | "max" | "avg"; keep?: { kind: "h" | "l"; k: number } },
): string | null {
  const p = parseDiceFormula(formula);
  if (!p.ok) return null;
  const pools = listDicePools(p.ast);
  const pool = pools[poolIndex];
  if (!pool) return null;
  const expr = formatDicePoolExpr(next.n, next.sides, next.agg, next.keep);
  return replaceFormulaRange(formula, pool.span, expr);
}

/**
 * Evaluate a dice formula once. Syntax (ASCII, no spaces required):
 * - <code>NdM</code> — roll N dice with M sides, sum all.
 * - <code>NdMkhK</code> / <code>NdMklK</code> — keep highest / lowest K dice, then sum those.
 * - <code>NdMmin</code> / <code>NdMmax</code> / <code>NdMavg</code> — min, max, or floor-average of all rolls.
 * - <code>+</code> <code>-</code> <code>*</code> <code>/</code> with usual precedence; unary <code>-</code>.
 * - Parentheses for grouping.
 *
 * @example <code>4d6kh3</code> (classic 4d6 drop lowest)
 * @example <code>(4d6kh3)+6</code>
 * @example <code>2d6min-2d4min</code> (Nattborg-style lesser; min of 2d6 minus min of 2d4)
 */
export function evaluateDiceFormula(formula: string, verbose: boolean): DiceFormulaEval {
  const parsed = parseDiceFormula(formula);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  try {
    const lines: string[] = [];
    const rng = () => Math.random();
    const value = evalAst(parsed.ast, rng, verbose, lines, 0);
    return { ok: true, value, lines };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function validateDiceFormula(formula: string): string | null {
  const r = parseDiceFormula(formula);
  return r.ok ? null : r.error;
}
