import type {
  Effect,
  RpgSystem,
  RollTable,
  SchemaField,
  SharedTraitDefinition,
  SheetListDefinition,
  SheetListEntry,
  StudioV2Config,
  StudioV2Effect,
  TableOption,
} from "../types";

function slugify(raw: string, fallback: string): string {
  const id = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return id || fallback;
}

export function createDefaultStudioV2(): StudioV2Config {
  return {
    projectOverview: {
      description: "",
      creatorName: "",
      creatorContact: "",
      tags: [],
    },
    trackedValues: {
      generationMethod: { kind: "standard_array", values: [15, 14, 13, 12, 10, 8] },
      statUsage: "modifier_only",
      stats: [
        { id: "str", name: "STR", startValue: 0 },
        { id: "agl", name: "AGL", startValue: 0 },
        { id: "pre", name: "PRE", startValue: 0 },
        { id: "tgh", name: "TGH", startValue: 0 },
      ],
      subStats: [],
      otherValues: [
        { id: "hp", name: "HP", startValue: 0 },
        { id: "gold", name: "Gold", startValue: 0 },
      ],
    },
       buildingBlocks: {
      components: [
        {
          id: "race",
          name: "Race",
          options: [{ id: "human", name: "Human" }],
        },
        {
          id: "class",
          name: "Class",
          options: [{ id: "adventurer", name: "Adventurer" }],
        },
      ],
      traits: [],
      tableGroups: [
        { id: "general", name: "General", gainLabel: "result" },
        { id: "weapons", name: "Weapons", gainLabel: "weapon" },
        { id: "inventory", name: "Inventory", gainLabel: "item" },
        { id: "spells", name: "Spells", gainLabel: "spell" },
      ],
      libraries: [
        { id: "weapons", name: "Weapons", category: "weapons", tableGroupId: "weapons", entries: [] },
        { id: "equipment", name: "Equipment", category: "inventory", tableGroupId: "inventory", entries: [] },
        { id: "traits", name: "Traits", tableGroupId: "general", entries: [] },
      ],
      tables: [],
    },
    sheetLayout: {
      includedBlocks: [
        "name",
        "race",
        "class",
        "description",
        "stats",
        "gold",
        "hp",
        "traits",
        "weapons",
        "inventory",
      ],
      customNotes: "",
      tableSections: [],
    },
    projectSettings: {
      visibility: "private",
      handbookEnabled: false,
      handbookVisibility: "unpublished",
    },
  };
}

function makeListFields(): SchemaField[] {
  return [
    { id: "name", label: "Name", fieldType: "text" },
    { id: "description", label: "Description", fieldType: "textarea" },
  ];
}

/** 1-based index lists like <code>1,3,5-8</code> → 0-based indices */
function parseIndexRaw(raw: string | undefined, rowCount: number): Set<number> | undefined {
  if (!raw?.trim() || rowCount <= 0) return undefined;
  const set = new Set<number>();
  for (const part of raw.split(/[\s,]+/).filter(Boolean)) {
    if (part.includes("-")) {
      const [a, b] = part.split("-").map((x) => parseInt(x.trim(), 10));
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (let n = lo; n <= hi; n++) {
        if (n >= 1 && n <= rowCount) set.add(n - 1);
      }
    } else {
      const n = parseInt(part, 10);
      if (n >= 1 && n <= rowCount) set.add(n - 1);
    }
  }
  return set.size ? set : undefined;
}

type V2ConvertContext = {
  v2: StudioV2Config;
  sheetLists: Record<string, SheetListDefinition>;
  tables: Record<string, RollTable>;
};

function mapV2EffectToLegacy(effect: StudioV2Effect, ctx: V2ConvertContext): Effect[] {
  switch (effect.type) {
    case "stat_mod":
      return [{ type: "stat_mod", statId: effect.statId, amount: effect.amount }];
    case "resource_mod":
      return [{ type: "resource_mod", resourceId: effect.trackedValueId, amount: effect.amount }];
    case "sheet_text":
      return [{ type: "sheet_text", slot: effect.slot, text: effect.text, append: true }];
    case "gain_from_table":
      if (effect.mode === "specific" && effect.specificEntryId) {
        return [{ type: "roll_table", tableId: effect.tableId, label: `Gain: ${effect.specificEntryId}` }];
      }
      return [{ type: "roll_table", tableId: effect.tableId }];
    case "gain_from_library": {
      const listId = effect.libraryId;
      if (effect.mode === "specific" && effect.specificEntryId) {
        return [{ type: "sheet_list_ref", listId, entryId: effect.specificEntryId }];
      }
      const baseId = `lib_pick_${listId}`;
      const ranged =
        effect.mode === "range_random"
          ? `${baseId}_${effect.minIndex ?? 1}_${effect.maxIndex ?? 999}`
          : baseId;
      if (!ctx.tables[ranged]) {
        const lib = ctx.v2.buildingBlocks.libraries.find((x) => x.id === listId);
        const entries = lib?.entries ?? [];
        const min = Math.max(1, effect.minIndex ?? 1) - 1;
        const maxIndex = effect.maxIndex ?? entries.length;
        const max = Math.max(min, maxIndex - 1);
        const subset = entries.slice(min, max + 1);
        const options: TableOption[] = (subset.length ? subset : entries).map((entry) => ({
          label: entry.name,
          description: entry.description,
          effects: [{ type: "sheet_list_ref", listId, entryId: entry.id }],
        }));
        ctx.tables[ranged] = {
          id: ranged,
          name: `Pick from ${lib?.name ?? listId}`,
          options,
          libraryKind: "general",
        };
      }
      return [{ type: "roll_table", tableId: ranged }];
    }
    default:
      return [];
  }
}

export function applyStudioV2ToSystem(system: RpgSystem): RpgSystem {
  const v2 = system.studioV2;
  if (!v2) return system;

  const sheetLists: Record<string, SheetListDefinition> = {};
  for (const lib of v2.buildingBlocks.libraries) {
    const listId = slugify(lib.id || lib.name, "library");
    const entries: Record<string, SheetListEntry> = {};
    for (const entry of lib.entries) {
      entries[entry.id] = {
        id: entry.id,
        values: {
          name: entry.name,
          description: entry.description ?? "",
          ...(entry.fields ?? {}),
        },
      };
    }
    sheetLists[listId] = {
      id: listId,
      sheetTitle: lib.name,
      fields: makeListFields(),
      entries,
    };
  }

  const tables: Record<string, RollTable> = {};
  const ctx: V2ConvertContext = { v2, sheetLists, tables };
  for (const table of v2.buildingBlocks.tables) {
    const tableId = slugify(table.id || table.name, "table");
    const groupId =
      table.tableGroupId ??
      (table.category === "weapons" ? "weapons" : table.category === "inventory" ? "inventory" : "general");
    tables[tableId] = {
      id: tableId,
      name: table.name,
      options: table.entries.map((entry) => ({
        label: entry.label,
        weight: entry.weight ?? 1,
        description: entry.description,
        extra: { entryId: entry.id },
        effects: (entry.effects ?? []).flatMap((effect) => mapV2EffectToLegacy(effect, ctx)),
      })),
      libraryKind: "general",
      studioCategory: table.category ?? "general",
      studioTableGroupId: groupId,
    };
  }

  for (const sec of v2.sheetLayout.tableSections ?? []) {
    const st = v2.buildingBlocks.tables.find((t) => t.id === sec.studioTableId);
    if (!st) continue;
    const slug = slugify(st.id || st.name, "table");
    if (!tables[slug]) continue;
    const cols: string[] = [];
    if (sec.showLabel !== false) cols.push("label");
    if (sec.showDescription) cols.push("description");
    if (sec.showWeight) cols.push("weight");
    if (cols.length === 0) cols.push("label");
    const listId = slugify(sec.id || sec.title, "sheetsec");
    sheetLists[listId] = {
      id: listId,
      sheetTitle: sec.title,
      sourceTableId: slug,
      sheetDisplayColumns: cols,
      fields: [],
      entries: {},
    };
  }

  const sharedTraitsAcc: Record<string, SharedTraitDefinition> = {};
  for (const tr of v2.buildingBlocks.traits ?? []) {
    sharedTraitsAcc[tr.id] = {
      id: tr.id,
      name: tr.name,
      description: tr.description ?? "",
    };
  }

  const embedSheetRefIds = new Set<string>();

  const archetypeGroups = v2.buildingBlocks.components.map((component) => ({
    id: slugify(component.id || component.name, "component"),
    label: component.name,
    options: component.options.map((option) => {
      const embedRollIds: string[] = [];
      for (const emb of option.embeddedTables ?? []) {
        const embedSlug = slugify(`${component.id}_${option.id}_${emb.id}`, "emb");
        const srcEntries =
          emb.source === "project_table" && emb.projectTableId
            ? v2.buildingBlocks.tables.find((x) => x.id === emb.projectTableId)?.entries ?? []
            : emb.inlineEntries ?? [];
        tables[embedSlug] = {
          id: embedSlug,
          name: emb.name,
          options: srcEntries.map((entry) => ({
            label: entry.label,
            weight: entry.weight ?? 1,
            description: entry.description,
            extra: { entryId: entry.id },
            effects: (entry.effects ?? []).flatMap((effect) => mapV2EffectToLegacy(effect, ctx)),
          })),
          libraryKind: "archetype",
          studioCategory: "general",
          includeOnCharacterSheet: emb.sheetMode === "sheet_reference",
        };
        if (emb.sheetMode === "sheet_reference") embedSheetRefIds.add(embedSlug);
        else embedRollIds.push(embedSlug);
      }

      const statMods = option.statAdjustEnabled
        ? Object.entries(option.statAdjustments ?? {}).map(([statId, amount]) => ({
            statId,
            amount: Number(amount) || 0,
          }))
        : [];
      const resourceMods = option.trackedAdjustEnabled
        ? Object.entries(option.trackedAdjustments ?? {}).map(([resourceId, amount]) => ({
            resourceId,
            amount: Number(amount) || 0,
          }))
        : [];
      const sharedTraitRefs = [...(option.traitRefs ?? [])];
      for (const tn of option.traitNew ?? []) {
        const newId = slugify(`${component.id}_${option.id}_${tn.name}`, "trait");
        if (!sharedTraitsAcc[newId]) {
          sharedTraitsAcc[newId] = {
            id: newId,
            name: tn.name,
            description: tn.description ?? "",
          };
        }
        sharedTraitRefs.push(newId);
      }
      const inventoryGrants =
        option.inventory?.map((inv) => {
          const t = v2.buildingBlocks.tables.find(
            (x) => x.id === inv.tableId || slugify(x.id || x.name, "table") === slugify(inv.tableId, "table"),
          );
          const realId = t ? slugify(t.id || t.name, "table") : slugify(inv.tableId, "table");
          const rowCount = t?.entries.length ?? 0;
          const onlySet = parseIndexRaw(inv.onlyRaw, rowCount);
          const exSet = parseIndexRaw(inv.excludeRaw, rowCount);
          return {
            tableId: realId,
            pick: inv.pick,
            entryId: inv.entryId,
            onlyIndices: onlySet ? [...onlySet] : undefined,
            excludeIndices: exSet ? [...exSet] : undefined,
          };
        }) ?? [];

      return {
        id: option.id,
        name: option.name,
        description: option.description,
        statMods,
        resourceMods,
        tableRolls: embedRollIds.length ? embedRollIds : undefined,
        sharedTraitRefs,
        inventoryGrants: inventoryGrants.length ? inventoryGrants : undefined,
        extra: {},
      };
    }),
  }));

  system.description = v2.projectOverview.description;
  system.creator = {
    name: v2.projectOverview.creatorName,
    contact: v2.projectOverview.creatorContact,
  };
  system.tags = v2.projectOverview.tags;

  system.statGenerationMethod = v2.trackedValues.generationMethod;
  system.statPostProcess = { kind: "none" };
  system.stats = v2.trackedValues.stats.map((s) => ({
    id: s.id,
    name: s.name,
    defaultValue: s.startValue,
    sheetExplanation: s.description,
    extra: {
      ...(s.abbreviation ? { abbreviation: s.abbreviation } : {}),
      ...(s.usesProficiency ? { proficiency: "yes" } : {}),
      ...(s.custom ?? {}),
    },
  }));
  for (const sub of v2.trackedValues.subStats) {
    system.stats.push({
      id: sub.id,
      name: sub.name,
      defaultValue: 0,
      sheetExplanation: sub.description ?? `Derived from ${sub.parentStatId}`,
      extra: {
        parentStatId: sub.parentStatId,
        proficiencyEnabled: sub.proficiencyEnabled ? "yes" : "no",
        ...(sub.custom ?? {}),
      },
    });
  }
  system.resources = v2.trackedValues.otherValues.map((value) => ({
    id: value.id,
    name: value.name,
    defaultValue: value.startValue,
    sheetExplanation: value.description,
    extra: { ...(value.abbreviation ? { abbreviation: value.abbreviation } : {}), ...(value.custom ?? {}) },
  }));
  system.archetypeGroups = archetypeGroups;
  system.tables = tables;
  system.sheetLists = sheetLists;
  system.sharedTraits = sharedTraitsAcc;

  const include = new Set(v2.sheetLayout.includedBlocks.map((x) => x.toLowerCase()));
  for (const table of Object.values(system.tables)) {
    table.includeOnCharacterSheet =
      include.has(table.name.toLowerCase()) || embedSheetRefIds.has(table.id);
  }
  return system;
}

