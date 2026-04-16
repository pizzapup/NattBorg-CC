import type { RpgSystem } from "../types";
import { normalizeSystem } from "../migrate";
import { createDefaultStudioV2 } from "../studio/v2";

/** Minimal system: empty numbers sheet; add dimensions, tables, lists, and stats/pools as you go. */
export function createBlankSystem(): RpgSystem {
  const id = `game_${Date.now().toString(36)}`;
  return normalizeSystem({
    id,
    name: "New game system",
    description: "",
    creator: { name: "", contact: "" },
    tags: [],
    studioV2: createDefaultStudioV2(),
    archetypeGroups: [],
    statGenerationMethod: { kind: "fixed_defaults" },
    stats: [],
    resources: [
      { id: "hp", name: "HP", defaultValue: 0 },
      { id: "gold", name: "Gold", defaultValue: 0 },
    ],
    sheetLists: {},
    tables: {},
    sharedTraits: {},
    systemDocs: {
      overview:
        "Describe your setting here. Under **Tracked values**, define stats and other numeric values (HP, Gold, metacurrency, etc.). Add **Dimensions** for character choices, **Tables** for random results, **Building blocks → Libraries** for reusable entries, and **Sheet layout** for what prints.",
      designerNotes: "",
    },
  });
}
