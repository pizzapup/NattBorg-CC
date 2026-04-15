import type {
  ArchetypeOption,
  ArchetypePick,
  Effect,
  GeneratedBlock,
  GeneratedCharacter,
  GeneratedRollTableReference,
  ModifierScope,
  RpgSystem,
  SheetListEntry,
  SheetSlot,
  StatModifier,
  ResourceModifier,
} from "../types";
import { sheetListBlockId } from "../types";
import { getSheetListFields, resolveSheetListEntry } from "../sheetListCore";
import { normalizeStartingGear } from "../migrate";
import { rollNattBorgAbility } from "./dice";
import { rollTableOption } from "./roll";

function pushLine(blocks: Map<SheetSlot, GeneratedBlock>, slot: SheetSlot, line: string) {
  let b = blocks.get(slot);
  if (!b) {
    b = { slot, lines: [] };
    blocks.set(slot, b);
  }
  b.lines.push(line);
}

function formatSheetListEntryLine(sys: RpgSystem, listId: string, entry: SheetListEntry): string {
  const def = sys.sheetLists[listId];
  if (!def) return `[missing list: ${listId}]`;
  const fields = getSheetListFields(sys, listId);
  const parts: string[] = [];
  for (const f of fields) {
    const v = entry.values[f.id];
    if (v === undefined || v === "") continue;
    parts.push(`${f.label}: ${v}`);
  }
  return parts.join(" · ") || entry.id;
}

function sheetListEntryDescription(sys: RpgSystem, listId: string, entry: SheetListEntry): string | undefined {
  const def = sys.sheetLists[listId];
  if (!def) return undefined;
  const notes = entry.values["notes"];
  if (typeof notes === "string" && notes.trim()) return notes.trim();
  const desc = entry.values["description"];
  if (typeof desc === "string" && desc.trim()) return desc.trim();
  return formatSheetListEntryLine(sys, listId, entry);
}

function applySheetListRef(
  sys: RpgSystem,
  effect: Extract<Effect, { type: "sheet_list_ref" }>,
  sourceLabel: string,
  statBreakdown: StatModifier[],
  resourceBreakdown: ResourceModifier[],
  statValues: Record<string, number>,
  resourceValues: Record<string, number>,
  blocks: Map<SheetSlot, GeneratedBlock>,
  rollLog: string[],
  depth: number
) {
  const listId = effect.listId;
  const entryId = effect.entryId;
  const listDef = sys.sheetLists[listId];
  const slot = sheetListBlockId(listId);
  if (!listDef) {
    pushLine(blocks, slot, `[missing list: ${listId}]`);
    return;
  }
  const entry = resolveSheetListEntry(sys, listId, entryId);
  if (!entry) {
    pushLine(blocks, slot, `[missing row: ${entryId}]`);
    return;
  }
  const statsLine = formatSheetListEntryLine(sys, listId, entry);
  const nameVal = entry.values["name"] ?? entry.values["label"];
  const defaultName = typeof nameVal === "string" && nameVal.trim() ? nameVal.trim() : entryId;
  const label = effect.displayName?.trim() || defaultName;
  const listLine = statsLine ? `${label} — ${statsLine}` : label;
  pushLine(blocks, slot, listLine);
  const desc =
    effect.displayDescription?.trim() ||
    sheetListEntryDescription(sys, listId, entry) ||
    (statsLine && !effect.displayName ? statsLine : undefined);
  if (desc) {
    const sec = listDef.sheetTitle.trim() || listId;
    pushLine(blocks, "description", `${sec}: ${label}. ${desc}`);
  }
  const nestedSource = `${sourceLabel} → ${listDef.sheetTitle}: ${label}`;
  for (const e of entry.effects ?? []) {
    applyEffect(
      sys,
      e,
      nestedSource,
      statBreakdown,
      resourceBreakdown,
      statValues,
      resourceValues,
      blocks,
      rollLog,
      depth
    );
  }
}

function applySharedTraitRefs(sys: RpgSystem, opt: ArchetypeOption, blocks: Map<SheetSlot, GeneratedBlock>) {
  const lib = sys.sharedTraits;
  const refs = opt.sharedTraitRefs;
  if (!lib || !refs?.length) return;
  for (const tid of refs) {
    const tr = lib[tid];
    if (!tr) continue;
    const body = tr.description.trim();
    const line = body ? `${tr.name}: ${body}` : tr.name;
    pushLine(blocks, "traits", line);
  }
}

const perm: ModifierScope = "permanent";
const cond: ModifierScope = "conditional";

function applyEffect(
  sys: RpgSystem,
  effect: Effect,
  sourceLabel: string,
  statBreakdown: StatModifier[],
  resourceBreakdown: ResourceModifier[],
  statValues: Record<string, number>,
  resourceValues: Record<string, number>,
  blocks: Map<SheetSlot, GeneratedBlock>,
  rollLog: string[],
  depth: number
) {
  const pad = "  ".repeat(depth);
  switch (effect.type) {
    case "stat_mod": {
      statValues[effect.statId] = (statValues[effect.statId] ?? 0) + effect.amount;
      statBreakdown.push({
        statId: effect.statId,
        amount: effect.amount,
        source: sourceLabel,
        scope: cond,
      });
      break;
    }
    case "resource_mod": {
      resourceValues[effect.resourceId] = (resourceValues[effect.resourceId] ?? 0) + effect.amount;
      resourceBreakdown.push({
        resourceId: effect.resourceId,
        amount: effect.amount,
        source: sourceLabel,
        scope: cond,
      });
      break;
    }
    case "sheet_text": {
      const text = effect.text.trim();
      if (!text) break;
      if (effect.append === false) {
        const b = blocks.get(effect.slot) ?? { slot: effect.slot, lines: [] };
        b.lines = [text];
        blocks.set(effect.slot, b);
      } else {
        pushLine(blocks, effect.slot, text);
      }
      break;
    }
    case "sheet_list_line": {
      const text = effect.text.trim();
      if (!text) break;
      const lid = effect.listId;
      if (!sys.sheetLists[lid]) {
        rollLog.push(`${pad}[missing list: ${lid}]`);
        break;
      }
      pushLine(blocks, sheetListBlockId(lid), text);
      break;
    }
    case "sheet_list_ref": {
      applySheetListRef(
        sys,
        effect,
        sourceLabel,
        statBreakdown,
        resourceBreakdown,
        statValues,
        resourceValues,
        blocks,
        rollLog,
        depth
      );
      break;
    }
    case "trait": {
      const t = effect.text.trim();
      if (t) pushLine(blocks, "traits", t);
      break;
    }
    case "special": {
      const t = effect.text.trim();
      if (t) pushLine(blocks, "special", t);
      break;
    }
    case "roll_table": {
      const table = sys.tables[effect.tableId];
      if (!table) {
        rollLog.push(`${pad}[missing table: ${effect.tableId}]`);
        return;
      }
      const subSource = effect.label ?? table.name;
      const fullSource = `${sourceLabel} → ${subSource}`;
      const { option, index } = rollTableOption(table);
      rollLog.push(
        `${pad}Table "${table.name}": ${option.label} (#${index + 1}/${table.options.length})`
      );
      const desc = option.description?.trim();
      if (desc) pushLine(blocks, "description", `${subSource}: ${option.label}. ${desc}`);
      else pushLine(blocks, "description", `${subSource}: ${option.label}`);
      for (const e of option.effects ?? []) {
        applyEffect(sys, e, fullSource, statBreakdown, resourceBreakdown, statValues, resourceValues, blocks, rollLog, depth + 1);
      }
      break;
    }
    default: {
      const _exhaustive: never = effect;
      return _exhaustive;
    }
  }
}

function rollOptionTables(
  sys: RpgSystem,
  opt: ArchetypeOption,
  sourcePrefix: string,
  statBreakdown: StatModifier[],
  resourceBreakdown: ResourceModifier[],
  statValues: Record<string, number>,
  resourceValues: Record<string, number>,
  blocks: Map<SheetSlot, GeneratedBlock>,
  rollLog: string[]
) {
  for (const tableId of opt.tableRolls ?? []) {
    const table = sys.tables[tableId];
    if (!table) {
      rollLog.push(`[${opt.name}] missing table: ${tableId}`);
      continue;
    }
    const { option, index } = rollTableOption(table);
    const source = `${sourcePrefix}: ${opt.name} — ${table.name}`;
    rollLog.push(`Table "${table.name}": ${option.label} (#${index + 1}/${table.options.length})`);
    const desc = option.description?.trim();
    if (desc) pushLine(blocks, "description", `${table.name}: ${option.label}. ${desc}`);
    else pushLine(blocks, "description", `${table.name}: ${option.label}`);
    for (const e of option.effects ?? []) {
      applyEffect(sys, e, source, statBreakdown, resourceBreakdown, statValues, resourceValues, blocks, rollLog, 1);
    }
  }
}

function applyOptionBase(
  opt: ArchetypeOption,
  groupLabel: string,
  statBreakdown: StatModifier[],
  resourceBreakdown: ResourceModifier[],
  statValues: Record<string, number>,
  resourceValues: Record<string, number>,
  blocks: Map<SheetSlot, GeneratedBlock>
) {
  for (const m of opt.statMods ?? []) {
    statValues[m.statId] = (statValues[m.statId] ?? 0) + m.amount;
    statBreakdown.push({
      statId: m.statId,
      amount: m.amount,
      source: `${groupLabel}: ${opt.name}`,
      scope: perm,
    });
  }
  for (const m of opt.resourceMods ?? []) {
    resourceValues[m.resourceId] = (resourceValues[m.resourceId] ?? 0) + m.amount;
    resourceBreakdown.push({
      resourceId: m.resourceId,
      amount: m.amount,
      source: `${groupLabel}: ${opt.name}`,
      scope: perm,
    });
  }
  if (opt.description?.trim()) {
    pushLine(blocks, "description", `${groupLabel} ${opt.name}: ${opt.description.trim()}`);
  }
}

export function pickRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

/** Resolve one option per archetype group (random where lock is empty). */
export function resolveArchetypeSelections(
  sys: RpgSystem,
  locks: Record<string, string>
): Record<string, ArchetypeOption> {
  const out: Record<string, ArchetypeOption> = {};
  for (const g of sys.archetypeGroups) {
    if (g.options.length === 0) {
      throw new Error(`Archetype group "${g.label}" has no options`);
    }
    const want = locks[g.id];
    const opt = want ? g.options.find((o) => o.id === want) ?? pickRandom(g.options) : pickRandom(g.options);
    out[g.id] = opt;
  }
  return out;
}

function orderedSheetSlots(sys: RpgSystem): SheetSlot[] {
  const core: SheetSlot[] = ["description", "traits", "special"];
  const listSlots = Object.keys(sys.sheetLists)
    .sort()
    .map((id) => sheetListBlockId(id));
  return [...core, ...listSlots, "notes"];
}

function buildReferenceTables(sys: RpgSystem): GeneratedRollTableReference[] {
  const out: GeneratedRollTableReference[] = [];
  for (const t of Object.values(sys.tables).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!t.includeOnCharacterSheet || !t.options.length) continue;
    const wts = t.options.map((o) => o.weight ?? 1);
    const showWeight = wts.length > 1 && new Set(wts).size > 1;
    const lines = t.options.map((opt, i) => {
      const n = i + 1;
      const lab = opt.label.trim() || "Outcome";
      const desc = opt.description?.trim();
      let s = `${n}. ${lab}`;
      if (desc) s += ` — ${desc}`;
      if (showWeight) s += ` (wt ${opt.weight ?? 1})`;
      return s;
    });
    out.push({ tableId: t.id, name: t.name, lines });
  }
  return out;
}

export function generateCharacter(
  sys: RpgSystem,
  selectionsByGroupId: Record<string, ArchetypeOption>
): GeneratedCharacter {
  const archetypePicks: ArchetypePick[] = [];
  for (const g of sys.archetypeGroups) {
    const opt = selectionsByGroupId[g.id];
    if (!opt) throw new Error(`Missing selection for group "${g.label}" (${g.id})`);
    archetypePicks.push({ groupId: g.id, groupLabel: g.label, option: opt });
  }

  const statValues: Record<string, number> = {};
  const statBreakdown: StatModifier[] = [];
  const resourceValues: Record<string, number> = {};
  const resourceBreakdown: ResourceModifier[] = [];
  const statRollLog: string[] = [];

  const method = sys.statGenerationMethod.kind;
  if (method === "fixed_defaults") {
    for (const s of sys.stats) {
      statValues[s.id] = s.defaultValue;
      statBreakdown.push({
        statId: s.id,
        amount: s.defaultValue,
        source: "Starting value",
        scope: perm,
      });
    }
  } else if (method === "nattborg_lesser") {
    for (const s of sys.stats) {
      const { value, detail } = rollNattBorgAbility(s.name);
      statValues[s.id] = value;
      statRollLog.push(detail);
      statBreakdown.push({
        statId: s.id,
        amount: value,
        source: "Rolled (NattBorg lesser)",
        scope: perm,
      });
    }
  } else {
    for (const s of sys.stats) {
      statValues[s.id] = s.defaultValue;
      statBreakdown.push({
        statId: s.id,
        amount: s.defaultValue,
        source: "Placeholder method — using defaults",
        scope: perm,
      });
    }
    statRollLog.push(
      `Stat method: ${(sys.statGenerationMethod as { kind: string }).kind} (${(sys.statGenerationMethod as { note?: string }).note ?? ""})`
    );
  }

  for (const r of sys.resources) {
    resourceValues[r.id] = r.defaultValue;
    resourceBreakdown.push({
      resourceId: r.id,
      amount: r.defaultValue,
      source: "Starting value",
      scope: perm,
    });
  }

  const blocks = new Map<SheetSlot, GeneratedBlock>();
  const rollLog: string[] = [...statRollLog];

  for (const pick of archetypePicks) {
    applyOptionBase(
      pick.option,
      pick.groupLabel,
      statBreakdown,
      resourceBreakdown,
      statValues,
      resourceValues,
      blocks
    );
    applySharedTraitRefs(sys, pick.option, blocks);
    rollOptionTables(
      sys,
      pick.option,
      pick.groupLabel,
      statBreakdown,
      resourceBreakdown,
      statValues,
      resourceValues,
      blocks,
      rollLog
    );
  }

  const gear = normalizeStartingGear(sys.startingGear);
  if (gear?.enabled && gear.loadout?.length) {
    for (const pick of gear.loadout) {
      const table = sys.tables[pick.tableId];
      if (!table) {
        rollLog.push(`[starting loadout] missing table: ${pick.tableId}`);
        continue;
      }
      const count = pick.mode === "once" ? 1 : Math.max(0, pick.rolls);
      for (let i = 0; i < count; i++) {
        const { option, index } = rollTableOption(table);
        rollLog.push(
          `Starting loadout "${table.name}" (${i + 1}/${count}): ${option.label} (#${index + 1}/${table.options.length})`
        );
        const src = `Starting loadout — ${table.name}`;
        const desc = option.description?.trim();
        if (desc) pushLine(blocks, "description", `${option.label}: ${desc}`);
        else pushLine(blocks, "description", option.label);
        for (const e of option.effects ?? []) {
          applyEffect(sys, e, src, statBreakdown, resourceBreakdown, statValues, resourceValues, blocks, rollLog, 1);
        }
      }
    }
  }

  const orderedSlots = orderedSheetSlots(sys);
  const blocksArr = orderedSlots
    .map((slot) => blocks.get(slot))
    .filter((b): b is GeneratedBlock => Boolean(b && b.lines.length > 0));

  const referenceTables = buildReferenceTables(sys);

  return {
    systemId: sys.id,
    systemName: sys.name,
    archetypePicks,
    stats: statValues,
    resources: resourceValues,
    statBreakdown,
    resourceBreakdown,
    statRollLog,
    blocks: blocksArr,
    ...(referenceTables.length ? { referenceTables } : {}),
    rollLog,
  };
}
