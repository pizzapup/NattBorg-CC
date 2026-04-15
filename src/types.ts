/** Fixed character sheet areas (prose sections). */
export type CoreSheetSlot = "description" | "traits" | "special" | "notes";

/**
 * Designer-defined list blocks use <code>list:&lt;id&gt;</code> (see <code>sheetLists</code>).
 * @example list:weapons
 */
export type SheetListSlot = `list:${string}`;

/** Any block on the generated character sheet. */
export type SheetSlot = CoreSheetSlot | SheetListSlot;

export function sheetListBlockId(listId: string): SheetListSlot {
  return `list:${listId}`;
}

/** How stat scores are set at generation time */
export type StatGenerationMethod =
  | { kind: "fixed_defaults" }
  | { kind: "nattborg_lesser" }
  | { kind: "placeholder"; note: string };

export type StatDefinition = {
  id: string;
  name: string;
  defaultValue: number;
  /**
   * Optional text on the printed sheet under this score (how it is used, formulas in plain language, etc.).
   */
  sheetExplanation?: string;
  /**
   * Designer-defined columns on the Numeric stats grid (see <code>RpgSystem.studioExtraColumns</code>).
   */
  extra?: Record<string, string | number>;
};

export type ResourceDefinition = {
  id: string;
  name: string;
  defaultValue: number;
  /**
   * Optional text on the printed sheet under this pool (e.g. how max HP is built from stats and choices).
   */
  sheetExplanation?: string;
  /**
   * Designer-defined columns on the Numeric stats grid (see <code>RpgSystem.studioExtraColumns</code>).
   */
  extra?: Record<string, string | number>;
};

/** Permanent = baked in at chargen from defaults and dimension picks; conditional = tables, gear, item effects, … */
export type ModifierScope = "permanent" | "conditional";

export type StatModifier = {
  statId: string;
  amount: number;
  source: string;
  scope: ModifierScope;
};

export type ResourceModifier = {
  resourceId: string;
  amount: number;
  source: string;
  scope: ModifierScope;
};

/** Designer-defined columns for a sheet list (dmg, range, tags, …) */
export type SchemaField = {
  id: string;
  label: string;
  fieldType: "text" | "number" | "textarea";
};

/** Shared shape for spreadsheet-style column defs in the studio (roll outcomes, numeric rows, lists, …). */
export type RollTableExtraColumn = {
  id: string;
  label: string;
  fieldType: "text" | "number" | "textarea";
};

/** One row in a designer-defined sheet list (weapons, gear, spells, …). */
export type SheetListEntry = {
  id: string;
  values: Record<string, string | number>;
  /** Optional nested effects when this entry is granted (e.g. loot that also modifies stats). */
  effects?: Effect[];
};

/**
 * A named list printed under <code>sheetTitle</code> on the character sheet.
 * Either mirror a roll table (table-first: pick table + which outcome columns to show) or define custom columns and rows.
 */
export type SheetListDefinition = {
  id: string;
  /** Section heading on the printed sheet */
  sheetTitle: string;
  /**
   * When set, each row is an outcome from this roll table (by index). Use <code>sheetDisplayColumns</code> for which fields print.
   * When unset, use <code>fields</code> + <code>entries</code> only.
   */
  sourceTableId?: string;
  /**
   * For table-backed lists: which parts of each outcome appear on the sheet, in order.
   * Use <code>label</code>, <code>description</code>, or <code>extra:&lt;id&gt;</code> matching <code>RollTable.extraColumns</code>.
   * If omitted, defaults to label + description.
   */
  sheetDisplayColumns?: string[];
  /** Custom lists: column definitions (ignored when <code>sourceTableId</code> is set). */
  fields: SchemaField[];
  /** Custom lists: rows by id (ignored when <code>sourceTableId</code> is set). */
  entries: Record<string, SheetListEntry>;
};

/** Reusable term definition (tag, species rule, keyword, …) referenced from multiple dimension options */
export type SharedTraitDefinition = {
  id: string;
  name: string;
  description: string;
  /** Designer-defined columns (see <code>RpgSystem.studioExtraColumns.traits</code>). */
  extra?: Record<string, string | number>;
};

/** One score adjustment row on a dimension choice (studio may add custom columns). */
export type ArchetypeStatModRow = {
  statId: string;
  amount: number;
  extra?: Record<string, string | number>;
};

/** One pool adjustment row on a dimension choice (studio may add custom columns). */
export type ArchetypeResourceModRow = {
  resourceId: string;
  amount: number;
  extra?: Record<string, string | number>;
};

/** One choice inside a character dimension (e.g. one Nature, one Background) */
export type ArchetypeOption = {
  id: string;
  name: string;
  description?: string;
  statMods?: ArchetypeStatModRow[];
  resourceMods?: ArchetypeResourceModRow[];
  /** Studio: extra columns on the Score changes grid for this choice. */
  statModExtraColumns?: RollTableExtraColumn[];
  /** Studio: extra columns on the Pool changes grid for this choice. */
  resourceModExtraColumns?: RollTableExtraColumn[];
  /** Roll these tables when this option is part of the character */
  tableRolls?: string[];
  /** Keys into `sharedTraits` (term-definition library) — same entry can appear on several options */
  sharedTraitRefs?: string[];
  /** Designer-defined columns on the dimension overview (see <code>ArchetypeGroup.optionExtraColumns</code>). */
  extra?: Record<string, string | number>;
};

/** Columns available for the dimension overview spreadsheet (order is fixed; visibility is per dimension). */
export type DimensionOverviewColumnId =
  | "id"
  | "name"
  | "desc"
  | "stats"
  | "resources"
  | "traits"
  | "tables";

export const DIMENSION_OVERVIEW_COLUMN_ORDER: DimensionOverviewColumnId[] = [
  "id",
  "name",
  "desc",
  "stats",
  "resources",
  "traits",
  "tables",
];

/** A character dimension: “Race”, “Class”, “Path”, or a single “Hero” bucket if you only need one list */
export type ArchetypeGroup = {
  id: string;
  label: string;
  options: ArchetypeOption[];
  /**
   * Which overview columns to show, in canonical order.
   * Omit or use full list = default (all columns).
   */
  overviewColumns?: DimensionOverviewColumnId[];
  /** Optional custom columns on the dimension option overview grid (studio only). */
  optionExtraColumns?: RollTableExtraColumn[];
};

/**
 * Roll tables: `libraryKind` organizes the CMS (general loot vs tied to an archetype option).
 * `linkedPath` is optional metadata for designers; rolls still come from `tableRolls` on options.
 */
export type TableLibraryKind = "general" | "archetype";

export type TableOption = {
  weight?: number;
  label: string;
  description?: string;
  effects?: Effect[];
  /** Values for designer-defined outcome columns (see <code>RollTable.extraColumns</code>). */
  extra?: Record<string, string | number>;
};

export type RollTable = {
  id: string;
  name: string;
  options: TableOption[];
  /** Optional spreadsheet-style columns per outcome row. */
  extraColumns?: RollTableExtraColumn[];
  /** Filled from dimension <code>tableRolls</code> by <code>synchronizeRollTableLibraryMeta</code>. */
  libraryKind?: TableLibraryKind;
  /** Set when exactly one choice lists this table in <code>tableRolls</code>; cleared when zero or many. */
  linkedPath?: { groupId: string; optionId: string };
  /**
   * When true, the full outcome list is printed on the generated character sheet (in-play reference).
   * Chargen-only tables (rolled once at creation) usually leave this off.
   */
  includeOnCharacterSheet?: boolean;
  /**
   * Optional sidebar section label (e.g. “Automaton”, “Nature”). Tables with the same label are grouped in a collapsible block.
   */
  sidebarCategory?: string;
};

/** Optional columns on numeric stat tables in the studio (id + start value are always shown). */
export type NumericStatOptionalColumn = "name" | "sheetNote";

export type NumericStatColumnPrefs = {
  /** Applies to the modifiers (<code>stats</code>) table. Omitted = all optional columns visible. */
  modifiers?: NumericStatOptionalColumn[];
  /** Applies to the other numeric stats (<code>resources</code>) table. */
  other?: NumericStatOptionalColumn[];
};

/** Studio-only extra column defs for grids other than roll-table outcomes. */
export type StudioExtraColumnBundle = {
  numericModifiers?: RollTableExtraColumn[];
  numericOther?: RollTableExtraColumn[];
  traits?: RollTableExtraColumn[];
  /** Starting gear loadout grid (studio only). */
  loadout?: RollTableExtraColumn[];
};

export type Effect =
  | { type: "stat_mod"; statId: string; amount: number }
  | {
      type: "sheet_text";
      slot: SheetSlot;
      text: string;
      append?: boolean;
    }
  /** Append one line to a sheet list (free text; no registry row). */
  | { type: "sheet_list_line"; listId: string; text: string }
  /** Grant a row from a designer-defined sheet list (<code>sheetLists[listId]</code>). */
  | {
      type: "sheet_list_ref";
      listId: string;
      entryId: string;
      displayName?: string;
      displayDescription?: string;
    }
  /** One line on the character sheet’s term-definitions block (<code>traits</code> slot). */
  | { type: "trait"; text: string }
  | { type: "special"; text: string }
  | { type: "resource_mod"; resourceId: string; amount: number }
  | { type: "roll_table"; tableId: string; label?: string };

/** One line in the starting loadout: roll a roll-definition N times, or a single draw. */
export type LoadoutEntry = {
  tableId: string;
  rolls: number;
  /** repeat: roll `rolls` times from this table; once: roll once (rolls should be 1) */
  mode?: "repeat" | "once";
  /** Designer-defined columns (see <code>RpgSystem.studioExtraColumns.loadout</code>). */
  extra?: Record<string, string | number>;
};

export type StartingGearRule = {
  enabled: boolean;
  /** Preferred: several roll definitions, each with its own count */
  loadout?: LoadoutEntry[];
  /** @deprecated — migrated into `loadout` by normalizeSystem */
  rolls?: number;
  tableId?: string;
};

export type SystemDocs = {
  overview?: string;
  designerNotes?: string;
};

export type RpgSystem = {
  id: string;
  name: string;
  /** Character dimensions (any number:0…n). Legacy importers may omit; migration supplies defaults. */
  archetypeGroups: ArchetypeGroup[];
  statGenerationMethod: StatGenerationMethod;
  stats: StatDefinition[];
  resources: ResourceDefinition[];
  /**
   * Sheet sections: either mirror a roll table (pick table + columns) or custom fields/rows.
   * Effects use <code>sheet_list_ref</code> (row = table outcome index when table-backed) / <code>sheet_list_line</code>.
   */
  sheetLists: Record<string, SheetListDefinition>;
  tables: Record<string, RollTable>;
  /** Library of reusable term definitions (referenced from dimension options) */
  sharedTraits?: Record<string, SharedTraitDefinition>;
  startingGear?: StartingGearRule;
  systemDocs?: SystemDocs;
  /** Studio: which optional columns to show on numeric stat tables. */
  numericStatColumns?: NumericStatColumnPrefs;
  /** Studio: designer-defined extra columns on numeric stats, traits, etc. */
  studioExtraColumns?: StudioExtraColumnBundle;
};

export type GeneratedBlock = {
  slot: SheetSlot;
  title?: string;
  lines: string[];
};

/** Full roll table printed on the sheet when <code>RollTable.includeOnCharacterSheet</code> is set. */
export type GeneratedRollTableReference = {
  tableId: string;
  name: string;
  lines: string[];
};

export type ArchetypePick = {
  groupId: string;
  groupLabel: string;
  option: ArchetypeOption;
};

export type GeneratedCharacter = {
  systemId: string;
  systemName: string;
  archetypePicks: ArchetypePick[];
  stats: Record<string, number>;
  resources: Record<string, number>;
  statBreakdown: StatModifier[];
  resourceBreakdown: ResourceModifier[];
  statRollLog: string[];
  blocks: GeneratedBlock[];
  /** In-play reference: full tables marked <code>includeOnCharacterSheet</code> on the system. */
  referenceTables?: GeneratedRollTableReference[];
  rollLog: string[];
};

/** @deprecated Use statGenerationMethod */
export type AbilityScoreMethod = StatGenerationMethod;
