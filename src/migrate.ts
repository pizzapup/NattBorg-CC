import {
  DIMENSION_OVERVIEW_COLUMN_ORDER,
  type ArchetypeGroup,
  type ArchetypeOption,
  type ArchetypeResourceModRow,
  type ArchetypeStatModRow,
  type DimensionOverviewColumnId,
  type Effect,
  type LoadoutEntry,
  type NumericStatColumnPrefs,
  type NumericStatOptionalColumn,
  type ResourceDefinition,
  type RpgSystem,
  type RollTable,
  type RollTableExtraColumn,
  type SchemaField,
  type SheetListDefinition,
  type SheetListEntry,
  type SheetListSlot,
  type SheetSlot,
  type SharedTraitDefinition,
  type StatDefinition,
  type StatGenerationMethod,
  type StudioExtraColumnBundle,
  type TableLibraryKind,
  type TableOption,
  sheetListBlockId,
} from "./types";

type LegacyArchetype = ArchetypeOption;

function normalizeRowExtraMap(raw: unknown): Record<string, string | number> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(o)) {
    const key = k.trim();
    if (!key) continue;
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
    else if (typeof v === "string") out[key] = v;
    else if (v != null) out[key] = String(v);
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeSharedTraitsRecord(raw: unknown): RpgSystem["sharedTraits"] {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, SharedTraitDefinition> = {};
  for (const [k, t] of Object.entries(raw)) {
    if (!t || typeof t !== "object") continue;
    const tr = t as Record<string, unknown>;
    const id = String(tr.id ?? k).trim();
    if (!id) continue;
    const name = String(tr.name ?? id).trim() || id;
    const description = String(tr.description ?? "").trim();
    const row: SharedTraitDefinition = { id, name, description };
    const ex = normalizeRowExtraMap(tr.extra);
    if (ex) row.extra = ex;
    out[id] = row;
  }
  return out;
}

/** Legacy catalog item shape (pre–sheet-lists). */
type LegacyItemDefinition = {
  id: string;
  kind: "weapon" | "equipment";
  name: string;
  description?: string;
  tags?: string[];
  effects?: Effect[];
};

type LegacyWeaponEntry = { id: string; values: Record<string, string | number> };

function normalizeStatEntries(raw: unknown): StatDefinition[] {
  if (!Array.isArray(raw)) return [];
  const out: StatDefinition[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const s = x as Record<string, unknown>;
    const id = String(s.id ?? "").trim();
    if (!id) continue;
    const name = String(s.name ?? id).trim() || id;
    const defaultValue = Math.floor(Number(s.defaultValue) || 0);
    const exp = typeof s.sheetExplanation === "string" ? s.sheetExplanation.trim() : "";
    const row: StatDefinition = { id, name, defaultValue };
    if (exp) row.sheetExplanation = exp;
    const ex = normalizeRowExtraMap(s.extra);
    if (ex) row.extra = ex;
    out.push(row);
  }
  return out;
}

function normalizeResourceEntries(raw: unknown, fallback: ResourceDefinition[]): ResourceDefinition[] {
  if (!Array.isArray(raw)) return fallback;
  const out: ResourceDefinition[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    const id = String(r.id ?? "").trim();
    if (!id) continue;
    const name = String(r.name ?? id).trim() || id;
    const defaultValue = Math.floor(Number(r.defaultValue) || 0);
    const exp = typeof r.sheetExplanation === "string" ? r.sheetExplanation.trim() : "";
    const row: ResourceDefinition = { id, name, defaultValue };
    if (exp) row.sheetExplanation = exp;
    const ex = normalizeRowExtraMap(r.extra);
    if (ex) row.extra = ex;
    out.push(row);
  }
  return out.length ? out : fallback;
}

function defaultWeaponFields(): SchemaField[] {
  return [
    { id: "name", label: "Name", fieldType: "text" },
    { id: "damage", label: "Damage", fieldType: "text" },
    { id: "notes", label: "Notes", fieldType: "textarea" },
  ];
}

function migrateSheetSlot(raw: unknown): SheetSlot {
  if (typeof raw !== "string") return "description";
  if (raw === "weapons") return sheetListBlockId("weapons");
  if (raw === "equipment") return sheetListBlockId("equipment");
  if (raw === "description" || raw === "traits" || raw === "special" || raw === "notes") return raw;
  if (raw.startsWith("list:")) return raw as SheetListSlot;
  return "description";
}

/** Map legacy effect types to current model (recursive for nested arrays). */
export function migrateEffect(raw: unknown): Effect | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown> & { type?: string };
  const t = e.type;
  switch (t) {
    case "weapon_ref": {
      const entryId = String(e.weaponId ?? "").trim();
      if (!entryId) return null;
      return {
        type: "sheet_list_ref",
        listId: "weapons",
        entryId,
        ...(typeof e.displayName === "string" && e.displayName.trim() ? { displayName: e.displayName.trim() } : {}),
        ...(typeof e.displayDescription === "string" && e.displayDescription.trim()
          ? { displayDescription: e.displayDescription.trim() }
          : {}),
      };
    }
    case "item_ref": {
      const entryId = String(e.itemId ?? "").trim();
      if (!entryId) return null;
      return { type: "sheet_list_ref", listId: "equipment", entryId };
    }
    case "weapon": {
      const name = String(e.name ?? "").trim();
      if (!name) return null;
      const parts = [name];
      if (typeof e.description === "string" && e.description.trim()) parts.push(e.description.trim());
      if (Array.isArray(e.tags) && e.tags.length)
        parts.push(`(${(e.tags as string[]).map((x) => String(x)).join(", ")})`);
      return { type: "sheet_list_line", listId: "weapons", text: parts.join(" — ") };
    }
    case "equipment": {
      const name = String(e.name ?? "").trim();
      if (!name) return null;
      const text =
        typeof e.description === "string" && e.description.trim()
          ? `${name} — ${e.description.trim()}`
          : name;
      return { type: "sheet_list_line", listId: "equipment", text };
    }
    case "sheet_text": {
      const text = String(e.text ?? "").trim();
      if (!text) return null;
      return {
        type: "sheet_text",
        slot: migrateSheetSlot(e.slot),
        text,
        append: e.append !== false,
      };
    }
    case "roll_table": {
      const tableId = String(e.tableId ?? "").trim();
      if (!tableId) return null;
      const label = typeof e.label === "string" ? e.label.trim() : "";
      return { type: "roll_table", tableId, ...(label ? { label } : {}) };
    }
    case "stat_mod": {
      const statId = String(e.statId ?? "").trim();
      if (!statId) return null;
      const amount = Number(e.amount) || 0;
      return { type: "stat_mod", statId, amount };
    }
    case "resource_mod": {
      const resourceId = String(e.resourceId ?? "").trim();
      if (!resourceId) return null;
      const amount = Number(e.amount) || 0;
      return { type: "resource_mod", resourceId, amount };
    }
    case "trait": {
      const text = String(e.text ?? "").trim();
      if (!text) return null;
      return { type: "trait", text };
    }
    case "special": {
      const text = String(e.text ?? "").trim();
      if (!text) return null;
      return { type: "special", text };
    }
    case "sheet_list_ref": {
      const listId = String(e.listId ?? "").trim();
      const entryId = String(e.entryId ?? "").trim();
      if (!listId || !entryId) return null;
      return {
        type: "sheet_list_ref",
        listId,
        entryId,
        ...(typeof e.displayName === "string" && e.displayName.trim() ? { displayName: e.displayName.trim() } : {}),
        ...(typeof e.displayDescription === "string" && e.displayDescription.trim()
          ? { displayDescription: e.displayDescription.trim() }
          : {}),
      };
    }
    case "sheet_list_line": {
      const listId = String(e.listId ?? "").trim();
      const text = String(e.text ?? "").trim();
      if (!listId || !text) return null;
      return { type: "sheet_list_line", listId, text };
    }
    default:
      return null;
  }
}

function migrateEffectsList(raw: unknown): Effect[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Effect[] = [];
  for (const x of raw) {
    const m = migrateEffect(x);
    if (m) out.push(m);
  }
  return out.length ? out : undefined;
}

function normalizeSheetListEntry(raw: unknown): SheetListEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = String(o.id ?? "").trim();
  if (!id) return null;
  const valuesRaw = o.values;
  const values: Record<string, string | number> = {};
  if (valuesRaw && typeof valuesRaw === "object" && !Array.isArray(valuesRaw)) {
    for (const [k, v] of Object.entries(valuesRaw as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) values[k] = v;
      else if (typeof v === "string") values[k] = v;
    }
  }
  const effects = migrateEffectsList(o.effects);
  return { id, values, ...(effects?.length ? { effects } : {}) };
}

function normalizeSheetDisplayColumns(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.map((x) => String(x).trim()).filter(Boolean);
  return out.length ? out : undefined;
}

function normalizeSheetListsFromRaw(raw: unknown): Record<string, SheetListDefinition> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, SheetListDefinition> = {};
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const s = v as Record<string, unknown>;
    const id = String(s.id ?? key).trim() || key;
    const sheetTitle = String(s.sheetTitle ?? s.title ?? id).trim() || id;
    const sourceTableIdRaw = s.sourceTableId;
    const sourceTableId =
      typeof sourceTableIdRaw === "string" && sourceTableIdRaw.trim() ? sourceTableIdRaw.trim() : undefined;
    const sheetDisplayColumns = normalizeSheetDisplayColumns(s.sheetDisplayColumns);
    const fieldsRaw = Array.isArray(s.fields)
      ? (s.fields as SchemaField[]).filter((f) => f && typeof f.id === "string")
      : [];
    const entriesIn = s.entries;
    const entriesParsed: Record<string, SheetListEntry> = {};
    if (entriesIn && typeof entriesIn === "object") {
      for (const [, ev] of Object.entries(entriesIn as Record<string, unknown>)) {
        const ent = normalizeSheetListEntry(ev);
        if (ent) entriesParsed[ent.id] = ent;
      }
    }
    const fields = sourceTableId ? [] : fieldsRaw;
    const entries = sourceTableId ? {} : entriesParsed;
    out[id] = {
      id,
      sheetTitle,
      fields,
      entries,
      ...(sourceTableId ? { sourceTableId } : {}),
      ...(sourceTableId && sheetDisplayColumns?.length ? { sheetDisplayColumns } : {}),
    };
  }
  return out;
}

function inferWeaponsFromCatalogLegacy(catalog: Record<string, LegacyItemDefinition>): Record<string, LegacyWeaponEntry> {
  const out: Record<string, LegacyWeaponEntry> = {};
  for (const item of Object.values(catalog)) {
    if (item.kind !== "weapon") continue;
    out[item.id] = {
      id: item.id,
      values: {
        name: item.name,
        damage: "",
        notes: [item.description, ...(item.tags ?? []).map((t) => `#${t}`)].filter(Boolean).join(" "),
      },
    };
  }
  return out;
}

function buildLegacySheetLists(o: Record<string, unknown>): Record<string, SheetListDefinition> {
  const contentFlags = o.contentFlags as Record<string, unknown> | undefined;
  const weaponsRegistryOff = contentFlags?.weaponsRegistry === false;

  let weaponFields: SchemaField[];
  if (weaponsRegistryOff) {
    weaponFields = Array.isArray(o.weaponFields) ? (o.weaponFields as SchemaField[]) : [];
  } else if (Array.isArray(o.weaponFields) && (o.weaponFields as SchemaField[]).length) {
    weaponFields = o.weaponFields as SchemaField[];
  } else {
    weaponFields = defaultWeaponFields();
  }

  let weapons: Record<string, LegacyWeaponEntry> =
    o.weapons && typeof o.weapons === "object" ? (o.weapons as Record<string, LegacyWeaponEntry>) : {};

  const itemCatalogRaw = o.itemCatalog;
  const itemCatalog: Record<string, LegacyItemDefinition> =
    itemCatalogRaw && typeof itemCatalogRaw === "object"
      ? (itemCatalogRaw as Record<string, LegacyItemDefinition>)
      : {};

  if (!weaponsRegistryOff && Object.keys(weapons).length === 0) {
    weapons = inferWeaponsFromCatalogLegacy(itemCatalog);
  }

  const lists: Record<string, SheetListDefinition> = {};

  if (weaponFields.length || Object.keys(weapons).length) {
    const fields = weaponFields.length ? weaponFields : defaultWeaponFields();
    const entries: Record<string, SheetListEntry> = {};
    for (const [wid, w] of Object.entries(weapons)) {
      entries[wid] = { id: w.id, values: { ...w.values } };
    }
    lists.weapons = { id: "weapons", sheetTitle: "Weapons", fields, entries };
  }

  if (Object.keys(itemCatalog).length) {
    const fields: SchemaField[] = [
      { id: "name", label: "Name", fieldType: "text" },
      { id: "description", label: "Description", fieldType: "textarea" },
      { id: "tags", label: "Tags", fieldType: "text" },
      { id: "kind", label: "Kind", fieldType: "text" },
    ];
    const entries: Record<string, SheetListEntry> = {};
    for (const [iid, item] of Object.entries(itemCatalog)) {
      const effects = migrateEffectsList(item.effects);
      entries[iid] = {
        id: item.id,
        values: {
          name: item.name,
          description: item.description ?? "",
          tags: (item.tags ?? []).join(", "),
          kind: item.kind,
        },
        ...(effects?.length ? { effects } : {}),
      };
    }
    lists.equipment = { id: "equipment", sheetTitle: "Equipment", fields, entries };
  }

  return lists;
}

const NUMERIC_STAT_OPTIONAL_ALL: NumericStatOptionalColumn[] = ["name", "sheetNote"];

function normalizeNumericStatColumns(
  raw: RpgSystem["numericStatColumns"] | undefined
): RpgSystem["numericStatColumns"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: NumericStatColumnPrefs = {};
  for (const key of ["modifiers", "other"] as const) {
    const arr = raw[key];
    if (!Array.isArray(arr)) continue;
    const filt = arr.filter((x): x is NumericStatOptionalColumn => x === "name" || x === "sheetNote");
    const hasAll =
      filt.length === NUMERIC_STAT_OPTIONAL_ALL.length &&
      NUMERIC_STAT_OPTIONAL_ALL.every((c) => filt.includes(c));
    if (hasAll) continue;
    out[key] = filt;
  }
  if (out.modifiers === undefined && out.other === undefined) return undefined;
  return out;
}

/** Accepts legacy exports (races/classes, nature/background, labels) and returns current shape */
export function normalizeSystem(raw: unknown): RpgSystem {
  if (!raw || typeof raw !== "object") throw new Error("Invalid system");
  const o = raw as Record<string, unknown>;

  const id = String(o.id ?? "");
  const name = String(o.name ?? "");
  if (!id || !name) throw new Error("System requires id and name");

  const stats = normalizeStatEntries(o.stats);

  const statGenerationMethod = (o.statGenerationMethod ??
    o.abilityScoreMethod ?? { kind: "fixed_defaults" }) as StatGenerationMethod;

  const defaultResources: ResourceDefinition[] = [
    { id: "hp", name: "Hit Points", defaultValue: 6 },
    { id: "devils_luck", name: "Devil's Luck", defaultValue: 0 },
  ];
  const resources = Array.isArray(o.resources)
    ? normalizeResourceEntries(o.resources, defaultResources)
    : defaultResources;

  const tablesRaw = o.tables;
  const tablesIn = tablesRaw && typeof tablesRaw === "object" ? (tablesRaw as Record<string, RollTable>) : {};
  const tables: Record<string, RollTable> = {};
  for (const [tid, t] of Object.entries(tablesIn)) {
    const extraColumns = normalizeRollTableExtraColumns(t.extraColumns);
    const tidNorm = t.id ?? tid;
    const row: RollTable = {
      ...t,
      id: tidNorm,
      name: t.name ?? tid,
      options: Array.isArray(t.options) ? t.options.map(normalizeTableOption) : [],
    };
    if (extraColumns.length) row.extraColumns = extraColumns;
    else delete row.extraColumns;
    tables[tid] = row;
  }

  const archetypeGroups = normalizeArchetypeGroups(o);

  let sheetLists: Record<string, SheetListDefinition>;
  if (o.sheetLists !== undefined && o.sheetLists !== null && typeof o.sheetLists === "object") {
    sheetLists = normalizeSheetListsFromRaw(o.sheetLists);
  } else {
    sheetLists = buildLegacySheetLists(o);
  }

  const startingGear = normalizeStartingGear(o.startingGear as RpgSystem["startingGear"] | undefined);
  const systemDocs = o.systemDocs as RpgSystem["systemDocs"] | undefined;

  const numericStatColumns = normalizeNumericStatColumns(
    o.numericStatColumns as RpgSystem["numericStatColumns"] | undefined
  );

  const studioExtraColumns = normalizeStudioExtraColumns(o.studioExtraColumns);

  const stRaw = o.sharedTraits;
  const sharedTraits = normalizeSharedTraitsRecord(stRaw);

  const out: RpgSystem = {
    id,
    name,
    archetypeGroups,
    statGenerationMethod,
    stats,
    resources,
    sheetLists,
    tables,
    sharedTraits,
    startingGear,
    systemDocs,
    ...(numericStatColumns && Object.keys(numericStatColumns).length ? { numericStatColumns } : {}),
    ...(studioExtraColumns ? { studioExtraColumns } : {}),
  };
  synchronizeRollTableLibraryMeta(out);
  return out;
}

function normalizeRollTableExtraColumns(raw: unknown): RollTableExtraColumn[] {
  if (!Array.isArray(raw)) return [];
  const out: RollTableExtraColumn[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    const cid = String(r.id ?? "").trim();
    if (!cid) continue;
    const label = String(r.label ?? cid).trim() || cid;
    const ft = r.fieldType === "number" || r.fieldType === "textarea" ? r.fieldType : "text";
    out.push({ id: cid, label, fieldType: ft });
  }
  return out;
}

function normalizeStudioExtraColumns(raw: unknown): StudioExtraColumnBundle | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const nm = normalizeRollTableExtraColumns(r.numericModifiers);
  const no = normalizeRollTableExtraColumns(r.numericOther);
  const tr = normalizeRollTableExtraColumns(r.traits);
  const lo = normalizeRollTableExtraColumns(r.loadout);
  const out: StudioExtraColumnBundle = {};
  if (nm.length) out.numericModifiers = nm;
  if (no.length) out.numericOther = no;
  if (tr.length) out.traits = tr;
  if (lo.length) out.loadout = lo;
  if (!out.numericModifiers && !out.numericOther && !out.traits && !out.loadout) return undefined;
  return out;
}

function normalizeTableOption(raw: unknown): TableOption {
  if (!raw || typeof raw !== "object") return { label: "Outcome", weight: 1 };
  const o = raw as Record<string, unknown>;
  const label = String(o.label ?? "Outcome").trim() || "Outcome";
  const w = Number(o.weight ?? 1);
  const weight = Number.isFinite(w) && w > 0 ? w : 1;
  const description = typeof o.description === "string" ? o.description.trim() : "";
  const effects = migrateEffectsList(o.effects);
  const extraRaw = o.extra;
  let extra: Record<string, string | number> | undefined;
  if (extraRaw && typeof extraRaw === "object" && !Array.isArray(extraRaw)) {
    extra = {};
    for (const [k, v] of Object.entries(extraRaw as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) extra[k] = v;
      else if (typeof v === "string") extra[k] = v;
    }
    if (Object.keys(extra).length === 0) extra = undefined;
  }
  return {
    label,
    weight,
    ...(description ? { description } : {}),
    ...(effects?.length ? { effects } : {}),
    ...(extra ? { extra } : {}),
  };
}

export function normalizeStartingGear(
  sg: RpgSystem["startingGear"] | undefined
): RpgSystem["startingGear"] | undefined {
  if (!sg) return undefined;
  const enabled = Boolean(sg.enabled);
  const rawLo = sg.loadout;
  if (Array.isArray(rawLo) && rawLo.length > 0) {
    const loadout = rawLo
      .map((x) => {
        const ex = normalizeRowExtraMap((x as LoadoutEntry).extra);
        return {
          tableId: String((x as LoadoutEntry).tableId ?? "").trim(),
          rolls: Math.max(0, Math.floor(Number((x as LoadoutEntry).rolls) || 0)),
          mode: (x as LoadoutEntry).mode === "once" ? ("once" as const) : ("repeat" as const),
          ...(ex ? { extra: ex } : {}),
        };
      })
      .filter((x) => x.tableId);
    return { enabled, loadout };
  }
  const tid = sg.tableId?.trim() ?? "";
  const rolls = Math.max(0, Math.floor(Number(sg.rolls) ?? 0));
  if (tid) {
    return { enabled, loadout: [{ tableId: tid, rolls: rolls || 1, mode: "repeat" as const }] };
  }
  return { enabled, loadout: [] };
}

/** Archetype options that include `tableId` in `tableRolls` (Extra rolls). */
export function tableRollLinksForTable(w: RpgSystem, tableId: string): { groupId: string; optionId: string }[] {
  const links: { groupId: string; optionId: string }[] = [];
  for (const g of w.archetypeGroups) {
    for (const o of g.options) {
      if (o.tableRolls?.includes(tableId)) links.push({ groupId: g.id, optionId: o.id });
    }
  }
  return links;
}

/**
 * Sets each table’s `libraryKind` / `linkedPath` from dimension `tableRolls` only:
 * exactly one link → archetype + linkedPath; otherwise general and no linkedPath.
 */
export function synchronizeRollTableLibraryMeta(w: RpgSystem, onlyTableId?: string): void {
  const ids = onlyTableId ? [onlyTableId] : Object.keys(w.tables);
  for (const tid of ids) {
    const t = w.tables[tid];
    if (!t) continue;
    const links = tableRollLinksForTable(w, tid);
    let kind: TableLibraryKind = "general";
    if (links.length === 1) {
      kind = "archetype";
      t.linkedPath = { groupId: links[0]!.groupId, optionId: links[0]!.optionId };
    } else {
      delete t.linkedPath;
    }
    t.libraryKind = kind;
  }
}

function normalizeGroupOverviewColumns(raw: unknown): DimensionOverviewColumnId[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const allowed = new Set<string>(DIMENSION_OVERVIEW_COLUMN_ORDER);
  const picked = new Set(raw.map((x) => String(x)).filter((x) => allowed.has(x)));
  const ordered = DIMENSION_OVERVIEW_COLUMN_ORDER.filter((c) => picked.has(c));
  if (ordered.length === 0 || ordered.length === DIMENSION_OVERVIEW_COLUMN_ORDER.length) {
    return undefined;
  }
  return ordered;
}

function normalizeArchetypeGroups(o: Record<string, unknown>): ArchetypeGroup[] {
  const existing = o.archetypeGroups as ArchetypeGroup[] | undefined;
  if (Array.isArray(existing)) {
    return existing.map((g) => {
      const overviewColumns = normalizeGroupOverviewColumns(g.overviewColumns);
      const oec = normalizeRollTableExtraColumns(g.optionExtraColumns);
      return {
        id: g.id,
        label: g.label,
        options: Array.isArray(g.options) ? g.options.map(normalizeOption) : [],
        ...(overviewColumns ? { overviewColumns } : {}),
        ...(oec.length ? { optionExtraColumns: oec } : {}),
      };
    });
  }

  const labelsIn = (o.labels ?? {}) as Record<string, unknown>;
  const raceLabel = String(labelsIn.race ?? labelsIn.nature ?? "Race");
  const classLabel = String(labelsIn.class ?? labelsIn.background ?? "Class");

  const races = (o.races ?? o.natures) as LegacyArchetype[] | undefined;
  const classes = (o.classes ?? o.backgrounds) as LegacyArchetype[] | undefined;

  if (Array.isArray(races) && Array.isArray(classes)) {
    return [
      { id: "race", label: raceLabel, options: races.map(normalizeOption) },
      { id: "class", label: classLabel, options: classes.map(normalizeOption) },
    ];
  }

  throw new Error(
    "System needs archetypeGroups[], or legacy races+natures and classes+backgrounds arrays"
  );
}

function normalizeStatModRow(raw: unknown): ArchetypeStatModRow | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const statId = String(o.statId ?? "").trim();
  if (!statId) return null;
  const amount = Number(o.amount ?? 0);
  const ex = normalizeRowExtraMap(o.extra);
  return {
    statId,
    amount: Number.isFinite(amount) ? amount : 0,
    ...(ex ? { extra: ex } : {}),
  };
}

function normalizeResourceModRow(raw: unknown): ArchetypeResourceModRow | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const resourceId = String(o.resourceId ?? "").trim();
  if (!resourceId) return null;
  const amount = Number(o.amount ?? 0);
  const ex = normalizeRowExtraMap(o.extra);
  return {
    resourceId,
    amount: Number.isFinite(amount) ? amount : 0,
    ...(ex ? { extra: ex } : {}),
  };
}

function normalizeOption(opt: ArchetypeOption): ArchetypeOption {
  const ex = normalizeRowExtraMap(opt.extra);
  const statMods = Array.isArray(opt.statMods)
    ? opt.statMods.map(normalizeStatModRow).filter((x): x is ArchetypeStatModRow => x != null)
    : [];
  const resourceMods = Array.isArray(opt.resourceMods)
    ? opt.resourceMods.map(normalizeResourceModRow).filter((x): x is ArchetypeResourceModRow => x != null)
    : [];
  const smc = normalizeRollTableExtraColumns(opt.statModExtraColumns);
  const rmc = normalizeRollTableExtraColumns(opt.resourceModExtraColumns);
  return {
    id: opt.id,
    name: opt.name,
    description: opt.description,
    ...(statMods.length ? { statMods } : {}),
    ...(resourceMods.length ? { resourceMods } : {}),
    ...(smc.length ? { statModExtraColumns: smc } : {}),
    ...(rmc.length ? { resourceModExtraColumns: rmc } : {}),
    tableRolls: opt.tableRolls,
    sharedTraitRefs: Array.isArray(opt.sharedTraitRefs)
      ? opt.sharedTraitRefs.map((x) => String(x)).filter(Boolean)
      : undefined,
    ...(ex ? { extra: ex } : {}),
  };
}
