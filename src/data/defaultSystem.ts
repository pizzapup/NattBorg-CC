import type { RpgSystem } from "../types";
import { createDefaultStudioV2 } from "../studio/v2";

/** Generic fantasy-flavored starter: classic six abilities, ancestry + class, starter gear — replace or extend for any setting. */
export const DEFAULT_SYSTEM: RpgSystem = {
  id: "generic_rpg",
  name: "Generic fantasy RPG (starter)",
  description: "A starter project that demonstrates dimensions, tracked values, libraries, and effects.",
  creator: { name: "", contact: "" },
  tags: ["fantasy", "starter"],
  studioV2: createDefaultStudioV2(),
  archetypeGroups: [
    {
      id: "ancestry",
      label: "Ancestry",
      options: [
        {
          id: "human",
          name: "Human",
          description: "Adaptable and widespread; tweak to match your setting.",
          statMods: [{ statId: "cha", amount: 1 }],
        },
        {
          id: "dwarf",
          name: "Dwarf",
          description: "Sturdy folk of stone and forge; rename for any hardy lineage.",
          statMods: [{ statId: "con", amount: 1 }],
          sharedTraitRefs: ["darkvision"],
        },
        {
          id: "elf",
          name: "Elf",
          description: "Keen senses and long memory; swap for any graceful people.",
          statMods: [{ statId: "dex", amount: 1 }],
          sharedTraitRefs: ["darkvision"],
        },
      ],
    },
    {
      id: "class",
      label: "Class",
      options: [
        {
          id: "fighter",
          name: "Fighter",
          description: "Trained for front-line action.",
          statMods: [{ statId: "str", amount: 1 }],
          resourceMods: [{ resourceId: "hp", amount: 2 }],
        },
        {
          id: "rogue",
          name: "Rogue",
          description: "Sneaking, scouting, and sudden strikes.",
          statMods: [{ statId: "dex", amount: 1 }],
        },
        {
          id: "wizard",
          name: "Wizard",
          description: "Schooled in arcane patterns.",
          statMods: [{ statId: "int", amount: 1 }],
          resourceMods: [{ resourceId: "mp", amount: 2 }],
          tableRolls: ["arcane_focus"],
        },
      ],
    },
  ],
  statGenerationMethod: { kind: "fixed_defaults" },
  stats: [
    {
      id: "str",
      name: "Strength",
      defaultValue: 10,
      sheetExplanation: "Physical power, melee, heavy gear. Rescale (e.g. 0–5) if your game uses smaller numbers.",
    },
    {
      id: "dex",
      name: "Dexterity",
      defaultValue: 10,
      sheetExplanation: "Agility, reflexes, ranged attacks, stealth.",
    },
    {
      id: "con",
      name: "Constitution",
      defaultValue: 10,
      sheetExplanation: "Endurance, health, resisting poison and fatigue.",
    },
    {
      id: "int",
      name: "Intelligence",
      defaultValue: 10,
      sheetExplanation: "Reasoning, lore, crafting, arcane study.",
    },
    {
      id: "wis",
      name: "Wisdom",
      defaultValue: 10,
      sheetExplanation: "Awareness, intuition, survival, divine insight.",
    },
    {
      id: "cha",
      name: "Charisma",
      defaultValue: 10,
      sheetExplanation: "Force of personality, leadership, social sway.",
    },
  ],
  resources: [
    {
      id: "hp",
      name: "Hit points",
      defaultValue: 0,
      sheetExplanation: "Injury buffer; tie max HP to class and CON in your rules.",
    },
    {
      id: "gold",
      name: "Gold",
      defaultValue: 0,
      sheetExplanation: "Starting currency. Keep this, rename it, or swap it for your own economy pool.",
    },
  ],
  sharedTraits: {
    darkvision: {
      id: "darkvision",
      name: "Darkvision",
      description: "Treat dim light within 60 ft as bright light for you (adjust range to taste).",
    },
  },
  sheetLists: {
    weapons: {
      id: "weapons",
      sheetTitle: "Weapons",
      fields: [
        { id: "name", label: "Name", fieldType: "text" },
        { id: "damage", label: "Damage", fieldType: "text" },
        { id: "notes", label: "Notes", fieldType: "textarea" },
      ],
      entries: {
        shortsword: {
          id: "shortsword",
          values: {
            name: "Shortsword",
            damage: "1d6",
            notes: "One-handed melee.",
          },
        },
        dagger: {
          id: "dagger",
          values: {
            name: "Dagger",
            damage: "1d4",
            notes: "Light, concealable, throwable.",
          },
        },
        quarterstaff: {
          id: "quarterstaff",
          values: {
            name: "Quarterstaff",
            damage: "1d6",
            notes: "Two-handed simple weapon.",
          },
        },
      },
    },
    equipment: {
      id: "equipment",
      sheetTitle: "Equipment",
      fields: [
        { id: "name", label: "Name", fieldType: "text" },
        { id: "description", label: "Description", fieldType: "textarea" },
      ],
      entries: {
        explorers_pack: {
          id: "explorers_pack",
          values: {
            name: "Explorer's pack",
            description: "Backpack, bedroll, mess kit, tinderbox, 10 torches, 10 days rations, waterskin, 50 ft rope.",
          },
        },
        leather_armor: {
          id: "leather_armor",
          values: {
            name: "Leather armor",
            description: "Light protection; rename AC rule to match your system.",
          },
        },
      },
    },
  },
  tables: {
    arcane_focus: {
      id: "arcane_focus",
      name: "Arcane focus",
      options: [
        {
          weight: 1,
          label: "Orb",
          description: "Crystal sphere; easy to stow, hard to hide as mundane.",
          effects: [
            {
              type: "sheet_list_line",
              listId: "equipment",
              text: "Arcane orb — focus for spellcasting.",
            },
          ],
        },
        {
          weight: 1,
          label: "Staff",
          description: "Doubles as a walking stick.",
          effects: [{ type: "sheet_list_ref", listId: "weapons", entryId: "quarterstaff" }],
        },
        {
          weight: 1,
          label: "Worn talisman",
          description: "Amulet or ring; keeps hands free.",
          effects: [
            {
              type: "sheet_list_line",
              listId: "equipment",
              text: "Spell talisman — worn focus.",
            },
          ],
        },
      ],
    },
    starter_gear: {
      id: "starter_gear",
      name: "Starter supplies",
      libraryKind: "general",
      options: [
        {
          weight: 2,
          label: "Standard kit",
          description: "Basic travel and dungeon essentials.",
          effects: [
            { type: "sheet_list_ref", listId: "equipment", entryId: "explorers_pack" },
            { type: "sheet_list_line", listId: "equipment", text: "Pouch with small coin" },
          ],
        },
        {
          weight: 1,
          label: "War kit",
          description: "Lean toward combat readiness.",
          effects: [
            { type: "sheet_list_ref", listId: "equipment", entryId: "leather_armor" },
            { type: "sheet_list_ref", listId: "weapons", entryId: "shortsword" },
          ],
        },
        {
          weight: 1,
          label: "Scout kit",
          description: "Tools over armor.",
          effects: [
            { type: "sheet_list_ref", listId: "weapons", entryId: "dagger" },
            {
              type: "sheet_list_line",
              listId: "equipment",
              text: "Thieves' tools or equivalent",
            },
          ],
        },
      ],
    },
  },
  startingGear: {
    enabled: true,
    loadout: [{ tableId: "starter_gear", rolls: 1, mode: "once" }],
  },
  systemDocs: {
    overview:
      "Neutral **starter system**: six classic attributes (default 10), **Hit points** and optional **Spell points**, two dimensions (**Ancestry** / **Class**), and small **Weapons** / **Equipment** lists. Rename stats, swap dimensions, or delete what you do not need — nothing here is tied to a single published ruleset.",
    designerNotes:
      "Replace ancestry and class labels for sci-fi, horror, or modern games. Use **fixed_defaults** or switch stat generation in **System → Core**. Hook tables from dimension options via **Extra rolls**.",
  },
};
