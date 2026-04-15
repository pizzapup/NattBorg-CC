import type { Effect, RpgSystem, SheetSlot } from "../types";
import { sheetListBlockId } from "../types";
import { resolveSheetListEntry } from "../sheetListCore";

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function coreSheetSlots(): { id: SheetSlot; label: string }[] {
  return [
    { id: "description", label: "Description" },
    { id: "traits", label: "Term definitions" },
    { id: "special", label: "Special" },
    { id: "notes", label: "Notes" },
  ];
}

export function sheetSlotsForSystem(w: RpgSystem): { id: SheetSlot; label: string }[] {
  const lists = Object.keys(w.sheetLists)
    .sort()
    .map((id) => {
      const title = w.sheetLists[id]?.sheetTitle?.trim() || id;
      return { id: sheetListBlockId(id), label: `List: ${title}` };
    });
  return [...coreSheetSlots(), ...lists];
}

const EFFECT_TYPE_OPTIONS: { id: Effect["type"]; label: string }[] = [
  { id: "stat_mod", label: "Change a stat" },
  { id: "resource_mod", label: "Change HP or a pool" },
  { id: "sheet_list_ref", label: "Give a row from a sheet list" },
  { id: "sheet_list_line", label: "Add a line on a sheet list (free text)" },
  { id: "trait", label: "Add text (term definitions)" },
  { id: "special", label: "Add special text" },
  { id: "sheet_text", label: "Put text on the sheet" },
  { id: "roll_table", label: "Roll another table" },
];

function statSel(w: RpgSystem, v: string): string {
  return w.stats
    .map(
      (s) =>
        `<option value="${esc(s.id)}"${s.id === v ? " selected" : ""}>${esc(s.name)}</option>`
    )
    .join("");
}

function resSel(w: RpgSystem, v: string): string {
  return w.resources
    .map(
      (r) =>
        `<option value="${esc(r.id)}"${r.id === v ? " selected" : ""}>${esc(r.name)}</option>`
    )
    .join("");
}

function tableSel(w: RpgSystem, v: string): string {
  return Object.values(w.tables)
    .map(
      (t) =>
        `<option value="${esc(t.id)}"${t.id === v ? " selected" : ""}>${esc(t.name)}</option>`
    )
    .join("");
}

function sheetListIdSel(w: RpgSystem, v: string, emptyLabel: string): string {
  const keys = Object.keys(w.sheetLists).sort();
  if (keys.length === 0) {
    return `<option value="">${esc(emptyLabel)}</option>`;
  }
  return (
    `<option value="">${esc(emptyLabel)}</option>` +
    keys
      .map((id) => {
        const title = w.sheetLists[id]?.sheetTitle?.trim() || id;
        return `<option value="${esc(id)}"${id === v ? " selected" : ""}>${esc(`«${title}» (${id})`)}</option>`;
      })
      .join("")
  );
}

export function sheetListEntrySel(w: RpgSystem, listId: string, v: string): string {
  const def = listId ? w.sheetLists[listId] : undefined;
  if (!def) return `<option value="">—</option>`;
  if (def.sourceTableId) {
    const t = w.tables[def.sourceTableId];
    if (!t) return `<option value="">—</option>`;
    const opts = t.options
      .map((opt, i) => {
        const id = String(i);
        const ent = resolveSheetListEntry(w, listId, id);
        const lab =
          (ent?.values.label !== undefined && String(ent.values.label).trim()) ||
          (ent?.values.name !== undefined && String(ent.values.name).trim()) ||
          opt.label.trim() ||
          `#${i}`;
        return `<option value="${esc(id)}"${id === v ? " selected" : ""}>${esc(lab)}</option>`;
      })
      .join("");
    return `<option value="">—</option>${opts}`;
  }
  const keys = Object.keys(def.entries).sort();
  const nameField = def.fields.find((f) => f.id === "name");
  const opts =
    keys.map((eid) => {
      const ent = def.entries[eid]!;
      const lab =
        (nameField && String(ent.values[nameField.id] ?? "").trim()) || eid;
      return `<option value="${esc(eid)}"${eid === v ? " selected" : ""}>${esc(lab)}</option>`;
    }).join("") || `<option value="">—</option>`;
  return `<option value="">—</option>${opts}`;
}

function slotSel(w: RpgSystem, v: string): string {
  return sheetSlotsForSystem(w)
    .map((s) => `<option value="${esc(s.id)}"${s.id === v ? " selected" : ""}>${esc(s.label)}</option>`)
    .join("");
}

function typeOptions(w: RpgSystem, current: string): string {
  const allowed = EFFECT_TYPE_OPTIONS.filter((o) => {
    if (o.id === "sheet_list_ref" || o.id === "sheet_list_line") {
      return Object.keys(w.sheetLists).length > 0;
    }
    return true;
  });
  const ids = new Set(allowed.map((x) => x.id));
  const merged =
    ids.has(current as Effect["type"]) || current === ""
      ? allowed
      : (() => {
          const orphan = EFFECT_TYPE_OPTIONS.find((x) => x.id === current);
          return orphan ? [orphan, ...allowed] : allowed;
        })();
  return merged
    .map((o) => `<option value="${esc(o.id)}"${o.id === current ? " selected" : ""}>${esc(o.label)}</option>`)
    .join("");
}

export function defaultEffect(w: RpgSystem): Effect {
  const s = w.stats[0];
  if (s) return { type: "stat_mod", statId: s.id, amount: 0 };
  const firstList = Object.keys(w.sheetLists).sort()[0];
  if (firstList) return { type: "sheet_list_line", listId: firstList, text: "" };
  return { type: "trait", text: "" };
}

export function renderEffectRow(w: RpgSystem, e: Effect, rowIx: number, scope: string): string {
  const t = e.type;
  const sm = e.type === "stat_mod" ? e : { statId: "", amount: 0 };
  const rm = e.type === "resource_mod" ? e : { resourceId: "", amount: 0 };
  const slr = e.type === "sheet_list_ref" ? e : { listId: "", entryId: "", displayName: "", displayDescription: "" };
  const sll = e.type === "sheet_list_line" ? e : { listId: "", text: "" };
  const tr = e.type === "trait" ? e : { text: "" };
  const sp = e.type === "special" ? e : { text: "" };
  const st = e.type === "sheet_text" ? e : { slot: "description" as SheetSlot, text: "", append: true };
  const rt = e.type === "roll_table" ? e : { tableId: "", label: "" };

  const listIdRef = slr.listId || Object.keys(w.sheetLists).sort()[0] || "";
  const listIdLine = sll.listId || Object.keys(w.sheetLists).sort()[0] || "";
  const refList = listIdRef ? w.sheetLists[listIdRef] : undefined;
  const tableBackedSheetList = Boolean(refList?.sourceTableId && w.tables[refList.sourceTableId]);
  const sheetListRefRowHelp = tableBackedSheetList
    ? `<p class="muted tiny">Pick outcome by <strong>row #</strong> (0 = first row in the roll table). Edit rows under <strong>Roll tables</strong>.</p>`
    : `<div class="eff-inline-actions"><button type="button" class="secondary small-btn" data-inline-new="sheetlist-row">+ New row in this list</button></div>`;

  return `
    <div class="effect-row" data-effect-type="${esc(t)}" data-eff-scope="${esc(scope)}" data-eff-row="${rowIx}">
      <div class="effect-row-head">
        <label class="inline tight">
          <span class="muted small">Does</span>
          <select class="inp inp-compact" data-eff-type>${typeOptions(w, t)}</select>
        </label>
        <button type="button" class="danger small btn-del-eff">Remove</button>
      </div>
      <div class="eff-group" data-for="stat_mod">
        <div class="form-grid-2">
          <label><span class="muted small">Stat</span><select class="inp inp-compact" data-f="stat">${statSel(w, sm.statId)}</select></label>
          <label><span class="muted small">Amount</span><input class="inp inp-compact" type="number" data-f="amt" value="${sm.amount}" /></label>
        </div>
      </div>
      <div class="eff-group" data-for="resource_mod">
        <div class="form-grid-2">
          <label><span class="muted small">Resource</span><select class="inp inp-compact" data-f="res">${resSel(w, rm.resourceId)}</select></label>
          <label><span class="muted small">Amount</span><input class="inp inp-compact" type="number" data-f="ramt" value="${rm.amount}" /></label>
        </div>
      </div>
      <div class="eff-group" data-for="sheet_list_ref">
        <label class="block tight"><span class="muted small">List</span><select class="inp inp-compact" data-f="sllid">${sheetListIdSel(w, listIdRef, "Define lists under Content → Lists")}</select></label>
        <label class="block tight"><span class="muted small">Row</span><select class="inp inp-compact" data-f="sleid">${sheetListEntrySel(w, listIdRef, slr.entryId)}</select></label>
        ${sheetListRefRowHelp}
        <label class="block tight"><span class="muted small">Name on sheet (optional)</span><input class="inp inp-compact" type="text" data-f="slref-label" value="${esc(slr.displayName ?? "")}" placeholder="Override label" /></label>
        <label class="block tight"><span class="muted small">Note on sheet (optional)</span><input class="inp inp-compact" type="text" data-f="slref-desc" value="${esc(slr.displayDescription ?? "")}" placeholder="Override description" /></label>
      </div>
      <div class="eff-group" data-for="sheet_list_line">
        <label class="block tight"><span class="muted small">List</span><select class="inp inp-compact" data-f="slline-lid">${sheetListIdSel(w, listIdLine, "Add a list under Content → Lists first")}</select></label>
        <label class="block tight"><span class="muted small">Line text</span><input class="inp inp-compact" type="text" data-f="slline-text" value="${esc(sll.text ?? "")}" placeholder="Shown as one line under that list" /></label>
      </div>
      <div class="eff-group" data-for="trait">
        <label><span class="muted small">Text for term definitions</span><textarea class="inp inp-compact" data-f="trait" rows="2">${esc(tr.text)}</textarea></label>
      </div>
      <div class="eff-group" data-for="special">
        <label><span class="muted small">Special text</span><textarea class="inp inp-compact" data-f="special" rows="2">${esc(sp.text)}</textarea></label>
      </div>
      <div class="eff-group" data-for="sheet_text">
        <div class="form-grid-2">
          <label><span class="muted small">Section</span><select class="inp inp-compact" data-f="slot">${slotSel(w, st.slot)}</select></label>
          <label class="check"><input type="checkbox" data-f="append" ${st.append !== false ? " checked" : ""} /> Append</label>
        </div>
        <label><span class="muted small">Text</span><textarea class="inp inp-compact" data-f="stext" rows="2">${esc(st.text)}</textarea></label>
      </div>
      <div class="eff-group" data-for="roll_table">
        <div class="form-grid-2">
          <label><span class="muted small">Roll table</span><select class="inp inp-compact" data-f="tid">${`<option value="">—</option>${tableSel(w, rt.tableId)}`}</select></label>
          <label><span class="muted small">Log label (optional)</span><input class="inp inp-compact" type="text" data-f="tlabel" value="${esc(rt.label ?? "")}" /></label>
        </div>
        <div class="eff-inline-actions"><button type="button" class="secondary small-btn" data-inline-new="rolltable">+ New roll table</button></div>
      </div>
    </div>`;
}

export function renderEffectsEditor(w: RpgSystem, effects: Effect[] | undefined, scope: string): string {
  const list = effects?.length ? effects : [];
  const rows = list.map((e, i) => renderEffectRow(w, e, i, scope)).join("");
  return `
    <div class="effects-editor">
      <div class="effects-nest" data-scope="${esc(scope)}">${rows}</div>
      <button type="button" class="btn-add-eff secondary" data-add-eff="${esc(scope)}">+ Add effect</button>
    </div>`;
}

function trunc(s: string, n: number): string {
  const t = s.trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n - 1)}…`;
}

function oneLineEffectLabel(w: RpgSystem, e: Effect): string {
  switch (e.type) {
    case "stat_mod": {
      const s = w.stats.find((x) => x.id === e.statId);
      return `${s?.name ?? e.statId} ${e.amount >= 0 ? "+" : ""}${e.amount}`;
    }
    case "resource_mod": {
      const r = w.resources.find((x) => x.id === e.resourceId);
      return `${r?.name ?? e.resourceId} ${e.amount >= 0 ? "+" : ""}${e.amount}`;
    }
    case "sheet_list_ref": {
      const def = w.sheetLists[e.listId];
      const ent = resolveSheetListEntry(w, e.listId, e.entryId);
      const base =
        (ent?.values.name !== undefined && String(ent.values.name).trim()) ||
        (ent?.values.label !== undefined && String(ent.values.label).trim()) ||
        e.entryId;
      const sec = def?.sheetTitle?.trim() || e.listId;
      return (e.displayName?.trim() || base).trim()
        ? `${sec}: ${(e.displayName?.trim() || base).trim()}`
        : "Sheet list row";
    }
    case "sheet_list_line": {
      const sec = w.sheetLists[e.listId]?.sheetTitle?.trim() || e.listId;
      return `${sec}: ${trunc(e.text, 28)}`;
    }
    case "trait":
      return trunc(e.text, 36);
    case "special":
      return trunc(e.text, 36);
    case "sheet_text":
      return trunc(e.text, 36) || "Sheet text";
    case "roll_table": {
      const t = w.tables[e.tableId];
      return (e.label?.trim() || t?.name || e.tableId).trim() || "Roll table";
    }
  }
}

/** One-line preview for table cells (plain text). */
export function summarizeEffectsForTable(w: RpgSystem, effects: Effect[] | undefined): string {
  const list = effects?.length ? effects : [];
  if (list.length === 0) return "None";
  const parts = list.map((e) => oneLineEffectLabel(w, e));
  if (parts.length <= 2) return parts.join(" · ");
  return `${parts.slice(0, 2).join(" · ")} · +${parts.length - 2} more`;
}

/** Read effects from a hidden JSON stash field (used when the full editor lives in a modal). */
export function parseEffectsFromStash(raw: string | undefined | null): Effect[] {
  if (!raw?.trim()) return [];
  try {
    const j = JSON.parse(raw) as unknown;
    return Array.isArray(j) ? (j as Effect[]) : [];
  } catch {
    return [];
  }
}

function readNum(el: HTMLInputElement | null, fallback = 0): number {
  const n = Number(el?.value ?? fallback);
  return Number.isFinite(n) ? n : fallback;
}

/** Rebuild entry &lt;select&gt; options when list changes (modal / live editor). */
export function refreshSheetListEntrySelects(w: RpgSystem, root: ParentNode) {
  root.querySelectorAll(".effect-row").forEach((row) => {
    const type = (row.querySelector("select[data-eff-type]") as HTMLSelectElement | null)?.value;
    if (type !== "sheet_list_ref") return;
    const g = row.querySelector('.eff-group[data-for="sheet_list_ref"]');
    if (!g) return;
    const listId = (g.querySelector('[data-f="sllid"]') as HTMLSelectElement | null)?.value ?? "";
    const entSel = g.querySelector('[data-f="sleid"]') as HTMLSelectElement | null;
    if (!entSel) return;
    const prev = entSel.value;
    entSel.innerHTML = sheetListEntrySel(w, listId, prev);
    if (prev && [...entSel.options].some((o) => o.value === prev)) entSel.value = prev;
  });
}

export function parseEffectsFromNest(nest: Element | null | undefined): Effect[] {
  if (!nest) return [];
  const out: Effect[] = [];
  nest.querySelectorAll(":scope > .effect-row").forEach((row) => {
    const type = (row.querySelector("select[data-eff-type]") as HTMLSelectElement | null)?.value as Effect["type"] | "";
    if (!type) return;
    const g = row.querySelector(`.eff-group[data-for="${type}"]`);
    if (!g) return;
    switch (type) {
      case "stat_mod": {
        const statId = (g.querySelector('[data-f="stat"]') as HTMLSelectElement)?.value;
        if (!statId) return;
        out.push({ type: "stat_mod", statId, amount: readNum(g.querySelector('[data-f="amt"]') as HTMLInputElement) });
        break;
      }
      case "resource_mod": {
        const resourceId = (g.querySelector('[data-f="res"]') as HTMLSelectElement)?.value;
        if (!resourceId) return;
        out.push({
          type: "resource_mod",
          resourceId,
          amount: readNum(g.querySelector('[data-f="ramt"]') as HTMLInputElement),
        });
        break;
      }
      case "sheet_list_ref": {
        const listId = (g.querySelector('[data-f="sllid"]') as HTMLSelectElement)?.value.trim() ?? "";
        const entryId = (g.querySelector('[data-f="sleid"]') as HTMLSelectElement)?.value.trim() ?? "";
        if (!listId || !entryId) return;
        const displayName = (g.querySelector('[data-f="slref-label"]') as HTMLInputElement)?.value.trim();
        const displayDescription = (g.querySelector('[data-f="slref-desc"]') as HTMLInputElement)?.value.trim();
        out.push({
          type: "sheet_list_ref",
          listId,
          entryId,
          ...(displayName ? { displayName } : {}),
          ...(displayDescription ? { displayDescription } : {}),
        });
        break;
      }
      case "sheet_list_line": {
        const listId = (g.querySelector('[data-f="slline-lid"]') as HTMLSelectElement)?.value.trim() ?? "";
        const text = (g.querySelector('[data-f="slline-text"]') as HTMLInputElement)?.value.trim() ?? "";
        if (!listId || !text) return;
        out.push({ type: "sheet_list_line", listId, text });
        break;
      }
      case "trait": {
        const text = (g.querySelector('[data-f="trait"]') as HTMLTextAreaElement)?.value.trim() ?? "";
        if (!text) return;
        out.push({ type: "trait", text });
        break;
      }
      case "special": {
        const text = (g.querySelector('[data-f="special"]') as HTMLTextAreaElement)?.value.trim() ?? "";
        if (!text) return;
        out.push({ type: "special", text });
        break;
      }
      case "sheet_text": {
        const slot = (g.querySelector('[data-f="slot"]') as HTMLSelectElement)?.value as SheetSlot;
        const text = (g.querySelector('[data-f="stext"]') as HTMLTextAreaElement)?.value.trim() ?? "";
        if (!slot || !text) return;
        const append = (g.querySelector('[data-f="append"]') as HTMLInputElement | null)?.checked ?? true;
        out.push({ type: "sheet_text", slot, text, append });
        break;
      }
      case "roll_table": {
        const tableId = (g.querySelector('[data-f="tid"]') as HTMLSelectElement)?.value;
        if (!tableId) return;
        const label = (g.querySelector('[data-f="tlabel"]') as HTMLInputElement)?.value.trim();
        out.push({ type: "roll_table", tableId, ...(label ? { label } : {}) });
        break;
      }
      default:
        break;
    }
  });
  return out;
}

/** Update <code>dataset.effectType</code> when the type dropdown changes (for CSS visibility). */
export function bindEffectTypeVisibility(shell: HTMLElement | null) {
  shell?.addEventListener("change", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.matches("select[data-eff-type]")) {
      const row = t.closest(".effect-row") as HTMLElement | null;
      if (row) row.dataset.effectType = (t as HTMLSelectElement).value;
    }
  });
}
