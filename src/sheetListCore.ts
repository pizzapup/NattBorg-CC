import type {
  RpgSystem,
  RollTable,
  SchemaField,
  SheetListDefinition,
  SheetListEntry,
  TableOption,
} from "./types";

/** Column keys for table-backed sheet lists. */
export const SHEET_COL_LABEL = "label";
export const SHEET_COL_DESCRIPTION = "description";

export function extraSheetColId(extraColumnId: string): string {
  return `extra:${extraColumnId}`;
}

export function defaultSheetDisplayColumns(): string[] {
  return [SHEET_COL_LABEL, SHEET_COL_DESCRIPTION];
}

export function sheetListDisplayColumns(def: SheetListDefinition): string[] {
  if (!def.sourceTableId) return [];
  if (def.sheetDisplayColumns?.length) return def.sheetDisplayColumns;
  return defaultSheetDisplayColumns();
}

export function displayColumnFields(table: RollTable, cols: string[]): SchemaField[] {
  return cols.map((c) => {
    if (c === SHEET_COL_LABEL) return { id: SHEET_COL_LABEL, label: "Result", fieldType: "text" as const };
    if (c === SHEET_COL_DESCRIPTION)
      return { id: SHEET_COL_DESCRIPTION, label: "Note", fieldType: "textarea" as const };
    const xid = c.startsWith("extra:") ? c.slice("extra:".length) : c;
    const ec = table.extraColumns?.find((x) => x.id === xid);
    return {
      id: xid,
      label: ec?.label ?? xid,
      fieldType: ec?.fieldType === "number" || ec?.fieldType === "textarea" ? ec.fieldType : "text",
    };
  });
}

export function sheetValuesFromTableOption(opt: TableOption, cols: string[]): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const c of cols) {
    if (c === SHEET_COL_LABEL) {
      out[SHEET_COL_LABEL] = opt.label;
    } else if (c === SHEET_COL_DESCRIPTION) {
      out[SHEET_COL_DESCRIPTION] = opt.description ?? "";
    } else if (c.startsWith("extra:")) {
      const id = c.slice("extra:".length);
      const v = opt.extra?.[id];
      if (v !== undefined) out[id] = v;
      else out[id] = "";
    }
  }
  return out;
}

/** Fields used when formatting a sheet line (manual schema or derived from roll table). */
export function getSheetListFields(sys: RpgSystem, listId: string): SchemaField[] {
  const def = sys.sheetLists[listId];
  if (!def) return [];
  if (def.sourceTableId) {
    const t = sys.tables[def.sourceTableId];
    if (!t) return [];
    return displayColumnFields(t, sheetListDisplayColumns(def));
  }
  return def.fields;
}

export function resolveSheetListEntry(
  sys: RpgSystem,
  listId: string,
  entryId: string
): SheetListEntry | undefined {
  const def = sys.sheetLists[listId];
  if (!def) return undefined;
  if (def.sourceTableId) {
    const t = sys.tables[def.sourceTableId];
    if (!t) return undefined;
    const idx = Number(entryId);
    if (!Number.isInteger(idx) || idx < 0 || idx >= t.options.length) return undefined;
    const opt = t.options[idx]!;
    const cols = sheetListDisplayColumns(def);
    return {
      id: entryId,
      values: sheetValuesFromTableOption(opt, cols),
      effects: opt.effects,
    };
  }
  return def.entries[entryId];
}
