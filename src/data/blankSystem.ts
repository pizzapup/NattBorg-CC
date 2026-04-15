import type { RpgSystem } from "../types";
import { normalizeSystem } from "../migrate";

/** Minimal system: empty numbers sheet; add dimensions, tables, lists, and stats/pools as you go. */
export function createBlankSystem(): RpgSystem {
  const id = `game_${Date.now().toString(36)}`;
  return normalizeSystem({
    id,
    name: "New game system",
    archetypeGroups: [],
    statGenerationMethod: { kind: "fixed_defaults" },
    stats: [],
    resources: [],
    sheetLists: {},
    tables: {},
    sharedTraits: {},
    systemDocs: {
      overview:
        "Describe your setting here. Under **Character → Numeric stats**, add modifiers (e.g. ability-style scores) and other numeric rows (HP, metacurrency, …)—nothing is predefined. Add **Dimensions** for character choices, **Roll tables** for random results, **Content → Lists** for registry rows, **Character sheet** for what prints, and **Content → Starting gear** for chargen rolls.",
      designerNotes: "",
    },
  });
}
