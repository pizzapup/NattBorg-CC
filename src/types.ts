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

/** Preset dice pipelines (see <code>random_dice</code>). */
export type RandomDicePreset = "4d6_drop_lowest" | "3d6" | "2d6_plus_6";

/** One step in a dice pipeline: roll dice, optionally keep a subset, then aggregate. */
export type DiceRollStage = {
  dice: number;
  sides: number;
  /** Log label; defaults to <code>NdS</code> notation. */
  label?: string;
  /**
   * Which rolled values feed <code>aggregate</code>.
   * Example: 4d6 drop lowest → <code>highest</code> with <code>k: 3</code> and <code>aggregate: "sum"</code>.
   */
  use: { kind: "all" } | { kind: "highest"; k: number } | { kind: "lowest"; k: number };
  aggregate: "sum" | "min" | "max";
};

export type DiceBinOp = "add" | "sub" | "mul" | "div";

/**
 * How to merge dice steps after each stage has produced one number.
 * - Pair: <code>op(stage[left], stage[right])</code> — use for the first operation.
 * - Tail: <code>op(runningResult, stage[right])</code> — use for further +/−/×/÷ (chain).
 */
export type DiceCombineStep =
  | { left: number; right: number; op: DiceBinOp }
  | { right: number; op: DiceBinOp };

/** Multi-step roll; optional combine chain; optional offset at the end. */
export type DicePipeline = {
  stages: DiceRollStage[];
  /**
   * First entry must be a pair (two stage indices). Further entries omit <code>left</code>
   * and combine the running value with <code>stage[right]</code>.
   */
  combines?: DiceCombineStep[];
  /** @deprecated Use <code>combines: [{ left, right, op }]</code> instead. */
  combine?: { left: number; right: number; op: DiceBinOp };
  postOffset?: number;
};

/** How stat scores are set at generation time */
export type StatGenerationMethod =
  | { kind: "fixed_defaults" }
  | { kind: "placeholder"; note: string }
  | { kind: "standard_array"; values: number[]; description?: string }
  | {
      kind: "point_buy";
      budget: number;
      minScore?: number;
      maxScore?: number;
      /** Cost per final score (e.g. 15 → 9). Omitted = common8–15 point-buy table. */
      costs?: Partial<Record<number, number>>;
      /** Player-facing note (e.g. point table prose). */
      tableDescription?: string;
      /** For automated generation only: use each row’s default, or sample a legal spread. */
      autoMode: "use_stat_defaults" | "random_valid";
    }
  | {
      kind: "random_dice";
      repeatPerStat: boolean;
      /** Text formula (e.g. <code>4d6kh3</code>); evaluated when set. Otherwise <code>preset</code> / <code>pipeline</code>. */
      formula?: string;
      preset?: RandomDicePreset;
      pipeline?: DicePipeline;
      description?: string;
    };

/** How a modifier stat is computed from its paired score stat (runs before dimension modifiers). */
export type StatModifierDerive =
  | { kind: "preset"; preset: "dnd_floor" | "identity" | "score_minus_10" }
  | { kind: "linear"; slope: number; intercept: number }
  | { kind: "table"; rows: { score: number; modifier: number }[] };

export type StatScoreModifierPair = {
  scoreStatId: string;
  modifierStatId: string;
  derive: StatModifierDerive;
  /** Printed sheet: show the score in small type next to the modifier, or hide it (modifier-only row). */
  scoreOnSheet: "subtle" | "hidden";
};

/**
 * After base scores are assigned, fill modifier stats from paired score stats.
 * Runs before dimension modifiers are applied.
 */
export type StatPostProcess =
  | { kind: "none" }
  | {
      kind: "score_to_modifier";
      pairs: StatScoreModifierPair[];
    };

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
  /**
   * Weighted inventory / loot picks from roll tables (subset randomization, specific row, etc.).
   * Populated from Studio V2 component options.
   */
  inventoryGrants?: {
    tableId: string;
    pick: "random" | "specific";
    /** Match <code>TableOption.extra.entryId</code> when present */
    entryId?: string;
    /** Inclusive 0-based indices into <code>table.options</code> */
    onlyIndices?: number[];
    excludeIndices?: number[];
  }[];
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

/** Studio V2 roll-table / loot bucket (designer metadata; also copied onto runtime <code>RollTable</code>). */
export type StudioV2TableCategory = "general" | "inventory" | "weapons";

/** Designer-defined bucket for tables (sheet organization, “Gain a …” pickers). */
export type StudioV2TableGroup = {
  id: string;
  name: string;
  /** Short noun for UI, e.g. “weapon”, “spell”. */
  gainLabel?: string;
};

/**
 * Character-sheet list block tied to one roll table: which outcome columns appear when list rows reference table outcomes.
 */
export type StudioV2SheetTableSection = {
  id: string;
  title: string;
  /** Id of a table in <code>buildingBlocks.tables</code>. */
  studioTableId: string;
  showLabel?: boolean;
  showDescription?: boolean;
  showWeight?: boolean;
};

export type StudioV2EmbeddedTableSource = "project_table" | "inline";

/** Optional sub-table on a component instance (e.g. ranger animal companions). */
export type StudioV2OptionEmbeddedTable = {
  id: string;
  name: string;
  description?: string;
  /**
   * <code>chargen_pick_only</code>: roll once at creation; only the chosen row affects the sheet.
   * <code>sheet_reference</code>: print the full outcome list on the sheet for ongoing reference (no chargen roll).
   */
  sheetMode: "chargen_pick_only" | "sheet_reference";
  source: StudioV2EmbeddedTableSource;
  projectTableId?: string;
  inlineEntries?: StudioV2TableEntry[];
};

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
  /** Studio V2 category for filtering inventory picks. */
  studioCategory?: StudioV2TableCategory;
  /** Studio V2 designer group id (<code>buildingBlocks.tableGroups</code>). */
  studioTableGroupId?: string;
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

export type ProjectCreator = {
  name?: string;
  contact?: string;
};

export type StatUsageMode = "modifier_only" | "score_only" | "score_and_modifier";

export type StudioV2Stat = {
  id: string;
  name: string;
  abbreviation?: string;
  startValue: number;
  description?: string;
  usesProficiency?: boolean;
  custom?: Record<string, string | number>;
};

export type StudioV2SubStat = {
  id: string;
  name: string;
  parentStatId: string;
  proficiencyEnabled: boolean;
  description?: string;
  custom?: Record<string, string | number>;
};

export type StudioV2TrackedValue = {
  id: string;
  name: string;
  abbreviation?: string;
  startValue: number;
  description?: string;
  custom?: Record<string, string | number>;
};

export type StudioV2ProjectOverview = {
  description: string;
  creatorName: string;
  creatorContact: string;
  tags: string[];
};

export type StudioV2GenerationMethod =
  | { kind: "fixed_defaults" }
  | { kind: "standard_array"; values: number[]; description?: string }
  | {
      kind: "point_buy";
      budget: number;
      minScore: number;
      maxScore: number;
      costs?: Partial<Record<number, number>>;
      tableDescription?: string;
      autoMode: "use_stat_defaults" | "random_valid";
    }
  | {
      kind: "random_dice";
      repeatPerStat: boolean;
      formula?: string;
      preset?: RandomDicePreset;
      pipeline?: DicePipeline;
      description?: string;
    };

export type StudioV2GainMode = "any_random" | "range_random" | "specific";

export type StudioV2Effect =
  | { type: "stat_mod"; statId: string; amount: number }
  | { type: "resource_mod"; trackedValueId: string; amount: number }
  | {
      type: "gain_from_library";
      libraryId: string;
      mode: StudioV2GainMode;
      minIndex?: number;
      maxIndex?: number;
      specificEntryId?: string;
    }
  | {
      type: "gain_from_table";
      tableId: string;
      mode: StudioV2GainMode;
      minIndex?: number;
      maxIndex?: number;
      specificEntryId?: string;
    }
  | { type: "sheet_text"; slot: SheetSlot; text: string };

export type StudioV2LibraryEntry = {
  id: string;
  name: string;
  description?: string;
  fields?: Record<string, string | number>;
  effects?: StudioV2Effect[];
};

export type StudioV2Library = {
  id: string;
  name: string;
  description?: string;
  /** Loot / gear classification for inventory pick UI */
  category?: StudioV2TableCategory;
  /** Optional designer group (weapons, spells, …) for sheet sections and filters */
  tableGroupId?: string;
  entries: StudioV2LibraryEntry[];
};

export type StudioV2TableEntry = {
  id: string;
  label: string;
  weight?: number;
  description?: string;
  effects?: StudioV2Effect[];
};

export type StudioV2Table = {
  id: string;
  name: string;
  description?: string;
  category?: StudioV2TableCategory;
  tableGroupId?: string;
  entries: StudioV2TableEntry[];
};

/** Reusable trait text referenced from dimension options */
export type StudioV2TraitDefinition = {
  id: string;
  name: string;
  description?: string;
  /** Advanced: legacy effect pipeline for this trait */
  traitEffects?: StudioV2Effect[];
};

export type StudioV2InventoryGrant = {
  tableId: string;
  pick: "random" | "specific";
  entryId?: string;
  /** 1-based row list, e.g. <code>1,3,5-8</code> (only these rows participate when random) */
  onlyRaw?: string;
  excludeRaw?: string;
};

export type StudioV2ComponentOption = {
  id: string;
  name: string;
  description?: string;
  statAdjustEnabled?: boolean;
  statAdjustments?: Record<string, number>;
  trackedAdjustEnabled?: boolean;
  trackedAdjustments?: Record<string, number>;
  traitRefs?: string[];
  traitNew?: { name: string; description?: string }[];
  inventory?: StudioV2InventoryGrant[];
  embeddedTables?: StudioV2OptionEmbeddedTable[];
};

export type StudioV2Component = {
  id: string;
  name: string;
  description?: string;
  options: StudioV2ComponentOption[];
};

export type StudioV2SheetLayoutConfig = {
  includedBlocks: string[];
  customNotes?: string;
  /** Table-backed sheet list sections (weapons block, spells, …) with column visibility. */
  tableSections?: StudioV2SheetTableSection[];
};

export type StudioV2ProjectSettings = {
  visibility: "private" | "public" | "unpublished";
  handbookEnabled: boolean;
  handbookVisibility: "private" | "public" | "unpublished";
  /** Segment in <code>#play/{slug}</code>; defaults to project id when empty. */
  publishSlug?: string;
  /** For private (invite) links: <code>?k=</code> value; generated on first publish if empty. */
  publishInviteKey?: string;
};

export type StudioV2Config = {
  projectOverview: StudioV2ProjectOverview;
  trackedValues: {
    generationMethod: StudioV2GenerationMethod;
    statUsage: StatUsageMode;
    stats: StudioV2Stat[];
    subStats: StudioV2SubStat[];
    otherValues: StudioV2TrackedValue[];
  };
  buildingBlocks: {
    components: StudioV2Component[];
    traits: StudioV2TraitDefinition[];
    /** Groups for organizing tables and driving sheet / “Gain a …” UI */
    tableGroups: StudioV2TableGroup[];
    libraries: StudioV2Library[];
    tables: StudioV2Table[];
  };
  sheetLayout: StudioV2SheetLayoutConfig;
  projectSettings: StudioV2ProjectSettings;
};

/** Created / last-saved timestamps (ISO8601). Set by storage on save. */
export type RpgSystemProjectMeta = {
  createdAt: string;
  updatedAt: string;
  /** Snapshot revision the working copy is aligned with (save-as or restore). */
  activeRevision?: number;
};

export type RpgSystem = {
  id: string;
  name: string;
  description?: string;
  creator?: ProjectCreator;
  tags?: string[];
  /** First save and last edit times; optional on legacy imports until next save. */
  projectMeta?: RpgSystemProjectMeta;
  studioV2?: StudioV2Config;
  /** Character dimensions (any number:0…n). Legacy importers may omit; migration supplies defaults. */
  archetypeGroups: ArchetypeGroup[];
  statGenerationMethod: StatGenerationMethod;
  /** Optional: map ability-style scores to modifier rows after rolling / array / point-buy. */
  statPostProcess?: StatPostProcess;
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

/** Options for <code>generateCharacter</code>. */
export type GenerateCharacterOptions = {
  /** When true, stat roll log includes dice faces and intermediate steps. */
  verboseStatRolls?: boolean;
};

/** @deprecated Use statGenerationMethod */
export type AbilityScoreMethod = StatGenerationMethod;
