import {
  DIMENSION_OVERVIEW_COLUMN_ORDER,
  type ArchetypeGroup,
  type ArchetypeOption,
  type DimensionOverviewColumnId,
  type ResourceDefinition,
  type RollTable,
  type RollTableExtraColumn,
  type SchemaField,
  type SheetListDefinition,
  type SheetListEntry,
  type TableOption,
  type Effect,
  type LoadoutEntry,
  type RpgSystem,
  type SharedTraitDefinition,
  type StatDefinition,
  type NumericStatOptionalColumn,
} from "../types";
import {
  defaultSheetDisplayColumns,
  extraSheetColId,
  getSheetListFields,
  resolveSheetListEntry,
  SHEET_COL_DESCRIPTION,
  SHEET_COL_LABEL,
  sheetListDisplayColumns,
} from "../sheetListCore";
import {
  deleteSystem,
  exportSystemJson,
  getAllSystems,
  getSystem,
  importSystemJson,
  saveSystem,
} from "../storage";
import { DEFAULT_SYSTEM } from "../data/defaultSystem";
import { supabaseConfigured } from "../lib/env";
import {
  deletePublishedGenerator,
  type PublishVisibility,
  upsertPublishedGenerator,
} from "../cloud/publishedRepo";
import { stripForPublish } from "../publish/stripForPublish";
import {
  normalizeStartingGear,
  normalizeSystem,
  synchronizeRollTableLibraryMeta,
  tableRollLinksForTable,
} from "../migrate";
import { createBlankSystem } from "../data/blankSystem";
import {
  bindEffectTypeVisibility,
  defaultEffect,
  parseEffectsFromNest,
  parseEffectsFromStash,
  refreshSheetListEntrySelects,
  sheetListEntrySel,
  renderEffectRow,
  renderEffectsEditor,
  summarizeEffectsForTable,
} from "./effect-editor";

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function studioClickTarget(ev: MouseEvent): HTMLElement | null {
  const n = ev.target;
  if (n instanceof HTMLElement) return n;
  if (n instanceof Text && n.parentElement instanceof HTMLElement) return n.parentElement;
  return null;
}

/** Compact “spreadsheet columns” trigger (Supabase-style grid editor affordance). */
function studioColsIconButton(title: string, dataAttrs: Record<string, string>): string {
  const attrs = Object.entries(dataAttrs)
    .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
    .join("");
  return `<button type="button" class="studio-cols-icon-btn"${attrs} title="${escapeHtml(title)}" aria-label="${escapeHtml(
    title
  )}"><span aria-hidden="true" class="studio-cols-icon-btn__glyph">&#x2699;</span></button>`;
}

const STUDIO_FX_MODAL_SCOPE = "studio-modal-fx";
const STUDIO_ROW_MODAL_SCOPE = "studio-modal-row";

type StudioFxModalCtx =
  | { kind: "tblopt"; card: HTMLElement }
  | { kind: "quick"; row: HTMLElement }
  | { kind: "sheetentry"; row: HTMLElement };

let studioFxModalCtx: StudioFxModalCtx | null = null;

/** Escaped JSON for `value=""` on hidden effect stash inputs. */
function effectsStashEscapedAttr(effects: Effect[] | undefined): string {
  return escapeHtml(JSON.stringify(effects ?? []));
}

function applyEffectsStashToRow(
  w: RpgSystem,
  kind: StudioFxModalCtx["kind"],
  root: HTMLElement,
  effects: Effect[]
): void {
  const json = JSON.stringify(effects);
  if (kind === "sheetentry") {
    const stash = root.querySelector(".slist-entry-effects-stash") as HTMLInputElement | null;
    const sum = root.querySelector(".slist-entry-fx-summary");
    if (stash) stash.value = json;
    if (sum) sum.textContent = summarizeEffectsForTable(w, effects);
  } else if (kind === "tblopt") {
    const stash = root.querySelector(".tbl-o-effects-stash") as HTMLInputElement | null;
    const sum = root.querySelector(".tbl-o-fx-summary");
    if (stash) stash.value = json;
    if (sum) sum.textContent = summarizeEffectsForTable(w, effects);
  } else {
    const stash = root.querySelector(".qt-effects-stash") as HTMLInputElement | null;
    const sum = root.querySelector(".qt-fx-summary");
    if (stash) stash.value = json;
    if (sum) sum.textContent = summarizeEffectsForTable(w, effects);
  }
}

function closeStudioEffectsModal(): void {
  const root = document.getElementById("studio-effects-modal");
  const body = document.getElementById("studio-effects-modal-body");
  if (root) {
    root.classList.add("studio-modal--hidden");
    root.setAttribute("aria-hidden", "true");
  }
  if (body) body.innerHTML = "";
  studioFxModalCtx = null;
}

function openStudioEffectsModal(w: RpgSystem, title: string, effects: Effect[], ctx: StudioFxModalCtx): void {
  studioFxModalCtx = ctx;
  const root = document.getElementById("studio-effects-modal");
  const h = document.getElementById("studio-effects-modal-title");
  const body = document.getElementById("studio-effects-modal-body");
  if (!root || !h || !body) return;
  h.textContent = title;
  body.innerHTML = renderEffectsEditor(w, effects, STUDIO_FX_MODAL_SCOPE);
  root.classList.remove("studio-modal--hidden");
  root.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => {
    (document.getElementById("studio-effects-modal-save") as HTMLButtonElement | null)?.focus();
  });
}

function saveStudioEffectsModal(w: RpgSystem, opts: StudioWireOpts): void {
  const body = document.getElementById("studio-effects-modal-body");
  const nest = body?.querySelector(".effects-nest");
  const fx = parseEffectsFromNest(nest ?? undefined);
  const ctx = studioFxModalCtx;
  if (!ctx) {
    closeStudioEffectsModal();
    return;
  }
  const root = ctx.kind === "tblopt" ? ctx.card : ctx.row;
  if (!root.isConnected) {
    opts.setError("That row is no longer on the page. Close the dialog and try again.");
    closeStudioEffectsModal();
    return;
  }
  applyEffectsStashToRow(w, ctx.kind, root, fx);
  closeStudioEffectsModal();
}

function closeStudioColsModal(): void {
  const root = document.getElementById("studio-cols-modal");
  const body = document.getElementById("studio-cols-modal-body");
  if (root) {
    root.classList.add("studio-modal--hidden");
    root.setAttribute("aria-hidden", "true");
  }
  if (body) body.innerHTML = "";
}

type ColsModalTarget =
  | { kind: "rollTable"; tableId: string }
  | { kind: "numeric"; which: "modifiers" | "other" }
  | { kind: "traits" }
  | { kind: "dimGroup"; groupId: string }
  | { kind: "sheetList"; listId: string }
  | { kind: "archStatMods"; groupId: string; optionId: string }
  | { kind: "archResourceMods"; groupId: string; optionId: string }
  | { kind: "loadout" };

function colsModalTargetFromBtn(btn: HTMLElement): ColsModalTarget | null {
  const k = btn.dataset.colsKind;
  if (!k) return null;
  switch (k) {
    case "rollTable": {
      const tid = btn.dataset.colsTable?.trim() ?? "";
      return tid ? { kind: "rollTable", tableId: tid } : null;
    }
    case "numeric": {
      const which = btn.dataset.colsWhich === "other" ? "other" : "modifiers";
      return { kind: "numeric", which };
    }
    case "traits":
      return { kind: "traits" };
    case "dimGroup": {
      const gid = btn.dataset.colsGroup?.trim() ?? "";
      return gid ? { kind: "dimGroup", groupId: gid } : null;
    }
    case "sheetList": {
      const lid = btn.dataset.colsList?.trim() ?? "";
      return lid ? { kind: "sheetList", listId: lid } : null;
    }
    case "archStatMods": {
      const gid = btn.dataset.colsArchGid?.trim() ?? "";
      const oid = btn.dataset.colsArchOid?.trim() ?? "";
      return gid && oid ? { kind: "archStatMods", groupId: gid, optionId: oid } : null;
    }
    case "archResMods": {
      const gid = btn.dataset.colsArchGid?.trim() ?? "";
      const oid = btn.dataset.colsArchOid?.trim() ?? "";
      return gid && oid ? { kind: "archResourceMods", groupId: gid, optionId: oid } : null;
    }
    case "loadout":
      return { kind: "loadout" };
    default:
      return null;
  }
}

function renderExtraColumnsEditorInner(cols: RollTableExtraColumn[], intro: string): string {
  const rows = cols
    .map(
      (c, i) => `
    <tr data-ec-idx="${i}">
      <td><input class="inp inp-compact" data-ec-id type="text" value="${escapeHtml(c.id)}" /></td>
      <td><input class="inp inp-compact" data-ec-label type="text" value="${escapeHtml(c.label)}" /></td>
      <td>
        <select class="inp inp-compact" data-ec-type>
          <option value="text"${c.fieldType === "text" ? " selected" : ""}>text</option>
          <option value="number"${c.fieldType === "number" ? " selected" : ""}>number</option>
          <option value="textarea"${c.fieldType === "textarea" ? " selected" : ""}>textarea</option>
        </select>
      </td>
      <td><button type="button" class="danger small-btn" data-ec-del="1">×</button></td>
    </tr>`
    )
    .join("");
  return `
    <p class="muted small">${intro}</p>
    <table class="data-table data-table--dense">
      <thead><tr><th>Field id</th><th>Label</th><th>Type</th><th></th></tr></thead>
      <tbody id="ec-body">${rows}</tbody>
    </table>
    <p class="studio-toolbar-row"><button type="button" class="secondary small-btn" id="ec-add">+ Add column</button></p>
  `;
}

function openStudioColsModal(w: RpgSystem, target: ColsModalTarget): void {
  const root = document.getElementById("studio-cols-modal");
  const body = document.getElementById("studio-cols-modal-body");
  const titleEl = document.getElementById("studio-cols-modal-title");
  if (!root || !body) return;
  let hiddens = "";
  let cols: RollTableExtraColumn[] = [];
  let intro = "";
  let title = "Table columns";
   if (target.kind === "rollTable") {
    syncQuickRollTablesFromDom(w);
    let nid = target.tableId;
    if (studioRoute.kind === "editTable") {
      nid = syncTableView(w, target.tableId);
      studioRoute = { kind: "editTable", tableId: nid };
    }
    cols = w.tables[nid]?.extraColumns ?? [];
    intro =
      "Extra fields on each outcome row (notes, DCs, links, …). Core generation still uses <strong>label</strong>, <strong>weight</strong>, and <strong>effects</strong>.";
    title = "Roll outcome columns";
    hiddens = `<input type="hidden" id="ec-target-kind" value="rollTable" /><input type="hidden" id="ec-table-id" value="${escapeHtml(nid)}" />`;
  } else if (target.kind === "numeric") {
    cols =
      target.which === "modifiers"
        ? w.studioExtraColumns?.numericModifiers ?? []
        : w.studioExtraColumns?.numericOther ?? [];
    intro =
      "Extra fields on each row. <strong>Id</strong>, starting value, and built-in optional columns are fixed; these are designer metadata only.";
    title = target.which === "modifiers" ? "Modifier rows — custom columns" : "Other numeric rows — custom columns";
    hiddens = `<input type="hidden" id="ec-target-kind" value="numeric" /><input type="hidden" id="ec-numeric-which" value="${target.which}" />`;
  } else if (target.kind === "traits") {
    cols = w.studioExtraColumns?.traits ?? [];
    intro =
      "Extra fields on each term definition. <strong>Id</strong>, label, and definition text are fixed.";
    title = "Term definitions — custom columns";
    hiddens = `<input type="hidden" id="ec-target-kind" value="traits" />`;
  } else if (target.kind === "dimGroup") {
    const g = w.archetypeGroups.find((x) => x.id === target.groupId);
    cols = g?.optionExtraColumns ?? [];
    intro = `Extra fields on each choice in <strong>${escapeHtml(g?.label ?? target.groupId)}</strong>. Overview id, name, and summary columns are fixed.`;
    title = "Dimension choices — custom columns";
    hiddens = `<input type="hidden" id="ec-target-kind" value="dimGroup" /><input type="hidden" id="ec-dim-gid" value="${escapeHtml(target.groupId)}" />`;
  } else if (target.kind === "sheetList") {
    const def = w.sheetLists[target.listId];
    cols = (def?.fields ?? []).map((f) => ({ id: f.id, label: f.label, fieldType: f.fieldType }));
    intro =
      "Columns for this custom list (field ids are stable for effects and data). <strong>Row id</strong> in the rows grid stays fixed.";
    title = `List columns — ${escapeHtml(def?.sheetTitle ?? target.listId)}`;
    hiddens = `<input type="hidden" id="ec-target-kind" value="sheetList" /><input type="hidden" id="ec-sheet-list-id" value="${escapeHtml(target.listId)}" />`;
  } else if (target.kind === "archStatMods") {
    const g = w.archetypeGroups.find((x) => x.id === target.groupId);
    const o = g?.options.find((x) => x.id === target.optionId);
    cols = o?.statModExtraColumns ?? [];
    intro = `Extra fields on each <strong>score change</strong> row for this choice. <strong>Score</strong> and <strong>amount</strong> are required for generation.`;
    title = "Score changes — custom columns";
    hiddens = `<input type="hidden" id="ec-target-kind" value="archStatMods" /><input type="hidden" id="ec-arch-gid" value="${escapeHtml(target.groupId)}" /><input type="hidden" id="ec-arch-oid" value="${escapeHtml(target.optionId)}" />`;
  } else if (target.kind === "archResourceMods") {
    const g = w.archetypeGroups.find((x) => x.id === target.groupId);
    const o = g?.options.find((x) => x.id === target.optionId);
    cols = o?.resourceModExtraColumns ?? [];
    intro = `Extra fields on each <strong>pool change</strong> row for this choice. <strong>Pool</strong> and <strong>amount</strong> are required for generation.`;
    title = "Pool changes — custom columns";
    hiddens = `<input type="hidden" id="ec-target-kind" value="archResMods" /><input type="hidden" id="ec-arch-gid" value="${escapeHtml(target.groupId)}" /><input type="hidden" id="ec-arch-oid" value="${escapeHtml(target.optionId)}" />`;
  } else {
    cols = w.studioExtraColumns?.loadout ?? [];
    intro =
      "Extra fields on each starting-gear line. <strong>Table</strong>, <strong>count</strong>, and <strong>mode</strong> are fixed.";
    title = "Starting gear — custom columns";
    hiddens = `<input type="hidden" id="ec-target-kind" value="loadout" />`;
  }
  if (titleEl) titleEl.textContent = title;
  body.innerHTML = hiddens + renderExtraColumnsEditorInner(cols, intro);
  root.classList.remove("studio-modal--hidden");
  root.setAttribute("aria-hidden", "false");
}

function parseExtraColumnsFromModal(): RollTableExtraColumn[] {
  const out: RollTableExtraColumn[] = [];
  document.querySelectorAll("#ec-body tr").forEach((tr) => {
    const id = (tr.querySelector("[data-ec-id]") as HTMLInputElement | null)?.value.trim();
    if (!id) return;
    const label = (tr.querySelector("[data-ec-label]") as HTMLInputElement | null)?.value.trim() || id;
    const ftRaw = (tr.querySelector("[data-ec-type]") as HTMLSelectElement | null)?.value;
    const fieldType: RollTableExtraColumn["fieldType"] =
      ftRaw === "number" || ftRaw === "textarea" ? ftRaw : "text";
    out.push({ id, label, fieldType });
  });
  return out;
}

function applyExtraColumnsToTable(w: RpgSystem, tid: string, cols: RollTableExtraColumn[]): void {
  const t = w.tables[tid];
  if (!t) return;
  const ids = new Set(cols.map((c) => c.id));
  if (cols.length) t.extraColumns = cols;
  else delete t.extraColumns;
  for (const opt of t.options) {
    if (!opt.extra) continue;
    const next: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(opt.extra)) {
      if (ids.has(k)) next[k] = v;
    }
    if (Object.keys(next).length) opt.extra = next;
    else delete opt.extra;
  }
}

function pruneRowExtras(rows: { extra?: Record<string, string | number> }[], ids: Set<string>): void {
  for (const row of rows) {
    if (!row.extra) continue;
    const next: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(row.extra)) {
      if (ids.has(k)) next[k] = v;
    }
    if (Object.keys(next).length) row.extra = next;
    else delete row.extra;
  }
}

function deleteStudioExtraColumnsIfEmpty(w: RpgSystem): void {
  const b = w.studioExtraColumns;
  if (!b) return;
  if (
    !b.numericModifiers?.length &&
    !b.numericOther?.length &&
    !b.traits?.length &&
    !b.loadout?.length
  ) {
    delete w.studioExtraColumns;
  }
}

function applyNumericTrackExtraColumns(w: RpgSystem, which: "modifiers" | "other", cols: RollTableExtraColumn[]): void {
  if (!w.studioExtraColumns) w.studioExtraColumns = {};
  const key = which === "modifiers" ? "numericModifiers" : "numericOther";
  if (cols.length) w.studioExtraColumns[key] = cols;
  else delete w.studioExtraColumns[key];
  deleteStudioExtraColumnsIfEmpty(w);
  const ids = new Set(cols.map((c) => c.id));
  pruneRowExtras(which === "modifiers" ? w.stats : w.resources, ids);
}

function applyTraitLibraryExtraColumns(w: RpgSystem, cols: RollTableExtraColumn[]): void {
  if (!w.studioExtraColumns) w.studioExtraColumns = {};
  if (cols.length) w.studioExtraColumns.traits = cols;
  else delete w.studioExtraColumns.traits;
  deleteStudioExtraColumnsIfEmpty(w);
  const ids = new Set(cols.map((c) => c.id));
  const lib = w.sharedTraits ?? {};
  pruneRowExtras(Object.values(lib), ids);
}

function applyLoadoutExtraColumns(w: RpgSystem, cols: RollTableExtraColumn[]): void {
  if (!w.studioExtraColumns) w.studioExtraColumns = {};
  if (cols.length) w.studioExtraColumns.loadout = cols;
  else delete w.studioExtraColumns.loadout;
  deleteStudioExtraColumnsIfEmpty(w);
  const ids = new Set(cols.map((c) => c.id));
  const lines = w.startingGear?.loadout;
  if (lines?.length) pruneRowExtras(lines, ids);
}

function applySheetListFieldColumns(w: RpgSystem, listId: string, cols: RollTableExtraColumn[]): void {
  const def = w.sheetLists[listId];
  if (!def) return;
  const fields: SchemaField[] = cols.map((c) => ({ id: c.id, label: c.label, fieldType: c.fieldType }));
  def.fields = fields;
  const ids = new Set(cols.map((c) => c.id));
  for (const ent of Object.values(def.entries)) {
    if (!ent.values) continue;
    const next: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(ent.values)) {
      if (ids.has(k)) next[k] = v;
    }
    ent.values = next;
  }
}

function applyArchStatModExtraColumns(
  w: RpgSystem,
  groupId: string,
  optionId: string,
  cols: RollTableExtraColumn[]
): void {
  const g = w.archetypeGroups.find((x) => x.id === groupId);
  const o = g?.options.find((x) => x.id === optionId);
  if (!o) return;
  if (cols.length) o.statModExtraColumns = cols;
  else delete o.statModExtraColumns;
  const ids = new Set(cols.map((c) => c.id));
  pruneRowExtras(o.statMods ?? [], ids);
}

function applyArchResourceModExtraColumns(
  w: RpgSystem,
  groupId: string,
  optionId: string,
  cols: RollTableExtraColumn[]
): void {
  const g = w.archetypeGroups.find((x) => x.id === groupId);
  const o = g?.options.find((x) => x.id === optionId);
  if (!o) return;
  if (cols.length) o.resourceModExtraColumns = cols;
  else delete o.resourceModExtraColumns;
  const ids = new Set(cols.map((c) => c.id));
  pruneRowExtras(o.resourceMods ?? [], ids);
}

function applyDimGroupExtraColumns(w: RpgSystem, groupId: string, cols: RollTableExtraColumn[]): void {
  const g = w.archetypeGroups.find((x) => x.id === groupId);
  if (!g) return;
  if (cols.length) g.optionExtraColumns = cols;
  else delete g.optionExtraColumns;
  const ids = new Set(cols.map((c) => c.id));
  pruneRowExtras(g.options, ids);
}

type StudioGridXcolBinding = "track" | "trait" | "dim" | "archSm" | "archRm" | "loadout";

function gridXcolDataAttr(binding: StudioGridXcolBinding, colId: string): string {
  const name =
    binding === "track"
      ? "data-track-xcol"
      : binding === "trait"
        ? "data-trait-xcol"
        : binding === "dim"
          ? "data-dim-xcol"
          : binding === "archSm"
            ? "data-arch-sm-xcol"
            : binding === "archRm"
              ? "data-arch-rm-xcol"
              : "data-loadout-xcol";
  return `${name}="${escapeHtml(colId)}"`;
}

function renderStudioGridExtraCells(
  cols: RollTableExtraColumn[],
  extra: Record<string, string | number> | undefined,
  binding: StudioGridXcolBinding
): string {
  return cols
    .map((c) => {
      const v = extra?.[c.id];
      const val = v === undefined ? "" : String(v);
      const attr = gridXcolDataAttr(binding, c.id);
      if (c.fieldType === "textarea") {
        return `<td><textarea class="inp inp-compact code-sm" ${attr} rows="2">${escapeHtml(val)}</textarea></td>`;
      }
      if (c.fieldType === "number") {
        const n = typeof v === "number" ? v : Number(val);
        const shown = Number.isFinite(n) ? String(n) : "";
        return `<td><input class="inp inp-compact" ${attr} type="number" step="any" value="${escapeHtml(shown)}" /></td>`;
      }
      return `<td><input class="inp inp-compact" ${attr} type="text" value="${escapeHtml(val)}" /></td>`;
    })
    .join("");
}

function parseStudioGridExtraRow(
  row: HTMLElement,
  cols: RollTableExtraColumn[]
): Record<string, string | number> | undefined {
  const allowed = new Set(cols.map((c) => c.id));
  const extra: Record<string, string | number> = {};
  row
    .querySelectorAll(
      "[data-track-xcol], [data-trait-xcol], [data-dim-xcol], [data-arch-sm-xcol], [data-arch-rm-xcol], [data-loadout-xcol]"
    )
    .forEach((node) => {
    const el = node as HTMLInputElement | HTMLTextAreaElement;
    const h = el as HTMLElement;
    const d = h.dataset;
    const fid =
      d.trackXcol?.trim() ??
      d.traitXcol?.trim() ??
      d.dimXcol?.trim() ??
      d.archSmXcol?.trim() ??
      d.archRmXcol?.trim() ??
      d.loadoutXcol?.trim() ??
      "";
    if (!fid || !allowed.has(fid)) return;
    const col = cols.find((c) => c.id === fid);
    if (!col) return;
    if (col.fieldType === "number") {
      const n = Number((el as HTMLInputElement).value);
      if (Number.isFinite(n)) extra[fid] = n;
    } else {
      const s = el.value.trim();
      if (s) extra[fid] = el.value;
    }
  });
  return Object.keys(extra).length ? extra : undefined;
}

function closeStudioRowModal(): void {
  studioTrackModalTargetRow = null;
  studioTraitModalTargetRow = null;
  studioDimOptionModalTargetRow = null;
  studioLoadoutModalTargetRow = null;
  studioSlistFieldModalTargetRow = null;
  studioSlistEntryModalTargetRow = null;
  const root = document.getElementById("studio-row-modal");
  const body = document.getElementById("studio-row-modal-body");
  if (root) {
    root.classList.add("studio-modal--hidden");
    root.setAttribute("aria-hidden", "true");
  }
  if (body) body.innerHTML = "";
}

/** Modal targets: live DOM rows updated in place (no full rerender). */
let studioTrackModalTargetRow: HTMLTableRowElement | null = null;
let studioTraitModalTargetRow: HTMLTableRowElement | null = null;
let studioDimOptionModalTargetRow: HTMLTableRowElement | null = null;
let studioLoadoutModalTargetRow: HTMLTableRowElement | null = null;
let studioSlistFieldModalTargetRow: HTMLTableRowElement | null = null;
let studioSlistEntryModalTargetRow: HTMLTableRowElement | null = null;

function trackNotePreview(text: string, max = 72): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t.length) return "—";
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function renderTrackModalBody(tr: HTMLTableRowElement): string {
  const kind = tr.dataset.trKind;
  if (kind !== "stat" && kind !== "resource") return "";
  const isStat = kind === "stat";
  const id = isStat
    ? (tr.querySelector('[name="sid"]') as HTMLInputElement | null)?.value ?? ""
    : (tr.querySelector('[name="rid"]') as HTMLInputElement | null)?.value ?? "";
  const name = isStat
    ? (tr.querySelector('[name="sname"]') as HTMLInputElement | null)?.value ?? ""
    : (tr.querySelector('[name="rname"]') as HTMLInputElement | null)?.value ?? "";
  const defVal = isStat
    ? (tr.querySelector('[name="sdef"]') as HTMLInputElement | null)?.value ?? "0"
    : (tr.querySelector('[name="rdef"]') as HTMLInputElement | null)?.value ?? "0";
  const explain = isStat
    ? (tr.querySelector('[name="sexplain"]') as HTMLTextAreaElement | null)?.value ?? ""
    : (tr.querySelector('[name="rexplain"]') as HTMLTextAreaElement | null)?.value ?? "";
  const kindTitle = isStat ? "modifier" : "other numeric stat";
  return `
    <input type="hidden" id="rm-context" value="track" />
    <p class="muted small">The <strong>id</strong> is used in data and effects. <strong>Starting value</strong> is the default before modifiers. <strong>Sheet note</strong> appears under this line on the printed character (formulas, reminders).</p>
    <div class="form-grid-2 form-grid-2--tight">
      <label><span class="muted small">Id</span>
        <input class="inp inp-compact mono" id="rm-track-id" type="text" value="${escapeHtml(id)}" /></label>
      <label><span class="muted small">Display name</span>
        <input class="inp inp-compact" id="rm-track-name" type="text" value="${escapeHtml(name)}" /></label>
      <label><span class="muted small">Starting value</span>
        <input class="inp inp-compact" id="rm-track-def" type="number" step="any" value="${escapeHtml(defVal)}" /></label>
      <label class="span-full"><span class="muted small">Sheet note</span>
        <textarea class="inp inp-compact" id="rm-track-explain" rows="6" placeholder="${isStat ? "How this score is used on the sheet…" : "e.g. Max = PHY + background…"}">${escapeHtml(explain)}</textarea></label>
    </div>
    <p class="muted tiny">You are editing a <strong>${kindTitle}</strong>.</p>
  `;
}

function openStudioTrackRowModal(tr: HTMLTableRowElement): void {
  studioTrackModalTargetRow = tr;
  const root = document.getElementById("studio-row-modal");
  const h = document.getElementById("studio-row-modal-title");
  const body = document.getElementById("studio-row-modal-body");
  if (!root || !h || !body) return;
  const isPool = tr.dataset.trKind === "resource";
  h.textContent = isPool ? "Edit other numeric stat" : "Edit modifier";
  body.innerHTML = renderTrackModalBody(tr);
  root.classList.remove("studio-modal--hidden");
  root.setAttribute("aria-hidden", "false");
}

function saveTrackRowFromModal(body: HTMLElement): void {
  const tr = studioTrackModalTargetRow;
  studioTrackModalTargetRow = null;
  if (!tr?.isConnected) return;
  const kind = tr.dataset.trKind;
  if (kind !== "stat" && kind !== "resource") return;
  const id = (body.querySelector("#rm-track-id") as HTMLInputElement | null)?.value.trim() ?? "";
  const name = (body.querySelector("#rm-track-name") as HTMLInputElement | null)?.value.trim() ?? "";
  const defRaw = Number((body.querySelector("#rm-track-def") as HTMLInputElement | null)?.value ?? 0);
  const def = Number.isFinite(defRaw) ? defRaw : 0;
  const explain = (body.querySelector("#rm-track-explain") as HTMLTextAreaElement | null)?.value ?? "";
  if (kind === "stat") {
    const sid = tr.querySelector('[name="sid"]') as HTMLInputElement | null;
    const sname = tr.querySelector('[name="sname"]') as HTMLInputElement | null;
    const sdef = tr.querySelector('[name="sdef"]') as HTMLInputElement | null;
    const sex = tr.querySelector('[name="sexplain"]') as HTMLTextAreaElement | null;
    if (sid && id) sid.value = id;
    if (sname) sname.value = name || id;
    if (sdef) sdef.value = String(def);
    if (sex) sex.value = explain;
  } else {
    const rid = tr.querySelector('[name="rid"]') as HTMLInputElement | null;
    const rname = tr.querySelector('[name="rname"]') as HTMLInputElement | null;
    const rdef = tr.querySelector('[name="rdef"]') as HTMLInputElement | null;
    const rex = tr.querySelector('[name="rexplain"]') as HTMLTextAreaElement | null;
    if (rid && id) rid.value = id;
    if (rname) rname.value = name || id;
    if (rdef) rdef.value = String(def);
    if (rex) rex.value = explain;
  }
}

function refreshTraitRowSummary(tr: HTMLTableRowElement): void {
  const stash = tr.querySelector(":scope > td.trait-stash");
  if (!stash) return;
  const id = (stash.querySelector('[name="trait-id"]') as HTMLInputElement | null)?.value.trim() ?? "";
  const name = (stash.querySelector('[name="trait-name"]') as HTMLInputElement | null)?.value.trim() ?? id;
  const desc = (stash.querySelector('[name="trait-desc"]') as HTMLTextAreaElement | null)?.value ?? "";
  const sid = tr.querySelector('[data-trait-sum="id"]');
  const sn = tr.querySelector('[data-trait-sum="name"]');
  const sd = tr.querySelector('[data-trait-sum="desc"]');
  if (sid) sid.textContent = id;
  if (sn) sn.textContent = name;
  if (sd) sd.textContent = trackNotePreview(desc, 96);
}

function renderTraitModalBody(tr: HTMLTableRowElement): string {
  const stash = tr.querySelector(":scope > td.trait-stash");
  if (!stash) return "";
  const id = (stash.querySelector('[name="trait-id"]') as HTMLInputElement | null)?.value ?? "";
  const name = (stash.querySelector('[name="trait-name"]') as HTMLInputElement | null)?.value ?? "";
  const desc = (stash.querySelector('[name="trait-desc"]') as HTMLTextAreaElement | null)?.value ?? "";
  return `
    <input type="hidden" id="rm-context" value="trait" />
    <p class="muted small">Term definitions are reusable text (tags, moves, species rules) linked from character choices. The <strong>id</strong> is used in data; changing it updates this row only—search dimensions if you rename.</p>
    <div class="form-grid-2 form-grid-2--tight">
      <label><span class="muted small">Id</span>
        <input class="inp inp-compact mono" id="rm-trait-id" type="text" value="${escapeHtml(id)}" /></label>
      <label><span class="muted small">Label</span>
        <input class="inp inp-compact" id="rm-trait-name" type="text" value="${escapeHtml(name)}" /></label>
      <label class="span-full"><span class="muted small">Definition</span>
        <textarea class="inp inp-compact" id="rm-trait-desc" rows="10" placeholder="Full text shown when this term appears on the character.">${escapeHtml(desc)}</textarea></label>
    </div>
  `;
}

function openStudioTraitRowModal(tr: HTMLTableRowElement): void {
  studioTraitModalTargetRow = tr;
  const root = document.getElementById("studio-row-modal");
  const h = document.getElementById("studio-row-modal-title");
  const body = document.getElementById("studio-row-modal-body");
  if (!root || !h || !body) return;
  h.textContent = "Edit term definition";
  body.innerHTML = renderTraitModalBody(tr);
  root.classList.remove("studio-modal--hidden");
  root.setAttribute("aria-hidden", "false");
}

function saveTraitRowFromModal(body: HTMLElement): void {
  const tr = studioTraitModalTargetRow;
  studioTraitModalTargetRow = null;
  if (!tr?.isConnected) return;
  const stash = tr.querySelector(":scope > td.trait-stash");
  if (!stash) return;
  const id = (body.querySelector("#rm-trait-id") as HTMLInputElement | null)?.value.trim() ?? "";
  const name = (body.querySelector("#rm-trait-name") as HTMLInputElement | null)?.value.trim() ?? "";
  const desc = (body.querySelector("#rm-trait-desc") as HTMLTextAreaElement | null)?.value ?? "";
  const tid = stash.querySelector('[name="trait-id"]') as HTMLInputElement | null;
  const tname = stash.querySelector('[name="trait-name"]') as HTMLInputElement | null;
  const tdesc = stash.querySelector('[name="trait-desc"]') as HTMLTextAreaElement | null;
  if (tid && id) tid.value = id;
  if (tname) tname.value = name || id;
  if (tdesc) tdesc.value = desc;
  refreshTraitRowSummary(tr);
}

function readDimOptionInputs(tr: HTMLTableRowElement): { id: string; name: string; desc: string } {
  const id =
    (tr.querySelector('[data-opt-col="id"]') as HTMLInputElement | null)?.value.trim() ?? "";
  const name =
    (tr.querySelector('[data-opt-col="name"]') as HTMLInputElement | null)?.value.trim() ?? "";
  const desc =
    (tr.querySelector('[data-opt-col="desc"]') as HTMLInputElement | null)?.value.trim() ?? "";
  return { id, name, desc };
}

function renderDimOptionModalBody(w: RpgSystem, tr: HTMLTableRowElement): string {
  const gid = tr.dataset.dimRow ?? "";
  const oid = tr.dataset.oid ?? "";
  const g = w.archetypeGroups.find((x) => x.id === gid);
  const o = g?.options.find((x) => x.id === oid);
  const { id, name, desc } = readDimOptionInputs(tr);
  const sumStats = o ? summarizeStatMods(o.statMods) : "—";
  const sumRes = o ? summarizeResMods(o.resourceMods) : "—";
  const sumTr = o ? summarizeTraitRefs(w, o.sharedTraitRefs) : "—";
  const sumTbl = o ? summarizeTableRollsCell(w, o.tableRolls) : "—";
  return `
    <input type="hidden" id="rm-context" value="dim-option" />
    <p class="muted small">Edit the basics here. Stat bonuses, pools, linked definitions, and extra rolls are in the <strong>full choice editor</strong>.</p>
    <div class="form-grid-2 form-grid-2--tight">
      <label><span class="muted small">Choice id</span>
        <input class="inp inp-compact mono" id="rm-dim-id" type="text" value="${escapeHtml(id)}" /></label>
      <label><span class="muted small">Display name</span>
        <input class="inp inp-compact" id="rm-dim-name" type="text" value="${escapeHtml(name)}" /></label>
      <label class="span-full"><span class="muted small">Summary / description</span>
        <textarea class="inp inp-compact" id="rm-dim-desc" rows="6">${escapeHtml(desc)}</textarea></label>
    </div>
    <h4 class="subh subh--tight">Current modifiers (read-only)</h4>
    <ul class="muted small studio-modal-hint-list">
      <li><strong>Scores:</strong> ${escapeHtml(sumStats)}</li>
      <li><strong>Pools:</strong> ${escapeHtml(sumRes)}</li>
      <li><strong>Definitions:</strong> ${escapeHtml(sumTr)}</li>
      <li><strong>Extra rolls:</strong> ${escapeHtml(sumTbl)}</li>
    </ul>
    <p class="studio-toolbar-row">
      <a href="#" class="cms-open-option primary small-btn" data-cms-group="${escapeHtml(gid)}" data-cms-option="${escapeHtml(oid)}">Open full choice editor…</a>
    </p>
  `;
}

function summarizeTableRollsCell(w: RpgSystem, rolls: string[] | undefined): string {
  if (!rolls?.length) return "—";
  return rolls
    .map((tid) => w.tables[tid]?.name ?? tid)
    .join(", ");
}

function openStudioDimOptionRowModal(w: RpgSystem, tr: HTMLTableRowElement): void {
  studioDimOptionModalTargetRow = tr;
  const root = document.getElementById("studio-row-modal");
  const h = document.getElementById("studio-row-modal-title");
  const body = document.getElementById("studio-row-modal-body");
  if (!root || !h || !body) return;
  h.textContent = "Edit dimension choice";
  body.innerHTML = renderDimOptionModalBody(w, tr);
  root.classList.remove("studio-modal--hidden");
  root.setAttribute("aria-hidden", "false");
}

function saveDimOptionRowFromModal(body: HTMLElement): void {
  const tr = studioDimOptionModalTargetRow;
  studioDimOptionModalTargetRow = null;
  if (!tr?.isConnected) return;
  const id = (body.querySelector("#rm-dim-id") as HTMLInputElement | null)?.value.trim() ?? "";
  const name = (body.querySelector("#rm-dim-name") as HTMLInputElement | null)?.value.trim() ?? "";
  const desc = (body.querySelector("#rm-dim-desc") as HTMLTextAreaElement | null)?.value ?? "";
  const idEl = tr.querySelector('[data-opt-col="id"]') as HTMLInputElement | null;
  const nameEl = tr.querySelector('[data-opt-col="name"]') as HTMLInputElement | null;
  const descEl = tr.querySelector('[data-opt-col="desc"]') as HTMLInputElement | null;
  if (idEl && id) idEl.value = id;
  if (nameEl) nameEl.value = name || id;
  if (descEl) descEl.value = desc;
}

function refreshLoadoutRowSummary(tr: HTMLTableRowElement, w: RpgSystem): void {
  const stash = tr.querySelector(":scope > td.loadout-stash");
  if (!stash) return;
  const tbl = (stash.querySelector("[data-loadout-table]") as HTMLSelectElement | null)?.value.trim() ?? "";
  const rolls = Number((stash.querySelector("[data-loadout-rolls]") as HTMLInputElement | null)?.value ?? 0);
  const modeRaw = (stash.querySelector("[data-loadout-mode]") as HTMLSelectElement | null)?.value;
  const mode = modeRaw === "once" ? "Once" : "Repeat";
  const tname = tbl ? w.tables[tbl]?.name ?? tbl : "—";
  const sumTbl = tr.querySelector("[data-lo-sum-table]");
  const sumRolls = tr.querySelector("[data-lo-sum-rolls]");
  const sumMode = tr.querySelector("[data-lo-sum-mode]");
  if (sumTbl) sumTbl.textContent = tname;
  if (sumRolls) sumRolls.textContent = Number.isFinite(rolls) ? String(rolls) : "0";
  if (sumMode) sumMode.textContent = mode;
}

function renderLoadoutModalBody(tr: HTMLTableRowElement, w: RpgSystem): string {
  const stash = tr.querySelector(":scope > td.loadout-stash");
  if (!stash) return "";
  const curTid = (stash.querySelector("[data-loadout-table]") as HTMLSelectElement | null)?.value ?? "";
  const tableOpts =
    `<option value="">— pick table —</option>` +
    Object.keys(w.tables)
      .sort((a, b) => a.localeCompare(b))
      .map((id) => {
        const sel = id === curTid ? " selected" : "";
        return `<option value="${escapeHtml(id)}"${sel}>${escapeHtml(w.tables[id]?.name ?? id)}</option>`;
      })
      .join("");
  const rolls = (stash.querySelector("[data-loadout-rolls]") as HTMLInputElement | null)?.value ?? "1";
  const mode = (stash.querySelector("[data-loadout-mode]") as HTMLSelectElement | null)?.value ?? "repeat";
  return `
    <input type="hidden" id="rm-context" value="loadout" />
    <p class="muted small">Each line rolls from a table when a new character is created. <strong>Repeat</strong> runs the table N times; <strong>Once</strong> is a single weighted pick.</p>
    <label class="block"><span class="muted small">Roll table</span>
      <select class="inp inp-compact" id="rm-loadout-table">${tableOpts}</select></label>
    <div class="form-grid-2 form-grid-2--tight">
      <label><span class="muted small">Count / N</span>
        <input class="inp inp-compact" id="rm-loadout-rolls" type="number" min="0" value="${escapeHtml(rolls)}" /></label>
      <label><span class="muted small">Mode</span>
        <select class="inp inp-compact" id="rm-loadout-mode">
          <option value="repeat"${mode === "repeat" ? " selected" : ""}>Repeat N times</option>
          <option value="once"${mode === "once" ? " selected" : ""}>Once (single draw)</option>
        </select></label>
    </div>
  `;
}

function openStudioLoadoutRowModal(w: RpgSystem, tr: HTMLTableRowElement): void {
  studioLoadoutModalTargetRow = tr;
  const root = document.getElementById("studio-row-modal");
  const h = document.getElementById("studio-row-modal-title");
  const body = document.getElementById("studio-row-modal-body");
  if (!root || !h || !body) return;
  h.textContent = "Edit starting gear line";
  body.innerHTML = renderLoadoutModalBody(tr, w);
  root.classList.remove("studio-modal--hidden");
  root.setAttribute("aria-hidden", "false");
}

function saveLoadoutRowFromModal(body: HTMLElement): void {
  const tr = studioLoadoutModalTargetRow;
  studioLoadoutModalTargetRow = null;
  if (!tr?.isConnected) return;
  const stash = tr.querySelector(":scope > td.loadout-stash");
  if (!stash) return;
  const tbl = (body.querySelector("#rm-loadout-table") as HTMLSelectElement | null)?.value.trim() ?? "";
  const rolls = (body.querySelector("#rm-loadout-rolls") as HTMLInputElement | null)?.value ?? "0";
  const mode = (body.querySelector("#rm-loadout-mode") as HTMLSelectElement | null)?.value ?? "repeat";
  const sel = stash.querySelector("[data-loadout-table]") as HTMLSelectElement | null;
  const ri = stash.querySelector("[data-loadout-rolls]") as HTMLInputElement | null;
  const mi = stash.querySelector("[data-loadout-mode]") as HTMLSelectElement | null;
  if (sel && [...sel.options].some((o) => o.value === tbl)) sel.value = tbl;
  else if (sel) sel.value = "";
  if (ri) ri.value = rolls;
  if (mi && (mode === "once" || mode === "repeat")) mi.value = mode;
  const w = getWorking();
  refreshLoadoutRowSummary(tr, w);
}

function renderSlistFieldModalBody(tr: HTMLTableRowElement): string {
  const id = (tr.querySelector("[data-sfid]") as HTMLInputElement | null)?.value ?? "";
  const label = (tr.querySelector("[data-sflabel]") as HTMLInputElement | null)?.value ?? "";
  const ft = (tr.querySelector("[data-sftype]") as HTMLSelectElement | null)?.value ?? "text";
  return `
    <input type="hidden" id="rm-context" value="slist-field" />
    <p class="muted small">Stable <strong>field id</strong> is used in stored row data and effects. Rename carefully if content already exists.</p>
    <label><span class="muted small">Field id</span>
      <input class="inp inp-compact mono" id="rm-sfld-id" type="text" value="${escapeHtml(id)}" /></label>
    <label><span class="muted small">Label (on sheet)</span>
      <input class="inp inp-compact" id="rm-sfld-label" type="text" value="${escapeHtml(label)}" /></label>
    <label><span class="muted small">Type</span>
      <select class="inp inp-compact" id="rm-sfld-type">
        <option value="text"${ft === "text" ? " selected" : ""}>text</option>
        <option value="number"${ft === "number" ? " selected" : ""}>number</option>
        <option value="textarea"${ft === "textarea" ? " selected" : ""}>textarea</option>
      </select></label>
  `;
}

function openStudioSlistFieldModal(tr: HTMLTableRowElement): void {
  studioSlistFieldModalTargetRow = tr;
  const root = document.getElementById("studio-row-modal");
  const h = document.getElementById("studio-row-modal-title");
  const body = document.getElementById("studio-row-modal-body");
  if (!root || !h || !body) return;
  h.textContent = "Edit sheet list column";
  body.innerHTML = renderSlistFieldModalBody(tr);
  root.classList.remove("studio-modal--hidden");
  root.setAttribute("aria-hidden", "false");
}

function saveSlistFieldRowFromModal(body: HTMLElement): void {
  const tr = studioSlistFieldModalTargetRow;
  studioSlistFieldModalTargetRow = null;
  if (!tr?.isConnected) return;
  const id = (body.querySelector("#rm-sfld-id") as HTMLInputElement | null)?.value.trim() ?? "";
  const label = (body.querySelector("#rm-sfld-label") as HTMLInputElement | null)?.value.trim() ?? "";
  const ftRaw = (body.querySelector("#rm-sfld-type") as HTMLSelectElement | null)?.value;
  const ft = ftRaw === "number" || ftRaw === "textarea" ? ftRaw : "text";
  const idEl = tr.querySelector("[data-sfid]") as HTMLInputElement | null;
  const labEl = tr.querySelector("[data-sflabel]") as HTMLInputElement | null;
  const tyEl = tr.querySelector("[data-sftype]") as HTMLSelectElement | null;
  if (idEl && id) idEl.value = id;
  if (labEl) labEl.value = label || id;
  if (tyEl) tyEl.value = ft;
  const sid = tr.querySelector("[data-sfld-sum-id]");
  const slab = tr.querySelector("[data-sfld-sum-lab]");
  const styp = tr.querySelector("[data-sfld-sum-type]");
  if (sid) sid.textContent = id;
  if (slab) slab.textContent = label || id;
  if (styp) styp.textContent = `(${ft})`;
}

function renderSlistEntryModalBody(w: RpgSystem, listId: string, tr: HTMLTableRowElement): string {
  const def = w.sheetLists[listId];
  if (!def) return "";
  const eid = (tr.querySelector("[data-slist-eid]") as HTMLInputElement | null)?.value.trim() ?? "";
  const ent = def.entries[eid];
  const fields = def.fields
    .map((f) => {
      const raw = ent?.values[f.id];
      const val = raw === undefined ? "" : String(raw);
      const fe = escapeHtml(f.id);
      if (f.fieldType === "textarea") {
        return `<label class="block"><span class="muted small">${escapeHtml(f.label)}</span><textarea class="inp inp-compact rm-slist-ev" data-slist-fid="${fe}" rows="4">${escapeHtml(val)}</textarea></label>`;
      }
      if (f.fieldType === "number") {
        const n = typeof raw === "number" ? raw : Number(val);
        const shown = Number.isFinite(n) ? String(n) : "";
        return `<label class="block"><span class="muted small">${escapeHtml(f.label)}</span><input class="inp inp-compact rm-slist-ev" data-slist-fid="${fe}" type="number" step="any" value="${escapeHtml(shown)}" /></label>`;
      }
      return `<label class="block"><span class="muted small">${escapeHtml(f.label)}</span><input class="inp inp-compact rm-slist-ev" data-slist-fid="${fe}" type="text" value="${escapeHtml(val)}" /></label>`;
    })
    .join("");
  return `
    <input type="hidden" id="rm-context" value="slist-entry" />
    <input type="hidden" id="rm-slist-id" value="${escapeHtml(listId)}" />
    <p class="muted small">Row <strong class="mono">${escapeHtml(eid)}</strong> in list <strong class="mono">${escapeHtml(listId)}</strong>. Use <strong>Edit effects…</strong> on the row for nested effects.</p>
    <label class="block"><span class="muted small">Row id</span>
      <input class="inp inp-compact mono" id="rm-slist-eid" type="text" value="${escapeHtml(eid)}" /></label>
    ${fields}
  `;
}

function refreshSlistEntrySummary(w: RpgSystem, listId: string, tr: HTMLTableRowElement): void {
  const def = w.sheetLists[listId];
  if (!def) return;
  const stash = tr.querySelector(".slist-entry-stash");
  const scope = stash ?? tr;
  const parts = def.fields.map((f) => {
    const inp = [...scope.querySelectorAll("[data-slist-ev]")].find(
      (el) => (el as HTMLElement).dataset.slistEv === f.id
    ) as HTMLInputElement | HTMLTextAreaElement | null;
    const v = inp?.value.trim() ?? "";
    return `${f.label}: ${v}`;
  });
  const prev = parts.join(" · ").replace(/\s+/g, " ").trim() || "—";
  const el = tr.querySelector("[data-slist-entry-preview]");
  if (el) el.textContent = prev.length > 120 ? `${prev.slice(0, 117)}…` : prev;
}

function openStudioSlistEntryModal(w: RpgSystem, listId: string, tr: HTMLTableRowElement): void {
  studioSlistEntryModalTargetRow = tr;
  const root = document.getElementById("studio-row-modal");
  const h = document.getElementById("studio-row-modal-title");
  const body = document.getElementById("studio-row-modal-body");
  if (!root || !h || !body) return;
  const eid = (tr.querySelector("[data-slist-eid]") as HTMLInputElement | null)?.value.trim() ?? "row";
  h.textContent = `Edit list row — ${eid}`;
  body.innerHTML = renderSlistEntryModalBody(w, listId, tr);
  root.classList.remove("studio-modal--hidden");
  root.setAttribute("aria-hidden", "false");
}

function saveSlistEntryRowFromModal(body: HTMLElement): void {
  const tr = studioSlistEntryModalTargetRow;
  studioSlistEntryModalTargetRow = null;
  if (!tr?.isConnected) return;
  const listId = (body.querySelector("#rm-slist-id") as HTMLInputElement | null)?.value.trim() ?? "";
  const w = getWorking();
  const def = listId ? w.sheetLists[listId] : undefined;
  if (!def) return;
  const oldEid = (tr.querySelector("[data-slist-eid]") as HTMLInputElement | null)?.value.trim() ?? "";
  const newEid = (body.querySelector("#rm-slist-eid") as HTMLInputElement | null)?.value.trim() ?? "";
  if (!newEid) return;
  if (newEid !== oldEid && def.entries[oldEid]) {
    def.entries[newEid] = def.entries[oldEid]!;
    delete def.entries[oldEid];
    def.entries[newEid]!.id = newEid;
  }
  const eidEl = tr.querySelector("[data-slist-eid]") as HTMLInputElement | null;
  if (eidEl) eidEl.value = newEid;
  tr.dataset.slistEntry = newEid;
  const idDisp = tr.querySelector("[data-slist-eid-display]");
  if (idDisp) idDisp.textContent = newEid;
  const ent = def.entries[newEid];
  if (!ent) return;
  for (const f of def.fields) {
    const modalInp = [...body.querySelectorAll(".rm-slist-ev")].find(
      (el) => (el as HTMLElement).dataset.slistFid === f.id
    ) as HTMLInputElement | HTMLTextAreaElement | null;
    const rowInp = [...tr.querySelectorAll("[data-slist-ev]")].find(
      (el) => (el as HTMLElement).dataset.slistEv === f.id
    ) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!modalInp || !rowInp) continue;
    rowInp.value = modalInp.value;
    if (f.fieldType === "number") {
      const n = Number(modalInp.value);
      ent.values[f.id] = Number.isFinite(n) ? n : 0;
    } else {
      ent.values[f.id] = modalInp.value;
    }
  }
  refreshSlistEntrySummary(w, listId, tr);
}

function openStudioTableRowModal(w: RpgSystem, tableId: string, rowIdx: number): void {
  syncQuickRollTablesFromDom(w);
  let nid = tableId;
  if (studioRoute.kind === "editTable" && studioRoute.tableId === tableId) {
    const idEl = document.getElementById("tbl-id");
    if (idEl) nid = syncTableView(w, tableId);
  }
  if (studioRoute.kind === "editTable") {
    studioRoute = { kind: "editTable", tableId: nid };
  }
  const t = w.tables[nid];
  const o = t?.options[rowIdx];
  if (!t || !o) return;
  const root = document.getElementById("studio-row-modal");
  const h = document.getElementById("studio-row-modal-title");
  const body = document.getElementById("studio-row-modal-body");
  if (!root || !h || !body) return;
  h.textContent = `Edit outcome — ${t.name}`;
  body.innerHTML = renderTableRowModalBody(w, t, rowIdx, o);
  root.classList.remove("studio-modal--hidden");
  root.setAttribute("aria-hidden", "false");
}

function renderTableRowModalBody(w: RpgSystem, t: RollTable, idx: number, o: TableOption): string {
  const extraFields = (t.extraColumns ?? [])
    .map((col) => {
      const v = o.extra?.[col.id];
      const val = v === undefined ? "" : String(v);
      const d = escapeHtml(col.id);
      if (col.fieldType === "textarea") {
        return `<label class="block"><span class="muted small">${escapeHtml(col.label)}</span><textarea class="inp inp-compact rm-extra-inp" data-rm-extra="${d}" rows="2">${escapeHtml(val)}</textarea></label>`;
      }
      if (col.fieldType === "number") {
        const n = typeof v === "number" ? v : Number(val);
        const shown = Number.isFinite(n) ? String(n) : "";
        return `<label class="block"><span class="muted small">${escapeHtml(col.label)}</span><input class="inp inp-compact rm-extra-inp" data-rm-extra="${d}" type="number" step="any" value="${escapeHtml(shown)}" /></label>`;
      }
      return `<label class="block"><span class="muted small">${escapeHtml(col.label)}</span><input class="inp inp-compact rm-extra-inp" data-rm-extra="${d}" type="text" value="${escapeHtml(val)}" /></label>`;
    })
    .join("");
  return `
    <input type="hidden" id="rm-context" value="table-outcome" />
    <input type="hidden" id="rm-table-id" value="${escapeHtml(t.id)}" />
    <input type="hidden" id="rm-row-idx" value="${idx}" />
    <div class="form-grid-2 form-grid-2--tight">
      <label><span class="muted small">Result label</span><input class="inp inp-compact" id="rm-label" type="text" value="${escapeHtml(o.label)}" /></label>
      <label><span class="muted small">Weight</span><input class="inp inp-compact" id="rm-weight" type="number" min="1" step="1" value="${o.weight ?? 1}" /></label>
      <label class="span-full"><span class="muted small">Note</span><input class="inp inp-compact" id="rm-desc" type="text" value="${escapeHtml(o.description ?? "")}" /></label>
    </div>
    ${extraFields ? `<h4 class="subh subh--tight">Custom columns</h4>${extraFields}` : ""}
    <h4 class="subh subh--tight">Effects</h4>
    ${renderEffectsEditor(w, o.effects ?? [], STUDIO_ROW_MODAL_SCOPE)}
  `;
}

function saveStudioRowModal(w: RpgSystem, opts: StudioWireOpts): void {
  const body = document.getElementById("studio-row-modal-body");
  if (!body) {
    closeStudioRowModal();
    return;
  }
  const ctx = (body.querySelector("#rm-context") as HTMLInputElement | null)?.value ?? "table-outcome";
  if (ctx === "track") {
    saveTrackRowFromModal(body);
    closeStudioRowModal();
    return;
  }
  if (ctx === "trait") {
    saveTraitRowFromModal(body);
    closeStudioRowModal();
    return;
  }
  if (ctx === "dim-option") {
    saveDimOptionRowFromModal(body);
    closeStudioRowModal();
    return;
  }
  if (ctx === "loadout") {
    saveLoadoutRowFromModal(body);
    closeStudioRowModal();
    return;
  }
  if (ctx === "slist-field") {
    saveSlistFieldRowFromModal(body);
    closeStudioRowModal();
    return;
  }
  if (ctx === "slist-entry") {
    saveSlistEntryRowFromModal(body);
    closeStudioRowModal();
    return;
  }

  const idx = Number((body.querySelector("#rm-row-idx") as HTMLInputElement | null)?.value ?? -1);
  if (!Number.isFinite(idx) || idx < 0) {
    closeStudioRowModal();
    return;
  }
  syncQuickRollTablesFromDom(w);
  let tid = (body.querySelector("#rm-table-id") as HTMLInputElement | null)?.value.trim() ?? "";
  if (studioRoute.kind === "editTable") {
    const idEl = document.getElementById("tbl-id");
    if (idEl) tid = syncTableView(w, studioRoute.tableId);
    studioRoute = { kind: "editTable", tableId: tid };
  }
  const t = w.tables[tid];
  const o = t?.options[idx];
  if (!t || !o) {
    opts.setError("That outcome row no longer exists.");
    closeStudioRowModal();
    opts.rerender();
    return;
  }
  const label = (body.querySelector("#rm-label") as HTMLInputElement | null)?.value.trim() ?? "";
  const weight = Number((body.querySelector("#rm-weight") as HTMLInputElement | null)?.value ?? 1);
  const description = (body.querySelector("#rm-desc") as HTMLInputElement | null)?.value.trim();
  o.label = label || "Outcome";
  o.weight = Number.isFinite(weight) && weight > 0 ? weight : 1;
  o.description = description || undefined;
  const nest = body.querySelector(".effects-nest");
  const fx = parseEffectsFromNest(nest ?? undefined);
  o.effects = fx.length ? fx : undefined;
  const extra: Record<string, string | number> = {};
  for (const col of t.extraColumns ?? []) {
    const el = [...body.querySelectorAll(".rm-extra-inp")].find(
      (n) => (n as HTMLElement).dataset.rmExtra === col.id
    ) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!el) continue;
    if (col.fieldType === "number") {
      const n = Number(el.value);
      if (Number.isFinite(n)) extra[col.id] = n;
    } else {
      const s = el.value.trim();
      if (s) extra[col.id] = el.value;
    }
  }
  if (Object.keys(extra).length) o.extra = extra;
  else delete o.extra;
  closeStudioRowModal();
  opts.rerender();
}

function saveStudioColsModal(w: RpgSystem, opts: StudioWireOpts): void {
  const kind =
    (document.getElementById("ec-target-kind") as HTMLInputElement | null)?.value ?? "rollTable";
  const cols = parseExtraColumnsFromModal();
  if (kind === "rollTable") {
    const tid = (document.getElementById("ec-table-id") as HTMLInputElement | null)?.value.trim() ?? "";
    if (!tid || !w.tables[tid]) {
      closeStudioColsModal();
      opts.rerender();
      return;
    }
    syncQuickRollTablesFromDom(w);
    if (studioRoute.kind === "editTable" && studioRoute.tableId === tid) {
      const nid = syncTableView(w, tid);
      studioRoute = { kind: "editTable", tableId: nid };
      applyExtraColumnsToTable(w, nid, cols);
    } else {
      applyExtraColumnsToTable(w, tid, cols);
    }
  } else if (kind === "numeric") {
    const whichRaw = (document.getElementById("ec-numeric-which") as HTMLInputElement | null)?.value;
    const which = whichRaw === "other" ? "other" : "modifiers";
    applyNumericTrackExtraColumns(w, which, cols);
  } else if (kind === "traits") {
    applyTraitLibraryExtraColumns(w, cols);
  } else if (kind === "dimGroup") {
    const gid = (document.getElementById("ec-dim-gid") as HTMLInputElement | null)?.value.trim() ?? "";
    if (gid) applyDimGroupExtraColumns(w, gid, cols);
  } else if (kind === "sheetList") {
    const lid = (document.getElementById("ec-sheet-list-id") as HTMLInputElement | null)?.value.trim() ?? "";
    if (lid) applySheetListFieldColumns(w, lid, cols);
  } else if (kind === "archStatMods" || kind === "archResMods") {
    const gid = (document.getElementById("ec-arch-gid") as HTMLInputElement | null)?.value.trim() ?? "";
    const oid = (document.getElementById("ec-arch-oid") as HTMLInputElement | null)?.value.trim() ?? "";
    if (gid && oid) {
      if (kind === "archStatMods") applyArchStatModExtraColumns(w, gid, oid, cols);
      else applyArchResourceModExtraColumns(w, gid, oid, cols);
    }
  } else if (kind === "loadout") {
    applyLoadoutExtraColumns(w, cols);
  }
  closeStudioColsModal();
  opts.rerender();
}

/** Panel ids → human-readable titles (breadcrumb + context line) */
const STUDIO_SECTION_LABELS: Record<string, string> = {
  overview: "Overview",
  stats: "Numeric stats",
  resources: "Numeric stats",
  dimensions: "Dimensions",
  traits: "Term definitions",
  tables: "Roll tables",
  lists: "Lists",
  gear: "Starting gear",
  sheet: "Character sheet",
  advanced: "Backup",
};

function studioSectionLabel(sectionId: string): string {
  if (sectionId === "resources") return STUDIO_SECTION_LABELS.stats;
  if (sectionId === "sheetlists") return STUDIO_SECTION_LABELS.lists;
  return STUDIO_SECTION_LABELS[sectionId] ?? sectionId;
}

const NUMERIC_STAT_OPTIONAL: NumericStatOptionalColumn[] = ["name", "sheetNote"];

type NumericColVisibility = Record<NumericStatOptionalColumn, boolean>;

function numericColVisibility(w: RpgSystem, key: "modifiers" | "other"): NumericColVisibility {
  const saved =
    key === "modifiers" ? w.numericStatColumns?.modifiers : w.numericStatColumns?.other;
  const set =
    saved === undefined ? new Set(NUMERIC_STAT_OPTIONAL) : new Set(saved);
  return {
    name: set.has("name"),
    sheetNote: set.has("sheetNote"),
  };
}

function numColHideAttr(visible: boolean): string {
  return visible ? "" : ` style="display:none" aria-hidden="true"`;
}

function renderNumericColPicker(w: RpgSystem, key: "modifiers" | "other"): string {
  const vis = numericColVisibility(w, key);
  const toggles = NUMERIC_STAT_OPTIONAL.map((cid) => {
    const label = cid === "name" ? "Display name" : "Sheet note";
    const on = vis[cid];
    return `<label class="dim-col-toggle"><input type="checkbox" data-num-col="${cid}"${
      on ? " checked" : ""
    } /> ${label}</label>`;
  }).join("");
  return `<details class="disclosure disclosure--nested numeric-col-picker">
    <summary class="disclosure__summary numeric-col-picker__summary">Table columns</summary>
    <p class="muted tiny">Every row always has a stable <strong>id</strong> and a numeric <strong>start</strong> value. Toggle optional columns for a denser grid.</p>
    <div class="disclosure__body numeric-col-picker__body" data-num-col-prefs="${key}">${toggles}</div>
  </details>`;
}

/** Distinct non-empty sidebar section names (studio UI only), sorted. */
function rollTableSidebarSectionSuggestions(w: RpgSystem): string[] {
  const set = new Set<string>();
  for (const t of Object.values(w.tables)) {
    const s = (t.sidebarCategory ?? "").trim();
    if (s) set.add(s);
  }
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function renderRollTableSidebarCategoryDatalist(w: RpgSystem, listId: string): string {
  const opts = rollTableSidebarSectionSuggestions(w)
    .map((n) => `<option value="${escapeHtml(n)}"></option>`)
    .join("");
  return `<datalist id="${escapeHtml(listId)}">${opts}</datalist>`;
}

const ROLL_TABLE_SIDEBAR_DATALIST_ID = "roll-table-sidebar-sections";

function rollTableCategoryBuckets(w: RpgSystem): { label: string; tables: RollTable[] }[] {
  const map = new Map<string, RollTable[]>();
  for (const t of Object.values(w.tables)) {
    const k = (t.sidebarCategory ?? "").trim();
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(t);
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  const keys = [...map.keys()].sort((a, b) => {
    if (a === "" && b !== "") return 1;
    if (b === "" && a !== "") return -1;
    return a.localeCompare(b, undefined, { sensitivity: "base" });
  });
  return keys.map((rawKey) => ({
    label: rawKey ? rawKey : "Uncategorized",
    tables: map.get(rawKey)!,
  }));
}

function renderRollTableSidebarNav(w: RpgSystem): string {
  const route = studioRoute;
  const activeId = route.kind === "editTable" ? route.tableId : null;
  const buckets = rollTableCategoryBuckets(w);
  return buckets
    .map((b) => {
      const openAttr =
        activeId && b.tables.some((t) => t.id === activeId) ? " open" : "";
      const links = b.tables
        .map((t) => {
          const active = activeId === t.id ? " is-active" : "";
          return `<a href="#" class="cms-open-table studio-nav-sublink${active}" data-cms-table="${escapeHtml(t.id)}">${escapeHtml(trunc(t.name, 30))}</a>`;
        })
        .join("");
      return `<details class="studio-nav-rollcat"${openAttr}><summary class="studio-nav-rollcat__summary">${escapeHtml(b.label)} <span class="nav-count">${b.tables.length}</span></summary><div class="studio-nav-rollcat__body">${links}</div></details>`;
    })
    .join("");
}

function syncNumericStatColumnsFromDom(w: RpgSystem): void {
  for (const key of ["modifiers", "other"] as const) {
    const wrap = document.querySelector(`[data-num-col-prefs="${key}"]`);
    if (!wrap) continue;
    const picked: NumericStatOptionalColumn[] = [];
    wrap.querySelectorAll("input[data-num-col]:checked").forEach((inp) => {
      const c = (inp as HTMLInputElement).getAttribute("data-num-col") as NumericStatOptionalColumn | null;
      if (c && NUMERIC_STAT_OPTIONAL.includes(c)) picked.push(c);
    });
    if (!w.numericStatColumns) w.numericStatColumns = {};
    if (picked.length === NUMERIC_STAT_OPTIONAL.length) {
      delete w.numericStatColumns[key];
    } else {
      w.numericStatColumns[key] = picked;
    }
  }
  if (
    w.numericStatColumns &&
    w.numericStatColumns.modifiers === undefined &&
    w.numericStatColumns.other === undefined
  ) {
    delete w.numericStatColumns;
  }
}

function syncRollTableSidebarCategoriesFromDom(w: RpgSystem): void {
  document.querySelectorAll(".tbl-lib-cat").forEach((el) => {
    const tid = (el as HTMLElement).dataset.tblCat?.trim();
    if (!tid || !w.tables[tid]) return;
    const v = (el as HTMLInputElement).value.trim();
    if (v) w.tables[tid].sidebarCategory = v;
    else delete w.tables[tid].sidebarCategory;
  });
}

function renderStudioSidebar(w: RpgSystem, activeTab: string, dimFocus: string | null): string {
  const tabHi = studioTabHighlight(activeTab);
  const rollNav = renderRollTableSidebarNav(w);

  const rollsSectionActive = tabHi === "tables" ? " is-active" : "";
  const traitsSectionActive = tabHi === "traits" ? " is-active" : "";

  const dimAllActive = tabHi === "dimensions" && !dimFocus ? " is-active" : "";
  const dimLinks = w.archetypeGroups
    .map((g) => {
      const active = tabHi === "dimensions" && dimFocus === g.id ? " is-active" : "";
      return `<a href="#" class="studio-nav-sublink${active}" data-studio-tab="dimensions" data-dim-focus="${escapeHtml(g.id)}">${escapeHtml(trunc(g.label, 28))}</a>`;
    })
    .join("");

  const dimBlock =
    w.archetypeGroups.length === 0
      ? `<p class="nav-hint small muted">Add a choice list with <strong>+ Add dimension</strong> below or on <strong>Overview</strong>.</p>`
      : `<a href="#" class="studio-nav-sublink${dimAllActive}" data-studio-tab="dimensions" data-dim-all="1">All dimensions</a>${dimLinks}`;

  return `
    <div class="nav-group">
      <div class="nav-group-title">Project</div>
      <a href="#" class="studio-nav-link${tabHi === "overview" ? " is-active" : ""}" data-studio-tab="overview">Overview</a>
      <a href="#" class="studio-nav-link${tabHi === "advanced" ? " is-active" : ""}" data-studio-tab="advanced">Backup</a>
    </div>
    <div class="nav-group">
      <div class="nav-group-title">Character</div>
      <a href="#" class="studio-nav-link${tabHi === "stats" ? " is-active" : ""}" data-studio-tab="stats">Numeric stats</a>
    </div>
    <div class="nav-group">
      <div class="nav-group-title">Dimensions</div>
      ${dimBlock}
      <a href="#" class="cms-add-dim studio-nav-sublink studio-nav-sublink--action" id="sidebar-add-dim">+ Add dimension</a>
    </div>
    <div class="nav-group">
      <a href="#" class="nav-group-title studio-nav-link studio-nav-link--group-heading${traitsSectionActive}" data-studio-tab="traits">Term definitions</a>
    </div>
    <div class="nav-group">
      <a href="#" class="nav-group-title studio-nav-link studio-nav-link--group-heading${rollsSectionActive}" data-studio-tab="tables">Roll tables <span class="nav-count">${Object.keys(w.tables).length}</span></a>
      ${rollNav}
      <a href="#" class="studio-nav-sublink studio-nav-sublink--action" id="sidebar-new-roll">+ New roll table</a>
    </div>
    <div class="nav-group">
      <div class="nav-group-title">Content</div>
      <a href="#" class="studio-nav-link studio-nav-sublink${tabHi === "lists" ? " is-active" : ""}" data-studio-tab="lists">Lists <span class="nav-count">${Object.keys(w.sheetLists).length}</span></a>
      <a href="#" class="studio-nav-link studio-nav-sublink${tabHi === "gear" ? " is-active" : ""}" data-studio-tab="gear">Starting gear</a>
    </div>
    <div class="nav-group">
      <div class="nav-group-title">Character sheet</div>
      <a href="#" class="studio-nav-link${tabHi === "sheet" ? " is-active" : ""}" data-studio-tab="sheet">Layout &amp; display</a>
    </div>`;
}

export type StudioRoute =
  | { kind: "main" }
  | { kind: "editTable"; tableId: string }
  | { kind: "editArchetype"; groupId: string; optionId: string };

let studioRoute: StudioRoute = { kind: "main" };
export function setStudioRoute(r: StudioRoute) {
  studioRoute = r;
}
export function getStudioRoute(): StudioRoute {
  return studioRoute;
}

let working: RpgSystem | null = null;
let workingSourceId: string | null = null;

export function getWorking(): RpgSystem {
  if (!working) throw new Error("Studio working copy not initialized");
  return working;
}

export function ensureWorking(selectedId: string | null): RpgSystem {
  const id = selectedId ?? getAllSystems()[0]?.id ?? null;
  if (!id) throw new Error("No systems available");
  if (!working || workingSourceId !== id) {
    const base = getSystem(id);
    if (!base) throw new Error(`Missing system ${id}`);
    working = structuredClone(base);
    workingSourceId = id;
    studioRoute = { kind: "main" };
  }
  return working;
}

function trunc(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function summarizeStatMods(mods: ArchetypeOption["statMods"]): string {
  if (!mods?.length) return "—";
  return mods.map((m) => `${m.statId} ${m.amount >= 0 ? "+" : ""}${m.amount}`).join(", ");
}

function summarizeResMods(mods: ArchetypeOption["resourceMods"]): string {
  if (!mods?.length) return "—";
  return mods.map((m) => `${m.resourceId} ${m.amount >= 0 ? "+" : ""}${m.amount}`).join(", ");
}

function summarizeTraitRefs(w: RpgSystem, refs: string[] | undefined): string {
  if (!refs?.length) return "—";
  const lib = w.sharedTraits ?? {};
  return refs.map((id) => lib[id]?.name ?? id).join(", ");
}

/** Dimension group ids that reference this trait on any option */
function traitUsedInGroupIds(w: RpgSystem, traitId: string): string[] {
  const ids = new Set<string>();
  for (const g of w.archetypeGroups) {
    if (g.options.some((o) => o.sharedTraitRefs?.includes(traitId))) ids.add(g.id);
  }
  return [...ids];
}

function traitUsedInCell(w: RpgSystem, traitId: string): string {
  const gids = traitUsedInGroupIds(w, traitId);
  if (!gids.length) return `<span class="muted">—</span>`;
  return gids
    .map((gid) => {
      const g = w.archetypeGroups.find((x) => x.id === gid);
      const lab = g?.label ?? gid;
      return `<a href="#" class="table-cell-link" data-studio-tab="dimensions" data-dim-focus="${escapeHtml(gid)}">${escapeHtml(trunc(lab, 20))}</a>`;
    })
    .join('<span class="dim-actions-sep"> · </span>');
}

function traitRow(w: RpgSystem, t: SharedTraitDefinition): string {
  const dimCsv = traitUsedInGroupIds(w, t.id).join(",");
  const desc = t.description ?? "";
  const xcols = w.studioExtraColumns?.traits ?? [];
  const xcells = renderStudioGridExtraCells(xcols, t.extra, "trait");
  return `<tr data-trait-dims="${escapeHtml(dimCsv)}">
    <td class="mono small"><span data-trait-sum="id">${escapeHtml(t.id)}</span></td>
    <td><span data-trait-sum="name">${escapeHtml(t.name)}</span></td>
    <td class="muted small"><span data-trait-sum="desc">${escapeHtml(trackNotePreview(desc, 96))}</span></td>
    ${xcells}
    <td class="trait-used-in small">${traitUsedInCell(w, t.id)}</td>
    <td class="nowrap studio-row-actions">
      <button type="button" class="secondary small-btn" data-trait-edit>Details…</button>
      <button type="button" class="row-del danger small-btn" data-table="trait" aria-label="Remove">×</button>
    </td>
    <td class="trait-stash" hidden aria-hidden="true">
      <input name="trait-id" type="hidden" value="${escapeHtml(t.id)}" />
      <input name="trait-name" type="hidden" value="${escapeHtml(t.name)}" />
      <textarea name="trait-desc" hidden>${escapeHtml(desc)}</textarea>
    </td>
  </tr>`;
}

function renderTraitLibrary(w: RpgSystem): string {
  const dimFilterOpts =
    `<option value="">All dimensions</option>` +
    `<option value="__unused">Not used anywhere</option>` +
    w.archetypeGroups
      .map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.label)}</option>`)
      .join("");
  const rows = Object.values(w.sharedTraits ?? {})
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((t) => traitRow(w, t))
    .join("");
  const xth = (w.studioExtraColumns?.traits ?? []).map((c) => `<th>${escapeHtml(c.label)}</th>`).join("");
  return `
    <p class="muted small">A <strong>term definition</strong> is reusable text (tag, keyword, move, species rule, …) attached to several character choices. Edit it here and every linked choice updates. Filter by where it’s used.</p>
    <div class="studio-toolbar-row studio-toolbar-row--wrap">
      <label class="inline inline--grow"><span class="muted small">Filter by dimension</span>
        <select id="traits-filter-dim" class="inp inp-compact">${dimFilterOpts}</select>
      </label>
    </div>
    <table class="data-table data-table--dense">
      <thead><tr><th>Id</th><th>Label</th><th><span class="th-with-cols-trigger">Definition ${studioColsIconButton("Edit custom columns", {
        id: "traits-cols-manage",
        "data-cols-kind": "traits",
      })}</span></th>${xth}<th>Used in</th><th class="nowrap">Actions</th></tr></thead>
      <tbody id="traits-body">${rows}</tbody>
    </table>
    <p class="studio-toolbar-row"><a href="#" class="studio-action-link" id="traits-add">+ Add definition</a></p>
  `;
}

function statOptionsHtml(w: RpgSystem, selected: string): string {
  return w.stats
    .map(
      (s) =>
        `<option value="${escapeHtml(s.id)}"${s.id === selected ? " selected" : ""}>${escapeHtml(s.name)}</option>`
    )
    .join("");
}

function resourceOptionsHtml(w: RpgSystem, selected: string): string {
  return w.resources
    .map(
      (r) =>
        `<option value="${escapeHtml(r.id)}"${r.id === selected ? " selected" : ""}>${escapeHtml(r.name)}</option>`
    )
    .join("");
}

function loadoutEntryRowHtml(w: RpgSystem, entry: LoadoutEntry): string {
  const tid = entry.tableId.trim();
  const rolls = entry.rolls;
  const mode = entry.mode === "once" ? "once" : "repeat";
  const tableOpts =
    `<option value="">— pick table —</option>` +
    Object.keys(w.tables)
      .sort((a, b) => a.localeCompare(b))
      .map(
        (id) =>
          `<option value="${escapeHtml(id)}"${id === tid ? " selected" : ""}>${escapeHtml(
            w.tables[id]?.name ?? id
          )}</option>`
      )
      .join("");
  const tname = tid ? w.tables[tid]?.name ?? tid : "—";
  const modeLabel = mode === "once" ? "Once" : "Repeat";
  const loX = w.studioExtraColumns?.loadout ?? [];
  const xcells = renderStudioGridExtraCells(loX, entry.extra, "loadout");
  return `<tr>
    <td><span data-lo-sum-table>${escapeHtml(tname)}</span></td>
    <td><span data-lo-sum-rolls>${rolls}</span></td>
    <td><span data-lo-sum-mode>${modeLabel}</span></td>
    ${xcells}
    <td class="nowrap studio-row-actions">
      <button type="button" class="secondary small-btn" data-loadout-edit>Details…</button>
      <button type="button" class="row-del danger small-btn" data-table="lod" aria-label="Remove">×</button>
    </td>
    <td class="loadout-stash" hidden aria-hidden="true">
      <select class="inp inp-compact" data-loadout-table>${tableOpts}</select>
      <input class="inp inp-compact" type="number" min="0" data-loadout-rolls value="${rolls}" />
      <select class="inp inp-compact" data-loadout-mode>
        <option value="repeat"${mode === "repeat" ? " selected" : ""}>Repeat N times</option>
        <option value="once"${mode === "once" ? " selected" : ""}>Once (single draw)</option>
      </select>
    </td>
  </tr>`;
}

function renderStartingLoadoutRows(w: RpgSystem): string {
  const sg = normalizeStartingGear(w.startingGear);
  const raw = sg?.loadout ?? [];
  const entries = raw.length ? raw : [{ tableId: "", rolls: 1, mode: "repeat" as const }];
  return entries.map((e) => loadoutEntryRowHtml(w, e)).join("");
}

function tableLinkCell(w: RpgSystem, rolls: string[] | undefined): string {
  if (!rolls?.length) return "—";
  return rolls
    .map((tid) => {
      const t = w.tables[tid];
      const label = t?.name ?? tid;
      return `<a href="#" class="cms-open-table table-cell-link" data-cms-table="${escapeHtml(tid)}">${escapeHtml(trunc(label, 22))}</a>`;
    })
    .join(" ");
}

const DIMENSION_OVERVIEW_LABELS: Record<DimensionOverviewColumnId, string> = {
  id: "Id",
  name: "Name",
  desc: "Summary",
  stats: "Scores",
  resources: "Pools",
  traits: "Definitions",
  tables: "Tables",
};

function getDimensionOverviewColumns(g: ArchetypeGroup): DimensionOverviewColumnId[] {
  const raw = g.overviewColumns;
  if (!raw?.length) return [...DIMENSION_OVERVIEW_COLUMN_ORDER];
  const allowed = new Set(DIMENSION_OVERVIEW_COLUMN_ORDER);
  const filtered = raw.filter((c) => allowed.has(c));
  return filtered.length ? filtered : [...DIMENSION_OVERVIEW_COLUMN_ORDER];
}

function dimensionOverviewNeedsStash(cols: DimensionOverviewColumnId[]): boolean {
  return !cols.includes("id") || !cols.includes("name") || !cols.includes("desc");
}

function renderDimensionColumnPicker(g: ArchetypeGroup): string {
  const visible = new Set(getDimensionOverviewColumns(g));
  const toggles = DIMENSION_OVERVIEW_COLUMN_ORDER.map((cid) => {
    const on = visible.has(cid);
    return `<label class="dim-col-toggle"><input type="checkbox" data-dim-col-toggle="${escapeHtml(cid)}"${
      on ? " checked" : ""
    } /> ${escapeHtml(DIMENSION_OVERVIEW_LABELS[cid])}</label>`;
  }).join("");
  return `<details class="disclosure disclosure--nested dim-col-picker">
    <summary class="disclosure__summary dim-col-picker__summary">Overview columns</summary>
    <div class="disclosure__body dim-col-picker__body" data-dim-overview-cols="${escapeHtml(g.id)}">${toggles}</div>
  </details>`;
}

function renderDimOverviewRow(w: RpgSystem, g: ArchetypeGroup, o: ArchetypeOption, cols: DimensionOverviewColumnId[]): string {
  const stashParts: string[] = [];
  if (!cols.includes("id")) {
    stashParts.push(
      `<input class="inp inp-compact" data-opt-col="id" type="text" value="${escapeHtml(o.id)}" />`
    );
  }
  if (!cols.includes("name")) {
    stashParts.push(
      `<input class="inp inp-compact" data-opt-col="name" type="text" value="${escapeHtml(o.name)}" />`
    );
  }
  if (!cols.includes("desc")) {
    stashParts.push(
      `<input class="inp inp-compact" data-opt-col="desc" type="text" value="${escapeHtml(
        o.description ?? ""
      )}" />`
    );
  }
  const stashTd = stashParts.length
    ? `<td class="dim-overview-stash" hidden aria-hidden="true">${stashParts.join("")}</td>`
    : "";
  const bodyTds = cols
    .map((cid) => {
      switch (cid) {
        case "id":
          return `<td><input class="inp inp-compact" data-opt-col="id" type="text" value="${escapeHtml(o.id)}" /></td>`;
        case "name":
          return `<td><input class="inp inp-compact" data-opt-col="name" type="text" value="${escapeHtml(o.name)}" /></td>`;
        case "desc":
          return `<td><input class="inp inp-compact" data-opt-col="desc" type="text" value="${escapeHtml(
            o.description ?? ""
          )}" title="${escapeHtml(o.description ?? "")}" /></td>`;
        case "stats":
          return `<td class="mono small">${escapeHtml(summarizeStatMods(o.statMods))}</td>`;
        case "resources":
          return `<td class="mono small">${escapeHtml(summarizeResMods(o.resourceMods))}</td>`;
        case "traits":
          return `<td class="small">${escapeHtml(summarizeTraitRefs(w, o.sharedTraitRefs))}</td>`;
        case "tables":
          return `<td class="small">${tableLinkCell(w, o.tableRolls)}</td>`;
      }
    })
    .join("");
  const xcols = g.optionExtraColumns ?? [];
  const xcells = renderStudioGridExtraCells(xcols, o.extra, "dim");
  return `<tr data-dim-row="${escapeHtml(g.id)}" data-oid="${escapeHtml(o.id)}">${stashTd}${bodyTds}${xcells}<td class="nowrap">
            <button type="button" class="secondary small-btn" data-dim-opt-modal>Row…</button>
            <span class="dim-actions-sep">·</span>
            <a href="#" class="cms-open-option table-cell-link" data-cms-group="${escapeHtml(g.id)}" data-cms-option="${escapeHtml(o.id)}">Full editor</a>
            <span class="dim-actions-sep">·</span>
            <a href="#" class="cms-del-option table-cell-link table-cell-link--danger" data-cms-group="${escapeHtml(g.id)}" data-cms-option="${escapeHtml(o.id)}">Remove</a>
          </td></tr>`;
}

function renderDimensionsMaster(w: RpgSystem, dimFocus: string | null): string {
  if (!w.archetypeGroups.length) {
    return `<p class="muted small">No dimensions yet. Use <strong>+ Add dimension</strong> above. Each dimension is a structured list (class, lineage, origin, …) with a shared grid and per-option detail.</p>`;
  }
  return w.archetypeGroups
    .map((g) => {
      const cols = getDimensionOverviewColumns(g);
      const hasStash = dimensionOverviewNeedsStash(cols);
      const stashTh = hasStash
        ? `<th class="dim-overview-stash" hidden aria-hidden="true"></th>`
        : "";
      const headerCells = cols
        .map((c) => `<th>${escapeHtml(DIMENSION_OVERVIEW_LABELS[c])}</th>`)
        .join("");
      const xth = (g.optionExtraColumns ?? []).map((c) => `<th>${escapeHtml(c.label)}</th>`).join("");
      const rows = g.options.map((o) => renderDimOverviewRow(w, g, o, cols)).join("");
      const focusCls = dimFocus === g.id ? " dim-section--focus" : "";
      return `
      <section class="dim-section${focusCls}" id="dim-section-${escapeHtml(g.id)}" data-dim-section="${escapeHtml(g.id)}">
        <div class="dim-head dim-head--toolbar">
          <label class="inline"><span class="muted">Dimension label</span>
            <input type="text" class="inp inp-compact" data-dim-label="${escapeHtml(g.id)}" value="${escapeHtml(g.label)}" />
          </label>
          <label class="inline"><span class="muted small">Id</span>
            <input type="text" class="inp inp-compact mono" data-dim-gid value="${escapeHtml(g.id)}" title="Slug used in data; avoid duplicates" />
          </label>
          ${renderDimensionColumnPicker(g)}
          ${studioColsIconButton("Edit custom columns for choices in this dimension", {
            "data-cols-kind": "dimGroup",
            "data-cols-group": g.id,
          })}
          <button type="button" class="cms-add-option secondary small-btn" data-cms-group="${escapeHtml(g.id)}">Add option</button>
          <button type="button" class="danger small-btn cms-del-dim" data-cms-del-dim="${escapeHtml(g.id)}">Delete dimension</button>
        </div>
        <p class="muted small dim-col-hint">Pick which columns show in this list. Turn a column back on anytime; hidden id/name/summary still save.</p>
        <table class="data-table cms-master data-table--dense">
                   <thead>
            <tr>
              ${stashTh}${headerCells}${xth}<th class="nowrap">Actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
    })
    .join(`<hr class="sep" />`);
}

/** Dimension groups whose choices list this table in <code>tableRolls</code> (Extra rolls). */
function rollTableUsedInGroupIds(w: RpgSystem, tableId: string): string[] {
  const ids = new Set<string>();
  for (const l of tableRollLinksForTable(w, tableId)) {
    ids.add(l.groupId);
  }
  return [...ids];
}

function rollTableUsedInCell(w: RpgSystem, tableId: string): string {
  const gids = rollTableUsedInGroupIds(w, tableId);
  if (!gids.length) return `<span class="muted">—</span>`;
  return gids
    .map((gid) => {
      const g = w.archetypeGroups.find((x) => x.id === gid);
      const lab = g?.label ?? gid;
      return `<a href="#" class="table-cell-link" data-studio-tab="dimensions" data-dim-focus="${escapeHtml(gid)}">${escapeHtml(trunc(lab, 20))}</a>`;
    })
    .join('<span class="dim-actions-sep"> · </span>');
}

function rollTableKindLabel(w: RpgSystem, t: RollTable): string {
  return tableRollLinksForTable(w, t.id).length === 1 ? "Linked choice" : "General";
}

function renderTableUsedByLine(w: RpgSystem, tid: string): string {
  const links = tableRollLinksForTable(w, tid);
  if (links.length === 0) {
    return `<p class="tbl-related-line muted tiny"><span class="tbl-related-kicker">Used by</span> — <span class="muted">(no choice yet — link under Dimensions → Edit → Extra rolls.)</span></p>`;
  }
  const parts = links.map(({ groupId, optionId }) => {
    const g = w.archetypeGroups.find((x) => x.id === groupId);
    const o = g?.options.find((x) => x.id === optionId);
    const gl = g?.label ?? groupId;
    const on = o?.name ?? optionId;
    return `${escapeHtml(gl)} → ${escapeHtml(on)}`;
  });
  return `<p class="tbl-related-line muted tiny"><span class="tbl-related-kicker">Used by</span> ${parts.join('<span class="tbl-related-sep"> · </span>')}</p>`;
}

function quickOutcomeExtraCells(t: RollTable, opt: TableOption): string {
  return (t.extraColumns ?? [])
    .map((col) => {
      const v = opt.extra?.[col.id];
      const val = v === undefined ? "" : String(v);
      const d = escapeHtml(col.id);
      if (col.fieldType === "textarea") {
        return `<td><textarea class="inp inp-compact qt-extra" data-qt-extra="${d}" rows="1">${escapeHtml(val)}</textarea></td>`;
      }
      if (col.fieldType === "number") {
        const n = typeof v === "number" ? v : Number(val);
        const shown = Number.isFinite(n) ? String(n) : "";
        return `<td><input class="inp inp-compact qt-extra" data-qt-extra="${d}" type="number" step="any" value="${escapeHtml(shown)}" /></td>`;
      }
      return `<td><input class="inp inp-compact qt-extra" data-qt-extra="${d}" type="text" value="${escapeHtml(val)}" /></td>`;
    })
    .join("");
}

function htmlQuickRollNewRow(w: RpgSystem, t: RollTable): string {
  const extras = (t.extraColumns ?? [])
    .map((col) => {
      const d = escapeHtml(col.id);
      if (col.fieldType === "textarea") {
        return `<td><textarea class="inp inp-compact qt-extra" data-qt-extra="${d}" rows="1"></textarea></td>`;
      }
      if (col.fieldType === "number") {
        return `<td><input class="inp inp-compact qt-extra" data-qt-extra="${d}" type="number" step="any" value="" /></td>`;
      }
      return `<td><input class="inp inp-compact qt-extra" data-qt-extra="${d}" type="text" value="" /></td>`;
    })
    .join("");
  return `
    <tr>
      <td><input type="text" class="inp inp-compact qt-label" value="New outcome" /></td>
      <td class="tbl-col-weight"><input type="number" class="inp inp-compact qt-w" min="1" step="1" value="1" title="Relative chance vs other rows" /></td>
      <td><input type="text" class="inp inp-compact qt-d" value="" placeholder="Note" /></td>
      ${extras}
      <td class="qt-fx-cell">
        <input type="hidden" class="qt-effects-stash" value="${effectsStashEscapedAttr([])}" />
        <div class="qt-fx-summary muted small">${escapeHtml(summarizeEffectsForTable(w, []))}</div>
        <button type="button" class="secondary small-btn" data-open-effects-quick="${escapeHtml(t.id)}">Edit effects…</button>
      </td>
      <td><button type="button" class="secondary small-btn" data-quick-row-edit>Row…</button></td>
      <td><button type="button" class="row-del" data-table="qt" aria-label="Remove">×</button></td>
    </tr>`;
}

function renderQuickRollOutcomeRows(w: RpgSystem, t: RollTable): string {
  return t.options
    .map((opt) => {
      const extras = quickOutcomeExtraCells(t, opt);
      return `
    <tr>
      <td><input type="text" class="inp inp-compact qt-label" value="${escapeHtml(opt.label)}" /></td>
      <td class="tbl-col-weight"><input type="number" class="inp inp-compact qt-w" min="1" step="1" value="${opt.weight ?? 1}" title="Relative chance vs other rows" /></td>
      <td><input type="text" class="inp inp-compact qt-d" value="${escapeHtml(opt.description ?? "")}" placeholder="Note" /></td>
      ${extras}
      <td class="qt-fx-cell">
        <input type="hidden" class="qt-effects-stash" value="${effectsStashEscapedAttr(opt.effects)}" />
        <div class="qt-fx-summary muted small">${escapeHtml(summarizeEffectsForTable(w, opt.effects))}</div>
        <button type="button" class="secondary small-btn" data-open-effects-quick="${escapeHtml(t.id)}">Edit effects…</button>
      </td>
      <td><button type="button" class="secondary small-btn" data-quick-row-edit>Row…</button></td>
      <td><button type="button" class="row-del" data-table="qt" aria-label="Remove">×</button></td>
    </tr>`;
    })
    .join("");
}

function renderTableLibrary(w: RpgSystem): string {
  const dimFilterOpts =
    `<option value="">Every dimension</option>` +
    `<option value="__unused">Not tied to a dimension</option>` +
    w.archetypeGroups
      .map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.label)}</option>`)
      .join("");
  const rows = Object.values(w.tables)
    .map((t) => {
      const dimCsv = rollTableUsedInGroupIds(w, t.id).join(",");
      const qtRows = renderQuickRollOutcomeRows(w, t);
      const qh = (t.extraColumns ?? []).map((c) => `<th>${escapeHtml(c.label)}</th>`).join("");
      return `<tr data-table-dims="${escapeHtml(dimCsv)}">
        <td class="mono small">${escapeHtml(t.id)}</td>
        <td>${escapeHtml(t.name)}${t.includeOnCharacterSheet ? ` <span class="tbl-sheet-badge muted tiny" title="Full outcomes print on the character sheet">(sheet)</span>` : ""}</td>
        <td class="tbl-lib-section-cell"><input class="inp inp-compact tbl-lib-cat tbl-lib-cat--discreet" type="text" data-tbl-cat="${escapeHtml(t.id)}" value="${escapeHtml(t.sidebarCategory ?? "")}" list="${ROLL_TABLE_SIDEBAR_DATALIST_ID}" placeholder="—" title="Studio sidebar only: groups this link under a heading in the left nav. Does not change table content." autocomplete="off" /></td>
        <td class="small">${escapeHtml(rollTableKindLabel(w, t))}</td>
        <td class="small">${rollTableUsedInCell(w, t.id)}</td>
        <td>${t.options.length}</td>
        <td class="tbl-lib-actions">
          <details class="tbl-quick">
            <summary>Edit outcomes here</summary>
            <table class="data-table data-table--dense tbl-quick-inner">
              <thead><tr><th><span class="th-with-cols-trigger">Result ${studioColsIconButton("Edit outcome columns", {
                "data-cols-kind": "rollTable",
                "data-cols-table": t.id,
              })}</span></th><th class="tbl-col-weight"><abbr title="Relative pick chance vs other rows">Wt</abbr></th><th>Note</th>${qh}<th>Effects</th><th class="nowrap">Row</th><th></th></tr></thead>
              <tbody data-quick-tbl="${escapeHtml(t.id)}">${qtRows}</tbody>
            </table>
            <button type="button" class="secondary small-btn" data-quick-tbl-add="${escapeHtml(t.id)}">+ Row</button>
          </details>
          <span class="tbl-lib-sep muted">·</span>
          <a href="#" class="cms-open-table table-cell-link" data-cms-table="${escapeHtml(t.id)}">Effects &amp; details →</a>
          <span class="tbl-lib-sep muted">·</span>
          <a href="#" class="table-cell-link table-cell-link--danger" data-cms-del-table="${escapeHtml(t.id)}">Delete</a>
        </td>
      </tr>`;
    })
    .join("");
  return `
    <p class="muted small">Weighted tables: each outcome row has a <strong>Wt</strong> (relative pick chance). Edit rows here or open a table for full effects. “List as” follows which dimension choices reference the table.</p>
    ${renderRollTableSidebarCategoryDatalist(w, ROLL_TABLE_SIDEBAR_DATALIST_ID)}
    <div class="studio-toolbar-row studio-toolbar-row--wrap">
      <label class="inline inline--grow"><span class="muted small">Show tables used by</span>
        <select id="tables-filter-dim" class="inp inp-compact">${dimFilterOpts}</select>
      </label>
      <a href="#" class="studio-action-link" id="cms-add-table">+ New roll table</a>
    </div>
    <table class="data-table cms-master data-table--dense">
      <thead><tr><th>Id</th><th>Name</th><th class="tbl-lib-section-col"><abbr title="Studio sidebar only — groups links in the left nav; not part of game content">Nav</abbr></th><th>List as</th><th>Used on</th><th>Rows</th><th>Actions</th></tr></thead>
      <tbody id="tables-lib-body">${rows}</tbody>
    </table>`;
}

function sortTracksById<T extends { id: string }>(defs: T[]): T[] {
  return [...defs].sort((a, b) => a.id.localeCompare(b.id));
}

function renderTracksStatsBody(w: RpgSystem): string {
  const vis = numericColVisibility(w, "modifiers");
  const xc = w.studioExtraColumns?.numericModifiers ?? [];
  return sortTracksById(w.stats).map((s) => statRow(s, vis, xc)).join("");
}

function renderTracksPoolsBody(w: RpgSystem): string {
  const vis = numericColVisibility(w, "other");
  const xc = w.studioExtraColumns?.numericOther ?? [];
  return sortTracksById(w.resources).map((r) => resRow(r, vis, xc)).join("");
}

function statRow(s: StatDefinition, vis: NumericColVisibility, extraCols: RollTableExtraColumn[]): string {
  const exp = s.sheetExplanation ?? "";
  const dn = numColHideAttr(vis.name);
  const ds = numColHideAttr(vis.sheetNote);
  const xcells = renderStudioGridExtraCells(extraCols, s.extra, "track");
  return `<tr data-tr-kind="stat">
    <td><input class="inp inp-compact mono" name="sid" type="text" value="${escapeHtml(s.id)}" title="Stable id — required" /></td>
    <td${dn}><input class="inp inp-compact" name="sname" type="text" value="${escapeHtml(s.name)}" placeholder="Display name" /></td>
    <td><input class="inp inp-compact" name="sdef" type="number" step="any" value="${s.defaultValue}" title="Starting numeric value — required" /></td>
    <td${ds}><textarea class="inp inp-compact code-sm" name="sexplain" rows="2" placeholder="Sheet note">${escapeHtml(exp)}</textarea></td>
    ${xcells}
    <td class="nowrap studio-row-actions">
      <button type="button" class="secondary small-btn" data-track-edit>Expand…</button>
      <button type="button" class="row-del danger small-btn" data-table="abl" aria-label="Remove">×</button>
    </td>
  </tr>`;
}

function renderNumericTracksThead(
  vis: NumericColVisibility,
  extraCols: RollTableExtraColumn[],
  which: "modifiers" | "other"
): string {
  const dn = numColHideAttr(vis.name);
  const ds = numColHideAttr(vis.sheetNote);
  const xh = extraCols.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("");
  const colBtn = studioColsIconButton("Edit custom columns for this table", {
    id: which === "modifiers" ? "numeric-cols-modifiers" : "numeric-cols-other",
    "data-cols-kind": "numeric",
    "data-cols-which": which,
  });
  return `<thead><tr>
    <th>Id <span class="muted tiny font-normal">(required)</span></th>
    <th${dn}>Name</th>
    <th>Start <span class="muted tiny font-normal">(number)</span></th>
    <th${ds}>Sheet note</th>
    ${xh}
    <th class="nowrap"><span class="th-with-cols-trigger">${colBtn} Actions</span></th>
  </tr></thead>`;
}

function resRow(r: ResourceDefinition, vis: NumericColVisibility, extraCols: RollTableExtraColumn[]): string {
  const exp = r.sheetExplanation ?? "";
  const dn = numColHideAttr(vis.name);
  const ds = numColHideAttr(vis.sheetNote);
  const xcells = renderStudioGridExtraCells(extraCols, r.extra, "track");
  return `<tr data-tr-kind="resource">
    <td><input class="inp inp-compact mono" name="rid" type="text" value="${escapeHtml(r.id)}" title="Stable id — required" /></td>
    <td${dn}><input class="inp inp-compact" name="rname" type="text" value="${escapeHtml(r.name)}" placeholder="Display name" /></td>
    <td><input class="inp inp-compact" name="rdef" type="number" step="any" value="${r.defaultValue}" title="Starting numeric value — required" /></td>
    <td${ds}><textarea class="inp inp-compact code-sm" name="rexplain" rows="2" placeholder="Sheet note">${escapeHtml(exp)}</textarea></td>
    ${xcells}
    <td class="nowrap studio-row-actions">
      <button type="button" class="secondary small-btn" data-track-edit>Expand…</button>
      <button type="button" class="row-del danger small-btn" data-table="res" aria-label="Remove">×</button>
    </td>
  </tr>`;
}

function renderSheetListFieldRow(f: SchemaField, i: number): string {
  return `<tr data-slist-fld-idx="${i}">
    <td class="mono"><span data-sfld-sum-id>${escapeHtml(f.id)}</span></td>
    <td><span data-sfld-sum-lab>${escapeHtml(f.label)}</span> <span class="muted tiny" data-sfld-sum-type>(${escapeHtml(f.fieldType)})</span></td>
    <td class="nowrap">
      <button type="button" class="secondary small-btn" data-slist-field-edit>Details…</button>
      <button type="button" class="danger small-btn" data-slist-del-field>×</button>
    </td>
    <td class="sfld-stash" hidden aria-hidden="true">
      <input class="inp inp-compact mono" data-sfid type="hidden" value="${escapeHtml(f.id)}" />
      <input class="inp inp-compact" data-sflabel type="hidden" value="${escapeHtml(f.label)}" />
      <select class="inp inp-compact" data-sftype>
        <option value="text"${f.fieldType === "text" ? " selected" : ""}>text</option>
        <option value="number"${f.fieldType === "number" ? " selected" : ""}>number</option>
        <option value="textarea"${f.fieldType === "textarea" ? " selected" : ""}>textarea</option>
      </select>
    </td>
  </tr>`;
}

function renderSheetListEntryRow(w: RpgSystem, listId: string, eid: string, ent: SheetListEntry): string {
  const def = w.sheetLists[listId]!;
  const previewParts = def.fields.map((f) => {
    const v = ent.values[f.id];
    return `${f.label}: ${v === undefined ? "" : String(v)}`;
  });
  const previewRaw = previewParts.join(" · ").replace(/\s+/g, " ").trim() || "—";
  const preview = previewRaw.length > 120 ? `${previewRaw.slice(0, 117)}…` : previewRaw;
  const stashFields = def.fields
    .map((f) => {
      const v = ent.values[f.id];
      const val = v === undefined ? "" : String(v);
      const fe = escapeHtml(f.id);
      if (f.fieldType === "textarea") {
        return `<textarea class="inp inp-compact code-sm" data-slist-ev="${fe}" rows="2">${escapeHtml(val)}</textarea>`;
      }
      if (f.fieldType === "number") {
        const n = typeof v === "number" ? v : Number(val);
        const shown = Number.isFinite(n) ? String(n) : "";
        return `<input class="inp inp-compact" data-slist-ev="${fe}" type="number" step="any" value="${escapeHtml(shown)}" />`;
      }
      return `<input class="inp inp-compact" data-slist-ev="${fe}" type="text" value="${escapeHtml(val)}" />`;
    })
    .join("");
  return `<tr class="slist-entry-row" data-slist-entry="${escapeHtml(eid)}">
    <td class="mono"><span data-slist-eid-display>${escapeHtml(eid)}</span></td>
    <td class="muted small" data-slist-entry-preview>${escapeHtml(preview)}</td>
    <td class="slist-entry-fx-cell">
      <input type="hidden" class="slist-entry-effects-stash" value="${effectsStashEscapedAttr(ent.effects)}" />
      <div class="slist-entry-fx-summary muted small">${escapeHtml(summarizeEffectsForTable(w, ent.effects))}</div>
      <button type="button" class="secondary small-btn" data-open-effects-sheetentry>Edit effects…</button>
    </td>
    <td class="nowrap">
      <button type="button" class="secondary small-btn" data-slist-entry-edit>Edit row…</button>
      <button type="button" class="danger small-btn" data-slist-del-entry>×</button>
    </td>
    <td class="slist-entry-stash" hidden aria-hidden="true">
      <input class="inp inp-compact mono" data-slist-eid type="hidden" value="${escapeHtml(eid)}" />
      ${stashFields}
    </td>
  </tr>`;
}

function renderSheetListSourceTableSelect(w: RpgSystem, current: string | undefined): string {
  let orphan = "";
  if (current && !w.tables[current]) {
    orphan = `<option value="${escapeHtml(current)}" selected>${escapeHtml(`[missing table: ${current}]`)}</option>`;
  }
  const opts =
    `<option value="">${escapeHtml("— Custom list (your own columns & rows) —")}</option>` +
    orphan +
    Object.values(w.tables)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => {
        const sel = current === t.id ? " selected" : "";
        return `<option value="${escapeHtml(t.id)}"${sel}>${escapeHtml(t.name)}</option>`;
      })
      .join("");
  return `<label class="block"><span class="muted small">Roll table (rows on the sheet)</span><select class="inp inp-compact" data-slist-source-table>${opts}</select></label>`;
}

function renderSheetListDisplayColumnToggles(t: RollTable, selected: string[]): string {
  const sel = (id: string, label: string) =>
    `<label class="check slist-dcol-label"><input type="checkbox" data-slist-dcol="${escapeHtml(id)}"${
      selected.includes(id) ? " checked" : ""
    } /> ${escapeHtml(label)}</label>`;
  const parts = [sel(SHEET_COL_LABEL, "Result label"), sel(SHEET_COL_DESCRIPTION, "Note / description")];
  for (const ec of t.extraColumns ?? []) {
    parts.push(sel(extraSheetColId(ec.id), ec.label));
  }
  return parts.join(" ");
}

function renderSheetListTablePreview(w: RpgSystem, listId: string): string {
  const def = w.sheetLists[listId]!;
  if (!def.sourceTableId) return "";
  const t = w.tables[def.sourceTableId];
  if (!t) return "";
  const fields = getSheetListFields(w, listId);
  if (!fields.length) return `<p class="muted small">Select at least one column above.</p>`;
  const th = fields.map((f) => `<th>${escapeHtml(f.label)}</th>`).join("");
  const rows = t.options
    .map((_, i) => {
      const ent = resolveSheetListEntry(w, listId, String(i));
      if (!ent) return "";
      const cells = fields
        .map((f) => {
          const v = ent.values[f.id];
          return `<td class="small">${escapeHtml(v === undefined ? "" : String(v))}</td>`;
        })
        .join("");
      return `<tr><td class="muted mono">${i}</td>${cells}</tr>`;
    })
    .join("");
  return `<div class="spreadsheet-wrap"><table class="data-table data-table--dense"><thead><tr><th>#</th>${th}</tr></thead><tbody>${rows}</tbody></table></div><p class="muted tiny">Effects use this <strong>#</strong> (0-based) as the row when granting from this list.</p>`;
}

function renderSheetListDataBlock(w: RpgSystem, listId: string): string {
  const def = w.sheetLists[listId]!;
  const t = def.sourceTableId ? w.tables[def.sourceTableId] : undefined;
  const isTableBacked = Boolean(def.sourceTableId && t);

  const tableBackedSection =
    isTableBacked && t
      ? `
      <h5 class="subh subh--tight">Preview</h5>
      <p class="muted tiny">Visible columns follow <strong>Character sheet → Layout &amp; display</strong>. Edit outcomes in <a href="#" class="cms-open-table" data-cms-table="${escapeHtml(
        def.sourceTableId!
      )}">Roll tables — ${escapeHtml(t.name)}</a>.</p>
      ${renderSheetListTablePreview(w, listId)}`
      : def.sourceTableId && !t
        ? `<p class="msg-error small">That roll table no longer exists. Choose another table or switch to a custom list.</p>`
        : "";

  const fieldRows = def.fields.map((f, i) => renderSheetListFieldRow(f, i)).join("");
  const entryRows = Object.keys(def.entries)
    .sort()
    .map((eid) => renderSheetListEntryRow(w, listId, eid, def.entries[eid]!))
    .join("");

  const manualSection = !isTableBacked
    ? `
      <h5 class="subh subh--tight">Columns ${studioColsIconButton("Add, rename, or remove list columns", {
        "data-cols-kind": "sheetList",
        "data-cols-list": listId,
      })}</h5>
      <p class="muted tiny">Stable field ids for data; labels appear when printing the list. Use <strong>Details…</strong> to edit a column, or the column icon for the full column list.</p>
      <table class="data-table data-table--dense">
        <thead><tr><th>Field id</th><th>Label (type)</th><th class="nowrap">Actions</th></tr></thead>
        <tbody data-slist-fields-body>${fieldRows}</tbody>
      </table>
      <p class="studio-toolbar-row"><button type="button" class="secondary small-btn" data-slist-add-field>+ Add column</button></p>
      <h5 class="subh subh--tight">Rows</h5>
      <p class="muted tiny">Summary of each row; open <strong>Edit row…</strong> for all field values.</p>
      <div class="spreadsheet-wrap">
        <table class="data-table data-table--dense data-table--spreadsheet">
          <thead><tr><th>Row id</th><th>Summary</th><th>Effects</th><th class="nowrap">Actions</th></tr></thead>
          <tbody data-slist-entries-body>${entryRows}</tbody>
        </table>
      </div>
      <p class="studio-toolbar-row"><button type="button" class="secondary small-btn" data-slist-add-entry>+ Add row</button></p>`
    : "";

  return `
    <section class="sheet-list-editor sheet-list-editor--data" data-sheet-list-data="${escapeHtml(listId)}">
      <h4 class="subh">${escapeHtml(def.sheetTitle)}</h4>
      <p class="mono small muted">List id: <strong>${escapeHtml(listId)}</strong> — stable id for effects and data; rename only via export/import if needed.</p>
      ${renderSheetListSourceTableSelect(w, def.sourceTableId)}
      ${tableBackedSection}
      ${manualSection}
      <p class="studio-toolbar-row"><button type="button" class="danger small-btn" data-slist-delete-list>Delete this list</button></p>
    </section>`;
}

function renderSheetListDisplayBlock(w: RpgSystem, listId: string): string {
  const def = w.sheetLists[listId]!;
  const t = def.sourceTableId ? w.tables[def.sourceTableId] : undefined;
  const cols = def.sourceTableId && t ? sheetListDisplayColumns(def) : [];
  const isTableBacked = Boolean(def.sourceTableId && t);

  const tableDisplaySection =
    isTableBacked && t
      ? `
      <h5 class="subh subh--tight">Columns on character sheet</h5>
      <p class="muted tiny">Which outcome fields appear in this printed section.</p>
      <div class="slist-dcol-wrap" data-slist-dcol-wrap>${renderSheetListDisplayColumnToggles(t, cols)}</div>`
      : def.sourceTableId && !t
        ? `<p class="msg-error small">Roll table missing — fix the link under <strong>Content → Lists</strong>.</p>`
        : `<p class="muted tiny">Custom list: row data is edited under <strong>Content → Lists</strong>. Only the section title here sets the printed block heading.</p>`;

  return `
    <section class="sheet-list-editor sheet-list-editor--display" data-sheet-list-display="${escapeHtml(listId)}">
      <h4 class="subh">${escapeHtml(def.sheetTitle)}</h4>
      <p class="mono small muted">List id: <strong>${escapeHtml(listId)}</strong> · <a href="#" class="table-cell-link" data-studio-tab="lists">Edit data in Lists</a></p>
      <label class="block"><span class="muted small">Section title (printed on character sheet)</span><input class="inp inp-compact" data-slist-sheet-title type="text" value="${escapeHtml(def.sheetTitle)}" /></label>
      ${tableDisplaySection}
    </section>`;
}

function renderListsPanel(w: RpgSystem): string {
  const blocks = Object.keys(w.sheetLists)
    .sort()
    .map((id) => renderSheetListDataBlock(w, id))
    .join("");
  return `
    <div id="sheet-lists-data-root">
      <p class="muted small"><strong>Lists</strong> are registry data: weapons, gear, spells, or any rows effects and chargen reference. A list can mirror a roll table’s outcomes or use custom columns. <strong>Character sheet → Layout &amp; display</strong> chooses printed headings and visible columns only.</p>
      ${blocks || `<p class="muted small">No lists yet. Add one to get started.</p>`}
    </div>
    <p class="studio-toolbar-row"><button type="button" class="primary small-btn" id="sheetlist-add-list">+ Add list</button></p>`;
}

function renderCharacterSheetPanel(w: RpgSystem): string {
  const listBlocks = Object.keys(w.sheetLists)
    .sort()
    .map((id) => renderSheetListDisplayBlock(w, id))
    .join("");
  const refTables = Object.values(w.tables)
    .filter((t) => t.includeOnCharacterSheet)
    .sort((a, b) => a.name.localeCompare(b.name));
  const refRows =
    refTables.length === 0
      ? `<tr><td colspan="3" class="muted small">None. Enable <strong>Print full table on character sheet</strong> when editing a roll table.</td></tr>`
      : refTables
          .map(
            (t) =>
              `<tr><td class="mono small">${escapeHtml(t.id)}</td><td><a href="#" class="cms-open-table table-cell-link" data-cms-table="${escapeHtml(t.id)}">${escapeHtml(t.name)}</a></td><td class="small muted">Full table (all outcomes) on the sheet.</td></tr>`
          )
          .join("");
  return `
    <p class="muted small">Control <strong>what the generated character sheet shows</strong> from data you already built. Rows, outcomes, and effects are edited under <strong>Content</strong> and <strong>Roll tables</strong>.</p>
    <h4 class="subh subh--tight">Printed list sections</h4>
    <div id="sheet-display-root">${listBlocks || `<p class="muted small">No lists yet. Add registry lists under <strong>Content → Lists</strong>.</p>`}</div>
    <h4 class="subh subh--tight studio-subpanel--spaced">Full tables on the sheet</h4>
    <p class="muted tiny">Weighted tables printed in full (in-play reference).</p>
    <table class="data-table data-table--dense">
      <thead><tr><th>Id</th><th>Table</th><th></th></tr></thead>
      <tbody>${refRows}</tbody>
    </table>`;
}

function outcomeExtraCells(t: RollTable, opt: TableOption): string {
  return (t.extraColumns ?? [])
    .map((col) => {
      const v = opt.extra?.[col.id];
      const val = v === undefined ? "" : String(v);
      const d = escapeHtml(col.id);
      if (col.fieldType === "textarea") {
        return `<td><textarea class="inp inp-compact tbl-o-extra" data-tbl-extra="${d}" rows="1">${escapeHtml(val)}</textarea></td>`;
      }
      if (col.fieldType === "number") {
        const n = typeof v === "number" ? v : Number(val);
        const shown = Number.isFinite(n) ? String(n) : "";
        return `<td><input class="inp inp-compact tbl-o-extra" data-tbl-extra="${d}" type="number" step="any" value="${escapeHtml(shown)}" /></td>`;
      }
      return `<td><input class="inp inp-compact tbl-o-extra" data-tbl-extra="${d}" type="text" value="${escapeHtml(val)}" /></td>`;
    })
    .join("");
}

function renderTableOptionCard(w: RpgSystem, t: RollTable, opt: TableOption, idx: number): string {
  const extras = outcomeExtraCells(t, opt);
  return `
    <tr class="table-opt-card" data-tbl-opt-idx="${idx}">
      <td class="muted small mono tbl-col-idx">${idx + 1}</td>
      <td><input class="inp inp-compact tbl-o-label" type="text" value="${escapeHtml(opt.label)}" /></td>
      <td class="tbl-col-weight"><input class="inp inp-compact tbl-o-weight" type="number" min="0" step="1" value="${opt.weight ?? 1}" title="Relative chance vs other rows (not a die size)" /></td>
      <td><input class="inp inp-compact tbl-o-desc" type="text" value="${escapeHtml(opt.description ?? "")}" placeholder="Note" /></td>
      ${extras}
      <td class="tbl-o-fx-cell">
        <input type="hidden" class="tbl-o-effects-stash" value="${effectsStashEscapedAttr(opt.effects)}" />
        <div class="tbl-o-fx-summary muted small">${escapeHtml(summarizeEffectsForTable(w, opt.effects))}</div>
        <button type="button" class="secondary small-btn" data-open-effects-tblopt="1">Edit effects…</button>
      </td>
      <td class="tbl-col-row-edit"><button type="button" class="secondary small-btn" data-tbl-row-edit="${idx}">Edit row…</button></td>
      <td class="tbl-col-del"><button type="button" class="danger small tbl-del-opt" data-idx="${idx}">×</button></td>
    </tr>`;
}

function renderTableEditor(w: RpgSystem, tid: string): string {
  const t = w.tables[tid];
  if (!t) return `<p>Missing table.</p>`;
  const optCards = t.options.map((opt, i) => renderTableOptionCard(w, t, opt, i)).join("");
  const extraTh = (t.extraColumns ?? []).map((c) => `<th>${escapeHtml(c.label)}</th>`).join("");
  return `
    <div class="table-editor table-editor--compact">
    ${renderRollTableSidebarCategoryDatalist(w, ROLL_TABLE_SIDEBAR_DATALIST_ID)}
 <div class="form-grid-3 form-grid-3--tight tbl-meta-grid">
      <label><span class="muted small">Id</span><input class="inp inp-compact" id="tbl-id" type="text" value="${escapeHtml(t.id)}" /></label>
      <label class="span-2"><span class="muted small">Name</span><input class="inp inp-compact" id="tbl-name" type="text" value="${escapeHtml(t.name)}" /></label>
    </div>
    <details class="disclosure disclosure--nested tbl-editor-nav-group">
      <summary class="disclosure__summary tbl-editor-nav-group__summary">Left nav grouping <span class="muted tiny font-normal">(optional, UI only)</span></summary>
      <div class="disclosure__body tbl-editor-nav-group__body">
        <p class="muted tiny tbl-editor-nav-group__hint">Does not affect rolls, lists, or character content—only how this table is grouped in the sidebar.</p>
        <label class="block tbl-editor-nav-group__field"><span class="muted tiny">Section name</span><input class="inp inp-compact tbl-sidebar-cat-input" id="tbl-sidebar-cat" type="text" value="${escapeHtml(t.sidebarCategory ?? "")}" list="${ROLL_TABLE_SIDEBAR_DATALIST_ID}" placeholder="e.g. Equipment" title="Pick a previous name from suggestions or type a new one." autocomplete="off" /></label>
      </div>
    </details>
    <p class="studio-toolbar-row studio-toolbar-row--wrap">
      <label class="inline"><input type="checkbox" id="tbl-sheet-ref" ${t.includeOnCharacterSheet ? "checked" : ""} />
        <span>Print full table on character sheet</span></label>
      <span class="muted tiny">Use for in-play tables (e.g. roll again each session). Chargen-only tables can stay off.</span>
    </p>
    ${renderTableUsedByLine(w, tid)}
    <h4 class="subh subh--tight">Outcomes ${studioColsIconButton("Edit outcome columns", {
      id: "tbl-cols-manage",
      "data-cols-kind": "rollTable",
      "data-cols-table": tid,
    })}</h4>
    <p class="muted tiny tbl-outcomes-intro">Each row is one possible result when this table is rolled. <strong>Weight</strong> is a <em>relative</em> chance compared to other rows (4 vs 2 means twice as likely)—not a die size or DC. Use the column icon for extra fields per row (generation still uses label, weight, and effects).</p>
    <table class="data-table data-table--dense table-opt-sheet">
      <thead><tr><th class="tbl-col-idx">#</th><th>Result label</th><th class="tbl-col-weight"><abbr title="Relative pick chance: higher = more likely than other rows">Wt</abbr></th><th>Note</th>${extraTh}<th>Effects</th><th class="tbl-col-row-edit"></th><th class="tbl-col-del"></th></tr></thead>
      <tbody id="tbl-options-wrap">${optCards}</tbody>
    </table>
    <p class="studio-toolbar-row"><button type="button" class="secondary small-btn" id="tbl-add-opt">+ Add row</button></p>
    </div>
  `;
}

function renderArchetypeEditor(w: RpgSystem, groupId: string, optionId: string): string {
  const g = w.archetypeGroups.find((x) => x.id === groupId);
  const o = g?.options.find((x) => x.id === optionId);
  if (!g || !o) return `<p>Missing option.</p>`;
  const smXcols = o.statModExtraColumns ?? [];
  const rmXcols = o.resourceModExtraColumns ?? [];
  const smXh = smXcols.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("");
  const rmXh = rmXcols.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("");
  const archColsSm = {
    "data-cols-kind": "archStatMods",
    "data-cols-arch-gid": groupId,
    "data-cols-arch-oid": optionId,
  };
  const archColsRm = {
    "data-cols-kind": "archResMods",
    "data-cols-arch-gid": groupId,
    "data-cols-arch-oid": optionId,
  };
  const statRows = (o.statMods ?? [])
    .map((m, i) => {
      const xcells = renderStudioGridExtraCells(smXcols, m.extra, "archSm");
      return `
    <tr data-sm-i="${i}">
      <td><select class="inp" data-sm-stat>${statOptionsHtml(w, m.statId)}</select></td>
      <td><input type="number" class="inp" data-sm-amt value="${m.amount}" /></td>
      ${xcells}
      <td><button type="button" class="row-del" data-table="sm">×</button></td>
    </tr>`;
    })
    .join("");
  const resRows = (o.resourceMods ?? [])
    .map((m, i) => {
      const xcells = renderStudioGridExtraCells(rmXcols, m.extra, "archRm");
      return `
    <tr data-rm-i="${i}">
      <td><select class="inp" data-rm-res>${resourceOptionsHtml(w, m.resourceId)}</select></td>
      <td><input type="number" class="inp" data-rm-amt value="${m.amount}" /></td>
      ${xcells}
      <td><button type="button" class="row-del" data-table="rm">×</button></td>
    </tr>`;
    })
    .join("");
  const tblOpts = Object.keys(w.tables)
    .map((tid) => {
      const t = w.tables[tid]!;
      const sel = (o.tableRolls ?? []).includes(tid) ? " selected" : "";
      return `<option value="${escapeHtml(tid)}"${sel}>${escapeHtml(t.name)}</option>`;
    })
    .join("");
  const traitOpts = Object.keys(w.sharedTraits ?? {})
    .sort()
    .map((tid) => {
      const tr = w.sharedTraits![tid]!;
      const sel = (o.sharedTraitRefs ?? []).includes(tid) ? " selected" : "";
      return `<option value="${escapeHtml(tid)}"${sel}>${escapeHtml(tr.name)}</option>`;
    })
    .join("");
  return `
    <div class="arch-editor arch-editor--compact">
    <input type="hidden" id="arch-gid" value="${escapeHtml(groupId)}" />
    <input type="hidden" id="arch-oid" value="${escapeHtml(optionId)}" />
    <div class="form-grid-2 form-grid-2--tight">
      <label><span class="muted small">Option id</span><input class="inp inp-compact" id="arch-id" type="text" value="${escapeHtml(o.id)}" /></label>
      <label><span class="muted small">Name</span><input class="inp inp-compact" id="arch-name" type="text" value="${escapeHtml(o.name)}" /></label>
      <label class="span-full"><span class="muted small">Description</span><textarea class="inp inp-compact" id="arch-desc" rows="2">${escapeHtml(o.description ?? "")}</textarea></label>
    </div>
    <h4 class="subh subh--tight">Score changes ${studioColsIconButton("Edit columns for score changes", archColsSm)}</h4>
    <table class="data-table data-table--dense"><thead><tr><th>Score</th><th>Amt</th>${smXh}<th></th></tr></thead>
    <tbody id="arch-sm-body">${statRows}</tbody></table>
    <button type="button" id="arch-add-sm" class="secondary small-btn">+ Score</button>
    <h4 class="subh subh--tight">Pool changes ${studioColsIconButton("Edit columns for pool changes", archColsRm)}</h4>
    <table class="data-table data-table--dense"><thead><tr><th>Pool</th><th>Amt</th>${rmXh}<th></th></tr></thead>
    <tbody id="arch-rm-body">${resRows}</tbody></table>
    <button type="button" id="arch-add-rm" class="secondary small-btn">+ Resource</button>
    <h4 class="subh subh--tight">Term definitions</h4>
    <label class="block"><select id="arch-traits" class="inp inp-compact inp-multiselect" multiple size="5">${traitOpts}</select></label>
    <p class="studio-toolbar-row"><button type="button" class="secondary small-btn" id="arch-inline-new-trait">+ New definition</button></p>
    <p class="muted small">Ctrl/Cmd-click to pick several. <strong>+ New definition</strong> creates a shared entry and attaches it here.</p>
    <h4 class="subh subh--tight">Extra rolls for this choice</h4>
    <label class="block"><select id="arch-tables" class="inp inp-compact inp-multiselect" multiple size="5">${tblOpts}</select></label>
    <p class="muted small">Ctrl/Cmd-click. Add tables under <strong>Roll tables</strong> first.</p>
    </div>
  `;
}

function studioTabHighlight(activeTab: string): string {
  if (studioRoute.kind === "editTable") return "tables";
  if (studioRoute.kind === "editArchetype") return "dimensions";
  if (activeTab === "resources") return "stats";
  return activeTab;
}

function renderStudioBreadcrumb(w: RpgSystem, activeTab: string): string {
  const route = studioRoute;
  if (route.kind === "editTable") {
    const t = w.tables[route.tableId];
    const title = t?.name ?? route.tableId;
    return `<nav class="breadcrumb-nav" aria-label="Breadcrumb">
      <ol class="breadcrumb">
        <li><a href="#" data-crumb-root="1">Studio</a></li>
        <li><a href="#" data-crumb-tab="tables">${escapeHtml(studioSectionLabel("tables"))}</a></li>
        <li aria-current="page"><span class="mono">${escapeHtml(route.tableId)}</span> · ${escapeHtml(title)}</li>
      </ol>
    </nav>`;
  }
  if (route.kind === "editArchetype") {
    const g = w.archetypeGroups.find((x) => x.id === route.groupId);
    const o = g?.options.find((x) => x.id === route.optionId);
    const gl = g?.label ?? route.groupId;
    const on = o?.name ?? route.optionId;
    return `<nav class="breadcrumb-nav" aria-label="Breadcrumb">
      <ol class="breadcrumb">
        <li><a href="#" data-crumb-root="1">Studio</a></li>
        <li><a href="#" data-crumb-tab="dimensions">${escapeHtml(studioSectionLabel("dimensions"))}</a></li>
        <li aria-current="page">${escapeHtml(gl)} · ${escapeHtml(on)}</li>
      </ol>
    </nav>`;
  }
  return `<nav class="breadcrumb-nav breadcrumb-nav--context" aria-label="Section">
    <ol class="breadcrumb">
      <li aria-current="page">${escapeHtml(studioSectionLabel(activeTab))}</li>
    </ol>
  </nav>`;
}

export function renderStudioBody(w: RpgSystem, activeTab: string, dimFocus: string | null): string {
  const systems = getAllSystems();
  const sysOpts = systems
    .map(
      (s) =>
        `<option value="${escapeHtml(s.id)}"${s.id === w.id ? " selected" : ""}>${escapeHtml(s.name)}</option>`
    )
    .join("");

  const method = w.statGenerationMethod.kind;
  const panel = (id: string, inner: string) => {
    const visible =
      id === "stats" ? activeTab === "stats" || activeTab === "resources" : activeTab === id;
    return `<div class="tab-panel${visible ? "" : " hidden"}" data-panel="${id}">${inner}</div>`;
  };

  const panelsHtml = `
      ${panel(
        "overview",
        `
        <details class="disclosure" open>
          <summary class="disclosure__summary">Identity</summary>
          <div class="disclosure__body">
            <div class="form-grid-2 form-grid-2--tight">
              <label><span class="muted small">Slug id</span><input class="inp inp-compact" id="st-id" type="text" value="${escapeHtml(w.id)}" /></label>
              <label><span class="muted small">Display name</span><input class="inp inp-compact" id="st-name" type="text" value="${escapeHtml(w.name)}" /></label>
            </div>
          </div>
        </details>
        <details class="disclosure" open>
          <summary class="disclosure__summary">Guides &amp; notes</summary>
          <div class="disclosure__body">
            <label class="block"><span class="muted small">Overview</span><textarea class="inp inp-compact" id="st-overview" rows="5">${escapeHtml(w.systemDocs?.overview ?? "")}</textarea></label>
            <label class="block"><span class="muted small">Designer notes</span><textarea class="inp inp-compact" id="st-designer" rows="2">${escapeHtml(w.systemDocs?.designerNotes ?? "")}</textarea></label>
          </div>
        </details>
        <p class="muted small">One project at a time. Use <strong>Character → Numeric stats</strong> for modifiers and other numeric rows (nothing is built-in—ability-style scores, HP, metacurrency, …). <strong>Dimensions</strong> are character choices; <strong>Roll tables</strong> are random picks; <strong>Content → Lists</strong> holds registry rows effects reference; <strong>Character sheet</strong> only controls what prints; <strong>Content → Starting gear</strong> configures chargen rolls.</p>
        <p class="studio-toolbar-row"><a href="#" class="cms-add-dim studio-action-link">+ Add dimension</a></p>
      `
      )}

      ${panel(
        "stats",
        `
        <p class="muted small">Everything here is <strong>designer-defined</strong>: there are no built-in abilities or HP. Use <strong>modifiers</strong> for numbers that choices and effects adjust. Use <strong>other numeric stats</strong> for totals you track separately—HP, metacurrency, “DC”-style pools, or anything else. Open <strong>Expand…</strong> for ids, defaults, and sheet notes.</p>
        <label class="block"><span class="muted small">How scores are set at generation</span>
          <select class="inp inp-compact" id="stat-method">
            <option value="fixed_defaults"${method === "fixed_defaults" ? " selected" : ""}>Fixed defaults (per row below)</option>
            <option value="nattborg_lesser"${method === "nattborg_lesser" ? " selected" : ""}>NattBorg — min(2d6) − min(2d4) each</option>
            <option value="placeholder"${method === "placeholder" ? " selected" : ""}>Placeholder (defaults only)</option>
          </select>
        </label>
        <div class="studio-subpanel">
          <h4 class="subh subh--tight">Modifiers <span class="subh-kicker muted tiny">(scores traits &amp; effects adjust)</span></h4>
          <p class="muted tiny studio-subpanel-hint">Numbers that dimensions, tables, and gear adjust (e.g. ability-style scores).</p>
          <p class="studio-toolbar-row studio-toolbar-row--wrap">
            ${renderNumericColPicker(w, "modifiers")}
          </p>
          <table class="data-table data-table--dense tracks-table">
            ${renderNumericTracksThead(
              numericColVisibility(w, "modifiers"),
              w.studioExtraColumns?.numericModifiers ?? [],
              "modifiers"
            )}
            <tbody id="tracks-stats-body">${renderTracksStatsBody(w)}</tbody>
          </table>
          <p class="studio-toolbar-row"><a href="#" class="studio-action-link" id="tracks-add-stat">+ Add modifier</a></p>
        </div>
        <div class="studio-subpanel studio-subpanel--spaced">
          <h4 class="subh subh--tight">Other numeric stats <span class="subh-kicker muted tiny">(HP, currency, other totals)</span></h4>
          <p class="muted tiny studio-subpanel-hint">Standalone or grouped tracked values—hit points, meta-currency, custom “DC” pools, etc.</p>
          <p class="studio-toolbar-row studio-toolbar-row--wrap">
            ${renderNumericColPicker(w, "other")}
          </p>
          <table class="data-table data-table--dense tracks-table">
            ${renderNumericTracksThead(
              numericColVisibility(w, "other"),
              w.studioExtraColumns?.numericOther ?? [],
              "other"
            )}
            <tbody id="tracks-pools-body">${renderTracksPoolsBody(w)}</tbody>
          </table>
          <p class="studio-toolbar-row"><a href="#" class="studio-action-link" id="tracks-add-pool">+ Add row</a></p>
        </div>
      `
      )}

      ${panel(
        "dimensions",
        `<p class="muted small">Each dimension is a list of choices. <strong>Edit</strong> opens the full builder for one choice.</p>
        <p class="studio-toolbar-row"><a href="#" class="cms-add-dim studio-action-link">+ Add dimension</a></p>
        ${renderDimensionsMaster(w, dimFocus)}`
      )}

      ${panel("traits", renderTraitLibrary(w))}

      ${panel("tables", renderTableLibrary(w))}

      ${panel("lists", renderListsPanel(w))}

      ${panel(
        "gear",
        `
        <p class="muted small">Chargen loot: what to roll when a new character is made. <strong>Repeat</strong> = roll that many times from the table. <strong>Once</strong> = one weighted pick. Use <strong>Details…</strong> to pick the table and set options. Granting list rows or sheet text still happens in roll outcomes and effects; this panel only defines the loadout rolls.</p>
        <label class="block"><span><input id="gear-en" type="checkbox"${normalizeStartingGear(w.startingGear)?.enabled ? " checked" : ""} /> Use this starting gear</span></label>
        <table class="data-table data-table--dense">
          <thead><tr><th>Table</th><th>Count / N</th><th>Mode</th>${(w.studioExtraColumns?.loadout ?? [])
            .map((c) => `<th>${escapeHtml(c.label)}</th>`)
            .join("")}<th class="nowrap"><span class="th-with-cols-trigger">Actions ${studioColsIconButton("Edit columns for this table", {
            "data-cols-kind": "loadout",
          })}</span></th></tr></thead>
          <tbody id="loadout-body">${renderStartingLoadoutRows(w)}</tbody>
        </table>
        <p class="studio-toolbar-row"><a href="#" class="studio-action-link" id="loadout-add">+ Add roll line</a></p>
      `
      )}

      ${panel("sheet", renderCharacterSheetPanel(w))}

      ${panel(
        "advanced",
        `
        <p class="muted small">Use <strong>Project file</strong> in the header for snapshots, download, import, duplicate, validation, and delete. With cloud sign-in, projects sync to your account.</p>
        <details class="disclosure disclosure--nested" open>
          <summary class="disclosure__summary">Share character generator</summary>
          <div class="disclosure__body">
            <p class="muted tiny">Publish a player-facing snapshot (designer notes are stripped). Anyone with the link can roll characters; your studio draft stays private.</p>
            <div class="form-grid-2 form-grid-2--tight publish-grid">
              <label><span class="muted small">URL slug</span>
                <input class="inp inp-compact" id="publish-slug" type="text" placeholder="e.g. my-hex-game" autocomplete="off" /></label>
              <label><span class="muted small">Visibility</span>
                <select class="inp inp-compact" id="publish-vis">
                  <option value="public">Public (open generator)</option>
                  <option value="unlisted" selected>Unlisted (only people with the link)</option>
                  <option value="invite">Invite (needs secret in URL)</option>
                </select>
              </label>
            </div>
            <p class="studio-toolbar-row publish-actions">
              <button type="button" class="primary small-btn" id="btn-publish-gen">Publish or update</button>
              <button type="button" class="secondary small-btn" id="btn-unpublish-gen">Unpublish…</button>
            </p>
            <p id="publish-feedback" class="publish-feedback muted small" aria-live="polite"></p>
            <p class="muted tiny publish-hint">Invite mode: share <span class="mono">yoursite.com/?k=SECRET#play/your-slug</span> — copy the secret from the confirmation after publish.</p>
          </div>
        </details>
        <ul class="hint-list">
          <li>Keep local saves backed up.</li>
          <li>Duplicate before big changes.</li>
        </ul>
      `
      )}
`;

  const drill =
    studioRoute.kind === "editTable"
      ? renderTableEditor(w, studioRoute.tableId)
      : studioRoute.kind === "editArchetype"
        ? renderArchetypeEditor(w, studioRoute.groupId, studioRoute.optionId)
        : "";

  return `
    <div id="studio-shell" class="studio-shell">
      <header class="project-topbar">
        <div class="project-topbar-main">
          <span class="muted small project-topbar-kicker">Project</span>
          <strong class="project-topbar-name">${escapeHtml(w.name)}</strong>
          <span class="mono small muted project-topbar-slug">${escapeHtml(w.id)}</span>
        </div>
        <div class="project-file-bar">
          <button
            type="button"
            class="project-file-menu-trigger"
            id="project-file-menu-trigger"
            aria-haspopup="true"
            aria-expanded="false"
            aria-controls="project-file-menu"
          >
            Project file
          </button>
          <div id="project-file-menu" class="project-file-menu" role="menu" hidden>
            <div class="project-file-menu__section">
              <div class="project-file-menu__section-title">Open saved project</div>
              <label class="project-file-menu__open">
                <select class="inp inp-compact" id="studio-sys">${sysOpts}</select>
              </label>
            </div>
            <hr class="project-file-menu__sep" />
            <button type="button" class="project-file-menu__item" id="project-file-new-blank" role="menuitem">
              New blank project
            </button>
            <button
              type="button"
              class="project-file-menu__item"
              id="project-file-export-snapshot"
              role="menuitem"
              title="Download a timestamped copy; your open project stays as-is."
            >
              Export snapshot…
            </button>
            <button
              type="button"
              class="project-file-menu__item"
              id="project-file-download"
              role="menuitem"
              title="Download the current project as a single .rpg-system file."
            >
              Download
            </button>
            <label
              class="project-file-menu__item project-file-menu__item--import"
              role="menuitem"
              title="Load a backup file and switch to that project."
            >
              <span class="project-file-menu__item-label">Import…</span>
              <input
                type="file"
                id="import-file"
                class="project-file-menu__file-input"
                accept=".rpg-system,.json,application/json,text/plain"
              />
            </label>
            <button type="button" class="project-file-menu__item" id="project-file-duplicate" role="menuitem">
              Duplicate…
            </button>
            <button
              type="button"
              class="project-file-menu__item"
              id="project-file-check"
              role="menuitem"
              title="Validate and normalize the working project; errors appear below."
            >
              Check for issues
            </button>
            <button
              type="button"
              class="project-file-menu__item project-file-menu__item--danger"
              id="project-file-delete"
              role="menuitem"
            >
              Delete…
            </button>
          </div>
        </div>
      </header>
      <div class="studio-layout">
        <aside class="studio-sidebar" aria-label="Studio navigation">
          <nav class="studio-sidebar-nav">${renderStudioSidebar(w, activeTab, dimFocus)}</nav>
        </aside>
        <div class="studio-content">
          ${renderStudioBreadcrumb(w, activeTab)}
          <div class="studio-main${studioRoute.kind !== "main" ? " studio-main--drill" : ""}">
            ${studioRoute.kind === "main" ? `<div class="studio-panels">${panelsHtml}</div>` : `<div class="studio-drill-panel">${drill}</div>`}
          </div>
        </div>
      </div>
      <div id="studio-effects-modal" class="studio-modal studio-modal--hidden" aria-hidden="true">
        <div class="studio-modal__backdrop" data-studio-effects-modal-close tabindex="-1"></div>
        <div class="studio-modal__dialog" role="dialog" aria-modal="true" aria-labelledby="studio-effects-modal-title">
          <header class="studio-modal__head">
            <h2 id="studio-effects-modal-title" class="studio-modal__title">Edit effects</h2>
            <button type="button" class="studio-modal__close" data-studio-effects-modal-close aria-label="Close">×</button>
          </header>
          <div id="studio-effects-modal-body" class="studio-modal__body"></div>
          <footer class="studio-modal__foot">
            <button type="button" class="primary small-btn" id="studio-effects-modal-save">Save</button>
            <button type="button" class="secondary small-btn" data-studio-effects-modal-close>Cancel</button>
          </footer>
        </div>
      </div>
      <div id="studio-cols-modal" class="studio-modal studio-modal--hidden" aria-hidden="true">
        <div class="studio-modal__backdrop" data-studio-cols-modal-close tabindex="-1"></div>
        <div class="studio-modal__dialog" role="dialog" aria-modal="true" aria-labelledby="studio-cols-modal-title">
          <header class="studio-modal__head">
            <h2 id="studio-cols-modal-title" class="studio-modal__title">Outcome columns</h2>
            <button type="button" class="studio-modal__close" data-studio-cols-modal-close aria-label="Close">×</button>
          </header>
          <div id="studio-cols-modal-body" class="studio-modal__body"></div>
          <footer class="studio-modal__foot">
            <button type="button" class="primary small-btn" id="studio-cols-modal-save">Save</button>
            <button type="button" class="secondary small-btn" data-studio-cols-modal-close>Cancel</button>
          </footer>
        </div>
      </div>
      <div id="studio-row-modal" class="studio-modal studio-modal--hidden" aria-hidden="true">
        <div class="studio-modal__backdrop" data-studio-row-modal-close tabindex="-1"></div>
        <div class="studio-modal__dialog" role="dialog" aria-modal="true" aria-labelledby="studio-row-modal-title">
          <header class="studio-modal__head">
            <h2 id="studio-row-modal-title" class="studio-modal__title">Edit outcome</h2>
            <button type="button" class="studio-modal__close" data-studio-row-modal-close aria-label="Close">×</button>
          </header>
          <div id="studio-row-modal-body" class="studio-modal__body"></div>
          <footer class="studio-modal__foot">
            <button type="button" class="primary small-btn" id="studio-row-modal-save">Save</button>
            <button type="button" class="secondary small-btn" data-studio-row-modal-close>Cancel</button>
          </footer>
        </div>
      </div>
    </div>
  `;
}

function parseTableOptionsFromDom(w: RpgSystem, tableKey: string): TableOption[] {
  const wrap = document.getElementById("tbl-options-wrap");
  if (!wrap) return [];
  const extraCols = w.tables[tableKey]?.extraColumns ?? [];
  const options: TableOption[] = [];
  wrap.querySelectorAll(":scope > tr.table-opt-card, :scope > .table-opt-card").forEach((card) => {
    const label = (card.querySelector(".tbl-o-label") as HTMLInputElement | null)?.value.trim() ?? "";
    const weight = Number((card.querySelector(".tbl-o-weight") as HTMLInputElement | null)?.value ?? 1);
    const description = (card.querySelector(".tbl-o-desc") as HTMLInputElement | null)?.value.trim();
    const stash = card.querySelector(".tbl-o-effects-stash") as HTMLInputElement | null;
    let effects = parseEffectsFromStash(stash?.value);
    if (!stash) {
      const nest = card.querySelector(".effects-nest");
      effects = parseEffectsFromNest(nest ?? undefined);
    }
    const extra: Record<string, string | number> = {};
    for (const col of extraCols) {
      const el = [...card.querySelectorAll("[data-tbl-extra]")].find(
        (n) => (n as HTMLElement).dataset.tblExtra === col.id
      ) as HTMLInputElement | HTMLTextAreaElement | null;
      if (!el) continue;
      if (col.fieldType === "number") {
        const n = Number(el.value);
        if (Number.isFinite(n)) extra[col.id] = n;
      } else {
        const s = el.value.trim();
        if (s) extra[col.id] = el.value;
      }
    }
    options.push({
      label: label || "Outcome",
      weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
      ...(description ? { description } : {}),
      ...(effects.length ? { effects } : {}),
      ...(Object.keys(extra).length ? { extra } : {}),
    });
  });
  return options;
}

function syncTableView(w: RpgSystem, oldTid: string): string {
  const idEl = document.getElementById("tbl-id") as HTMLInputElement | null;
  const nameEl = document.getElementById("tbl-name") as HTMLInputElement | null;
  const t = w.tables[oldTid];
  if (!t || !idEl || !nameEl) return oldTid;
  const newId = idEl.value.trim() || oldTid;
  const opts = parseTableOptionsFromDom(w, oldTid);
  const sheetRefEl = document.getElementById("tbl-sheet-ref") as HTMLInputElement | null;
  const includeOnCharacterSheet = Boolean(sheetRefEl?.checked);
  const next: RollTable = {
    ...t,
    id: newId,
    name: nameEl.value.trim() || newId,
    options: opts,
  };
  const sidebarCat = (document.getElementById("tbl-sidebar-cat") as HTMLInputElement | null)?.value.trim() ?? "";
  if (sidebarCat) next.sidebarCategory = sidebarCat;
  else delete next.sidebarCategory;
  if (includeOnCharacterSheet) next.includeOnCharacterSheet = true;
  else delete next.includeOnCharacterSheet;
  delete w.tables[oldTid];
  w.tables[newId] = next;
  for (const g of w.archetypeGroups) {
    for (const o of g.options) {
      if (!o.tableRolls) continue;
      o.tableRolls = o.tableRolls.map((x) => (x === oldTid ? newId : x));
    }
  }
  if (w.startingGear?.tableId === oldTid) w.startingGear.tableId = newId;
  for (const line of w.startingGear?.loadout ?? []) {
    if (line.tableId === oldTid) line.tableId = newId;
  }
  synchronizeRollTableLibraryMeta(w, newId);
  return newId;
}

function syncArchetypeView(w: RpgSystem, groupId: string, optionId: string) {
  const g = w.archetypeGroups.find((x) => x.id === groupId);
  const o = g?.options.find((x) => x.id === optionId);
  if (!g || !o) return;
  const nid = (document.getElementById("arch-id") as HTMLInputElement).value.trim();
  const nname = (document.getElementById("arch-name") as HTMLInputElement).value.trim();
  const ndesc = (document.getElementById("arch-desc") as HTMLTextAreaElement).value.trim();
  const smXcols = o.statModExtraColumns ?? [];
  const rmXcols = o.resourceModExtraColumns ?? [];
  const statMods: NonNullable<ArchetypeOption["statMods"]> = [];
  document.querySelectorAll("#arch-sm-body tr").forEach((tr) => {
    const sel = tr.querySelector("[data-sm-stat]") as HTMLSelectElement | null;
    const amt = tr.querySelector("[data-sm-amt]") as HTMLInputElement | null;
    if (!sel?.value) return;
    const n = Number(amt?.value ?? 0);
    const x = parseStudioGridExtraRow(tr as HTMLElement, smXcols);
    statMods.push({
      statId: sel.value,
      amount: Number.isFinite(n) ? n : 0,
      ...(x ? { extra: x } : {}),
    });
  });
  const resourceMods: NonNullable<ArchetypeOption["resourceMods"]> = [];
  document.querySelectorAll("#arch-rm-body tr").forEach((tr) => {
    const sel = tr.querySelector("[data-rm-res]") as HTMLSelectElement | null;
    const amt = tr.querySelector("[data-rm-amt]") as HTMLInputElement | null;
    if (!sel?.value) return;
    const n = Number(amt?.value ?? 0);
    const x = parseStudioGridExtraRow(tr as HTMLElement, rmXcols);
    resourceMods.push({
      resourceId: sel.value,
      amount: Number.isFinite(n) ? n : 0,
      ...(x ? { extra: x } : {}),
    });
  });
  const selTbl = document.getElementById("arch-tables") as HTMLSelectElement | null;
  const tableRolls = selTbl
    ? Array.from(selTbl.selectedOptions)
        .map((o) => o.value)
        .filter(Boolean)
    : [];
  const selTraits = document.getElementById("arch-traits") as HTMLSelectElement | null;
  const sharedTraitRefs = selTraits
    ? Array.from(selTraits.selectedOptions)
        .map((x) => x.value)
        .filter(Boolean)
    : [];
  o.name = nname || o.name;
  o.description = ndesc || undefined;
  o.statMods = statMods.length ? statMods : undefined;
  o.resourceMods = resourceMods.length ? resourceMods : undefined;
  o.sharedTraitRefs = sharedTraitRefs.length ? sharedTraitRefs : undefined;
  o.tableRolls = tableRolls.length ? tableRolls : undefined;
  if (nid && nid !== o.id) {
    const taken = g.options.some((x) => x.id === nid && x !== o);
    if (!taken) {
      o.id = nid;
    }
  }
  synchronizeRollTableLibraryMeta(w);
}

function syncQuickRollTablesFromDom(w: RpgSystem) {
  document.querySelectorAll("tbody[data-quick-tbl]").forEach((tbody) => {
    const tid = (tbody as HTMLElement).dataset.quickTbl?.trim();
    if (!tid) return;
    const t = w.tables[tid];
    if (!t) return;
    const extraCols = t.extraColumns ?? [];
    const options: TableOption[] = [];
    tbody.querySelectorAll(":scope > tr").forEach((tr) => {
      const label = (tr.querySelector(".qt-label") as HTMLInputElement | null)?.value.trim() ?? "";
      const weight = Number((tr.querySelector(".qt-w") as HTMLInputElement | null)?.value ?? 1);
      const description = (tr.querySelector(".qt-d") as HTMLInputElement | null)?.value.trim();
      const stash = tr.querySelector(".qt-effects-stash") as HTMLInputElement | null;
      const effects = parseEffectsFromStash(stash?.value);
      const extra: Record<string, string | number> = {};
      for (const col of extraCols) {
        const el = [...tr.querySelectorAll("[data-qt-extra]")].find(
          (n) => (n as HTMLElement).dataset.qtExtra === col.id
        ) as HTMLInputElement | HTMLTextAreaElement | null;
        if (!el) continue;
        if (col.fieldType === "number") {
          const n = Number(el.value);
          if (Number.isFinite(n)) extra[col.id] = n;
        } else {
          const s = el.value.trim();
          if (s) extra[col.id] = el.value;
        }
      }
      const row: TableOption = {
        label: label || "Outcome",
        weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
        ...(description ? { description } : {}),
        ...(effects.length ? { effects } : {}),
        ...(Object.keys(extra).length ? { extra } : {}),
      };
      options.push(row);
    });
    t.options = options;
  });
}

function scrubEffectsRemoveRollTable(effects: Effect[] | undefined, removedId: string): Effect[] | undefined {
  if (!effects?.length) return effects;
  const next = effects.filter((e) => !(e.type === "roll_table" && e.tableId === removedId));
  if (next.length === effects.length) return effects;
  return next.length ? next : undefined;
}

/** Remove a roll table and strip references (dimensions, loadouts, roll_table effects). */
export function removeRollTableFromSystem(w: RpgSystem, tableId: string): void {
  delete w.tables[tableId];
  for (const g of w.archetypeGroups) {
    for (const o of g.options) {
      if (o.tableRolls?.length) {
        o.tableRolls = o.tableRolls.filter((x) => x !== tableId);
        if (o.tableRolls.length === 0) delete o.tableRolls;
      }
    }
  }
  for (const t of Object.values(w.tables)) {
    for (const opt of t.options) {
      const fx = scrubEffectsRemoveRollTable(opt.effects, tableId);
      if (fx === undefined) delete opt.effects;
      else opt.effects = fx;
    }
  }
  for (const def of Object.values(w.sheetLists)) {
    if (def.sourceTableId === tableId) {
      delete def.sourceTableId;
      delete def.sheetDisplayColumns;
    }
    for (const ent of Object.values(def.entries)) {
      const fx = scrubEffectsRemoveRollTable(ent.effects, tableId);
      if (fx === undefined) delete ent.effects;
      else ent.effects = fx;
    }
  }
  const sg = w.startingGear;
  if (sg?.loadout?.length) {
    sg.loadout = sg.loadout.filter((x) => x.tableId !== tableId);
    if (sg.loadout.length === 0) delete sg.loadout;
  }
  if (sg?.tableId === tableId) delete sg.tableId;
  synchronizeRollTableLibraryMeta(w);
}

function syncDimensionIdRenames(w: RpgSystem): void {
  document.querySelectorAll(".dim-section[data-dim-section]").forEach((secEl) => {
    const sec = secEl as HTMLElement;
    const oldId = sec.dataset.dimSection;
    if (!oldId) return;
    const inp = sec.querySelector("[data-dim-gid]") as HTMLInputElement | null;
    const newId = inp?.value.trim() ?? oldId;
    if (!newId || newId === oldId) return;
    const g = w.archetypeGroups.find((x) => x.id === oldId);
    if (!g) return;
    if (w.archetypeGroups.some((x) => x.id === newId && x !== g)) return;
    g.id = newId;
    if (studioRoute.kind === "editArchetype" && studioRoute.groupId === oldId) {
      studioRoute = { ...studioRoute, groupId: newId };
    }
    for (const t of Object.values(w.tables)) {
      if (t.linkedPath?.groupId === oldId) {
        t.linkedPath = { groupId: newId, optionId: t.linkedPath.optionId };
      }
    }
    sec.dataset.dimSection = newId;
    sec.id = `dim-section-${newId}`;
    sec.querySelectorAll("tr[data-dim-row]").forEach((tr) => {
      (tr as HTMLElement).dataset.dimRow = newId;
    });
    sec.querySelectorAll("[data-dim-label]").forEach((el) => {
      (el as HTMLElement).dataset.dimLabel = newId;
    });
    sec.querySelectorAll("[data-dim-overview-cols]").forEach((el) => {
      (el as HTMLElement).dataset.dimOverviewCols = newId;
    });
    sec.querySelectorAll("[data-cms-group]").forEach((el) => {
      const h = el as HTMLElement;
      if (h.dataset.cmsGroup === oldId) h.dataset.cmsGroup = newId;
    });
  });
}

function syncMainView(w: RpgSystem) {
  const id = (document.getElementById("st-id") as HTMLInputElement | null)?.value.trim() ?? w.id;
  const name = (document.getElementById("st-name") as HTMLInputElement | null)?.value.trim() ?? w.name;
  w.id = id || w.id;
  w.name = name || w.name;
  w.systemDocs = {
    overview: (document.getElementById("st-overview") as HTMLTextAreaElement | null)?.value ?? "",
    designerNotes: (document.getElementById("st-designer") as HTMLTextAreaElement | null)?.value ?? "",
  };

  const sm = (document.getElementById("stat-method") as HTMLSelectElement | null)?.value;
  if (sm === "nattborg_lesser") w.statGenerationMethod = { kind: "nattborg_lesser" };
  else if (sm === "placeholder") w.statGenerationMethod = { kind: "placeholder", note: "Configure later" };
  else w.statGenerationMethod = { kind: "fixed_defaults" };

  if (document.getElementById("tracks-stats-body") && document.getElementById("tracks-pools-body")) {
    const stats: StatDefinition[] = [];
    const resources: ResourceDefinition[] = [];
    const modXcols = w.studioExtraColumns?.numericModifiers ?? [];
    const othXcols = w.studioExtraColumns?.numericOther ?? [];
    document
      .querySelectorAll("#tracks-stats-body tr[data-tr-kind], #tracks-pools-body tr[data-tr-kind]")
      .forEach((rowEl) => {
      const row = rowEl as HTMLElement;
      const kind = row.dataset.trKind;
      if (kind === "stat") {
        const sid = (row.querySelector('[name="sid"]') as HTMLInputElement | null)?.value.trim();
        if (!sid) return;
        const sname = (row.querySelector('[name="sname"]') as HTMLInputElement | null)?.value.trim() ?? sid;
        const def = Number((row.querySelector('[name="sdef"]') as HTMLInputElement | null)?.value ?? 0);
        const sexplain = (row.querySelector('[name="sexplain"]') as HTMLTextAreaElement | null)?.value.trim() ?? "";
        const x = parseStudioGridExtraRow(row, modXcols);
        stats.push({
          id: sid,
          name: sname,
          defaultValue: Number.isFinite(def) ? def : 0,
          ...(sexplain ? { sheetExplanation: sexplain } : {}),
          ...(x ? { extra: x } : {}),
        });
      } else if (kind === "resource") {
        const rid = (row.querySelector('[name="rid"]') as HTMLInputElement | null)?.value.trim();
        if (!rid) return;
        const rname = (row.querySelector('[name="rname"]') as HTMLInputElement | null)?.value.trim() ?? rid;
        const def = Number((row.querySelector('[name="rdef"]') as HTMLInputElement | null)?.value ?? 0);
        const rexplain = (row.querySelector('[name="rexplain"]') as HTMLTextAreaElement | null)?.value.trim() ?? "";
        const x = parseStudioGridExtraRow(row, othXcols);
        resources.push({
          id: rid,
          name: rname,
          defaultValue: Number.isFinite(def) ? def : 0,
          ...(rexplain ? { sheetExplanation: rexplain } : {}),
          ...(x ? { extra: x } : {}),
        });
      }
    });
    w.stats = stats;
    w.resources = resources;
  }

  syncDimensionIdRenames(w);

  document.querySelectorAll("[data-dim-label]").forEach((el) => {
    const gid = (el as HTMLElement).dataset.dimLabel;
    if (!gid) return;
    const g = w.archetypeGroups.find((x) => x.id === gid);
    if (g) g.label = (el as HTMLInputElement).value.trim() || g.label;
  });

  document.querySelectorAll("[data-dim-overview-cols]").forEach((wrap) => {
    const gid = (wrap as HTMLElement).dataset.dimOverviewCols;
    const g = w.archetypeGroups.find((x) => x.id === gid);
    if (!g) return;
    const checked = DIMENSION_OVERVIEW_COLUMN_ORDER.filter((cid) => {
      const inp = wrap.querySelector(`input[data-dim-col-toggle="${cid}"]`) as HTMLInputElement | null;
      return inp?.checked;
    });
    g.overviewColumns =
      checked.length === 0 || checked.length === DIMENSION_OVERVIEW_COLUMN_ORDER.length
        ? undefined
        : checked;
  });

  syncQuickRollTablesFromDom(w);
  syncNumericStatColumnsFromDom(w);
  syncRollTableSidebarCategoriesFromDom(w);

  document.querySelectorAll("tr[data-dim-row]").forEach((trEl) => {
    const tr = trEl as HTMLTableRowElement;
    const gid = tr.dataset.dimRow;
    const oid = tr.dataset.oid;
    if (!gid || !oid) return;
    const g = w.archetypeGroups.find((x) => x.id === gid);
    const o = g?.options.find((x) => x.id === oid);
    if (!g || !o) return;
    const nid = (tr.querySelector('[data-opt-col="id"]') as HTMLInputElement | null)?.value.trim();
    const nname = (tr.querySelector('[data-opt-col="name"]') as HTMLInputElement | null)?.value.trim();
    const ndesc = (tr.querySelector('[data-opt-col="desc"]') as HTMLInputElement | null)?.value.trim();
    o.name = nname || o.name;
    o.description = ndesc || undefined;
    if (nid && nid !== o.id) {
      const clash = g.options.some((x) => x.id === nid && x !== o);
      if (!clash) {
        o.id = nid;
        (tr as HTMLElement).dataset.oid = nid;
      }
    }
    const dcols = g.optionExtraColumns ?? [];
    const dex = parseStudioGridExtraRow(tr as HTMLElement, dcols);
    if (dex) o.extra = dex;
    else delete o.extra;
  });
  synchronizeRollTableLibraryMeta(w);

  if (document.getElementById("traits-body")) {
    const traits: Record<string, SharedTraitDefinition> = {};
    const tXcols = w.studioExtraColumns?.traits ?? [];
    document.querySelectorAll("#traits-body tr").forEach((row) => {
      const tid = (row.querySelector('[name="trait-id"]') as HTMLInputElement | null)?.value.trim();
      if (!tid) return;
      const tname = (row.querySelector('[name="trait-name"]') as HTMLInputElement | null)?.value.trim() ?? tid;
      const tdesc = (row.querySelector('[name="trait-desc"]') as HTMLTextAreaElement | null)?.value.trim() ?? "";
      const x = parseStudioGridExtraRow(row as HTMLElement, tXcols);
      traits[tid] = { id: tid, name: tname, description: tdesc, ...(x ? { extra: x } : {}) };
    });
    w.sharedTraits = traits;
  }

  if (document.getElementById("sheet-lists-data-root") || document.getElementById("sheet-display-root")) {
    const lists: Record<string, SheetListDefinition> = {};
    const displaySectionFor = (slug: string): HTMLElement | null => {
      let found: HTMLElement | null = null;
      document.querySelectorAll("[data-sheet-list-display]").forEach((node) => {
        if ((node as HTMLElement).dataset.sheetListDisplay === slug) found = node as HTMLElement;
      });
      return found;
    };

    document.querySelectorAll("[data-sheet-list-data]").forEach((secEl) => {
      const slug = (secEl as HTMLElement).dataset.sheetListData?.trim();
      if (!slug) return;
      const displayEl = displaySectionFor(slug);
      const sheetTitle =
        (displayEl?.querySelector("[data-slist-sheet-title]") as HTMLInputElement | null)?.value.trim() || slug;
      const sourceTable =
        (secEl.querySelector("[data-slist-source-table]") as HTMLSelectElement | null)?.value.trim() ?? "";
      const tableOk = Boolean(sourceTable && w.tables[sourceTable]);

      if (tableOk) {
        const dcols = displayEl
          ? [...displayEl.querySelectorAll("[data-slist-dcol]:checked")]
              .map((el) => (el as HTMLInputElement).getAttribute("data-slist-dcol") ?? "")
              .filter(Boolean)
          : [];
        const sheetDisplayColumns = dcols.length ? dcols : defaultSheetDisplayColumns();
        lists[slug] = {
          id: slug,
          sheetTitle,
          sourceTableId: sourceTable,
          sheetDisplayColumns,
          fields: [],
          entries: {},
        };
        return;
      }

      const fields: SchemaField[] = [];
      secEl.querySelectorAll("[data-slist-fields-body] tr").forEach((row) => {
        const id = (row.querySelector("[data-sfid]") as HTMLInputElement | null)?.value.trim();
        if (!id) return;
        const label = (row.querySelector("[data-sflabel]") as HTMLInputElement | null)?.value.trim() || id;
        const ftRaw = (row.querySelector("[data-sftype]") as HTMLSelectElement | null)?.value;
        const fieldType: SchemaField["fieldType"] =
          ftRaw === "number" || ftRaw === "textarea" ? ftRaw : "text";
        fields.push({ id, label, fieldType });
      });
      const entries: Record<string, SheetListEntry> = {};
      secEl.querySelectorAll(".slist-entry-row").forEach((row) => {
        const eid = (row.querySelector("[data-slist-eid]") as HTMLInputElement | null)?.value.trim();
        if (!eid) return;
        const values: Record<string, string | number> = {};
        row.querySelectorAll("[data-slist-ev]").forEach((inp) => {
          const fid = (inp as HTMLElement).dataset.slistEv!;
          const field = fields.find((f) => f.id === fid);
          if (field?.fieldType === "number") {
            const n = Number((inp as HTMLInputElement).value);
            values[fid] = Number.isFinite(n) ? n : 0;
          } else {
            values[fid] = (inp as HTMLInputElement | HTMLTextAreaElement).value;
          }
        });
        const stash = row.querySelector(".slist-entry-effects-stash") as HTMLInputElement | null;
        let effects = parseEffectsFromStash(stash?.value);
        if (!stash) {
          const nest = row.querySelector(".effects-nest");
          effects = parseEffectsFromNest(nest ?? undefined);
        }
        entries[eid] = {
          id: eid,
          values,
          ...(effects.length ? { effects } : {}),
        };
      });
      lists[slug] = { id: slug, sheetTitle, fields, entries };
    });
    w.sheetLists = lists;
  }

  const gearEn = document.getElementById("gear-en") as HTMLInputElement | null;
  if (document.getElementById("loadout-body")) {
    const loXcols = w.studioExtraColumns?.loadout ?? [];
    const loadout: LoadoutEntry[] = [];
    document.querySelectorAll("#loadout-body tr").forEach((tr) => {
      const scope = tr.querySelector(".loadout-stash") ?? tr;
      const tbl = (scope.querySelector("[data-loadout-table]") as HTMLSelectElement | null)?.value.trim() ?? "";
      const rollsRaw = Number((scope.querySelector("[data-loadout-rolls]") as HTMLInputElement | null)?.value ?? 0);
      const rolls = Number.isFinite(rollsRaw) ? Math.max(0, Math.floor(rollsRaw)) : 0;
      const modeRaw = (scope.querySelector("[data-loadout-mode]") as HTMLSelectElement | null)?.value;
      const mode = modeRaw === "once" ? ("once" as const) : ("repeat" as const);
      if (!tbl) return;
      const x = parseStudioGridExtraRow(tr as HTMLElement, loXcols);
      loadout.push({ tableId: tbl, rolls, mode, ...(x ? { extra: x } : {}) });
    });
    w.startingGear = normalizeStartingGear({
      enabled: Boolean(gearEn?.checked),
      loadout,
    });
  }
}

export function syncWorkingFromDom(w: RpgSystem) {
  if (studioRoute.kind === "editTable") {
    const nid = syncTableView(w, studioRoute.tableId);
    if (nid !== studioRoute.tableId) studioRoute = { kind: "editTable", tableId: nid };
    return;
  }
  if (studioRoute.kind === "editArchetype") {
    syncArchetypeView(w, studioRoute.groupId, studioRoute.optionId);
    return;
  }
  syncMainView(w);
}

export type StudioWireOpts = {
  getSelectedId: () => string | null;
  setSelectedId: (id: string | null) => void;
  getActiveTab: () => string;
  setActiveTab: (tab: string) => void;
  getDimFocus: () => string | null;
  setDimFocus: (groupId: string | null) => void;
  rerender: () => void;
  setError: (msg: string) => void;
  /** Signed-in user id when cloud auth is active. */
  getUserId: () => string | null;
};

let suppressNextStudioPersist = false;
let projectFileMenuDocAbort: AbortController | null = null;
let persistInputDebounceTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
const STUDIO_PERSIST_DEBOUNCE_MS = 500;

function studioModalOpen(): boolean {
  return !!document.querySelector(".studio-modal:not(.studio-modal--hidden)");
}

function refreshProjectTopbarMeta(name: string, id: string): void {
  document.querySelectorAll(".project-topbar-name").forEach((el) => {
    el.textContent = name;
  });
  document.querySelectorAll(".project-topbar-slug").forEach((el) => {
    el.textContent = id;
  });
}

/**
 * Persist DOM → working copy → storage. On slug or route repair, re-renders; otherwise refreshes the header labels only.
 * @returns false if normalization/validation failed (error message set).
 */
function persistStudioFromDom(opts: StudioWireOpts): boolean {
  const prevId = opts.getSelectedId();
  opts.setError("");
  try {
    const w = ensureWorking(prevId);
    syncWorkingFromDom(w);
    const normalized = normalizeSystem(structuredClone(w));
    saveSystem(normalized);
    working = structuredClone(normalized);
    workingSourceId = normalized.id;
    opts.setSelectedId(normalized.id);
    const routeSnap = studioRoute;
    let routeFixed = false;
    if (routeSnap.kind === "editTable" && !normalized.tables[routeSnap.tableId]) {
      setStudioRoute({ kind: "main" });
      routeFixed = true;
    }
    if (routeSnap.kind === "editArchetype") {
      const g = normalized.archetypeGroups.find((x) => x.id === routeSnap.groupId);
      if (!g?.options.some((x) => x.id === routeSnap.optionId)) {
        setStudioRoute({ kind: "main" });
        routeFixed = true;
      }
    }
    if (normalized.id !== prevId || routeFixed) {
      opts.rerender();
    } else {
      refreshProjectTopbarMeta(normalized.name, normalized.id);
    }
    return true;
  } catch (e) {
    opts.setError(e instanceof Error ? e.message : String(e));
    return false;
  }
}

/**
 * @param expectedSelectedId If set, persist only when `getSelectedId()` still matches (avoids racing project switches).
 */
function runAfterStudioRenderPersistForProject(
  opts: StudioWireOpts,
  expectedSelectedId: string | null | undefined
): void {
  if (expectedSelectedId !== undefined && opts.getSelectedId() !== expectedSelectedId) return;
  if (suppressNextStudioPersist) {
    suppressNextStudioPersist = false;
    return;
  }
  if (!persistStudioFromDom(opts)) {
    suppressNextStudioPersist = true;
    opts.rerender();
  }
}

/** Skips one call after a failed persist that re-renders (avoids a loop). */
export function runAfterStudioRenderPersist(opts: StudioWireOpts): void {
  runAfterStudioRenderPersistForProject(opts, undefined);
}

function scheduleDebouncedStudioPersist(opts: StudioWireOpts): void {
  if (persistInputDebounceTimer) clearTimeout(persistInputDebounceTimer);
  const expectedId = opts.getSelectedId();
  persistInputDebounceTimer = globalThis.setTimeout(() => {
    persistInputDebounceTimer = null;
    if (studioModalOpen()) return;
    runAfterStudioRenderPersistForProject(opts, expectedId);
  }, STUDIO_PERSIST_DEBOUNCE_MS);
}

function wireProjectFileMenu(opts: StudioWireOpts): void {
  const trigger = document.getElementById("project-file-menu-trigger");
  const menu = document.getElementById("project-file-menu");
  if (!trigger || !menu) return;

  const close = () => {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };
  const open = () => {
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
  };

  trigger.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (menu.hidden) open();
    else close();
  });

  projectFileMenuDocAbort?.abort();
  projectFileMenuDocAbort = new AbortController();
  const onDocClick = (ev: MouseEvent) => {
    if (menu.hidden) return;
    const t = ev.target as Node;
    if (trigger.contains(t) || menu.contains(t)) return;
    close();
  };
  document.addEventListener("click", onDocClick, { signal: projectFileMenuDocAbort.signal });

  menu.querySelectorAll("button.project-file-menu__item").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (menu.hidden) return;
      close();
    });
  });

  document.getElementById("project-file-new-blank")?.addEventListener("click", () => {
    opts.setError("");
    const sys = createBlankSystem();
    saveSystem(sys);
    opts.setSelectedId(sys.id);
    working = null;
    workingSourceId = null;
    setStudioRoute({ kind: "main" });
    opts.setDimFocus(null);
    opts.setActiveTab("overview");
    opts.rerender();
  });

  document.getElementById("project-file-export-snapshot")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    close();
    const tag = prompt(
      "Optional tag for the filename (e.g. playtest-3).\nLeave blank for timestamp only.\n\nCancel skips export.",
      ""
    );
    if (tag === null) return;
    opts.setError("");
    try {
      const w = ensureWorking(opts.getSelectedId());
      syncWorkingFromDom(w);
      const normalized = normalizeSystem(structuredClone(w));
      const json = exportSystemJson(normalized);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const safeTag = tag
        .trim()
        .replace(/[/\\?%*:|"<>]/g, "_")
        .slice(0, 48);
      const tagPart = safeTag ? `-${safeTag}` : "";
      const blob = new Blob([json], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${normalized.id}-snapshot-${stamp}${tagPart}.rpg-system`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      opts.setError(e instanceof Error ? e.message : String(e));
      opts.rerender();
    }
  });

  document.getElementById("project-file-download")?.addEventListener("click", () => {
    opts.setError("");
    try {
      const w = ensureWorking(opts.getSelectedId());
      syncWorkingFromDom(w);
      const normalized = normalizeSystem(structuredClone(w));
      const blob = new Blob([exportSystemJson(normalized)], {
        type: "application/octet-stream",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${normalized.id}.rpg-system`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      opts.setError(e instanceof Error ? e.message : String(e));
      opts.rerender();
    }
  });

  document.getElementById("import-file")?.addEventListener("change", async (ev) => {
    close();
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const sys = importSystemJson(text);
      saveSystem(sys);
      opts.setSelectedId(sys.id);
      working = null;
      workingSourceId = null;
      setStudioRoute({ kind: "main" });
      opts.setDimFocus(null);
      opts.setError("");
    } catch (e) {
      opts.setError(e instanceof Error ? e.message : String(e));
    }
    opts.rerender();
    input.value = "";
  });

  document.getElementById("project-file-duplicate")?.addEventListener("click", () => {
    opts.setError("");
    try {
      const w = ensureWorking(opts.getSelectedId());
      syncWorkingFromDom(w);
      const nid = prompt("New system id (slug)", `${w.id}-copy`);
      if (!nid) return;
      const nname = prompt("Display name", `${w.name} (copy)`) ?? w.name;
      const copy = normalizeSystem({
        ...structuredClone(w),
        id: nid.trim(),
        name: nname.trim(),
      });
      saveSystem(copy);
      opts.setSelectedId(copy.id);
      working = null;
      workingSourceId = null;
      setStudioRoute({ kind: "main" });
      opts.setDimFocus(null);
    } catch (e) {
      opts.setError(e instanceof Error ? e.message : String(e));
    }
    opts.rerender();
  });

  document.getElementById("project-file-check")?.addEventListener("click", () => {
    opts.setError("");
    try {
      const w = ensureWorking(opts.getSelectedId());
      syncWorkingFromDom(w);
      normalizeSystem(structuredClone(w));
    } catch (e) {
      opts.setError(e instanceof Error ? e.message : String(e));
    }
    opts.rerender();
  });

  document.getElementById("project-file-delete")?.addEventListener("click", () => {
    const id = opts.getSelectedId();
    if (!id) return;
    if (id === DEFAULT_SYSTEM.id) {
      opts.setError("The sample system cannot be deleted.");
      opts.rerender();
      return;
    }
    if (!confirm(`Delete "${id}" from this browser? This cannot be undone.`)) return;
    deleteSystem(id);
    opts.setSelectedId(getAllSystems()[0]?.id ?? null);
    working = null;
    workingSourceId = null;
    setStudioRoute({ kind: "main" });
    opts.setDimFocus(null);
    opts.setError("");
    opts.rerender();
  });
}

function wirePublishPanel(opts: StudioWireOpts): void {
  document.getElementById("btn-publish-gen")?.addEventListener("click", () => {
    void (async () => {
      const fb = document.getElementById("publish-feedback");
      const setFb = (t: string) => {
        if (fb) fb.textContent = t;
      };
      const uid = opts.getUserId();
      if (!supabaseConfigured()) {
        setFb("Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable publishing.");
        return;
      }
      if (!uid) {
        setFb("Sign in from the header to publish.");
        return;
      }
      try {
        const w = ensureWorking(opts.getSelectedId());
        if (w.id === DEFAULT_SYSTEM.id) {
          setFb("Duplicate the sample system under a new id before publishing.");
          return;
        }
        syncWorkingFromDom(w);
        const slugInp = document.getElementById("publish-slug") as HTMLInputElement | null;
        const visSel = document.getElementById("publish-vis") as HTMLSelectElement | null;
        const slug = slugInp?.value?.trim() ?? "";
        const vis = (visSel?.value ?? "unlisted") as PublishVisibility;
        const payload = stripForPublish(normalizeSystem(structuredClone(w)));
        const { slug: cleanSlug, inviteSecret } = await upsertPublishedGenerator({
          userId: uid,
          sourceSystemKey: w.id,
          slug,
          payload,
          visibility: vis,
        });
        if (slugInp) slugInp.value = cleanSlug;
        const u = new URL(window.location.href);
        u.hash = `#play/${cleanSlug}`;
        u.search = "";
        if (vis === "invite" && inviteSecret) u.searchParams.set("k", inviteSecret);
        setFb(`Published. Player link: ${u.toString()}`);
      } catch (e) {
        setFb(e instanceof Error ? e.message : String(e));
      }
    })();
  });

  document.getElementById("btn-unpublish-gen")?.addEventListener("click", () => {
    void (async () => {
      const fb = document.getElementById("publish-feedback");
      const uid = opts.getUserId();
      if (!supabaseConfigured() || !uid) {
        if (fb) fb.textContent = "Sign in to manage publications.";
        return;
      }
      const slugInp = document.getElementById("publish-slug") as HTMLInputElement | null;
      const slug = (slugInp?.value?.trim() || prompt("Slug to unpublish?", ""))?.trim();
      if (!slug) return;
      try {
        await deletePublishedGenerator(uid, slug);
        if (fb) fb.textContent = `Removed publication “${slug}”.`;
      } catch (e) {
        if (fb) fb.textContent = e instanceof Error ? e.message : String(e);
      }
    })();
  });
}

function createNewRollTableAndOpen(opts: StudioWireOpts) {
  const w = ensureWorking(opts.getSelectedId());
  let i = Object.keys(w.tables).length + 1;
  let id = `table_${i}`;
  while (w.tables[id]) {
    i++;
    id = `table_${i}`;
  }
  w.tables[id] = { id, name: "New table", options: [] };
  synchronizeRollTableLibraryMeta(w, id);
  opts.setDimFocus(null);
  setStudioRoute({ kind: "editTable", tableId: id });
  opts.rerender();
}

function wireLibraryDimFilters() {
  const applyTrait = () => {
    const sel = document.getElementById("traits-filter-dim") as HTMLSelectElement | null;
    const v = sel?.value ?? "";
    document.querySelectorAll("#traits-body tr").forEach((tr) => {
      const el = tr as HTMLElement;
      const dims = (el.dataset.traitDims ?? "").split(",").filter(Boolean);
      const used = dims.length > 0;
      let show = true;
      if (v === "__unused") show = !used;
      else if (v) show = dims.includes(v);
      el.classList.toggle("studio-filtered-out", !show);
    });
  };
  const applyTables = () => {
    const sel = document.getElementById("tables-filter-dim") as HTMLSelectElement | null;
    const v = sel?.value ?? "";
    document.querySelectorAll("#tables-lib-body tr").forEach((tr) => {
      const el = tr as HTMLElement;
      const dims = (el.dataset.tableDims ?? "").split(",").filter(Boolean);
      const used = dims.length > 0;
      let show = true;
      if (v === "__unused") show = !used;
      else if (v) show = dims.includes(v);
      el.classList.toggle("studio-filtered-out", !show);
    });
  };
  document.getElementById("traits-filter-dim")?.addEventListener("change", applyTrait);
  document.getElementById("tables-filter-dim")?.addEventListener("change", applyTables);
  applyTrait();
  applyTables();
}

function wireStudioTableCellTooltips(shell: HTMLElement | null): void {
  if (!shell) return;

  const fxSummarySel = ".tbl-o-fx-summary, .qt-fx-summary, .slist-entry-fx-summary";

  const skipWholeCellTitle = (td: HTMLTableCellElement) => td.classList.contains("tbl-lib-actions");

  const fullText = (td: HTMLTableCellElement): string => {
    const inp = td.querySelector(
      "input:not([type=hidden]):not([type=checkbox]):not([type=radio])"
    ) as HTMLInputElement | null;
    if (inp) return inp.value;
    const ta = td.querySelector("textarea") as HTMLTextAreaElement | null;
    if (ta) return ta.value;
    const sel = td.querySelector("select") as HTMLSelectElement | null;
    if (sel) {
      const opt = sel.options[sel.selectedIndex];
      return opt ? `${opt.text}`.trim() || sel.value : sel.value;
    }
    const sum = td.querySelector(fxSummarySel);
    if (sum) return sum.textContent?.trim() ?? "";
    return (td.innerText || "").replace(/\s+/g, " ").trim();
  };

  const overflowTarget = (td: HTMLTableCellElement): HTMLElement | null => {
    const inp = td.querySelector(
      "input:not([type=hidden]):not([type=checkbox]):not([type=radio])"
    ) as HTMLInputElement | null;
    if (inp) return inp;
    const ta = td.querySelector("textarea") as HTMLTextAreaElement | null;
    if (ta) return ta;
    const sel = td.querySelector("select") as HTMLSelectElement | null;
    if (sel) return sel;
    return td.querySelector(fxSummarySel) as HTMLElement | null;
  };

  const truncated = (el: HTMLElement): boolean =>
    el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;

  const updateTd = (td: HTMLTableCellElement) => {
    if (!td.closest(".data-table")) return;

    td.querySelectorAll<HTMLElement>(fxSummarySel).forEach((sum) => {
      const t = sum.textContent?.trim() ?? "";
      sum.title = t && truncated(sum) ? t : "";
    });

    if (skipWholeCellTitle(td)) {
      td.title = "";
      return;
    }

    const text = fullText(td);
    if (!text) {
      td.title = "";
      return;
    }

    const el = overflowTarget(td);
    if (el) {
      td.title = truncated(el) ? text : "";
    } else {
      td.title = truncated(td) ? text : "";
    }
  };

  shell.addEventListener(
    "mouseover",
    (ev) => {
      const td = (ev.target as HTMLElement).closest("td");
      if (!td || !shell.contains(td)) return;
      updateTd(td as HTMLTableCellElement);
    },
    true
  );

  shell.addEventListener(
    "focusin",
    (ev) => {
      const td = (ev.target as HTMLElement).closest("td");
      if (!td || !shell.contains(td)) return;
      updateTd(td as HTMLTableCellElement);
    },
    true
  );

  shell.addEventListener(
    "input",
    (ev) => {
      const node = ev.target as HTMLElement;
      if (!node.matches("input, textarea, select")) return;
      const td = node.closest("td");
      if (td && shell.contains(td)) updateTd(td as HTMLTableCellElement);
    },
    true
  );
}

export function wireStudio(opts: StudioWireOpts) {
  const shell = document.getElementById("studio-shell");
  const sel = document.getElementById("studio-sys") as HTMLSelectElement | null;

  bindEffectTypeVisibility(shell);
  wireStudioTableCellTooltips(shell);

  shell?.addEventListener(
    "input",
    (ev) => {
      const t = ev.target as HTMLElement;
      if (!t.matches("input, textarea, select")) return;
      scheduleDebouncedStudioPersist(opts);
    },
    { passive: true }
  );

  shell?.addEventListener("change", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.matches('select[data-f="sllid"]')) {
      try {
        const w = ensureWorking(opts.getSelectedId());
        const modal = document.getElementById("studio-effects-modal-body");
        refreshSheetListEntrySelects(w, modal ?? shell ?? document.body);
      } catch {
        /* ignore */
      }
      return;
    }
    if (t.matches("select[data-slist-source-table]") || t.matches("input[data-slist-dcol]")) {
      try {
        const w = ensureWorking(opts.getSelectedId());
        syncMainView(w);
      } catch {
        /* ignore */
      }
      opts.rerender();
      return;
    }
    if (t.matches("input[data-num-col]")) {
      try {
        const w = ensureWorking(opts.getSelectedId());
        syncMainView(w);
      } catch {
        /* ignore */
      }
      opts.rerender();
      return;
    }
    if (t.matches("input.tbl-lib-cat")) {
      try {
        const w = ensureWorking(opts.getSelectedId());
        syncMainView(w);
      } catch {
        /* ignore */
      }
      opts.rerender();
      return;
    }
  });

  shell?.addEventListener("click", (ev) => {
    const t = studioClickTarget(ev);
    if (!t) return;
    if (t.closest("[data-crumb-root]")) {
      ev.preventDefault();
      try {
        const w = ensureWorking(opts.getSelectedId());
        syncWorkingFromDom(w);
      } catch {
        /* ignore */
      }
      setStudioRoute({ kind: "main" });
      opts.setDimFocus(null);
      opts.setActiveTab("overview");
      opts.rerender();
      return;
    }
    const crumbTab = t.closest("[data-crumb-tab]") as HTMLElement | null;
    if (crumbTab?.dataset.crumbTab) {
      ev.preventDefault();
      const prevRoute = getStudioRoute();
      try {
        const w = ensureWorking(opts.getSelectedId());
        syncWorkingFromDom(w);
      } catch {
        /* ignore */
      }
      setStudioRoute({ kind: "main" });
      const nextTabRaw = crumbTab.dataset.crumbTab;
      const nextTab = nextTabRaw === "resources" ? "stats" : nextTabRaw;
      if (nextTab === "dimensions" && prevRoute.kind === "editArchetype") {
        opts.setDimFocus(prevRoute.groupId);
      } else {
        opts.setDimFocus(null);
      }
      opts.setActiveTab(nextTab);
      opts.rerender();
      return;
    }
    const tbl = t.closest(".cms-open-table") as HTMLElement | null;
    if (tbl?.dataset.cmsTable) {
      ev.preventDefault();
      try {
        const w = ensureWorking(opts.getSelectedId());
        syncWorkingFromDom(w);
      } catch {
        /* ignore */
      }
      opts.setDimFocus(null);
      setStudioRoute({ kind: "editTable", tableId: tbl.dataset.cmsTable });
      opts.rerender();
      return;
    }
    const op = t.closest(".cms-open-option") as HTMLElement | null;
    if (op?.dataset.cmsGroup && op.dataset.cmsOption) {
      ev.preventDefault();
      try {
        const w = ensureWorking(opts.getSelectedId());
        syncWorkingFromDom(w);
      } catch {
        /* ignore */
      }
      opts.setDimFocus(null);
      setStudioRoute({ kind: "editArchetype", groupId: op.dataset.cmsGroup, optionId: op.dataset.cmsOption });
      opts.rerender();
      return;
    }
    const delOpt = t.closest(".cms-del-option") as HTMLElement | null;
    if (delOpt?.dataset.cmsGroup && delOpt.dataset.cmsOption) {
      ev.preventDefault();
      ev.stopPropagation();
      const gid = delOpt.dataset.cmsGroup;
      const oid = delOpt.dataset.cmsOption;
      const w = ensureWorking(opts.getSelectedId());
      const g = w.archetypeGroups.find((x) => x.id === gid);
      if (!g) return;
      g.options = g.options.filter((x) => x.id !== oid);
      synchronizeRollTableLibraryMeta(w);
      opts.rerender();
      return;
    }
    const delDim = t.closest(".cms-del-dim") as HTMLElement | null;
    if (delDim?.dataset.cmsDelDim) {
      ev.preventDefault();
      ev.stopPropagation();
      const gid = delDim.dataset.cmsDelDim;
      const w = ensureWorking(opts.getSelectedId());
      const g = w.archetypeGroups.find((x) => x.id === gid);
      if (!g) return;
      if (
        !confirm(
          `Delete dimension “${g.label}” (${gid}) and all ${g.options.length} option(s)? Roll tables are not deleted.`
        )
      )
        return;
      try {
        syncMainView(w);
      } catch {
        /* ignore */
      }
      w.archetypeGroups = w.archetypeGroups.filter((x) => x.id !== gid);
      if (studioRoute.kind === "editArchetype" && studioRoute.groupId === gid) {
        setStudioRoute({ kind: "main" });
      }
      if (opts.getDimFocus() === gid) opts.setDimFocus(null);
      synchronizeRollTableLibraryMeta(w);
      opts.rerender();
      return;
    }
    const delTbl = t.closest("[data-cms-del-table]") as HTMLElement | null;
    if (delTbl?.dataset.cmsDelTable) {
      ev.preventDefault();
      const tid = delTbl.dataset.cmsDelTable;
      const w = ensureWorking(opts.getSelectedId());
      const tMeta = w.tables[tid];
      if (!tMeta) return;
      if (
        !confirm(
          `Delete roll table “${tMeta.name}” (${tid})? Extra rolls, starting loadout lines, and “roll table” effects that pointed here will be cleared.`
        )
      )
        return;
      try {
        syncMainView(w);
      } catch {
        /* ignore */
      }
      removeRollTableFromSystem(w, tid);
      if (studioRoute.kind === "editTable" && studioRoute.tableId === tid) {
        setStudioRoute({ kind: "main" });
      }
      opts.rerender();
      return;
    }
  });

  shell?.querySelectorAll("a[data-studio-tab]").forEach((el) => {
    el.addEventListener("click", (ev) => {
      ev.preventDefault();
      const hel = el as HTMLElement;
      const tabRaw = hel.dataset.studioTab ?? "overview";
      const tab = tabRaw === "resources" ? "stats" : tabRaw;
      const w = ensureWorking(opts.getSelectedId());
      try {
        if (getStudioRoute().kind !== "main") {
          syncWorkingFromDom(w);
          setStudioRoute({ kind: "main" });
        } else {
          syncMainView(w);
        }
      } catch {
        /* ignore */
      }
      if (tab === "dimensions") {
        if (hel.dataset.dimAll === "1") opts.setDimFocus(null);
        else if (hel.dataset.dimFocus) opts.setDimFocus(hel.dataset.dimFocus);
        else opts.setDimFocus(null);
      } else {
        opts.setDimFocus(null);
      }
      opts.setActiveTab(tab);
      opts.rerender();
    });
  });

  sel?.addEventListener("change", (ev) => {
    const cur = ev.currentTarget as HTMLSelectElement;
    const menuEl = document.getElementById("project-file-menu");
    const trg = document.getElementById("project-file-menu-trigger");
    if (menuEl && !menuEl.hidden) {
      menuEl.hidden = true;
      trg?.setAttribute("aria-expanded", "false");
    }
    const previousId = opts.getSelectedId();
    const nextId = cur.value || null;
    if (!persistStudioFromDom(opts)) {
      if (previousId) cur.value = previousId;
      opts.rerender();
      return;
    }
    opts.setSelectedId(nextId);
    working = null;
    workingSourceId = null;
    setStudioRoute({ kind: "main" });
    opts.setDimFocus(null);
    opts.rerender();
  });

  shell?.querySelectorAll(".cms-add-dim").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      const w = ensureWorking(opts.getSelectedId());
      let n = w.archetypeGroups.length + 1;
      let gid = `dimension_${n}`;
      while (w.archetypeGroups.some((g) => g.id === gid)) {
        n++;
        gid = `dimension_${n}`;
      }
      w.archetypeGroups.push({
        id: gid,
        label: `Dimension ${n}`,
        options: [{ id: `option_${gid}_1`, name: "First option" }],
      });
      opts.setActiveTab("dimensions");
      opts.setDimFocus(gid);
      opts.rerender();
    });
  });

  document.getElementById("loadout-add")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    const tbody = document.getElementById("loadout-body");
    if (!tbody) return;
    const w = ensureWorking(opts.getSelectedId());
    tbody.insertAdjacentHTML(
      "beforeend",
      loadoutEntryRowHtml(w, { tableId: "", rolls: 1, mode: "repeat" })
    );
  });

  document.getElementById("cms-add-table")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    createNewRollTableAndOpen(opts);
  });

  document.getElementById("sidebar-new-roll")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    createNewRollTableAndOpen(opts);
  });

  document.querySelectorAll(".cms-add-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      const gid = (btn as HTMLElement).dataset.cmsGroup;
      if (!gid) return;
      const w = ensureWorking(opts.getSelectedId());
      const g = w.archetypeGroups.find((x) => x.id === gid);
      if (!g) return;
      const k = g.options.length + 1;
      g.options.push({ id: `opt_${gid}_${k}`, name: `Option ${k}` });
      opts.rerender();
    });
  });

  document.getElementById("tracks-add-stat")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    const w = ensureWorking(opts.getSelectedId());
    w.stats.push({ id: `stat_${w.stats.length + 1}`, name: "Score", defaultValue: 0 });
    opts.rerender();
  });
  document.getElementById("tracks-add-pool")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    const w = ensureWorking(opts.getSelectedId());
    w.resources.push({ id: `pool_${w.resources.length + 1}`, name: "Pool", defaultValue: 0 });
    opts.rerender();
  });
  document.getElementById("sheetlist-add-list")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    const w = ensureWorking(opts.getSelectedId());
    let n = Object.keys(w.sheetLists).length + 1;
    let id = `list_${n}`;
    while (w.sheetLists[id]) {
      n++;
      id = `list_${n}`;
    }
    const tableIds = Object.keys(w.tables).sort();
    const tid = tableIds[0];
    if (tid) {
      const t = w.tables[tid]!;
      w.sheetLists[id] = {
        id,
        sheetTitle: t.name,
        sourceTableId: tid,
        sheetDisplayColumns: defaultSheetDisplayColumns(),
        fields: [],
        entries: {},
      };
    } else {
      w.sheetLists[id] = {
        id,
        sheetTitle: "New list",
        fields: [
          { id: "name", label: "Name", fieldType: "text" },
          { id: "notes", label: "Notes", fieldType: "textarea" },
        ],
        entries: {},
      };
    }
    opts.rerender();
  });

  document.getElementById("traits-add")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    const w = ensureWorking(opts.getSelectedId());
    if (!w.sharedTraits) w.sharedTraits = {};
    let n = Object.keys(w.sharedTraits).length + 1;
    let id = `trait_${n}`;
    while (w.sharedTraits[id]) {
      n++;
      id = `trait_${n}`;
    }
    w.sharedTraits[id] = { id, name: "New definition", description: "" };
    opts.rerender();
  });

  document.getElementById("tbl-add-opt")?.addEventListener("click", () => {
    const w = ensureWorking(opts.getSelectedId());
    const r = getStudioRoute();
    if (r.kind !== "editTable") return;
    const nid = syncTableView(w, r.tableId);
    studioRoute = { kind: "editTable", tableId: nid };
    const t = w.tables[nid];
    if (t) {
      t.options.push({ label: "New outcome", weight: 1, description: "", effects: [] });
    }
    opts.rerender();
  });

  shell?.addEventListener("click", (ev) => {
    const el = studioClickTarget(ev);
    if (!el) return;
    if (el.id === "ec-add") {
      ev.preventDefault();
      document.getElementById("ec-body")?.insertAdjacentHTML(
        "beforeend",
        `<tr>
      <td><input class="inp inp-compact" data-ec-id type="text" value="col_${Date.now().toString(36)}" /></td>
      <td><input class="inp inp-compact" data-ec-label type="text" value="New column" /></td>
      <td>
        <select class="inp inp-compact" data-ec-type>
          <option value="text" selected>text</option>
          <option value="number">number</option>
          <option value="textarea">textarea</option>
        </select>
      </td>
      <td><button type="button" class="danger small-btn" data-ec-del="1">×</button></td>
    </tr>`
      );
      return;
    }
    const ecDel = el.closest("[data-ec-del]") as HTMLElement | null;
    if (ecDel && el.closest("#studio-cols-modal-body")) {
      ev.preventDefault();
      ecDel.closest("tr")?.remove();
      return;
    }
    const openSlistFx = el.closest("[data-open-effects-sheetentry]") as HTMLElement | null;
    if (openSlistFx) {
      ev.preventDefault();
      const row = openSlistFx.closest(".slist-entry-row") as HTMLElement | null;
      if (!row) return;
      const w = ensureWorking(opts.getSelectedId());
      try {
        syncMainView(w);
      } catch {
        /* ignore */
      }
      const stash = row.querySelector(".slist-entry-effects-stash") as HTMLInputElement | null;
      const fx = parseEffectsFromStash(stash?.value);
      const eid = (row.querySelector("[data-slist-eid]") as HTMLInputElement | null)?.value.trim() || "Row";
      openStudioEffectsModal(w, `Effects — ${eid}`, fx, { kind: "sheetentry", row });
      return;
    }
    const openTblFx = el.closest("[data-open-effects-tblopt]") as HTMLElement | null;
    if (openTblFx) {
      ev.preventDefault();
      const card = openTblFx.closest("tr.table-opt-card") as HTMLElement | null;
      if (!card) return;
      const w = ensureWorking(opts.getSelectedId());
      const stash = card.querySelector(".tbl-o-effects-stash") as HTMLInputElement | null;
      const fx = parseEffectsFromStash(stash?.value);
      const label = (card.querySelector(".tbl-o-label") as HTMLInputElement | null)?.value.trim() || "Outcome";
      openStudioEffectsModal(w, `Effects — ${label}`, fx, { kind: "tblopt", card });
      return;
    }
    const colsHit = el.closest("[data-cols-kind]") as HTMLElement | null;
    if (colsHit?.dataset.colsKind) {
      ev.preventDefault();
      const w = ensureWorking(opts.getSelectedId());
      try {
        if (getStudioRoute().kind !== "main") syncWorkingFromDom(w);
        else syncMainView(w);
      } catch {
        /* ignore */
      }
      const tgt = colsModalTargetFromBtn(colsHit);
      if (tgt) openStudioColsModal(w, tgt);
      return;
    }
    const rowEditBtn = el.closest("[data-tbl-row-edit]") as HTMLElement | null;
    if (rowEditBtn?.dataset.tblRowEdit != null && rowEditBtn.dataset.tblRowEdit !== "") {
      ev.preventDefault();
      const w = ensureWorking(opts.getSelectedId());
      const r = getStudioRoute();
      if (r.kind !== "editTable") return;
      const idx = Number(rowEditBtn.dataset.tblRowEdit);
      if (!Number.isFinite(idx)) return;
      openStudioTableRowModal(w, r.tableId, idx);
      return;
    }
    const quickRowEd = el.closest("[data-quick-row-edit]") as HTMLElement | null;
    if (quickRowEd) {
      ev.preventDefault();
      const tr = quickRowEd.closest("tr") as HTMLTableRowElement | null;
      const tbody = tr?.parentElement as HTMLElement | null;
      const tid = tbody?.dataset.quickTbl?.trim();
      if (!tr || !tbody || !tid) return;
      const w = ensureWorking(opts.getSelectedId());
      syncQuickRollTablesFromDom(w);
      const rows = [...tbody.querySelectorAll(":scope > tr")];
      const idx = rows.indexOf(tr);
      if (idx < 0) return;
      openStudioTableRowModal(w, tid, idx);
      return;
    }
    if (el.closest("[data-track-edit]")) {
      ev.preventDefault();
      const tr = el.closest("tr") as HTMLTableRowElement | null;
      if (tr?.dataset.trKind) openStudioTrackRowModal(tr);
      return;
    }
    if (el.closest("[data-trait-edit]")) {
      ev.preventDefault();
      const tr = el.closest("tr") as HTMLTableRowElement | null;
      if (tr && tr.closest("#traits-body")) openStudioTraitRowModal(tr);
      return;
    }
    if (el.closest("[data-dim-opt-modal]")) {
      ev.preventDefault();
      const tr = el.closest("tr") as HTMLTableRowElement | null;
      if (tr?.dataset.dimRow && tr.dataset.oid) {
        const w = ensureWorking(opts.getSelectedId());
        openStudioDimOptionRowModal(w, tr);
      }
      return;
    }
    if (el.closest("[data-loadout-edit]")) {
      ev.preventDefault();
      const tr = el.closest("tr") as HTMLTableRowElement | null;
      if (tr) {
        const w = ensureWorking(opts.getSelectedId());
        openStudioLoadoutRowModal(w, tr);
      }
      return;
    }
    if (el.closest("[data-slist-field-edit]")) {
      ev.preventDefault();
      const tr = el.closest("tr") as HTMLTableRowElement | null;
      if (tr?.closest("[data-slist-fields-body]")) openStudioSlistFieldModal(tr);
      return;
    }
    if (el.closest("[data-slist-entry-edit]")) {
      ev.preventDefault();
      const tr = el.closest(".slist-entry-row") as HTMLTableRowElement | null;
      const sec = tr?.closest("[data-sheet-list-data]") as HTMLElement | null;
      const listId = sec?.dataset.sheetListData?.trim();
      if (tr && listId) {
        const w = ensureWorking(opts.getSelectedId());
        openStudioSlistEntryModal(w, listId, tr);
      }
      return;
    }
    const openQuickFx = el.closest("[data-open-effects-quick]") as HTMLElement | null;
    if (openQuickFx?.dataset.openEffectsQuick) {
      ev.preventDefault();
      const tid = openQuickFx.dataset.openEffectsQuick;
      const tr = openQuickFx.closest("tr") as HTMLElement | null;
      const tbody = tr?.parentElement as HTMLElement | null;
      if (!tid || !tr || !tbody || tbody.dataset.quickTbl !== tid) return;
      const w = ensureWorking(opts.getSelectedId());
      const stash = tr.querySelector(".qt-effects-stash") as HTMLInputElement | null;
      const fx = parseEffectsFromStash(stash?.value);
      const label = (tr.querySelector(".qt-label") as HTMLInputElement | null)?.value.trim() || "Outcome";
      openStudioEffectsModal(w, `Effects — ${label}`, fx, { kind: "quick", row: tr });
      return;
    }
    const slDelField = el.closest("[data-slist-del-field]") as HTMLElement | null;
    if (slDelField) {
      ev.preventDefault();
      slDelField.closest("tr")?.remove();
      return;
    }
    const slDelEntry = el.closest("[data-slist-del-entry]") as HTMLElement | null;
    if (slDelEntry) {
      ev.preventDefault();
      slDelEntry.closest("tr")?.remove();
      return;
    }
    const slDelList = el.closest("[data-slist-delete-list]") as HTMLElement | null;
    if (slDelList) {
      ev.preventDefault();
      if (
        !confirm(
          "Delete this list and all of its rows? Roll tables or effects that still reference this list id will need to be updated."
        )
      )
        return;
      const sec = slDelList.closest("[data-sheet-list-data]") as HTMLElement | null;
      const listId = sec?.dataset.sheetListData?.trim();
      if (!listId) return;
      const w = ensureWorking(opts.getSelectedId());
      syncMainView(w);
      delete w.sheetLists[listId];
      opts.rerender();
      return;
    }
    const slAddField = el.closest("[data-slist-add-field]") as HTMLElement | null;
    if (slAddField) {
      ev.preventDefault();
      const sec = slAddField.closest("[data-sheet-list-data]") as HTMLElement | null;
      const tbody = sec?.querySelector("[data-slist-fields-body]");
      if (!tbody) return;
      const n = tbody.querySelectorAll("tr").length;
      tbody.insertAdjacentHTML(
        "beforeend",
        renderSheetListFieldRow({ id: `field_${n + 1}`, label: "Field", fieldType: "text" }, n)
      );
      return;
    }
    const slAddEntry = el.closest("[data-slist-add-entry]") as HTMLElement | null;
    if (slAddEntry) {
      ev.preventDefault();
      const sec = slAddEntry.closest("[data-sheet-list-data]") as HTMLElement | null;
      const listId = sec?.dataset.sheetListData;
      if (!listId) return;
      const w = ensureWorking(opts.getSelectedId());
      syncMainView(w);
      const def = w.sheetLists[listId];
      if (!def) return;
      let i = Object.keys(def.entries).length + 1;
      let eid = `row_${i}`;
      while (def.entries[eid]) {
        i++;
        eid = `row_${i}`;
      }
      const values: Record<string, string | number> = {};
      for (const f of def.fields) values[f.id] = f.fieldType === "number" ? 0 : "";
      def.entries[eid] = { id: eid, values };
      opts.rerender();
      return;
    }
    const qAdd = el.closest("[data-quick-tbl-add]") as HTMLElement | null;
    if (qAdd?.dataset.quickTblAdd) {
      ev.preventDefault();
      const tid = qAdd.dataset.quickTblAdd;
      const tbody = Array.from(document.querySelectorAll("tbody[data-quick-tbl]")).find(
        (n) => (n as HTMLElement).dataset.quickTbl === tid
      );
      if (!tbody) return;
      const w = ensureWorking(opts.getSelectedId());
      const qt = tid ? w.tables[tid] : undefined;
      if (!qt) return;
      tbody.insertAdjacentHTML("beforeend", htmlQuickRollNewRow(w, qt));
      return;
    }
    const inlineNew = el.closest("[data-inline-new]") as HTMLElement | null;
    if (inlineNew?.dataset.inlineNew) {
      ev.preventDefault();
      const w = ensureWorking(opts.getSelectedId());
      const r = getStudioRoute();
      if (r.kind === "editTable") {
        try {
          syncTableView(w, r.tableId);
        } catch {
          /* ignore */
        }
      } else if (r.kind === "editArchetype") {
        try {
          syncArchetypeView(w, r.groupId, r.optionId);
        } catch {
          /* ignore */
        }
      } else {
        try {
          syncMainView(w);
        } catch {
          /* ignore */
        }
      }
      const k = inlineNew.dataset.inlineNew;
      if (k === "sheetlist-row") {
        const effRow = inlineNew.closest(".effect-row") as HTMLElement | null;
        const g = effRow?.querySelector('.eff-group[data-for="sheet_list_ref"]');
        const listId = (g?.querySelector('[data-f="sllid"]') as HTMLSelectElement | null)?.value.trim();
        if (!listId || !w.sheetLists[listId]) {
          opts.setError("Choose a list first, or add one under Content → Lists.");
          return;
        }
        const def = w.sheetLists[listId];
        let i = Object.keys(def.entries).length + 1;
        let eid = `row_${i}`;
        while (def.entries[eid]) {
          i++;
          eid = `row_${i}`;
        }
        const values: Record<string, string | number> = {};
        for (const f of def.fields) values[f.id] = f.fieldType === "number" ? 0 : "";
        const nf = def.fields.find((x) => x.id === "name") ?? def.fields[0];
        if (nf) values[nf.id] = "New row";
        def.entries[eid] = { id: eid, values };
        const entSel = g?.querySelector('[data-f="sleid"]') as HTMLSelectElement | null;
        if (entSel) {
          entSel.innerHTML = sheetListEntrySel(w, listId, eid);
        }
        return;
      }
      if (k === "rolltable") {
        let i = Object.keys(w.tables).length + 1;
        let tidNew = `table_${i}`;
        while (w.tables[tidNew]) {
          i++;
          tidNew = `table_${i}`;
        }
        w.tables[tidNew] = { id: tidNew, name: "New table", options: [] };
        synchronizeRollTableLibraryMeta(w, tidNew);
        opts.rerender();
        return;
      }
    }
    if (el.closest(".tbl-del-opt")) {
      const b = el.closest(".tbl-del-opt") as HTMLElement;
      const wrap = document.getElementById("tbl-options-wrap");
      const card = b.closest("tr.table-opt-card, .table-opt-card");
      if (!wrap || !card) return;
      const idx = Array.from(wrap.querySelectorAll(":scope > tr.table-opt-card, :scope > .table-opt-card")).indexOf(
        card as Element
      );
      if (idx < 0) return;
      const w = ensureWorking(opts.getSelectedId());
      const r = getStudioRoute();
      if (r.kind !== "editTable") return;
      const nid = syncTableView(w, r.tableId);
      studioRoute = { kind: "editTable", tableId: nid };
      w.tables[nid]?.options.splice(idx, 1);
      opts.rerender();
      return;
    }
    const addEff = el.closest("[data-add-eff]") as HTMLElement | null;
    if (addEff?.dataset.addEff) {
      const inFx = addEff.closest("#studio-effects-modal-body");
      const inRow = addEff.closest("#studio-row-modal-body");
      if (inFx) {
        ev.preventDefault();
        const w = ensureWorking(opts.getSelectedId());
        const nest = inFx.querySelector(".effects-nest");
        if (!nest) return;
        const n = nest.querySelectorAll(":scope > .effect-row").length;
        nest.insertAdjacentHTML("beforeend", renderEffectRow(w, defaultEffect(w), n, STUDIO_FX_MODAL_SCOPE));
        refreshSheetListEntrySelects(w, inFx);
        return;
      }
      if (inRow) {
        ev.preventDefault();
        const w = ensureWorking(opts.getSelectedId());
        const nest = inRow.querySelector(".effects-nest");
        if (!nest) return;
        const n = nest.querySelectorAll(":scope > .effect-row").length;
        nest.insertAdjacentHTML("beforeend", renderEffectRow(w, defaultEffect(w), n, STUDIO_ROW_MODAL_SCOPE));
        refreshSheetListEntrySelects(w, inRow);
        return;
      }
      return;
    }
    if (el.closest(".btn-del-eff")) {
      el.closest(".effect-row")?.remove();
      return;
    }
    const delBtn = el.closest<HTMLElement>(".row-del");
    if (!delBtn) return;
    const kind = delBtn.dataset.table;

    if (kind === "qt") {
      delBtn.closest("tr")?.remove();
      return;
    }

    if (kind === "trait") {
      delBtn.closest("tr")?.remove();
      return;
    }

    const tr = delBtn.closest("tr");
    if (!tr) return;
    if (kind === "abl") {
      ensureWorking(opts.getSelectedId());
    }
    if (kind === "res") {
      ensureWorking(opts.getSelectedId());
    }
    tr.remove();
  });

  document.getElementById("arch-add-sm")?.addEventListener("click", () => {
    const w = ensureWorking(opts.getSelectedId());
    const gid = (document.getElementById("arch-gid") as HTMLInputElement)?.value;
    const oid = (document.getElementById("arch-oid") as HTMLInputElement)?.value;
    const g = w.archetypeGroups.find((x) => x.id === gid);
    const o = g?.options.find((x) => x.id === oid);
    if (!o || !w.stats[0]) return;
    if (!o.statMods) o.statMods = [];
    o.statMods.push({ statId: w.stats[0].id, amount: 0 });
    opts.rerender();
  });
  document.getElementById("arch-add-rm")?.addEventListener("click", () => {
    const w = ensureWorking(opts.getSelectedId());
    const gid = (document.getElementById("arch-gid") as HTMLInputElement)?.value;
    const oid = (document.getElementById("arch-oid") as HTMLInputElement)?.value;
    const g = w.archetypeGroups.find((x) => x.id === gid);
    const o = g?.options.find((x) => x.id === oid);
    if (!o || !w.resources[0]) return;
    if (!o.resourceMods) o.resourceMods = [];
    o.resourceMods.push({ resourceId: w.resources[0].id, amount: 0 });
    opts.rerender();
  });

  document.getElementById("arch-inline-new-trait")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    const w = ensureWorking(opts.getSelectedId());
    const gid = (document.getElementById("arch-gid") as HTMLInputElement)?.value.trim();
    const oid = (document.getElementById("arch-oid") as HTMLInputElement)?.value.trim();
    if (!gid || !oid) return;
    const g = w.archetypeGroups.find((x) => x.id === gid);
    const o = g?.options.find((x) => x.id === oid);
    if (!g || !o) return;
    syncArchetypeView(w, gid, oid);
    if (!w.sharedTraits) w.sharedTraits = {};
    let n = Object.keys(w.sharedTraits).length + 1;
    let tid = `trait_${n}`;
    while (w.sharedTraits[tid]) {
      n++;
      tid = `trait_${n}`;
    }
    w.sharedTraits[tid] = { id: tid, name: "New definition", description: "" };
    if (!o.sharedTraitRefs) o.sharedTraitRefs = [];
    if (!o.sharedTraitRefs.includes(tid)) o.sharedTraitRefs.push(tid);
    opts.rerender();
  });

  wireProjectFileMenu(opts);
  wirePublishPanel(opts);

  wireLibraryDimFilters();

  document.getElementById("studio-effects-modal")?.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    if (!t.closest("[data-studio-effects-modal-close]")) return;
    ev.preventDefault();
    closeStudioEffectsModal();
  });
  document.getElementById("studio-effects-modal-save")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    const w = ensureWorking(opts.getSelectedId());
    saveStudioEffectsModal(w, opts);
  });
  document.getElementById("studio-cols-modal")?.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    if (!t.closest("[data-studio-cols-modal-close]")) return;
    ev.preventDefault();
    closeStudioColsModal();
  });
  document.getElementById("studio-cols-modal-save")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    const w = ensureWorking(opts.getSelectedId());
    saveStudioColsModal(w, opts);
  });
  document.getElementById("studio-row-modal")?.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    if (!t.closest("[data-studio-row-modal-close]")) return;
    ev.preventDefault();
    closeStudioRowModal();
  });
  document.getElementById("studio-row-modal-save")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    const w = ensureWorking(opts.getSelectedId());
    saveStudioRowModal(w, opts);
  });
  document.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    const pfm = document.getElementById("project-file-menu");
    const pft = document.getElementById("project-file-menu-trigger");
    if (pfm && !pfm.hidden) {
      pfm.hidden = true;
      pft?.setAttribute("aria-expanded", "false");
      ev.preventDefault();
      return;
    }
    const rowM = document.getElementById("studio-row-modal");
    if (rowM && !rowM.classList.contains("studio-modal--hidden")) {
      closeStudioRowModal();
      return;
    }
    const colsM = document.getElementById("studio-cols-modal");
    if (colsM && !colsM.classList.contains("studio-modal--hidden")) {
      closeStudioColsModal();
      return;
    }
    const root = document.getElementById("studio-effects-modal");
    if (!root || root.classList.contains("studio-modal--hidden")) return;
    closeStudioEffectsModal();
  });

  queueMicrotask(() => {
    const expectedId = opts.getSelectedId();
    runAfterStudioRenderPersistForProject(opts, expectedId);
    const focus = opts.getDimFocus();
    if (focus && opts.getActiveTab() === "dimensions") {
      document.getElementById(`dim-section-${focus}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
}
