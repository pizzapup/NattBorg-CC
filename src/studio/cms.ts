import { normalizeSystem } from "../migrate";
import {
  deleteSystem,
  exportSystemJson,
  flushSystemToCloud,
  getAllSystems,
  getSystem,
  isCloudMode,
  saveSystem,
} from "../storage";
import type {
  RpgSystem,
  StudioV2Component,
  StudioV2ComponentOption,
  StudioV2Config,
  StudioV2Effect,
  StudioV2GainMode,
  StudioV2Library,
  StudioV2LibraryEntry,
  StudioV2SheetTableSection,
  StudioV2Stat,
  StudioV2SubStat,
  StudioV2Table,
  StudioV2TableEntry,
  StudioV2TrackedValue,
  StudioV2TraitDefinition,
} from "../types";
import {
  evaluateDiceFormula,
  formatDicePoolExpr,
  listDicePools,
  parseDiceFormula,
  replaceDicePoolByIndex,
  validateDiceFormula,
} from "../engine/diceFormula";
import { applyStudioV2ToSystem, createDefaultStudioV2 } from "./v2";
import {
  deletePublishedGenerator,
  normalizePublishSlug,
  upsertPublishedGenerator,
} from "../cloud/publishedRepo";
import { supabaseConfigured } from "../lib/env";
import {
  appendProjectVersion,
  getNextRevisionNumber,
  listProjectVersionSummaries,
  projectVersionDisplayNote,
  restoreProjectVersion,
  revisionNumberTaken,
} from "../projectVersions";

export type StudioRoute = { kind: "main" };

/** In-app studio navigation (prefer full pages over modals). */
export type StudioViewState =
  | { kind: "home" }
  | { kind: "component"; index: number }
  | { kind: "option"; componentIndex: number; optionIndex: number };

export type StudioWireOpts = {
  getSelectedId: () => string | null;
  setSelectedId: (id: string | null) => void;
  getActiveTab: () => string;
  setActiveTab: (tab: string) => void;
  getStudioView: () => StudioViewState;
  setStudioView: (view: StudioViewState) => void;
  getDimFocus: () => string | null;
  setDimFocus: (groupId: string | null) => void;
  rerender: () => void;
  setError: (msg: string) => void;
  getUserId: () => string | null;
};

let working: RpgSystem | null = null;
let workingSourceId: string | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** After edits, flush cloud + update published link (replaces explicit Save). */
let cloudFlushPublishTimer: ReturnType<typeof setTimeout> | null = null;
const CLOUD_FLUSH_PUBLISH_DEBOUNCE_MS = 1200;

function buildGeneratorShareUrl(slugRaw: string, inviteKey: string | null | undefined): string {
  const slug = normalizePublishSlug(slugRaw);
  if (!slug) return "";
  const u = new URL(location.href);
  let path = u.pathname || "/";
  if (path !== "/" && path.endsWith("/")) path = path.slice(0, -1);
  const base = `${u.origin}${path}`;
  const hash = `#play/${slug}`;
  const key = inviteKey?.trim();
  if (key) {
    return `${base}?${new URLSearchParams({ k: key }).toString()}${hash}`;
  }
  return `${base}${hash}`;
}

function updatePublishShareUi(): void {
  const root = document.getElementById("v2-settings-root");
  if (!root) return;
  const usePassword = (document.getElementById("v2-publish-use-password") as HTMLInputElement | null)?.checked ?? false;
  const slugInput = document.getElementById("v2-publish-slug") as HTMLInputElement | null;
  const keyInput = document.getElementById("v2-publish-invite-key") as HTMLInputElement | null;
  const urlOut = document.getElementById("v2-share-url") as HTMLInputElement | null;
  const keyBlock = document.getElementById("v2-publish-key-block");
  if (keyBlock) keyBlock.hidden = !usePassword;
  const slugFromInput = slugInput?.value?.trim() ?? "";
  const nameFallback =
    (document.getElementById("v2-project-name") as HTMLInputElement | null)?.value?.trim() || "";
  const idFallback = root.dataset.currentProjectId?.trim() || "";
  const slugSource = slugFromInput || nameFallback || idFallback || "project";
  const slugNorm = normalizePublishSlug(slugSource);
  const keyVal = usePassword ? keyInput?.value?.trim() || "" : "";
  const url = slugNorm ? buildGeneratorShareUrl(slugNorm, usePassword ? keyVal || null : null) : "";
  if (urlOut) urlOut.value = url;
}

async function syncPublishedSnapshot(w: RpgSystem, userId: string | null): Promise<{ error?: string }> {
  if (!userId || !supabaseConfigured()) return {};
  const v2 = ensureStudioV2(w);
  const vis = v2.projectSettings.visibility;
  const slug = normalizePublishSlug(v2.projectSettings.publishSlug?.trim() || w.id);
  if (!slug) return { error: "Set a URL slug for publishing." };
  try {
    if (vis === "unpublished") {
      await deletePublishedGenerator(userId, slug);
      return {};
    }
    const pubVis = vis === "public" ? "public" : "invite";
    const explicit = vis === "private" ? v2.projectSettings.publishInviteKey?.trim() || undefined : undefined;
    const { inviteSecret } = await upsertPublishedGenerator({
      userId,
      sourceSystemKey: w.id,
      slug,
      payload: w,
      visibility: pubVis,
      inviteSecret: explicit,
    });
    if (vis === "private" && inviteSecret) {
      v2.projectSettings.publishInviteKey = inviteSecret;
    }
    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function renderStudioSidebar(activeTab: string): string {
  const link = (id: string, label: string) =>
    `<a href="#" class="studio-v2-nav__link${activeTab === id ? " is-active" : ""}" data-v2-tab="${id}">${label}</a>`;
  const div = `<div class="studio-v2-nav__divider" role="separator" aria-hidden="true"></div>`;
  return `
    <div class="studio-v2-nav__group" role="group" aria-label="Stats and generation">
      <span class="studio-v2-nav__grouplabel muted tiny">Stats &amp; values</span>
      ${link("v2_stats", "Stats")}
      ${link("v2_tracked", "Tracked values")}
      </div>
    <div class="studio-v2-nav__group" role="group" aria-label="Building blocks">
      <span class="studio-v2-nav__grouplabel muted tiny">Building blocks</span>
      ${link("blocks_components", "Components")}
      ${link("blocks_tables", "Tables")}
      </div>
    ${div}
    ${link("sheet", "Character sheet")}
    ${link("settings", "Project settings")}
    ${div}
    <a href="#generate" class="studio-v2-nav__link studio-v2-nav__link--external">Go to generator</a>
  `;
}

export function normalizeStudioView(w: RpgSystem, v: StudioViewState): StudioViewState {
  const v2 = w.studioV2;
  if (!v2) return { kind: "home" };
  if (v.kind === "component") {
    if (v.index < 0 || v.index >= v2.buildingBlocks.components.length) return { kind: "home" };
  }
  if (v.kind === "option") {
    const c = v2.buildingBlocks.components[v.componentIndex];
    if (!c || v.optionIndex < 0 || v.optionIndex >= c.options.length) return { kind: "home" };
  }
  return v;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function parentStatOptionsHtml(v2: StudioV2Config, selectedId: string): string {
  const opts = v2.trackedValues.stats.map(
    (s) =>
      `<option value="${escapeHtml(s.id)}"${s.id === selectedId ? " selected" : ""}>${escapeHtml(s.name)} (${escapeHtml(s.id)})</option>`,
  );
  return `<option value="">—</option>${opts.join("")}`;
}

function ensureStudioV2(w: RpgSystem): StudioV2Config {
  if (!w.studioV2) w.studioV2 = createDefaultStudioV2();
  const gm = w.studioV2.trackedValues.generationMethod as { kind?: string };
  if (gm.kind === "placeholder") {
    w.studioV2.trackedValues.generationMethod = { kind: "fixed_defaults" };
  }
  return w.studioV2;
}

/** Same math as <code>LEGACY_NATTBORG_LESSER_PIPELINE</code> (min 2d6 − min 2d4). */
const DEFAULT_LESSER_FORMULA = "2d6min-2d4min";

const DEFAULT_LESSER_SUMMARY =
  "Lesser of 2d4 subtracted from lesser of 2d6 (same as min of 2d6 minus min of 2d4).";

function normalizeDiceFormulaKey(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

function summarizeRandomDiceForDisplay(
  g: Extract<StudioV2Config["trackedValues"]["generationMethod"], { kind: "random_dice" }>,
): { formulaLine: string; repeatLine: string } {
  const raw = g.formula?.trim() ?? "";
  let formulaLine: string;
  if (raw) {
    formulaLine =
      normalizeDiceFormulaKey(raw) === normalizeDiceFormulaKey(DEFAULT_LESSER_FORMULA)
        ? DEFAULT_LESSER_SUMMARY
        : raw;
  } else {
    const preset = g.preset ?? "4d6_drop_lowest";
    if (preset === "4d6_drop_lowest") formulaLine = "4d6, drop lowest (sum of highest three dice).";
    else if (preset === "3d6") formulaLine = "Sum of 3d6.";
    else formulaLine = "2d6 + 6.";
  }
  const repeatLine = g.repeatPerStat ? "One roll per core stat." : "One roll shared by all core stats.";
  return { formulaLine, repeatLine };
}

function summarizeStandardArrayForDisplay(stats: StudioV2Stat[], values: number[]): string {
  if (!stats.length) return "Add core stats above to define the pool.";
  return stats.map((s, i) => `${s.name} ${values[i] ?? "—"}`).join(" · ");
}

function defaultGenerationForKind(method: string): StudioV2Config["trackedValues"]["generationMethod"] {
  switch (method) {
    case "standard_array":
      return { kind: "standard_array", values: [15, 14, 13, 12, 10, 8] };
    case "point_buy":
      return {
        kind: "point_buy",
        budget: 27,
        minScore: 8,
        maxScore: 15,
        autoMode: "random_valid",
      };
    case "random_dice":
      return { kind: "random_dice", repeatPerStat: true, formula: DEFAULT_LESSER_FORMULA };
    case "fixed_defaults":
    default:
      return { kind: "fixed_defaults" };
  }
}

function renderRandomDicePresetSelect(selected: string, id: string): string {
  const p = selected === "3d6" || selected === "2d6_plus_6" || selected === "4d6_drop_lowest" ? selected : "4d6_drop_lowest";
  return `<select id="${id}" class="inp" aria-label="Fallback preset when formula is empty">
    <option value="4d6_drop_lowest"${p === "4d6_drop_lowest" ? " selected" : ""}>4d6, drop lowest</option>
    <option value="3d6"${p === "3d6" ? " selected" : ""}>3d6</option>
    <option value="2d6_plus_6"${p === "2d6_plus_6" ? " selected" : ""}>2d6 + 6</option>
  </select>`;
}

function syncDicePoolPopoverModeUi(): void {
  const mode = (document.getElementById("v2-dice-pool-mode") as HTMLSelectElement | null)?.value ?? "sum";
  const wrap = document.getElementById("v2-dice-pool-k-wrap");
  if (wrap) wrap.hidden = mode !== "kh" && mode !== "kl";
}

function refreshDiceFormulaModalUi(): void {
  const ta = document.getElementById("v2-modal-dice-formula") as HTMLTextAreaElement | null;
  const status = document.getElementById("v2-modal-dice-formula-status");
  const chips = document.getElementById("v2-modal-dice-chips");
  if (!ta || !status || !chips) return;
  const parsed = parseDiceFormula(ta.value);
  if (!parsed.ok) {
    status.className = "v2-dice-formula-status v2-dice-formula-status--err";
    status.textContent = parsed.error;
    chips.innerHTML = "";
    return;
  }
  status.className = "v2-dice-formula-status v2-dice-formula-status--ok";
  status.textContent = "Formula parses. Click a pool to adjust how its dice combine.";
  const pools = listDicePools(parsed.ast);
  chips.innerHTML = pools
    .map((pool, i) => {
      const label = formatDicePoolExpr(pool.n, pool.sides, pool.agg, pool.keep);
      return `<button type="button" class="v2-dice-pool-chip" data-dice-pool-chip data-dice-pool-index="${i}">${escapeHtml(label)}</button>`;
    })
    .join("");
}

function positionDicePoolPopover(anchor: HTMLElement): void {
  const pop = document.getElementById("v2-dice-pool-popover") as HTMLElement | null;
  const modal = anchor.closest(".v2-dice-formula-modal") as HTMLElement | null;
  if (!pop || !modal) return;
  const ar = anchor.getBoundingClientRect();
  const mr = modal.getBoundingClientRect();
  const pad = 8;
  let left = ar.left - mr.left;
  let top = ar.bottom - mr.top + 6;
  pop.hidden = false;
  const pw = pop.offsetWidth || 280;
  const ph = pop.offsetHeight || 200;
  const maxRight = modal.clientWidth - pad;
  const maxBottom = modal.clientHeight - pad;
  if (left + pw > maxRight) left = Math.max(pad, maxRight - pw);
  if (top + ph > maxBottom) top = Math.max(pad, ar.top - mr.top - ph - 6);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function openDicePoolPopoverFromChip(chip: HTMLElement): void {
  const ta = document.getElementById("v2-modal-dice-formula") as HTMLTextAreaElement | null;
  const pop = document.getElementById("v2-dice-pool-popover") as HTMLElement | null;
  if (!ta || !pop) return;
  const idx = Number(chip.dataset.dicePoolIndex ?? -1);
  const parsed = parseDiceFormula(ta.value);
  if (!parsed.ok || !Number.isFinite(idx) || idx < 0) return;
  const pools = listDicePools(parsed.ast);
  const pool = pools[idx];
  if (!pool) return;

  pop.dataset.poolIndex = String(idx);
  const title = document.getElementById("v2-dice-pool-popover-title");
  if (title) title.textContent = `Pool: ${formatDicePoolExpr(pool.n, pool.sides, pool.agg, pool.keep)}`;

  const nEl = document.getElementById("v2-dice-pool-n") as HTMLInputElement | null;
  const sEl = document.getElementById("v2-dice-pool-sides") as HTMLInputElement | null;
  const modeEl = document.getElementById("v2-dice-pool-mode") as HTMLSelectElement | null;
  const kEl = document.getElementById("v2-dice-pool-k") as HTMLInputElement | null;
  if (nEl) nEl.value = String(pool.n);
  if (sEl) sEl.value = String(pool.sides);
  if (kEl) kEl.value = String(pool.keep?.k ?? Math.min(3, pool.n));

  let mode = "sum";
  if (pool.keep?.kind === "h") mode = "kh";
  else if (pool.keep?.kind === "l") mode = "kl";
  else if (pool.agg === "min") mode = "min";
  else if (pool.agg === "max") mode = "max";
  else if (pool.agg === "avg") mode = "avg";
  if (modeEl) modeEl.value = mode;

  syncDicePoolPopoverModeUi();
  positionDicePoolPopover(chip);
}

function applyDicePoolPopover(): void {
  const ta = document.getElementById("v2-modal-dice-formula") as HTMLTextAreaElement | null;
  const pop = document.getElementById("v2-dice-pool-popover") as HTMLElement | null;
  if (!ta || !pop) return;
  const idx = Number(pop.dataset.poolIndex ?? -1);
  const n = Math.floor(Number((document.getElementById("v2-dice-pool-n") as HTMLInputElement | null)?.value));
  const sides = Math.floor(Number((document.getElementById("v2-dice-pool-sides") as HTMLInputElement | null)?.value));
  const mode = (document.getElementById("v2-dice-pool-mode") as HTMLSelectElement | null)?.value ?? "sum";
  const k = Math.floor(Number((document.getElementById("v2-dice-pool-k") as HTMLInputElement | null)?.value));
  if (!Number.isFinite(n) || n < 1 || !Number.isFinite(sides) || sides < 2) return;

  let agg: "sum" | "min" | "max" | "avg" = "sum";
  let keep: { kind: "h" | "l"; k: number } | undefined;
  if (mode === "kh") {
    const kk = Number.isFinite(k) && k >= 1 ? Math.min(k, n) : 1;
    keep = { kind: "h", k: kk };
  } else if (mode === "kl") {
    const kk = Number.isFinite(k) && k >= 1 ? Math.min(k, n) : 1;
    keep = { kind: "l", k: kk };
  } else if (mode === "min") agg = "min";
  else if (mode === "max") agg = "max";
  else if (mode === "avg") agg = "avg";

  const next = replaceDicePoolByIndex(ta.value, idx, { n, sides, agg, keep });
  if (next === null) return;
  ta.value = next;
  pop.hidden = true;
  refreshDiceFormulaModalUi();
}

function renderDiceFormulaModalBody(formula: string, repeatPerStat: boolean, preset: string): string {
  return `<div class="v2-modal-form v2-dice-formula-modal">
 <label class="check"><input type="checkbox" id="v2-modal-dice-repeat"${repeatPerStat ? " checked" : ""} /> Roll once per core stat (unchecked = one result shared by all core stats)</label>
    <p class="muted small v2-dice-formula-syntax">Type dice like <code class="mono">4d6</code> or <code class="mono">(2d6min-2d4min)</code>. Combine with <code class="mono">+ − * /</code> and parentheses. After a pool, you can add <code class="mono">kh3</code> / <code class="mono">kl2</code> or <code class="mono">min</code> / <code class="mono">max</code> / <code class="mono">avg</code>—or click a pool chip below.</p>
    <label class="block"><span class="v2-dice-formula-label">Formula</span>
      <textarea id="v2-modal-dice-formula" class="inp mono v2-modal-dice-formula-ta" rows="5" spellcheck="false" placeholder="${escapeHtml(DEFAULT_LESSER_FORMULA)}">${escapeHtml(formula)}</textarea>
    </label>
    <p id="v2-modal-dice-formula-status" class="v2-dice-formula-status" role="status"></p>
    <div id="v2-modal-dice-chips" class="v2-dice-formula-chips" aria-label="Dice pools in this formula"></div>
    <div class="v2-dice-formula-preview-row">
      <button type="button" class="secondary small-btn" id="v2-modal-dice-preview-btn">Test roll</button>
    </div>
    <pre id="v2-modal-dice-preview-out" class="v2-dice-preview-out mono muted" hidden></pre>
    <details class="v2-advanced-block"><summary class="v2-advanced-summary muted small">Fallback when formula is empty</summary>
      <label class="block"><span>Preset pipeline</span>${renderRandomDicePresetSelect(preset, "v2-modal-dice-preset")}</label>
      <p class="muted small v2-gen-field-hint">If the formula field is empty, this preset is used instead.</p>
    </details>
    <div id="v2-dice-pool-popover" class="v2-dice-pool-popover" hidden>
      <div class="v2-dice-pool-popover__inner">
        <p class="v2-dice-pool-popover__title" id="v2-dice-pool-popover-title"></p>
        <div class="v2-dice-pool-popover__grid">
          <label class="block"><span class="muted small">Dice</span><input type="number" id="v2-dice-pool-n" class="inp inp-compact" min="1" max="999" /></label>
          <label class="block"><span class="muted small">Sides</span><input type="number" id="v2-dice-pool-sides" class="inp inp-compact" min="2" max="999" /></label>
        </div>
        <label class="block"><span class="muted small">Combine rolls as</span>
          <select id="v2-dice-pool-mode" class="inp">
            <option value="sum">Sum all (default)</option>
            <option value="kh">Keep highest K, sum those</option>
            <option value="kl">Keep lowest K, sum those</option>
            <option value="min">Minimum of the pool</option>
            <option value="max">Maximum of the pool</option>
            <option value="avg">Average (floor)</option>
          </select>
        </label>
        <label class="block" id="v2-dice-pool-k-wrap"><span class="muted small">K (how many dice)</span>
          <input type="number" id="v2-dice-pool-k" class="inp inp-compact" min="1" max="999" />
        </label>
        <div class="v2-dice-pool-popover__actions">
          <button type="button" class="small-btn" id="v2-dice-pool-apply">Apply</button>
          <button type="button" class="secondary small-btn" id="v2-dice-pool-popover-close">Close</button>
        </div>
      </div>
    </div>
  </div>`;
}

function openRandomDiceFormulaModal(w: RpgSystem): void {
  const v2 = ensureStudioV2(w);
  const g = v2.trackedValues.generationMethod;
  if (g.kind !== "random_dice") return;

  const formulaDom = (document.getElementById("v2-gen-rd-formula") as HTMLTextAreaElement | null)?.value ?? "";
  const repeatDom = (document.getElementById("v2-gen-rd-repeat") as HTMLInputElement | null)?.checked;
  const presetDom = (document.getElementById("v2-gen-rd-preset") as HTMLSelectElement | null)?.value;

  const formula = formulaDom.trim() || (g.formula?.trim() ?? "");
  const repeatPerStat = repeatDom !== undefined ? repeatDom : g.repeatPerStat;
  const preset =
    presetDom === "3d6" || presetDom === "2d6_plus_6" || presetDom === "4d6_drop_lowest"
      ? presetDom
      : (g.preset ?? "4d6_drop_lowest");

  openV2ModalLayer(
    "Edit dice formula",
    `<div class="v2-modal-scroll">${renderDiceFormulaModalBody(formula, repeatPerStat, preset)}</div>`,
    `<button type="button" class="secondary small-btn" data-v2-modal-close>Cancel</button> <button type="button" class="small-btn" id="v2-modal-save-dice-formula">Save</button>`,
  );
  requestAnimationFrame(() => {
    (document.getElementById("v2-modal-dice-formula") as HTMLTextAreaElement | null)?.focus();
    refreshDiceFormulaModalUi();
  });
}

const DEFAULT_POINT_BUY_COST_LINES = `8=0
9=1
10=2
11=3
12=4
13=5
14=7
15=9`;

function serializePointBuyCosts(costs?: Partial<Record<number, number>>): string {
  if (!costs || !Object.keys(costs).length) return DEFAULT_POINT_BUY_COST_LINES;
  return Object.keys(costs)
    .map(Number)
    .sort((a, b) => a - b)
    .map((score) => `${score}=${costs[score]}`)
    .join("\n");
}

function parsePointBuyCosts(raw: string): Partial<Record<number, number>> | undefined {
  const out: Partial<Record<number, number>> = {};
  for (const line of raw.split(/\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^(\d+)\s*[=:]\s*(-?\d+)/);
    if (m) out[Number(m[1])] = Number(m[2]);
  }
  return Object.keys(out).length ? out : undefined;
}

function derivePointBuyBounds(costs: Partial<Record<number, number>> | undefined): { minScore: number; maxScore: number } {
  const keys = costs ? Object.keys(costs).map(Number).filter((n) => Number.isFinite(n)) : [];
  if (!keys.length) return { minScore: 8, maxScore: 15 };
  return { minScore: Math.min(...keys), maxScore: Math.max(...keys) };
}

function renderGenerationParamsForm(
  g: StudioV2Config["trackedValues"]["generationMethod"],
  coreStats: StudioV2Stat[],
): string {
  const k = g.kind;
  let body = `<div class="v2-gen-editor" data-gen-editor data-gen-kind="${k}">`;
  switch (g.kind) {
    case "fixed_defaults":
      if (!coreStats.length) {
        body += `<p class="muted small v2-gen-field-hint">Add core stats above to set a fixed score for each.</p>`;
        break;
      }
      body += `<div class="v2-table-wrap v2-gen-fixed-wrap"><table class="v2-data-table v2-gen-fixed-table">
        <thead><tr><th>Stat</th><th>Score</th></tr></thead>
        <tbody>${coreStats
          .map(
            (stat, idx) =>
              `<tr><td>${escapeHtml(stat.name)}</td><td class="v2-td-num"><input type="number" class="inp inp-compact v2-gen-fixed-inp" data-v2-gen-fixed data-stat-index="${idx}" value="${stat.startValue}" /></td></tr>`,
          )
          .join("")}</tbody>
      </table></div>`;
      body += `<p class="muted small v2-gen-field-hint">Each score is that stat’s starting value and updates your project when you save.</p>`;
      break;
    case "standard_array": {
      const defaults = [15, 14, 13, 12, 10, 8];
      if (!coreStats.length) {
        body += `<p class="muted small v2-gen-field-hint">Add core stats above—each gets one value in the pool.</p>`;
        break;
      }
      const values = coreStats.map((_, i) => g.values[i] ?? defaults[i] ?? 10);
      const poolSummary = summarizeStandardArrayForDisplay(coreStats, values);
      body += `<div class="v2-gen-collapsible" data-v2-gen-sa-wrap>
        <div class="v2-gen-summary" data-v2-gen-sa-summary>
          <p class="v2-gen-readonly-text">${escapeHtml(poolSummary)}</p>
          <button type="button" class="secondary small-btn" data-v2-gen-sa-edit>Edit pool</button>
        </div>
        <div class="v2-gen-sa-editor" data-v2-gen-sa-editor hidden>
          <div class="v2-table-wrap"><table class="v2-data-table v2-gen-sa-edit-table">
            <thead><tr><th>Stat</th><th>Pool value</th></tr></thead>
            <tbody>${coreStats
              .map((stat, i) => {
                const v = values[i] ?? 10;
                return `<tr><td>${escapeHtml(stat.name)}</td><td class="v2-td-num"><input type="number" class="inp inp-compact" data-v2-gen-sa-slot value="${v}" /></td></tr>`;
              })
              .join("")}</tbody>
          </table></div>
          <p class="muted small v2-gen-field-hint">Values are shuffled onto core stats at generation (order here does not map to a specific stat).</p>
          <button type="button" class="small-btn" data-v2-gen-sa-done>Done</button>
        </div>
      </div>`;
      break;
    }
    case "point_buy": {
      body += `<label class="block"><span>Point budget</span><input id="v2-gen-pb-budget" type="number" class="inp" value="${g.budget}" /></label>`;
      body += `<label class="block"><span>Value → cost (one per line: <code class="mono">score=points</code>)</span><textarea id="v2-gen-pb-costs" class="inp mono" rows="8">${escapeHtml(serializePointBuyCosts(g.costs))}</textarea></label>`;
      body += `<p class="muted small v2-gen-field-hint">The generator picks a random set of scores that spends exactly the budget. Allowed scores are the numbers on the left side of each line; min and max follow from that list.</p>`;
      break;
    }
    case "random_dice": {
      const preset = g.preset ?? "4d6_drop_lowest";
      const formula = g.formula?.trim() ?? "";
      const { formulaLine, repeatLine } = summarizeRandomDiceForDisplay(g);
      body += `<div class="v2-gen-rd-block" data-v2-gen-rd-wrap>
        <div class="v2-gen-rd-sync" hidden aria-hidden="true">
          <input type="checkbox" id="v2-gen-rd-repeat"${g.repeatPerStat ? " checked" : ""} aria-label="Roll once per core stat" />
          <textarea id="v2-gen-rd-formula" class="inp mono" rows="1" placeholder="${escapeHtml(DEFAULT_LESSER_FORMULA)}">${escapeHtml(formula)}</textarea>
          ${renderRandomDicePresetSelect(preset, "v2-gen-rd-preset")}
        </div>
        <div class="v2-gen-summary v2-gen-summary--rd">
          <p class="v2-gen-readonly-text">${escapeHtml(formulaLine)}</p>
          <p class="muted small">${escapeHtml(repeatLine)}</p>
          <button type="button" class="secondary small-btn" data-v2-gen-rd-edit>Edit formula…</button>
        </div>
        <p class="muted small v2-gen-field-hint">Sub-stats are not rolled by this method.</p>
      </div>`;
      break;
    }
  }
  body += `</div>`;
  return body;
}

/** Read method parameters from an inline or modal <code>[data-gen-editor]</code> block. */
function readGenerationMethodFromEditor(ed: HTMLElement): StudioV2Config["trackedValues"]["generationMethod"] | null {
  const kind = ed.dataset.genKind ?? "fixed_defaults";
  switch (kind) {
    case "fixed_defaults":
      return { kind: "fixed_defaults" };
    case "standard_array": {
      const slots = document.querySelectorAll("[data-v2-gen-sa-wrap] input[data-v2-gen-sa-slot]");
      const values = [...slots].map((el) => Math.floor(Number((el as HTMLInputElement).value) || 0));
      if (!values.length) return { kind: "standard_array", values: [15, 14, 13, 12, 10, 8] };
      return { kind: "standard_array", values };
    }
    case "point_buy": {
      const budget = Number((document.getElementById("v2-gen-pb-budget") as HTMLInputElement | null)?.value ?? 27);
      const costsRaw = (document.getElementById("v2-gen-pb-costs") as HTMLTextAreaElement | null)?.value ?? "";
      const costs = parsePointBuyCosts(costsRaw);
      const { minScore, maxScore } = derivePointBuyBounds(costs);
      return {
        kind: "point_buy",
        budget: Number.isFinite(budget) ? budget : 27,
        minScore,
        maxScore,
        autoMode: "random_valid",
        ...(costs ? { costs } : {}),
      };
    }
    case "random_dice": {
      const repeatPerStat = (document.getElementById("v2-gen-rd-repeat") as HTMLInputElement | null)?.checked ?? false;
      const formulaRaw = (document.getElementById("v2-gen-rd-formula") as HTMLTextAreaElement | null)?.value.trim() ?? "";
      const presetRaw = (document.getElementById("v2-gen-rd-preset") as HTMLSelectElement | null)?.value ?? "4d6_drop_lowest";
      const preset =
        presetRaw === "3d6" || presetRaw === "2d6_plus_6" || presetRaw === "4d6_drop_lowest" ? presetRaw : "4d6_drop_lowest";
      if (formulaRaw) {
        return { kind: "random_dice", repeatPerStat, formula: formulaRaw };
      }
      return { kind: "random_dice", repeatPerStat, preset };
    }
    default:
      return { kind: "fixed_defaults" };
  }
}

function effectOptionsHtml(
  w: RpgSystem,
  sel: { statId?: string; resourceId?: string; libraryId?: string; tableId?: string } = {},
): { stats: string; resources: string; libraries: string; tables: string } {
  const v2 = ensureStudioV2(w);
  const stats = v2.trackedValues.stats
    .map((s) => `<option value="${escapeHtml(s.id)}"${s.id === sel.statId ? " selected" : ""}>${escapeHtml(s.name)}</option>`)
    .join("");
  const resources = [
    ...v2.trackedValues.stats.map(
      (s) =>
        `<option value="${escapeHtml(s.id)}"${s.id === sel.resourceId ? " selected" : ""}>${escapeHtml(s.name)} (stat)</option>`
    ),
    ...v2.trackedValues.otherValues.map(
      (o) => `<option value="${escapeHtml(o.id)}"${o.id === sel.resourceId ? " selected" : ""}>${escapeHtml(o.name)}</option>`
    ),
  ].join("");
  const libraries = v2.buildingBlocks.libraries
    .map(
      (l) => `<option value="${escapeHtml(l.id)}"${l.id === sel.libraryId ? " selected" : ""}>${escapeHtml(l.name)}</option>`,
    )
    .join("");
  const tables = v2.buildingBlocks.tables
    .map(
      (t) => `<option value="${escapeHtml(t.id)}"${t.id === sel.tableId ? " selected" : ""}>${escapeHtml(t.name)}</option>`,
    )
    .join("");
  return { stats, resources, libraries, tables };
}

function gainModeOptions(current: StudioV2GainMode): string {
  return `<option value="any_random"${current === "any_random" ? " selected" : ""}>Any entry</option>
    <option value="range_random"${current === "range_random" ? " selected" : ""}>Index range</option>
    <option value="specific"${current === "specific" ? " selected" : ""}>Specific entry</option>`;
}

function renderEffectCard(effect: StudioV2Effect, prefix: string, idx: number, w: RpgSystem): string {
  const sm = effect.type === "stat_mod" ? effect : { type: "stat_mod" as const, statId: "", amount: 0 };
  const rm = effect.type === "resource_mod" ? effect : { type: "resource_mod" as const, trackedValueId: "", amount: 0 };
  const gl =
    effect.type === "gain_from_library"
      ? effect
      : {
          type: "gain_from_library" as const,
          libraryId: "",
          mode: "any_random" as StudioV2GainMode,
        };
  const gt =
    effect.type === "gain_from_table"
      ? effect
      : { type: "gain_from_table" as const, tableId: "", mode: "any_random" as StudioV2GainMode };
  const { stats, resources, libraries, tables } = effectOptionsHtml(w, {
    statId: sm.statId,
    resourceId: rm.trackedValueId,
    libraryId: gl.libraryId,
    tableId: gt.tableId,
  });
  const ty = effect.type;
  const ph = (panel: string) => (ty !== panel ? " hidden" : "");

  const st = effect.type === "sheet_text" ? effect : { type: "sheet_text" as const, slot: "notes" as const, text: "" };

  const sheetKind = st.slot.startsWith("list:") ? "list" : st.slot;
  const listId = st.slot.startsWith("list:") ? st.slot.slice(5) : "";

  return `<details class="v2-effect-card" open data-effect-row="${prefix}" data-effect-index="${idx}">
    <summary class="v2-effect-summary">Effect</summary>
    <label class="block"><span>Kind</span>
      <select class="inp" data-effect-type>
        <option value="stat_mod"${ty === "stat_mod" ? " selected" : ""}>Adjust stat</option>
        <option value="resource_mod"${ty === "resource_mod" ? " selected" : ""}>Adjust tracked value</option>
        <option value="gain_from_library"${ty === "gain_from_library" ? " selected" : ""}>Gain from library</option>
        <option value="gain_from_table"${ty === "gain_from_table" ? " selected" : ""}>Gain from table</option>
        <option value="sheet_text"${ty === "sheet_text" ? " selected" : ""}>Sheet text</option>
      </select>
    </label>
    <div class="v2-effect-panel" data-effect-panel="stat_mod"${ph("stat_mod")}>
      <label class="block"><span>Stat</span><select class="inp" data-eff-stat-id><option value="">—</option>${stats}</select></label>
      <label class="block"><span>Amount</span><input type="number" class="inp" data-eff-amount step="any" value="${sm.amount}" /></label>
    </div>
    <div class="v2-effect-panel" data-effect-panel="resource_mod"${ph("resource_mod")}>
      <label class="block"><span>Value</span><select class="inp" data-eff-resource-id><option value="">—</option>${resources}</select></label>
      <label class="block"><span>Amount</span><input type="number" class="inp" data-eff-resource-amt step="any" value="${rm.amount}" /></label>
    </div>
    <div class="v2-effect-panel" data-effect-panel="gain_from_library"${ph("gain_from_library")}>
      <label class="block"><span>Library</span><select class="inp" data-eff-lib-id><option value="">—</option>${libraries}</select></label>
      <label class="block"><span>Pick</span><select class="inp" data-eff-lib-mode>${gainModeOptions(gl.mode)}</select></label>
      <div class="form-grid-2">
        <label class="block"><span>Min index</span><input type="number" class="inp" data-eff-lib-min value="${gl.minIndex ?? ""}" placeholder="optional" /></label>
        <label class="block"><span>Max index</span><input type="number" class="inp" data-eff-lib-max value="${gl.maxIndex ?? ""}" placeholder="optional" /></label>
    </div>
      <label class="block"><span>Entry id</span><input type="text" class="inp" data-eff-lib-entry value="${escapeHtml(gl.specificEntryId ?? "")}" placeholder="if specific" /></label>
    </div>
    <div class="v2-effect-panel" data-effect-panel="gain_from_table"${ph("gain_from_table")}>
      <label class="block"><span>Table</span><select class="inp" data-eff-tbl-id><option value="">—</option>${tables}</select></label>
      <label class="block"><span>Pick</span><select class="inp" data-eff-tbl-mode>${gainModeOptions(gt.mode)}</select></label>
      <div class="form-grid-2">
        <label class="block"><span>Min index</span><input type="number" class="inp" data-eff-tbl-min value="${gt.minIndex ?? ""}" placeholder="optional" /></label>
        <label class="block"><span>Max index</span><input type="number" class="inp" data-eff-tbl-max value="${gt.maxIndex ?? ""}" placeholder="optional" /></label>
      </div>
      <label class="block"><span>Entry id</span><input type="text" class="inp" data-eff-tbl-entry value="${escapeHtml(gt.specificEntryId ?? "")}" placeholder="if specific" /></label>
    </div>
    <div class="v2-effect-panel" data-effect-panel="sheet_text"${ph("sheet_text")}>
      <label class="block"><span>Area</span>
        <select class="inp" data-eff-sheet-area>
          <option value="description"${sheetKind === "description" ? " selected" : ""}>Description</option>
          <option value="traits"${sheetKind === "traits" ? " selected" : ""}>Traits</option>
          <option value="special"${sheetKind === "special" ? " selected" : ""}>Special</option>
          <option value="notes"${sheetKind === "notes" ? " selected" : ""}>Notes</option>
          <option value="list"${sheetKind === "list" ? " selected" : ""}>Custom list block</option>
        </select>
      </label>
      <label class="block"><span>List id</span><input type="text" class="inp" data-eff-list-id value="${escapeHtml(listId)}" placeholder="e.g. weapons" /></label>
      <label class="block"><span>Text</span><textarea class="inp" rows="3" data-eff-sheet-text>${escapeHtml(st.text)}</textarea></label>
    </div>
    <button type="button" class="danger small-btn" data-remove-effect>Remove</button>
  </details>`;
}

/** Keep effect detail panels in sync when the user changes the kind dropdown (static HTML only encodes initial type). */
function syncEffectPanelsForCard(card: Element): void {
  const sel = card.querySelector("[data-effect-type]") as HTMLSelectElement | null;
  if (!sel) return;
  const ty = sel.value;
  card.querySelectorAll("[data-effect-panel]").forEach((panel) => {
    if (panel.getAttribute("data-effect-panel") === ty) panel.removeAttribute("hidden");
    else panel.setAttribute("hidden", "");
  });
}

type ModalLayer = { title: string; body: string; foot?: string };
const v2ModalStack: ModalLayer[] = [];

function getV2ModalHost(): { host: HTMLElement; title: HTMLElement; body: HTMLElement; foot: HTMLElement } | null {
  const host = document.getElementById("v2-modal-host");
  const title = document.getElementById("v2-modal-title");
  const body = document.getElementById("v2-modal-body");
  const foot = document.getElementById("v2-modal-foot");
  if (!host || !title || !body || !foot) return null;
  return { host, title, body, foot };
}

function renderV2ModalFromStack(): void {
  const els = getV2ModalHost();
  if (!els) return;
  const layer = v2ModalStack[v2ModalStack.length - 1];
  if (!layer) {
    els.host.hidden = true;
    return;
  }
  els.title.textContent = layer.title;
  els.body.innerHTML = layer.body;
  els.foot.innerHTML = layer.foot ?? "";
  els.host.hidden = false;
  const back = document.getElementById("v2-modal-back");
  if (back) back.hidden = v2ModalStack.length < 2;
}

function openV2ModalLayer(title: string, body: string, foot?: string): void {
  v2ModalStack.length = 0;
  v2ModalStack.push({ title, body, foot });
  renderV2ModalFromStack();
}

function replaceV2ModalLayer(title: string, body: string, foot?: string): void {
  if (!v2ModalStack.length) v2ModalStack.push({ title, body, foot });
  else v2ModalStack[v2ModalStack.length - 1] = { title, body, foot };
  renderV2ModalFromStack();
}

function popV2ModalLayer(): void {
  v2ModalStack.pop();
  renderV2ModalFromStack();
}

function closeV2Modal(): void {
  v2ModalStack.length = 0;
  const els = getV2ModalHost();
  if (els) {
    els.host.hidden = true;
    els.body.innerHTML = "";
    els.foot.innerHTML = "";
  }
}

export function setStudioRoute(route: StudioRoute): void {
  void route;
}

export function getWorking(): RpgSystem {
  if (!working) throw new Error("Studio working copy not initialized");
  return working;
}

export function ensureWorking(selectedId: string | null): RpgSystem {
  const id = selectedId ?? getAllSystems()[0]?.id ?? null;
  if (!id) throw new Error("No systems available");
  if (!working || workingSourceId !== id) {
    const system = getSystem(id);
    if (!system) throw new Error(`Missing system ${id}`);
    working = normalizeSystem(structuredClone(system));
    ensureStudioV2(working);
    applyStudioV2ToSystem(working);
    workingSourceId = id;
  }
  return working;
}

function formatOptionSummary(opt: StudioV2ComponentOption, v2: StudioV2Config): string {
  const statNames = new Map(v2.trackedValues.stats.map((s) => [s.id, s.name]));
  const resNames = new Map(v2.trackedValues.otherValues.map((r) => [r.id, r.name]));
  const sparts: string[] = [];
  if (opt.statAdjustEnabled) {
    for (const [id, n] of Object.entries(opt.statAdjustments ?? {})) {
      if (Number(n) === 0) continue;
      sparts.push(`${statNames.get(id) ?? id}: ${Number(n) >= 0 ? "+" : ""}${n}`);
    }
  }
  if (opt.trackedAdjustEnabled) {
    for (const [id, n] of Object.entries(opt.trackedAdjustments ?? {})) {
      if (Number(n) === 0) continue;
      sparts.push(`${resNames.get(id) ?? id}: ${Number(n) >= 0 ? "+" : ""}${n}`);
    }
  }
  const traitN = (opt.traitRefs?.length ?? 0) + (opt.traitNew?.length ?? 0);
  const invN = opt.inventory?.length ?? 0;
  const bits = [
    sparts.length ? sparts.join(", ") : "",
    traitN ? `${traitN} trait${traitN === 1 ? "" : "s"}` : "",
    invN ? `${invN} table pick${invN === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return bits.join(" · ") || "—";
}

function inventoryTableOptionsHtml(v2: StudioV2Config, selectedId: string): string {
  const tables = v2.buildingBlocks.tables.filter((t) => t.category === "inventory" || t.category === "weapons");
  if (!tables.length) {
    return `<option value="">No inventory/weapons tables yet</option>`;
  }
  const inner = tables
    .map((t) => {
      const g = v2.buildingBlocks.tableGroups?.find((x) => x.id === t.tableGroupId);
      const gain = g?.gainLabel?.trim();
      const suffix = gain ? ` — gain: ${gain}` : g ? ` (${g.name})` : "";
      return `<option value="${escapeHtml(t.id)}"${t.id === selectedId ? " selected" : ""}>${escapeHtml(t.name)}${escapeHtml(
        suffix,
      )}</option>`;
    })
    .join("");
  return `<option value=""${!selectedId ? " selected" : ""}>— Table —</option>${inner}`;
}

function projectTableSelectHtml(v2: StudioV2Config, selectedId: string | undefined): string {
  const inner = v2.buildingBlocks.tables
    .map(
      (t) =>
        `<option value="${escapeHtml(t.id)}"${(selectedId ?? "") === t.id ? " selected" : ""}>${escapeHtml(t.name)}</option>`,
    )
    .join("");
  return `<option value="">— Choose table —</option>${inner}`;
}

function renderEmbeddedTablesEditor(v2: StudioV2Config, opt: StudioV2ComponentOption): string {
  const rows = (opt.embeddedTables ?? [])
    .map((emb, i) => {
      const modeOpts = `<option value="chargen_pick_only"${emb.sheetMode === "chargen_pick_only" ? " selected" : ""}>Chargen pick only</option><option value="sheet_reference"${emb.sheetMode === "sheet_reference" ? " selected" : ""}>Full table on sheet</option>`;
      const srcOpts = `<option value="project_table"${emb.source === "project_table" ? " selected" : ""}>Project table</option><option value="inline"${emb.source === "inline" ? " selected" : ""}>Inline (rows in JSON)</option>`;
      return `<tr data-emb-table-row data-emb-index="${i}">
      <td><input type="hidden" data-emb-id value="${escapeHtml(emb.id)}" /><input class="inp inp-compact" data-emb-name value="${escapeHtml(emb.name)}" placeholder="e.g. Animal companions" /></td>
      <td><select class="inp inp-compact" data-emb-mode>${modeOpts}</select></td>
      <td><select class="inp inp-compact" data-emb-source>${srcOpts}</select></td>
      <td><select class="inp inp-compact" data-emb-project-table>${projectTableSelectHtml(v2, emb.projectTableId)}</select></td>
      <td><button type="button" class="v2-icon-btn v2-icon-btn--danger" data-remove-emb-table>×</button></td>
  </tr>`;
    })
    .join("");
  return `<h4>Sub-tables</h4>
    <p class="muted small">Roll at creation only, or expose the full outcome list on the character sheet (reference). Use a project roll table or keep rows only in exported JSON (<code>inline</code>).</p>
    <div class="v2-table-wrap"><table class="v2-data-table v2-data-table--sheet">
      <thead><tr><th>Name</th><th>Sheet use</th><th>Source</th><th>Project table</th><th></th></tr></thead>
      <tbody id="v2-emb-tbody">${rows}</tbody>
    </table></div>
    <button type="button" class="secondary small-btn" id="v2-opt-add-emb">+ Sub-table</button>`;
}

function repopulateInventoryEntrySelect(row: HTMLElement, v2: StudioV2Config, selectedEntryId?: string): void {
  const selTable = row.querySelector("[data-inv-table]") as HTMLSelectElement | null;
  const selEntry = row.querySelector("[data-inv-entry]") as HTMLSelectElement | null;
  if (!selTable || !selEntry) return;
  const tid = selTable.value;
  const t = v2.buildingBlocks.tables.find((x) => x.id === tid);
  const pick = (row.querySelector("[data-inv-pick]") as HTMLSelectElement | null)?.value ?? "random";
  const lead =
    pick === "random"
      ? `<option value=""${!selectedEntryId ? " selected" : ""}>Random from table</option>`
      : `<option value=""${!selectedEntryId ? " selected" : ""}>— Choose row —</option>`;
  const rest =
    t?.entries
      .map(
        (e) =>
          `<option value="${escapeHtml(e.id)}"${e.id === selectedEntryId ? " selected" : ""}>${escapeHtml(e.label)}</option>`,
      )
      .join("") ?? "";
  selEntry.innerHTML = lead + rest;
}

function renderStatAdjustEditor(v2: StudioV2Config, opt: StudioV2ComponentOption): string {
  const en = Boolean(opt.statAdjustEnabled);
  const adj = opt.statAdjustments ?? {};
  const rows = v2.trackedValues.stats
    .map(
      (s) => `<tr><td>${escapeHtml(s.name)}</td><td><input type="number" class="inp inp-compact" data-opt-stat-val="${escapeHtml(
        s.id,
      )}" step="any" value="${adj[s.id] ?? 0}" /></td></tr>`,
    )
    .join("");
  return `<label class="check"><input type="checkbox" id="v2-opt-stat-enable"${en ? " checked" : ""} /> Adjust core stats</label>
    <div id="v2-opt-stat-panel"${en ? "" : " hidden"} class="v2-nested-panel">
      <table class="v2-data-table v2-data-table--sheet"><thead><tr><th>Stat</th><th>Δ</th></tr></thead><tbody>${rows}</tbody></table>
    </div>`;
}

function renderTrackedAdjustEditor(v2: StudioV2Config, opt: StudioV2ComponentOption): string {
  const en = Boolean(opt.trackedAdjustEnabled);
  const adj = opt.trackedAdjustments ?? {};
  const rows = v2.trackedValues.otherValues
    .map(
      (r) => `<tr><td>${escapeHtml(r.name)}</td><td><input type="number" class="inp inp-compact" data-opt-res-val="${escapeHtml(
        r.id,
      )}" step="any" value="${adj[r.id] ?? 0}" /></td></tr>`,
    )
    .join("");
  return `<label class="check"><input type="checkbox" id="v2-opt-tracked-enable"${en ? " checked" : ""} /> Adjust tracked values</label>
    <div id="v2-opt-tracked-panel"${en ? "" : " hidden"} class="v2-nested-panel">
      <table class="v2-data-table v2-data-table--sheet"><thead><tr><th>Value</th><th>Δ</th></tr></thead><tbody>${rows || `<tr><td colspan="2" class="muted small">No tracked values defined yet.</td></tr>`}</tbody></table>
    </div>`;
}

function renderTraitsEditor(v2: StudioV2Config, opt: StudioV2ComponentOption): string {
  const traitDefs = v2.buildingBlocks.traits ?? [];
  const refs = opt.traitRefs ?? [];
  const refChecks = traitDefs
      .map(
      (t) =>
        `<label class="check"><input type="checkbox" data-trait-ref="${escapeHtml(t.id)}"${refs.includes(t.id) ? " checked" : ""} /> ${escapeHtml(
          t.name,
        )}</label>`,
      )
      .join("");
  const news = (opt.traitNew ?? [])
    .map(
      (t, i) => `<div class="form-grid-2 v2-trait-new-row" data-trait-new-idx="${i}">
 <input type="text" class="inp" data-trait-new-name placeholder="Name" value="${escapeHtml(t.name)}" />
      <input type="text" class="inp" data-trait-new-desc placeholder="Description" value="${escapeHtml(t.description ?? "")}" />
    </div>`,
    )
    .join("");
  return `<h4>Traits</h4>
    <p class="muted small">Reuse project traits or add new lines (name + description).</p>
    <div class="v2-trait-refs">${refChecks || '<p class="muted small">No traits in project yet — add under Building Blocks.</p>'}</div>
    <div id="v2-trait-new-list">${news}</div>
    <button type="button" class="secondary small-btn" id="v2-opt-add-trait-new">+ New trait line</button>`;
}

function renderInventoryEditor(v2: StudioV2Config, opt: StudioV2ComponentOption): string {
  const rows = (opt.inventory ?? []).map((inv, i) => {
    const tblOpts = inventoryTableOptionsHtml(v2, inv.tableId);
    const t = v2.buildingBlocks.tables.find((x) => x.id === inv.tableId);
    const entryLead =
      inv.pick === "random"
        ? `<option value=""${!inv.entryId ? " selected" : ""}>Random from table</option>`
        : `<option value=""${!inv.entryId ? " selected" : ""}>— Choose row —</option>`;
    const entryOpts =
      entryLead +
      (t?.entries
        .map(
          (e) =>
            `<option value="${escapeHtml(e.id)}"${e.id === inv.entryId ? " selected" : ""}>${escapeHtml(e.label)}</option>`,
        )
        .join("") ?? "");
    return `<tr data-inv-row="${i}">
      <td><select class="inp inp-compact" data-inv-table>${tblOpts}</select></td>
      <td><select class="inp inp-compact" data-inv-pick><option value="random"${inv.pick === "random" ? " selected" : ""}>Random</option><option value="specific"${inv.pick === "specific" ? " selected" : ""}>Specific row</option></select></td>
      <td><select class="inp inp-compact" data-inv-entry>${entryOpts}</select></td>
      <td><input type="text" class="inp inp-compact mono" data-inv-only placeholder="Only rows (e.g. 1,3,5-8)" value="${escapeHtml(inv.onlyRaw ?? "")}" /></td>
      <td><input type="text" class="inp inp-compact mono" data-inv-exclude placeholder="Exclude rows" value="${escapeHtml(inv.excludeRaw ?? "")}" /></td>
      <td><button type="button" class="v2-icon-btn v2-icon-btn--danger" data-remove-inv-row>×</button></td>
  </tr>`;
  }).join("");
  return `<h4>Table picks (inventory / weapons)</h4>
    <p class="muted small">Tables must be tagged <strong>inventory</strong> or <strong>weapons</strong> in the Tables list.</p>
    <div class="v2-table-wrap"><table class="v2-data-table v2-data-table--sheet">
      <thead><tr><th>Table</th><th>Pick</th><th>Row</th><th>Only</th><th>Exclude</th><th></th></tr></thead>
      <tbody id="v2-inv-tbody">${rows}</tbody>
    </table></div>
    <button type="button" class="secondary small-btn" id="v2-opt-add-inv">+ Table pick</button>`;
}

function renderOptionDetailBody(cIdx: number, oIdx: number, component: StudioV2Component, opt: StudioV2ComponentOption, w: RpgSystem): string {
  const v2 = ensureStudioV2(w);
  return `<div data-modal-option data-component-index="${cIdx}" data-option-index="${oIdx}">
    <p class="v2-breadcrumb muted small">Components / ${escapeHtml(component.name)} / ${escapeHtml(opt.name)}</p>
    <label class="block"><span>Name</span><input type="text" class="inp" id="v2-opt-name" value="${escapeHtml(opt.name)}" /></label>
    <label class="block"><span>Description</span><textarea class="inp" id="v2-opt-desc" rows="3">${escapeHtml(opt.description ?? "")}</textarea></label>
    ${renderStatAdjustEditor(v2, opt)}
    ${renderTrackedAdjustEditor(v2, opt)}
    ${renderTraitsEditor(v2, opt)}
    ${renderInventoryEditor(v2, opt)}
    ${renderEmbeddedTablesEditor(v2, opt)}
  </div>`;
}

function renderComponentDetailBody(idx: number, component: StudioV2Component, w: RpgSystem): string {
  const v2 = ensureStudioV2(w);
  const optRows = component.options
    .map(
      (o, oIdx) => `<tr data-option-summary-row data-option-index="${oIdx}">
      <td>${escapeHtml(o.name)}</td>
      <td class="muted small">${escapeHtml(formatOptionSummary(o, v2))}</td>
      <td><button type="button" class="secondary small-btn" data-open-option="${oIdx}">Edit…</button></td>
      <td><button type="button" class="v2-icon-btn v2-icon-btn--danger" data-modal-remove-option="${oIdx}" title="Remove">×</button></td>
    </tr>`,
    )
    .join("");
  return `<div data-modal-component data-component-index="${idx}">
    <p class="v2-breadcrumb muted small">Components / ${escapeHtml(component.name)}</p>
    <label class="block"><span>Name</span><input type="text" class="inp" id="v2-comp-name" value="${escapeHtml(component.name)}" /></label>
    <label class="block"><span>Description</span><textarea class="inp" id="v2-comp-desc" rows="3">${escapeHtml(component.description ?? "")}</textarea></label>
    <h4>Instances</h4>
    <div class="v2-table-wrap"><table class="v2-data-table v2-data-table--sheet">
      <thead><tr><th>Name</th><th>Summary</th><th></th><th></th></tr></thead>
      <tbody>${optRows || `<tr><td colspan="4" class="v2-td-empty muted">No instances yet</td></tr>`}</tbody>
    </table></div>
    <button type="button" class="secondary small-btn" id="v2-comp-add-option">+ Instance</button>
  </div>`;
}

function readOptionDetailFromModal(prev: StudioV2ComponentOption): StudioV2ComponentOption {
  const name = (document.getElementById("v2-opt-name") as HTMLInputElement | null)?.value.trim() ?? "";
  const desc = (document.getElementById("v2-opt-desc") as HTMLTextAreaElement | null)?.value.trim() ?? "";
  const statEn = (document.getElementById("v2-opt-stat-enable") as HTMLInputElement | null)?.checked ?? false;
  const trackedEn = (document.getElementById("v2-opt-tracked-enable") as HTMLInputElement | null)?.checked ?? false;
  const statAdjustments: Record<string, number> = {};
  document.querySelectorAll("[data-opt-stat-val]").forEach((el) => {
    const sid = (el as HTMLElement).dataset.optStatVal ?? "";
    if (!sid) return;
    statAdjustments[sid] = Number((el as HTMLInputElement).value ?? 0) || 0;
  });
  const trackedAdjustments: Record<string, number> = {};
  document.querySelectorAll("[data-opt-res-val]").forEach((el) => {
    const rid = (el as HTMLElement).dataset.optResVal ?? "";
    if (!rid) return;
    trackedAdjustments[rid] = Number((el as HTMLInputElement).value ?? 0) || 0;
  });
  const traitRefs: string[] = [];
  document.querySelectorAll("[data-trait-ref]").forEach((el) => {
    const id = (el as HTMLInputElement).dataset.traitRef ?? "";
    if (!id) return;
    if ((el as HTMLInputElement).checked) traitRefs.push(id);
  });
  const traitNew: { name: string; description?: string }[] = [];
  document.querySelectorAll(".v2-trait-new-row").forEach((row) => {
    const n = (row.querySelector("[data-trait-new-name]") as HTMLInputElement | null)?.value.trim() ?? "";
    if (!n) return;
    const d = (row.querySelector("[data-trait-new-desc]") as HTMLInputElement | null)?.value.trim() || undefined;
    traitNew.push({ name: n, description: d });
  });
  const inventory: StudioV2ComponentOption["inventory"] = [];
  document.querySelectorAll("#v2-inv-tbody tr[data-inv-row]").forEach((row) => {
    const tableId = (row.querySelector("[data-inv-table]") as HTMLSelectElement | null)?.value ?? "";
    if (!tableId.trim()) return;
    const pick = ((row.querySelector("[data-inv-pick]") as HTMLSelectElement | null)?.value ?? "random") as "random" | "specific";
    const entryRaw = (row.querySelector("[data-inv-entry]") as HTMLSelectElement | null)?.value.trim() || "";
    const entryId = pick === "specific" && entryRaw ? entryRaw : undefined;
    const onlyRaw = (row.querySelector("[data-inv-only]") as HTMLInputElement | null)?.value.trim() || undefined;
    const excludeRaw = (row.querySelector("[data-inv-exclude]") as HTMLInputElement | null)?.value.trim() || undefined;
    inventory.push({ tableId, pick, entryId, onlyRaw, excludeRaw });
  });
  const embeddedTables: NonNullable<StudioV2ComponentOption["embeddedTables"]> = [];
  document.querySelectorAll("#v2-emb-tbody tr[data-emb-table-row]").forEach((row) => {
    const nameEmb = (row.querySelector("[data-emb-name]") as HTMLInputElement | null)?.value.trim() ?? "";
    if (!nameEmb) return;
    const i = Number((row as HTMLElement).dataset.embIndex ?? -1);
    const prevE = i >= 0 ? prev.embeddedTables?.[i] : undefined;
    const idEmb =
      (row.querySelector("[data-emb-id]") as HTMLInputElement | null)?.value.trim() ||
      prevE?.id ||
      nameEmb.toLowerCase().replace(/\s+/g, "_");
    const modeRaw = (row.querySelector("[data-emb-mode]") as HTMLSelectElement | null)?.value;
    const sheetMode = modeRaw === "sheet_reference" ? "sheet_reference" : "chargen_pick_only";
    const source =
      (row.querySelector("[data-emb-source]") as HTMLSelectElement | null)?.value === "inline" ? "inline" : "project_table";
    const projectTableId =
      (row.querySelector("[data-emb-project-table]") as HTMLSelectElement | null)?.value.trim() || undefined;
    embeddedTables.push({
      id: idEmb,
      name: nameEmb,
      description: prevE?.description,
      sheetMode,
      source,
      projectTableId: source === "project_table" ? projectTableId : undefined,
      inlineEntries: source === "inline" ? prevE?.inlineEntries : undefined,
    });
  });
  return {
    ...prev,
    id: prev.id || name.toLowerCase().replace(/\s+/g, "_") || `option_${Date.now()}`,
    name: name || prev.name,
    description: desc || undefined,
    statAdjustEnabled: statEn,
    statAdjustments,
    trackedAdjustEnabled: trackedEn,
    trackedAdjustments,
    traitRefs,
    traitNew,
    inventory,
    embeddedTables: embeddedTables.length ? embeddedTables : undefined,
  };
}

function renderLibraryEntry(entry: StudioV2LibraryEntry, lIdx: number, eIdx: number): string {
  return `<tr data-library-entry-row data-library-index="${lIdx}" data-entry-index="${eIdx}">
    <td><input class="inp inp-compact" data-library-entry-name value="${escapeHtml(entry.name)}" placeholder="Name" /></td>
    <td><input class="inp inp-compact" data-library-entry-description value="${escapeHtml(entry.description ?? "")}" placeholder="Description" /></td>
    <td><button type="button" class="v2-icon-btn v2-icon-btn--danger" data-remove-library-entry>×</button></td>
  </tr>`;
}

function libraryCategoryOptions(sel: string): string {
  const o = (v: string, lab: string) => `<option value="${v}"${sel === v ? " selected" : ""}>${lab}</option>`;
  return `${o("general", "General")}${o("inventory", "Inventory")}${o("weapons", "Weapons")}`;
}

function tableGroupOptionsHtml(v2: StudioV2Config, selectedId: string | undefined): string {
  const groups = v2.buildingBlocks.tableGroups ?? [];
  const opts = groups.map(
    (g) =>
      `<option value="${escapeHtml(g.id)}"${(selectedId ?? "") === g.id ? " selected" : ""}>${escapeHtml(g.name)}</option>`,
  );
  return `<option value="">— Table group —</option>${opts.join("")}`;
}

function renderLibraryCard(library: StudioV2Library, idx: number, compact: boolean | undefined, v2: StudioV2Config): string {
  const entries = library.entries.map((entry, eIdx) => renderLibraryEntry(entry, idx, eIdx)).join("");
  const cat = library.category ?? "general";
  return `<section class="v2-card" data-library-row data-library-index="${idx}">
    <div class="v2-card__head">
      <h4>${escapeHtml(library.name || `List ${idx + 1}`)}</h4>
      ${compact ? "" : `<button type="button" class="danger small-btn" data-remove-library>Remove</button>`}
        </div>
    <input type="hidden" data-library-id value="${escapeHtml(library.id)}" />
    <label class="block"><span>List name</span><input class="inp" data-library-name type="text" value="${escapeHtml(library.name)}" /></label>
    <label class="block"><span>Table group</span><select class="inp" data-library-group>${tableGroupOptionsHtml(v2, library.tableGroupId)}</select></label>
    <label class="block"><span>Category</span><select class="inp" data-library-category>${libraryCategoryOptions(cat)}</select></label>
    <label class="block"><span>Description</span><textarea class="inp" rows="2" data-library-description>${escapeHtml(
      library.description ?? ""
    )}</textarea></label>
    <div class="v2-table-wrap"><table class="v2-data-table v2-data-table--sheet">
      <thead><tr><th>Name</th><th>Description</th><th></th></tr></thead>
      <tbody>${entries || ""}</tbody>
    </table></div>
    <button type="button" class="secondary small-btn" data-add-library-entry>Add row</button>
      </section>`;
}

function renderTableEntry(entry: StudioV2TableEntry, tIdx: number, eIdx: number): string {
  return `<tr data-table-entry-row data-table-index="${tIdx}" data-entry-index="${eIdx}">
    <td><input class="inp inp-compact" data-table-entry-label value="${escapeHtml(entry.label)}" placeholder="Label" /></td>
    <td><input type="number" class="inp inp-compact" data-table-entry-weight value="${entry.weight ?? 1}" min="0" step="any" /></td>
    <td><input class="inp inp-compact" data-table-entry-description value="${escapeHtml(entry.description ?? "")}" placeholder="Description" /></td>
    <td><button type="button" class="v2-icon-btn v2-icon-btn--danger" data-remove-table-entry>×</button></td>
  </tr>`;
}

function renderTableCard(table: StudioV2Table, idx: number, compact: boolean | undefined, v2: StudioV2Config): string {
  const entries = table.entries.map((entry, eIdx) => renderTableEntry(entry, idx, eIdx)).join("");
  const cat = table.category ?? "general";
  return `<section class="v2-card" data-table-row data-table-index="${idx}">
    <div class="v2-card__head">
      <h4>${escapeHtml(table.name || `Roll table ${idx + 1}`)}</h4>
      ${compact ? "" : `<button type="button" class="danger small-btn" data-remove-table>Remove</button>`}
    </div>
    <input type="hidden" data-table-id value="${escapeHtml(table.id)}" />
    <label class="block"><span>Table name</span><input class="inp" data-table-name type="text" value="${escapeHtml(table.name)}" /></label>
    <label class="block"><span>Table group</span><select class="inp" data-table-group>${tableGroupOptionsHtml(v2, table.tableGroupId)}</select></label>
    <label class="block"><span>Category</span><select class="inp" data-table-category>${libraryCategoryOptions(cat)}</select></label>
    <label class="block"><span>Description</span><textarea class="inp" rows="2" data-table-description>${escapeHtml(
      table.description ?? ""
    )}</textarea></label>
    <div class="v2-table-wrap"><table class="v2-data-table v2-data-table--sheet">
      <thead><tr><th>Outcome</th><th>Weight</th><th>Description</th><th></th></tr></thead>
      <tbody>${entries || ""}</tbody>
    </table></div>
    <button type="button" class="secondary small-btn" data-add-table-entry>Add row</button>
  </section>`;
}

function statHiddenSync(stat: StudioV2Config["trackedValues"]["stats"][number]): string {
  return `<span class="v2-hidden-sync" aria-hidden="true">
    <input type="hidden" data-stat-start value="${stat.startValue}" />
    <input type="hidden" data-stat-abbr value="${escapeHtml(stat.abbreviation ?? "")}" />
    <textarea data-stat-description hidden>${escapeHtml(stat.description ?? "")}</textarea>
    <input type="checkbox" data-stat-prof${stat.usesProficiency ? " checked" : ""} hidden />
  </span>`;
}

function subStatHiddenSync(sub: StudioV2SubStat): string {
  return `<span class="v2-hidden-sync" aria-hidden="true">
    <input type="checkbox" data-sub-prof${sub.proficiencyEnabled ? " checked" : ""} hidden />
    <textarea data-sub-description hidden>${escapeHtml(sub.description ?? "")}</textarea>
  </span>`;
}

function otherHiddenSync(value: StudioV2TrackedValue): string {
  return `<span class="v2-hidden-sync" aria-hidden="true">
    <input type="hidden" data-other-abbr value="${escapeHtml(value.abbreviation ?? "")}" />
    <textarea data-other-description hidden>${escapeHtml(value.description ?? "")}</textarea>
  </span>`;
}

const GEN_METHOD_CHOICES: { kind: string; title: string; description: string }[] = [
  {
    kind: "fixed_defaults",
    title: "Fixed scores",
    description: "Set each core stat’s score directly in the table below.",
  },
  {
    kind: "standard_array",
    title: "Stat pool (array)",
    description: "One number per stat; at generation they are shuffled and assigned randomly.",
  },
  {
    kind: "point_buy",
    title: "Point buy",
    description: "A shared budget and a cost per score; the tool picks a random legal set.",
  },
  {
    kind: "random_dice",
    title: "Random roll",
    description: "A dice formula (or fallback preset) produces each core stat’s score.",
  },
];

/** Generation + sheet display for core stats (embedded on the Stats page). */
function renderStatsGenerationSection(v2: StudioV2Config): string {
  const generation = v2.trackedValues.generationMethod;
  const nCore = v2.trackedValues.stats.length;
  const nSub = v2.trackedValues.subStats.length;
  const methodsRows = GEN_METHOD_CHOICES.map((c) => {
    const on = generation.kind === c.kind;
    return `<label class="v2-gen-method-option${on ? " is-selected" : ""}">
      <span class="v2-gen-method-option__row">
        <input type="radio" name="v2-gen-method" value="${escapeHtml(c.kind)}"${on ? " checked" : ""} />
        <span class="v2-gen-method-option__title">${escapeHtml(c.title)}</span>
      </span>
      <span class="v2-gen-method-option__desc muted tiny">${escapeHtml(c.description)}</span>
    </label>`;
  }).join("");
  const u = v2.trackedValues.statUsage;
  return `<div id="v2-stats-generation-root" class="v2-stats-generation-root">
    <div class="v2-stat-rules-grid">
      <section class="v2-card v2-stat-rules-card v2-stat-rules-card--subtle" aria-labelledby="v2-stat-rules-gen-title">
        <div class="v2-card__head">
          <h4 id="v2-stat-rules-gen-title">Generation Method</h4>
        </div>
        <p class="muted small v2-stat-rules-lede">One method for your <strong>core stats</strong> (table above). Sub-stats are separate unless dimensions change them.</p>
        <p class="muted small v2-gen-scope-hint"><strong>${nCore}</strong> core row(s)${nSub ? ` · <strong>${nSub}</strong> sub-stat / skill row(s)` : ""}.</p>
        <fieldset class="v2-gen-method-fieldset">
          <legend class="v2-gen-method-legend">Generation method</legend>
          <div class="v2-gen-method-stack" role="radiogroup" aria-label="Stat generation method">${methodsRows}</div>
        </fieldset>
        <div id="v2-generation-params-wrap" class="v2-generation-params-wrap">
          <h5 class="v2-gen-params-title muted tiny">Options for this method</h5>
          ${renderGenerationParamsForm(generation, v2.trackedValues.stats)}
        </div>
      </section>
      <section class="v2-card v2-stat-rules-card v2-stat-rules-card--subtle" aria-labelledby="v2-stat-rules-usage-title">
        <div class="v2-card__head">
          <h4 id="v2-stat-rules-usage-title">Scores on the character sheet</h4>
        </div>
        <fieldset class="v2-stat-usage-fieldset">
          <legend class="v2-stat-usage-legend">What players see for each core stat</legend>
          <label class="v2-radio-stack">
            <span class="v2-radio-stack__row">
              <input type="radio" name="v2-stat-usage" value="modifier_only"${u === "modifier_only" ? " checked" : ""} />
              <span class="v2-radio-stack__title">Modifier only</span>
            </span>
            <span class="muted tiny v2-radio-stack__desc">Show +/− bonuses (e.g. +2). Hide the raw score if you do not use it at the table.</span>
          </label>
          <label class="v2-radio-stack">
            <span class="v2-radio-stack__row">
              <input type="radio" name="v2-stat-usage" value="score_only"${u === "score_only" ? " checked" : ""} />
              <span class="v2-radio-stack__title">Score only</span>
            </span>
            <span class="muted tiny v2-radio-stack__desc">Show the number rolled or bought (e.g. 14). Hide the derived modifier on the main line.</span>
          </label>
          <label class="v2-radio-stack">
            <span class="v2-radio-stack__row">
              <input type="radio" name="v2-stat-usage" value="score_and_modifier"${u === "score_and_modifier" ? " checked" : ""} />
              <span class="v2-radio-stack__title">Both</span>
            </span>
            <span class="muted tiny v2-radio-stack__desc">Show the score and the modifier together (typical “stat block” feel).</span>
          </label>
        </fieldset>
      </section>
    </div>
  </div>`;
}

function commitTableRowInputsToDisplay(tr: HTMLTableRowElement): void {
  tr.querySelectorAll(".v2-cell").forEach((cell) => {
    const disp = cell.querySelector(".v2-cell-display:not(.v2-cell-display--check)") as HTMLElement | null;
    const dispCheck = cell.querySelector(".v2-cell-display--check");
    const check = cell.querySelector("input.v2-cell-input--toggle") as HTMLInputElement | null;
    const inp = cell.querySelector("input.v2-cell-input:not(.v2-cell-input--toggle)") as HTMLInputElement | null;
    if (disp && inp) disp.textContent = inp.value;
    if (dispCheck && check) dispCheck.textContent = check.checked ? "\u2713" : "\u2013";
  });
}

function renderComponentPageView(w: RpgSystem, idx: number): string {
  const v2 = ensureStudioV2(w);
  const c = v2.buildingBlocks.components[idx];
  if (!c) return "";
  return `<section class="v2-section v2-studio-page" id="v2-component-page">
    <nav class="v2-page-nav"><button type="button" class="secondary small-btn" data-studio-nav-home>← All components</button></nav>
    ${renderComponentDetailBody(idx, c, w)}
    <div class="v2-page-actions">
      <button type="button" class="secondary small-btn" data-studio-nav-home>Cancel</button>
      <button type="button" class="small-btn" id="v2-page-save-component">Save</button>
    </div>
  </section>`;
}

function renderOptionPageView(w: RpgSystem, cIdx: number, oIdx: number): string {
  const v2 = ensureStudioV2(w);
  const c = v2.buildingBlocks.components[cIdx];
  const o = c?.options[oIdx];
  if (!c || !o) return "";
  return `<section class="v2-section v2-studio-page" id="v2-option-page">
    <nav class="v2-page-nav">
      <button type="button" class="secondary small-btn" data-studio-nav-home>← All components</button>
      <button type="button" class="secondary small-btn" data-studio-view-component="${cIdx}">← ${escapeHtml(c.name)}</button>
    </nav>
    ${renderOptionDetailBody(cIdx, oIdx, c, o, w)}
    <div class="v2-page-actions">
      <button type="button" class="secondary small-btn" data-studio-view-component="${cIdx}">Back</button>
      <button type="button" class="small-btn" id="v2-page-save-option">Save</button>
    </div>
  </section>`;
}

function formatDiscreetTs(iso: string | undefined): string {
  if (!iso?.trim()) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return "—";
  }
}

function renderRevisionsModalBody(projectId: string, currentRev: number | undefined): string {
  const rows = listProjectVersionSummaries(projectId);
  if (!rows.length) {
    return `<p class="muted small">No snapshots yet. Open <strong>Project file</strong> → <strong>Save as version…</strong>.</p>`;
  }
  return `<ul class="v2-rev-list">
    ${rows
      .map((v) => {
        const note = projectVersionDisplayNote(v);
        const isCurrent = currentRev != null && v.revision === currentRev;
        return `<li class="v2-rev-list__item">
          <div class="v2-rev-list__head">
            <span><strong>Rev ${v.revision}</strong>${isCurrent ? ' <span class="muted tiny">· current</span>' : ""}</span>
            <span class="muted tiny">${escapeHtml(formatDiscreetTs(v.savedAt))}</span>
          </div>
          ${note ? `<p class="muted small v2-rev-list__note">${escapeHtml(note)}</p>` : ""}
          <button type="button" class="secondary small-btn" data-v2-switch-revision="${escapeHtml(v.id)}" data-v2-revision-num="${v.revision}"${
            isCurrent ? " disabled" : ""
          }>Open this revision</button>
        </li>`;
      })
      .join("")}
  </ul>`;
}

function openProjectRevisionsModal(opts: StudioWireOpts): void {
  const w = ensureWorking(opts.getSelectedId());
  const currentRev = w.projectMeta?.activeRevision;
  openV2ModalLayer(
    "Revisions",
    `<p class="muted small">Each snapshot stores rules and sheet layout for this project. Opening one replaces the editor; your latest edits keep saving in the background.</p>
    ${renderRevisionsModalBody(w.id, currentRev)}`,
    `<button type="button" class="secondary small-btn" data-v2-modal-close>Close</button>`,
  );
}

function renderProjectOverviewForm(w: RpgSystem): string {
  const v2 = ensureStudioV2(w);
  return `<div class="v2-settings-overview-form" id="v2-project-overview">
      <label class="block"><span>Project name</span>
        <input type="text" id="v2-project-name" class="inp" value="${escapeHtml(w.name)}" autocomplete="off" />
      </label>
      <label class="block"><span>Description</span>
        <textarea id="v2-overview-description" class="inp" rows="4">${escapeHtml(v2.projectOverview.description)}</textarea>
      </label>
      <div class="form-grid-2">
        <label class="block"><span>Creator</span>
          <input type="text" id="v2-overview-creator" class="inp" value="${escapeHtml(v2.projectOverview.creatorName)}" autocomplete="name" />
        </label>
        <label class="block"><span>Contact</span>
          <input type="text" id="v2-overview-contact" class="inp" value="${escapeHtml(v2.projectOverview.creatorContact)}" autocomplete="off" />
        </label>
      </div>
      <label class="block"><span>Tags</span>
        <input type="text" id="v2-overview-tags" class="inp" value="${escapeHtml(v2.projectOverview.tags.join(", "))}" placeholder="e.g. fantasy, sci-fi" autocomplete="off" />
      </label>
    </div>`;
}

function renderStudioPanel(activeTab: string, w: RpgSystem, view: StudioViewState, localStudioHint?: boolean): string {
  const v2 = ensureStudioV2(w);
  if (activeTab === "v2_stats") {
    const statsRows = v2.trackedValues.stats
      .map(
        (stat, idx) => `<tr data-stat-row data-stat-index="${idx}">
        <td><div class="v2-cell">
          <span class="v2-cell-display v2-cell-display--primary">${escapeHtml(stat.name)}</span>
          <input type="text" class="v2-cell-input" data-stat-name value="${escapeHtml(stat.name)}" />
        </div></td>
        <td><div class="v2-cell">
          <span class="v2-cell-display v2-cell-display--mono">${escapeHtml(stat.id)}</span>
          <input type="text" class="v2-cell-input v2-cell-mono" data-stat-id value="${escapeHtml(stat.id)}" />
        </div></td>
        <td class="v2-td-center"><span class="v2-pip${stat.usesProficiency ? " v2-pip--on" : ""}" title="Uses proficiency (edit in details)">●</span></td>
        <td class="v2-td-actions">
          ${statHiddenSync(stat)}
          <button type="button" class="v2-icon-btn v2-icon-btn--row" data-stat-edit title="Edit">\u270E</button>
          <button type="button" class="v2-icon-btn v2-icon-btn--row v2-icon-btn--danger" data-remove-stat title="Remove">×</button>
    </td>
      </tr>`
      )
      .join("");
    const subRows = v2.trackedValues.subStats
      .map(
        (sub, idx) => `<tr data-substat-row data-substat-index="${idx}">
        <td><div class="v2-cell">
          <span class="v2-cell-display v2-cell-display--primary">${escapeHtml(sub.name)}</span>
          <input type="text" class="v2-cell-input" data-sub-name value="${escapeHtml(sub.name)}" />
        </div></td>
        <td><div class="v2-cell">
          <span class="v2-cell-display v2-cell-display--mono">${escapeHtml(sub.id)}</span>
          <input type="text" class="v2-cell-input v2-cell-mono" data-sub-id value="${escapeHtml(sub.id)}" />
        </div></td>
        <td><div class="v2-cell">
          <span class="v2-cell-display v2-cell-display--mono">${escapeHtml(sub.parentStatId)}</span>
          <input type="text" class="v2-cell-input v2-cell-mono" data-sub-parent value="${escapeHtml(sub.parentStatId)}" />
        </div></td>
        <td class="v2-td-center"><span class="v2-pip${sub.proficiencyEnabled ? " v2-pip--on" : ""}" title="Proficiency (edit in details)">●</span></td>
        <td class="v2-td-actions">
          ${subStatHiddenSync(sub)}
          <button type="button" class="v2-icon-btn v2-icon-btn--row" data-sub-edit title="Edit">\u270E</button>
          <button type="button" class="v2-icon-btn v2-icon-btn--row v2-icon-btn--danger" data-remove-substat title="Remove">×</button>
    </td>
      </tr>`
      )
      .join("");
    const hasSubStats = v2.trackedValues.subStats.length > 0;
    const subStatsBlock = hasSubStats
      ? `<div class="v2-substats-section">
      <h3 class="v2-substats-heading">Sub-stats / skills</h3>
      <div class="v2-table-wrap">
        <table class="v2-data-table v2-data-table--sheet v2-substats-table">
          <thead><tr><th>Name</th><th>Id</th><th>Parent stat</th><th>Prof</th><th></th></tr></thead>
          <tbody>${subRows}</tbody>
        </table>
      </div>
      <button type="button" class="secondary small-btn v2-substats-add-btn" id="v2-add-substat">+ Sub-stat</button>
      </div>`
      : `<div class="v2-substats-section">
      <div class="v2-substats-placeholder">
        <p class="muted small">Sub-stats and skills are optional. Add them when a value should roll up under a core stat (e.g. skills).</p>
        <button type="button" class="secondary small-btn v2-substats-add-btn" id="v2-add-substat">+ Add sub-stats / skills</button>
      </div>
      </div>`;
    const emptyColspan = 4;
    const coreStatsBlock = `<h3>Core stats</h3>
      <p class="muted small v2-panel-hint">Name and id identify each score on the sheet and in effects. Starting scores are set in <strong>Generation Method</strong> below (or under <strong>Starting score</strong> in each stat’s details). Tracked pools (HP, gold, …) live under <a href="#" data-v2-tab="v2_tracked">Tracked values</a>.</p>
      <div class="v2-table-wrap">
        <table class="v2-data-table v2-data-table--sheet v2-core-stats-table">
          <thead><tr><th>Name</th><th>Id</th><th>Prof</th><th></th></tr></thead>
          <tbody>${statsRows || `<tr><td colspan="${emptyColspan}" class="v2-td-empty muted">No stats yet</td></tr>`}</tbody>
        </table>
      </div>
      <button type="button" class="secondary small-btn" id="v2-add-stat">+ Stat</button>`;
    return `<section class="v2-section" id="v2-stats-root">
      ${coreStatsBlock}
      ${subStatsBlock}
      ${renderStatsGenerationSection(v2)}
    </section>`;
  }
  if (activeTab === "v2_tracked") {
    const otherRows = v2.trackedValues.otherValues
      .map(
        (value, idx) => `<tr data-other-row data-other-index="${idx}">
        <td><div class="v2-cell">
          <span class="v2-cell-display v2-cell-display--primary">${escapeHtml(value.name)}</span>
          <input type="text" class="v2-cell-input" data-other-name value="${escapeHtml(value.name)}" />
        </div></td>
        <td><div class="v2-cell">
          <span class="v2-cell-display v2-cell-display--mono">${escapeHtml(value.id)}</span>
          <input type="text" class="v2-cell-input v2-cell-mono" data-other-id value="${escapeHtml(value.id)}" />
        </div></td>
        <td class="v2-td-num"><div class="v2-cell">
          <span class="v2-cell-display v2-cell-display--num">${value.startValue}</span>
          <input type="number" class="v2-cell-input v2-cell-input--num" data-other-start value="${value.startValue}" />
        </div></td>
        <td class="v2-td-actions">
          ${otherHiddenSync(value)}
          <button type="button" class="v2-icon-btn v2-icon-btn--row" data-other-edit title="Edit">\u270E</button>
          <button type="button" class="v2-icon-btn v2-icon-btn--row v2-icon-btn--danger" data-remove-other title="Remove">×</button>
    </td>
      </tr>`
      )
      .join("");
    return `<section class="v2-section" id="v2-tracked-only-root">
      <p class="v2-panel-hint">Pools and resources (HP, gold, custom tracks). Core stat generation lives on <a href="#" data-v2-tab="v2_stats">Stats</a>.</p>
      <h3>Tracked values</h3>
      <div class="v2-table-wrap">
        <table class="v2-data-table v2-data-table--sheet">
          <thead><tr><th>Name</th><th>Id</th><th>Start</th><th></th></tr></thead>
          <tbody>${otherRows || `<tr><td colspan="4" class="v2-td-empty muted">No extra values</td></tr>`}</tbody>
        </table>
      </div>
      <button type="button" class="secondary small-btn" id="v2-add-other">+ Value</button>
    </section>`;
  }
  if (activeTab === "blocks_components") {
    if (view.kind === "component") {
      return renderComponentPageView(w, view.index);
    }
    if (view.kind === "option") {
      return renderOptionPageView(w, view.componentIndex, view.optionIndex);
    }
    const componentRows = v2.buildingBlocks.components
      .flatMap((component, idx) => {
        const main = `<tr data-component-row data-component-index="${idx}">
        <td><div class="v2-cell">
          <span class="v2-cell-display v2-cell-display--primary">${escapeHtml(component.name)}</span>
          <input type="text" class="v2-cell-input" data-component-name value="${escapeHtml(component.name)}" />
        </div><input type="hidden" data-component-id value="${escapeHtml(component.id)}" /></td>
        <td class="v2-td-center v2-td-count"><span class="v2-count">${component.options.length}</span></td>
        <td class="v2-td-center"><button type="button" class="v2-icon-btn v2-icon-btn--row" data-component-expand aria-expanded="false" title="Instances">+</button></td>
        <td class="v2-td-actions">
          <button type="button" class="v2-icon-btn v2-icon-btn--row" data-component-edit title="Edit component">⋯</button>
          <button type="button" class="v2-icon-btn v2-icon-btn--row v2-icon-btn--danger" data-remove-component title="Remove">×</button>
    </td>
  </tr>`;
        const subs = component.options
          .map(
            (o, oi) => `<tr class="v2-component-opt-row" hidden data-component-opt-parent="${idx}">
        <td class="muted small" colspan="1">${escapeHtml(o.name)}</td>
        <td colspan="2" class="muted small">${escapeHtml(formatOptionSummary(o, v2))}</td>
        <td class="v2-td-actions"><button type="button" class="secondary small-btn" data-open-option="${idx}" data-option-idx="${oi}">Edit…</button></td>
      </tr>`,
          )
      .join("");
        return [main, subs];
        })
        .join("");
    return `<section class="v2-section" id="v2-blocks-root">
        <p class="muted small v2-panel-hint">Dimensions (race, class, …). Edit inline, open the <strong>full page</strong> with <strong>⋯</strong>, expand <strong>+</strong> for instances.</p>
        <div class="v2-table-wrap">
          <table class="v2-data-table v2-data-table--sheet">
            <thead><tr><th>Name</th><th>Instances</th><th></th><th></th></tr></thead>
            <tbody>${componentRows || `<tr><td colspan="4" class="v2-td-empty muted">No components</td></tr>`}</tbody>
        </table>
      </div>
        <button type="button" class="secondary small-btn" id="v2-add-component">+ Component</button>
    </section>`;
}
  if (activeTab === "blocks_tables") {
    const lc = (c: string) => libraryCategoryOptions(c);
    const groupRows = (v2.buildingBlocks.tableGroups ?? [])
      .map(
        (g, i) => `<tr data-table-group-row data-group-index="${i}">
        <td><input type="hidden" data-group-id value="${escapeHtml(g.id)}" /><input class="inp inp-compact" data-group-name value="${escapeHtml(g.name)}" /></td>
        <td><input class="inp inp-compact" data-group-gain value="${escapeHtml(g.gainLabel ?? "")}" placeholder="weapon, spell…" /></td>
        <td><button type="button" class="v2-icon-btn v2-icon-btn--danger" data-remove-table-group>×</button></td>
      </tr>`,
      )
    .join("");
    const libraryRows = v2.buildingBlocks.libraries
      .map(
        (library, idx) => `<tr data-library-row data-library-index="${idx}">
        <td class="muted small">List</td>
        <td><div class="v2-cell">
          <span class="v2-cell-display v2-cell-display--primary">${escapeHtml(library.name)}</span>
          <input type="text" class="v2-cell-input" data-library-name value="${escapeHtml(library.name)}" />
        </div><input type="hidden" data-library-id value="${escapeHtml(library.id)}" /></td>
        <td><select class="inp inp-compact" data-library-group>${tableGroupOptionsHtml(v2, library.tableGroupId)}</select></td>
        <td><select class="inp inp-compact" data-library-category>${lc(library.category ?? "general")}</select></td>
        <td class="v2-td-center v2-td-count"><span class="v2-count">${library.entries.length}</span></td>
        <td class="v2-td-actions">
          <input type="hidden" data-library-description value="${escapeHtml(library.description ?? "")}" />
          <button type="button" class="v2-icon-btn v2-icon-btn--row" data-v2-inline-edit title="Edit inline">\u270E</button>
          <button type="button" class="v2-icon-btn v2-icon-btn--row" data-library-edit title="Edit all rows">⋯</button>
          <button type="button" class="v2-icon-btn v2-icon-btn--row v2-icon-btn--danger" data-remove-library title="Remove">×</button>
        </td>
      </tr>`,
      )
    .join("");
    const tableRows = v2.buildingBlocks.tables
          .map(
        (table, idx) => `<tr data-table-row data-table-index="${idx}">
        <td class="muted small">Roll</td>
        <td><div class="v2-cell">
          <span class="v2-cell-display v2-cell-display--primary">${escapeHtml(table.name)}</span>
          <input type="text" class="v2-cell-input" data-table-name value="${escapeHtml(table.name)}" />
        </div><input type="hidden" data-table-id value="${escapeHtml(table.id)}" /></td>
        <td><select class="inp inp-compact" data-table-group>${tableGroupOptionsHtml(v2, table.tableGroupId)}</select></td>
        <td><select class="inp inp-compact" data-table-category>${lc(table.category ?? "general")}</select></td>
        <td class="v2-td-center v2-td-count"><span class="v2-count">${table.entries.length}</span></td>
        <td class="v2-td-actions">
          <input type="hidden" data-table-description value="${escapeHtml(table.description ?? "")}" />
          <button type="button" class="v2-icon-btn v2-icon-btn--row" data-v2-inline-edit title="Edit inline">\u270E</button>
          <button type="button" class="v2-icon-btn v2-icon-btn--row" data-table-edit title="Edit all rows">⋯</button>
          <button type="button" class="v2-icon-btn v2-icon-btn--row v2-icon-btn--danger" data-remove-table title="Remove">×</button>
        </td>
      </tr>`,
          )
          .join("");
    const unifiedRows = [libraryRows, tableRows].filter(Boolean).join("");
    const traitRows = (v2.buildingBlocks.traits ?? [])
      .map(
        (t, i) => `<tr data-trait-row data-trait-index="${i}">
        <td><input type="text" class="inp inp-compact" data-trait-name value="${escapeHtml(t.name)}" /></td>
        <td><input type="text" class="inp inp-compact" data-trait-desc value="${escapeHtml(t.description ?? "")}" /></td>
        <td><input type="hidden" data-trait-id value="${escapeHtml(t.id)}" /></td>
        <td><button type="button" class="v2-icon-btn v2-icon-btn--danger" data-remove-trait-def>×</button></td>
      </tr>`,
      )
    .join("");
    return `<section class="v2-section" id="v2-blocks-tables-root">
      <h4>Project traits</h4>
      <p class="muted small">Reusable trait blurbs referenced from component instances.</p>
      <div class="v2-table-wrap">
        <table class="v2-data-table v2-data-table--sheet" id="v2-traits-table">
          <thead><tr><th>Name</th><th>Description</th><th></th><th></th></tr></thead>
          <tbody>${traitRows || `<tr><td colspan="4" class="v2-td-empty muted">No traits yet</td></tr>`}</tbody>
        </table>
    </div>
      <button type="button" class="secondary small-btn" id="v2-add-trait-def">+ Trait</button>
      <h4>Table groups</h4>
      <p class="muted small">Organize lists and roll tables. <strong>Gain label</strong> appears in “gain: …” hints on inventory picks.</p>
      <div class="v2-table-wrap">
        <table class="v2-data-table v2-data-table--sheet" id="v2-table-groups-table">
          <thead><tr><th>Group name</th><th>Gain label (noun)</th><th></th></tr></thead>
          <tbody id="v2-table-groups-tbody">${groupRows || `<tr><td colspan="3" class="v2-td-empty muted">No groups</td></tr>`}</tbody>
        </table>
      </div>
      <button type="button" class="secondary small-btn" id="v2-add-table-group">+ Group</button>
      <p class="muted small">Table-backed sheet blocks (weapons columns, etc.) are configured under <a href="#" data-v2-tab="sheet">Character sheet</a>.</p>
      <h4>Lists &amp; roll tables</h4>
      <p class="muted small">Assign a <strong>table group</strong> for sheet organization. Category <strong>inventory</strong> / <strong>weapons</strong> enables loot picks on instances.</p>
      <div class="v2-table-wrap">
        <table class="v2-data-table v2-data-table--sheet">
          <thead><tr><th>Type</th><th>Name</th><th>Group</th><th>Category</th><th>Rows</th><th></th></tr></thead>
          <tbody>${unifiedRows || `<tr><td colspan="6" class="v2-td-empty muted">No lists or tables yet</td></tr>`}</tbody>
    </table>
    </div>
      <button type="button" class="secondary small-btn" id="v2-add-library">+ List</button>
      <button type="button" class="secondary small-btn" id="v2-add-table">+ Roll table</button>
    </section>`;
  }
  if (activeTab === "sheet") {
    const blockCandidates = ["Name", "Race", "Class", "Description", "Stats", "Gold", "HP", "Traits", "Weapons", "Inventory"];
    const selected = new Set(v2.sheetLayout.includedBlocks.map((x) => x.toLowerCase()));
    const checks = blockCandidates
      .map(
        (block) => `<label class="check v2-check-tight">
        <input type="checkbox" data-sheet-block="${escapeHtml(block)}"${selected.has(block.toLowerCase()) ? " checked" : ""} />
        ${escapeHtml(block)}
      </label>`
      )
    .join("");
    const secRows = (v2.sheetLayout.tableSections ?? [])
    .map(
        (s, i) => `<tr data-sheet-sec-row data-sheet-sec-index="${i}">
        <td><input type="hidden" data-sheet-sec-id value="${escapeHtml(s.id)}" /><input class="inp inp-compact" data-sheet-sec-title value="${escapeHtml(s.title)}" /></td>
        <td><select class="inp inp-compact" data-sheet-sec-table>${projectTableSelectHtml(v2, s.studioTableId)}</select></td>
        <td class="v2-td-center"><label class="check tight"><input type="checkbox" data-sheet-sec-lab${s.showLabel !== false ? " checked" : ""} /> Name</label></td>
        <td class="v2-td-center"><label class="check tight"><input type="checkbox" data-sheet-sec-desc${s.showDescription ? " checked" : ""} /> Desc</label></td>
        <td class="v2-td-center"><label class="check tight"><input type="checkbox" data-sheet-sec-wt${s.showWeight ? " checked" : ""} /> Wt</label></td>
        <td><button type="button" class="v2-icon-btn v2-icon-btn--danger" data-remove-sheet-sec>×</button></td>
      </tr>`,
    )
    .join("");
    return `<section class="v2-section v2-sheet-section" id="v2-sheet-root">
      <p class="v2-sheet-lede muted small">Blocks included on the character sheet preview.</p>
      <div class="v2-check-grid v2-check-grid--sheet">${checks}</div>
      <h4>Table-backed list sections</h4>
      <p class="muted small">Each row is a sheet block tied to one roll table. Choose which outcome columns appear when rows reference that table.</p>
      <div class="v2-table-wrap">
        <table class="v2-data-table v2-data-table--sheet">
          <thead><tr><th>Section title</th><th>Roll table</th><th>Name</th><th>Desc</th><th>Wt</th><th></th></tr></thead>
          <tbody id="v2-sheet-secs-tbody">${secRows || ""}</tbody>
          </table>
        </div>
      <button type="button" class="secondary small-btn" id="v2-add-sheet-sec">+ Table section</button>
      <label class="block v2-sheet-notes-label"><span class="muted small">Designer notes</span><textarea class="inp v2-sheet-notes" id="v2-sheet-notes" rows="3">${escapeHtml(
        v2.sheetLayout.customNotes ?? ""
      )}</textarea></label>
    </section>`;
  }
  if (activeTab === "settings") {
    const bypassNote =
      localStudioHint
        ? `<p class="studio-bypass-hint muted small no-print">Projects stay in this browser only until you sign in. Publishing and cloud sync need an account.</p>`
        : "";
    const verSummaries = listProjectVersionSummaries(w.id);
    const activeRev = w.projectMeta?.activeRevision;
    const revPill =
      verSummaries.length === 0
        ? ""
        : ` · <button type="button" class="v2-rev-pill muted tiny" id="v2-open-revisions" title="Revisions and notes">${escapeHtml(
            activeRev != null ? `Rev ${activeRev}` : `${verSummaries.length} revisions`,
          )}</button>`;
    return `<section class="v2-section v2-settings-page" id="v2-settings-root" data-current-project-id="${escapeHtml(w.id)}">
      ${bypassNote}
      <div class="v2-settings-unified">
        <div class="v2-settings-overview">
          <h3 class="v2-settings-section__title">Overview</h3>
          <p class="v2-project-meta-line muted tiny" title="Timestamps update when you save">Created ${escapeHtml(formatDiscreetTs(w.projectMeta?.createdAt))} · Last edited ${escapeHtml(formatDiscreetTs(w.projectMeta?.updatedAt))}${revPill}</p>
          ${renderProjectOverviewForm(w)}
        </div>

        <div class="v2-settings-publish">
          <h3 class="v2-settings-section__title">Publishing</h3>
          <p class="muted small v2-settings-publish__lede">Copy this URL to share your generator. Add a password if you want restricted access.</p>
          <div id="v2-share-url-wrap">
            <label class="block v2-settings-publish__url-label"><span>URL</span></label>
            <div class="v2-share-url-row v2-share-url-row--prominent">
              <input type="text" id="v2-share-url" readonly class="inp v2-cell-mono" aria-label="Share link" />
              <button type="button" class="secondary small-btn" id="v2-copy-share-url">Copy</button>
            </div>
          </div>
          <label class="check v2-settings-publish__pw-toggle"><input type="checkbox" id="v2-publish-use-password"${
            v2.projectSettings.visibility === "private" ? " checked" : ""
          } /> Require password</label>
          <div id="v2-publish-key-block" hidden>
            <label class="block"><span>Password</span>
              <input type="text" id="v2-publish-invite-key" class="inp v2-cell-mono" value="${escapeHtml(v2.projectSettings.publishInviteKey ?? "super-secret-password")}" autocomplete="off" spellcheck="false" />
            </label>
          </div>
          <input type="hidden" id="v2-publish-slug" value="${escapeHtml(v2.projectSettings.publishSlug ?? normalizePublishSlug(w.id))}" />
        </div>

        <div class="v2-settings-actions-footer">
          <div class="v2-settings-toolbar v2-settings-toolbar--actions">
            <div class="v2-project-file" role="group" aria-label="Project file">
              <details class="v2-project-file__details" id="studio-save-split-menu">
                <summary class="small-btn v2-project-file__summary">Project file ▾</summary>
                <div class="v2-project-file__panel">
                  <button type="button" class="v2-project-file__choice" id="studio-save-as-version">Save as version…</button>
                  <button type="button" class="v2-project-file__choice" id="studio-download-backup">Download to Computer</button>
                </div>
              </details>
            </div>
            <button type="button" class="danger small-btn" id="studio-delete">Delete project</button>
          </div>
          <p id="v2-settings-feedback" class="muted small v2-settings-feedback" role="status"></p>
        </div>
      </div>
    </section>`;
  }
  return renderStudioPanel("settings", w, view, localStudioHint);
}

export function renderStudioBody(
  w: RpgSystem,
  activeTab: string,
  view: StudioViewState,
  _dimFocus?: string | null,
  localStudioHint?: boolean
): string {
  const nav = renderStudioSidebar(activeTab);
  return `<div id="studio-shell" class="studio-v2">
    <div class="studio-v2-layout">
      <aside class="studio-v2-sidebar" id="studio-v2-sidebar">${nav}</aside>
      <main class="studio-v2-main">${renderStudioPanel(activeTab, w, view, localStudioHint)}</main>
        </div>
    <div id="v2-modal-host" class="v2-modal-host" hidden>
      <div class="v2-modal-backdrop" data-v2-modal-close tabindex="-1"></div>
      <div class="v2-modal" role="dialog" aria-modal="true">
        <header class="v2-modal__head">
          <button type="button" class="v2-icon-btn v2-modal__back" id="v2-modal-back" data-v2-modal-back hidden aria-label="Back">←</button>
          <h2 id="v2-modal-title" class="v2-modal__title"></h2>
          <button type="button" class="v2-icon-btn" data-v2-modal-close aria-label="Close">×</button>
          </header>
        <div id="v2-modal-body" class="v2-modal__body"></div>
        <footer id="v2-modal-foot" class="v2-modal__foot"></footer>
        </div>
      </div>
  </div>`;
}

function readStudioV2ComponentFromModal(w: RpgSystem, idx: number): StudioV2Component | null {
  const v2 = ensureStudioV2(w);
  const prev = v2.buildingBlocks.components[idx];
  if (!prev) return null;
  const name = (document.getElementById("v2-comp-name") as HTMLInputElement | null)?.value.trim() ?? "";
  const desc = (document.getElementById("v2-comp-desc") as HTMLTextAreaElement | null)?.value.trim() ?? "";
  if (!name) return null;
  return {
    ...prev,
    id: prev.id || name.toLowerCase().replace(/\s+/g, "_"),
    name,
    description: desc || undefined,
    options: prev.options.map((o) => structuredClone(o)),
  };
}

function readStudioV2LibraryFromRow(row: Element, prevLib?: StudioV2Library | null): StudioV2Library | null {
  const nameVal = (row.querySelector("[data-library-name]") as HTMLInputElement | null)?.value.trim() ?? "";
  const idVal = (row.querySelector("[data-library-id]") as HTMLInputElement | null)?.value.trim() ?? "";
  if (!nameVal) return null;
  const catRaw = (row.querySelector("[data-library-category]") as HTMLSelectElement | null)?.value;
  const category =
    catRaw === "inventory" || catRaw === "weapons" || catRaw === "general" ? catRaw : (prevLib?.category ?? "general");
  const grpRaw = (row.querySelector("[data-library-group]") as HTMLSelectElement | null)?.value.trim() || "";
  const tableGroupId = grpRaw || undefined;
  const entries: StudioV2LibraryEntry[] = [];
  row.querySelectorAll("[data-library-entry-row]").forEach((entryRow) => {
    const entryName = (entryRow.querySelector("[data-library-entry-name]") as HTMLInputElement | null)?.value.trim() ?? "";
    if (!entryName) return;
    const eIdx = Number((entryRow as HTMLElement).dataset.entryIndex ?? -1);
    const prevE = eIdx >= 0 ? prevLib?.entries[eIdx] : undefined;
    const entryId = prevE?.id ?? entryName.toLowerCase().replace(/\s+/g, "_");
    const desc =
      (entryRow.querySelector("[data-library-entry-description]") as HTMLInputElement | null)?.value.trim() ||
      undefined;
    entries.push({
      id: entryId,
      name: entryName,
      description: desc,
      fields: prevE?.fields ? structuredClone(prevE.fields) : undefined,
    });
  });
  const descEl = row.querySelector("[data-library-description]") as HTMLInputElement | HTMLTextAreaElement | null;
  const descRaw = descEl?.value?.trim() ?? "";
  return {
    id: idVal || nameVal.toLowerCase().replace(/\s+/g, "_"),
    name: nameVal,
    description: descRaw || undefined,
    category,
    tableGroupId,
    entries,
  };
}

function readStudioV2TableFromRow(row: Element, prevTbl?: StudioV2Table | null): StudioV2Table | null {
  const nameVal = (row.querySelector("[data-table-name]") as HTMLInputElement | null)?.value.trim() ?? "";
  const idVal = (row.querySelector("[data-table-id]") as HTMLInputElement | null)?.value.trim() ?? "";
  if (!nameVal) return null;
  const catRaw = (row.querySelector("[data-table-category]") as HTMLSelectElement | null)?.value;
  const category =
    catRaw === "inventory" || catRaw === "weapons" || catRaw === "general" ? catRaw : (prevTbl?.category ?? "general");
  const grpRaw = (row.querySelector("[data-table-group]") as HTMLSelectElement | null)?.value.trim() || "";
  const tableGroupId = grpRaw || undefined;
  const entries: StudioV2TableEntry[] = [];
  row.querySelectorAll("[data-table-entry-row]").forEach((entryRow) => {
    const label = (entryRow.querySelector("[data-table-entry-label]") as HTMLInputElement | null)?.value.trim() ?? "";
    if (!label) return;
    const eIdx = Number((entryRow as HTMLElement).dataset.entryIndex ?? -1);
    const prevE = eIdx >= 0 ? prevTbl?.entries[eIdx] : undefined;
    const entryId = prevE?.id ?? label.toLowerCase().replace(/\s+/g, "_");
    entries.push({
      id: entryId,
      label,
      description: (entryRow.querySelector("[data-table-entry-description]") as HTMLInputElement | null)?.value.trim() || undefined,
      weight: Number((entryRow.querySelector("[data-table-entry-weight]") as HTMLInputElement | null)?.value ?? 1),
      effects: prevE?.effects ? structuredClone(prevE.effects) : undefined,
    });
  });
  const descEl = row.querySelector("[data-table-description]") as HTMLInputElement | HTMLTextAreaElement | null;
  const descRaw = descEl?.value?.trim() ?? "";
  return {
    id: idVal || nameVal.toLowerCase().replace(/\s+/g, "_"),
    name: nameVal,
    description: descRaw || undefined,
    category,
    tableGroupId,
    entries,
  };
}

export function syncWorkingFromDom(w: RpgSystem): void {
  const v2 = ensureStudioV2(w);

  if (document.getElementById("v2-stats-generation-root")) {
    const methodRadio = document.querySelector('input[name="v2-gen-method"]:checked') as HTMLInputElement | null;
    const method = methodRadio?.value ?? "";
    const usageRadio = document.querySelector('input[name="v2-stat-usage"]:checked') as HTMLInputElement | null;
    const usage = usageRadio?.value;
    const methodOk =
      method === "fixed_defaults" ||
      method === "standard_array" ||
      method === "point_buy" ||
      method === "random_dice";
    if (methodOk) {
      if (v2.trackedValues.generationMethod.kind !== method) {
        v2.trackedValues.generationMethod = defaultGenerationForKind(method);
      } else {
        const ed = document.querySelector("#v2-generation-params-wrap [data-gen-editor]") as HTMLElement | null;
        if (ed && ed.dataset.genKind === method) {
          const parsed = readGenerationMethodFromEditor(ed);
          if (parsed) v2.trackedValues.generationMethod = parsed;
        }
      }
    }
    if (usage === "modifier_only" || usage === "score_only" || usage === "score_and_modifier") {
      v2.trackedValues.statUsage = usage;
    }
  }

  if (document.getElementById("v2-stats-root")) {
    const prevStats = v2.trackedValues.stats.slice();
    const stats: StudioV2Config["trackedValues"]["stats"] = [];
    document.querySelectorAll("#v2-stats-root [data-stat-row]").forEach((row) => {
      const idx = Number((row as HTMLElement).dataset.statIndex ?? -1);
      const nameVal = (row.querySelector("[data-stat-name]") as HTMLInputElement | null)?.value.trim() ?? "";
      const idVal = (row.querySelector("[data-stat-id]") as HTMLInputElement | null)?.value.trim() ?? "";
      if (!nameVal) return;
      const prev = idx >= 0 ? prevStats[idx] : undefined;
      stats.push({
        id: idVal || nameVal.toLowerCase().replace(/\s+/g, "_"),
        name: nameVal,
        startValue: Number((row.querySelector("[data-stat-start]") as HTMLInputElement | null)?.value ?? 0),
        abbreviation: (row.querySelector("[data-stat-abbr]") as HTMLInputElement | null)?.value.trim() || undefined,
        description: (row.querySelector("[data-stat-description]") as HTMLTextAreaElement | null)?.value.trim() || undefined,
        usesProficiency: (row.querySelector("[data-stat-prof]") as HTMLInputElement | null)?.checked ?? false,
        custom: prev?.custom ? structuredClone(prev.custom) : undefined,
      });
    });
    v2.trackedValues.stats = stats;

    const prevSub = v2.trackedValues.subStats.slice();
    const subStats: StudioV2SubStat[] = [];
    document.querySelectorAll("#v2-stats-root [data-substat-row]").forEach((row) => {
      const idx = Number((row as HTMLElement).dataset.substatIndex ?? -1);
      const nameVal = (row.querySelector("[data-sub-name]") as HTMLInputElement | null)?.value.trim() ?? "";
      const idVal = (row.querySelector("[data-sub-id]") as HTMLInputElement | null)?.value.trim() ?? "";
      if (!nameVal) return;
      const prev = idx >= 0 ? prevSub[idx] : undefined;
      subStats.push({
        id: idVal || nameVal.toLowerCase().replace(/\s+/g, "_"),
        name: nameVal,
        parentStatId: (row.querySelector("[data-sub-parent]") as HTMLInputElement | null)?.value.trim() ?? "",
        proficiencyEnabled: (row.querySelector("[data-sub-prof]") as HTMLInputElement | null)?.checked ?? false,
        description: (row.querySelector("[data-sub-description]") as HTMLTextAreaElement | null)?.value.trim() || undefined,
        custom: prev?.custom ? structuredClone(prev.custom) : undefined,
      });
    });
    v2.trackedValues.subStats = subStats;
  }

  if (document.getElementById("v2-tracked-only-root")) {
    const prevOther = v2.trackedValues.otherValues.slice();
    const otherValues: StudioV2TrackedValue[] = [];
    document.querySelectorAll("#v2-tracked-only-root [data-other-row]").forEach((row) => {
      const idx = Number((row as HTMLElement).dataset.otherIndex ?? -1);
      const nameVal = (row.querySelector("[data-other-name]") as HTMLInputElement | null)?.value.trim() ?? "";
      const idVal = (row.querySelector("[data-other-id]") as HTMLInputElement | null)?.value.trim() ?? "";
      if (!nameVal) return;
      const prev = idx >= 0 ? prevOther[idx] : undefined;
      otherValues.push({
        id: idVal || nameVal.toLowerCase().replace(/\s+/g, "_"),
        name: nameVal,
        startValue: Number((row.querySelector("[data-other-start]") as HTMLInputElement | null)?.value ?? 0),
        abbreviation: (row.querySelector("[data-other-abbr]") as HTMLInputElement | null)?.value.trim() || undefined,
        description: (row.querySelector("[data-other-description]") as HTMLTextAreaElement | null)?.value.trim() || undefined,
        custom: prev?.custom ? structuredClone(prev.custom) : undefined,
      });
    });
    v2.trackedValues.otherValues = otherValues;
  }

  if (document.getElementById("v2-blocks-root")) {
    const prevComponents = v2.buildingBlocks.components.slice();
    const components: StudioV2Component[] = [];
    document.querySelectorAll("#v2-blocks-root [data-component-row]").forEach((row) => {
      const idx = Number((row as HTMLElement).dataset.componentIndex ?? -1);
      const nameVal = (row.querySelector("[data-component-name]") as HTMLInputElement | null)?.value.trim() ?? "";
      const idVal = (row.querySelector("[data-component-id]") as HTMLInputElement | null)?.value.trim() ?? "";
      if (!nameVal) return;
      const prev = idx >= 0 ? prevComponents[idx] : undefined;
      components.push({
        id: idVal || nameVal.toLowerCase().replace(/\s+/g, "_"),
        name: nameVal,
        description: prev?.description,
        options: prev?.options?.length ? prev.options.map((o) => structuredClone(o)) : [],
      });
    });
    v2.buildingBlocks.components = components;
  }

  if (document.getElementById("v2-blocks-tables-root")) {
    const prevTraits = (v2.buildingBlocks.traits ?? []).slice();
    const traits: StudioV2TraitDefinition[] = [];
    document.querySelectorAll("#v2-blocks-tables-root [data-trait-row]").forEach((row) => {
      const idx = Number((row as HTMLElement).dataset.traitIndex ?? -1);
      const nameVal = (row.querySelector("[data-trait-name]") as HTMLInputElement | null)?.value.trim() ?? "";
      if (!nameVal) return;
      const idVal = (row.querySelector("[data-trait-id]") as HTMLInputElement | null)?.value.trim() ?? "";
      const prev = idx >= 0 ? prevTraits[idx] : undefined;
      const t: StudioV2TraitDefinition = {
        id: idVal || nameVal.toLowerCase().replace(/\s+/g, "_"),
        name: nameVal,
        description: (row.querySelector("[data-trait-desc]") as HTMLInputElement | null)?.value.trim() || undefined,
      };
      if (prev?.traitEffects?.length) t.traitEffects = structuredClone(prev.traitEffects);
      traits.push(t);
    });
    v2.buildingBlocks.traits = traits;

    const prevGroups = (v2.buildingBlocks.tableGroups ?? []).slice();
    const tableGroups: StudioV2Config["buildingBlocks"]["tableGroups"] = [];
    document.querySelectorAll("#v2-table-groups-tbody [data-table-group-row]").forEach((row) => {
      const idx = Number((row as HTMLElement).dataset.groupIndex ?? -1);
      const nameVal = (row.querySelector("[data-group-name]") as HTMLInputElement | null)?.value.trim() ?? "";
      if (!nameVal) return;
      const idVal = (row.querySelector("[data-group-id]") as HTMLInputElement | null)?.value.trim() ?? "";
      const prevG = idx >= 0 ? prevGroups[idx] : undefined;
      tableGroups.push({
        id: idVal || prevG?.id || nameVal.toLowerCase().replace(/\s+/g, "_"),
        name: nameVal,
        gainLabel: (row.querySelector("[data-group-gain]") as HTMLInputElement | null)?.value.trim() || undefined,
      });
    });
    if (tableGroups.length) v2.buildingBlocks.tableGroups = tableGroups;

    const prevLibraries = v2.buildingBlocks.libraries.slice();
    const libraries: StudioV2Library[] = [];
    document.querySelectorAll("#v2-blocks-tables-root [data-library-row]").forEach((row) => {
      const idx = Number((row as HTMLElement).dataset.libraryIndex ?? -1);
      const nameVal = (row.querySelector("[data-library-name]") as HTMLInputElement | null)?.value.trim() ?? "";
      const idVal = (row.querySelector("[data-library-id]") as HTMLInputElement | null)?.value.trim() ?? "";
      if (!nameVal) return;
      const prev = idx >= 0 ? prevLibraries[idx] : undefined;
      const libDesc = row.querySelector("[data-library-description]") as HTMLInputElement | HTMLTextAreaElement | null;
      const catRaw = (row.querySelector("[data-library-category]") as HTMLSelectElement | null)?.value;
      const category =
        catRaw === "inventory" || catRaw === "weapons" || catRaw === "general" ? catRaw : (prev?.category ?? "general");
      const grpRaw = (row.querySelector("[data-library-group]") as HTMLSelectElement | null)?.value.trim() || "";
      libraries.push({
        id: idVal || nameVal.toLowerCase().replace(/\s+/g, "_"),
        name: nameVal,
        description: libDesc?.value?.trim() || undefined,
        category,
        tableGroupId: grpRaw || undefined,
        entries: prev?.entries?.length ? prev.entries.map((e) => structuredClone(e)) : [],
      });
    });
    v2.buildingBlocks.libraries = libraries;

    const prevTables = v2.buildingBlocks.tables.slice();
    const tables: StudioV2Table[] = [];
    document.querySelectorAll("#v2-blocks-tables-root [data-table-row]").forEach((row) => {
      const idx = Number((row as HTMLElement).dataset.tableIndex ?? -1);
      const nameVal = (row.querySelector("[data-table-name]") as HTMLInputElement | null)?.value.trim() ?? "";
      const idVal = (row.querySelector("[data-table-id]") as HTMLInputElement | null)?.value.trim() ?? "";
      if (!nameVal) return;
      const prev = idx >= 0 ? prevTables[idx] : undefined;
      const tblDesc = row.querySelector("[data-table-description]") as HTMLInputElement | HTMLTextAreaElement | null;
      const catRaw = (row.querySelector("[data-table-category]") as HTMLSelectElement | null)?.value;
      const category =
        catRaw === "inventory" || catRaw === "weapons" || catRaw === "general" ? catRaw : (prev?.category ?? "general");
      const grpRaw = (row.querySelector("[data-table-group]") as HTMLSelectElement | null)?.value.trim() || "";
      tables.push({
        id: idVal || nameVal.toLowerCase().replace(/\s+/g, "_"),
        name: nameVal,
        description: tblDesc?.value?.trim() || undefined,
        category,
        tableGroupId: grpRaw || undefined,
        entries: prev?.entries?.length ? prev.entries.map((e) => structuredClone(e)) : [],
      });
    });
    v2.buildingBlocks.tables = tables;
  }

  if (document.getElementById("v2-sheet-root")) {
    const includedBlocks: string[] = [];
    document.querySelectorAll("#v2-sheet-root [data-sheet-block]").forEach((el) => {
      const checkbox = el as HTMLInputElement;
      if (checkbox.checked) includedBlocks.push(checkbox.dataset.sheetBlock ?? "");
    });
    v2.sheetLayout.includedBlocks = includedBlocks;
    const notes = (document.getElementById("v2-sheet-notes") as HTMLTextAreaElement | null)?.value;
    if (notes !== undefined) v2.sheetLayout.customNotes = notes;

    const prevSecs = (v2.sheetLayout.tableSections ?? []).slice();
    const tableSections: StudioV2SheetTableSection[] = [];
    document.querySelectorAll("#v2-sheet-secs-tbody [data-sheet-sec-row]").forEach((row) => {
      const idx = Number((row as HTMLElement).dataset.sheetSecIndex ?? -1);
      const prevS = idx >= 0 ? prevSecs[idx] : undefined;
      const idVal = (row.querySelector("[data-sheet-sec-id]") as HTMLInputElement | null)?.value.trim() ?? "";
      const title = (row.querySelector("[data-sheet-sec-title]") as HTMLInputElement | null)?.value.trim() ?? "";
      const studioTableId = (row.querySelector("[data-sheet-sec-table]") as HTMLSelectElement | null)?.value.trim() ?? "";
      if (!studioTableId) return;
      tableSections.push({
        id: idVal || prevS?.id || `sheet_sec_${Date.now()}_${tableSections.length}`,
        title: title || prevS?.title || "Section",
        studioTableId,
        showLabel: (row.querySelector("[data-sheet-sec-lab]") as HTMLInputElement | null)?.checked ?? true,
        showDescription: (row.querySelector("[data-sheet-sec-desc]") as HTMLInputElement | null)?.checked ?? false,
        showWeight: (row.querySelector("[data-sheet-sec-wt]") as HTMLInputElement | null)?.checked ?? false,
      });
    });
    v2.sheetLayout.tableSections = tableSections;
  }

  if (document.getElementById("v2-settings-root")) {
    const usePassword = (document.getElementById("v2-publish-use-password") as HTMLInputElement | null)?.checked ?? false;
    v2.projectSettings.visibility = usePassword ? "private" : "public";
    const projectName = (document.getElementById("v2-project-name") as HTMLInputElement | null)?.value?.trim();
    if (projectName) w.name = projectName;
    v2.projectOverview.description =
      (document.getElementById("v2-overview-description") as HTMLTextAreaElement | null)?.value ?? "";
    v2.projectOverview.creatorName = (document.getElementById("v2-overview-creator") as HTMLInputElement | null)?.value ?? "";
    v2.projectOverview.creatorContact =
      (document.getElementById("v2-overview-contact") as HTMLInputElement | null)?.value ?? "";
    const tagsRaw = (document.getElementById("v2-overview-tags") as HTMLInputElement | null)?.value ?? "";
    v2.projectOverview.tags = tagsRaw
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const pubSlugEl = document.getElementById("v2-publish-slug") as HTMLInputElement | null;
    if (pubSlugEl) {
      const t = pubSlugEl.value.trim();
      v2.projectSettings.publishSlug = t || undefined;
    }
    const pubKeyEl = document.getElementById("v2-publish-invite-key") as HTMLInputElement | null;
    if (pubKeyEl) {
      const t = pubKeyEl.value.trim();
      v2.projectSettings.publishInviteKey = t || "super-secret-password";
    } else if (usePassword) {
      v2.projectSettings.publishInviteKey = "super-secret-password";
    } else {
      v2.projectSettings.publishInviteKey = undefined;
    }
  }

  applyStudioV2ToSystem(w);
}

function downloadSystem(system: RpgSystem): void {
  const data = exportSystemJson(system);
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${system.id || "project"}.rpg-system`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function scheduleCloudFlushAndPublish(opts: StudioWireOpts): void {
  if (cloudFlushPublishTimer) clearTimeout(cloudFlushPublishTimer);
  cloudFlushPublishTimer = setTimeout(() => {
    cloudFlushPublishTimer = null;
    const w = ensureWorking(opts.getSelectedId());
    syncWorkingFromDom(w);
    saveSystem(w);
    void (async () => {
      const out = document.getElementById("v2-settings-feedback");
      try {
        if (isCloudMode()) {
          await flushSystemToCloud(w).catch(() => {
            if (out) out.textContent = "Saved locally. Account sync failed—try again.";
          });
        }
        const pub = await syncPublishedSnapshot(w, opts.getUserId());
        if (pub.error && out) out.textContent = `Could not update shared link: ${pub.error}`;
        const keyInput = document.getElementById("v2-publish-invite-key") as HTMLInputElement | null;
        const v2 = ensureStudioV2(w);
        if (keyInput && v2.projectSettings.publishInviteKey) {
          keyInput.value = v2.projectSettings.publishInviteKey;
        }
        updatePublishShareUi();
      } catch {
        /* ignore */
      }
    })();
  }, CLOUD_FLUSH_PUBLISH_DEBOUNCE_MS);
}

function queuePersist(opts: StudioWireOpts): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const w = ensureWorking(opts.getSelectedId());
    syncWorkingFromDom(w);
    saveSystem(w);
    scheduleCloudFlushAndPublish(opts);
  }, 350);
}

function rowIndex(node: Element | null, attr: string): number {
  if (!node) return -1;
  return Number((node as HTMLElement).dataset[attr] ?? -1);
}

export function runAfterStudioRenderPersist(opts: StudioWireOpts): void {
  const w = ensureWorking(opts.getSelectedId());
  syncWorkingFromDom(w);
  saveSystem(w);
  scheduleCloudFlushAndPublish(opts);
}

function defaultEffectDetails(prefix: string, idx: number, w: RpgSystem): string {
  return renderEffectCard({ type: "stat_mod", statId: "", amount: 0 }, prefix, idx, w);
}

function v2ModalIsOpen(): boolean {
  const host = document.getElementById("v2-modal-host");
  return !!(host && !host.hidden);
}

function targetInsideModalBody(target: HTMLElement): boolean {
  return !!target.closest("#v2-modal-body");
}

function refreshComponentModal(w: RpgSystem, idx: number): void {
  const v2 = ensureStudioV2(w);
  const c = v2.buildingBlocks.components[idx];
  if (!c) return;
  replaceV2ModalLayer(
    `Component: ${c.name}`,
    `<div class="v2-modal-scroll">${renderComponentDetailBody(idx, c, w)}</div>`,
    `<button type="button" class="secondary small-btn" data-v2-modal-close>Cancel</button> <button type="button" class="small-btn" id="v2-modal-save-component">Save</button>`
  );
}

function refreshLibraryModal(w: RpgSystem, idx: number): void {
  const v2 = ensureStudioV2(w);
  const lib = v2.buildingBlocks.libraries[idx];
  if (!lib) return;
  replaceV2ModalLayer(
    `Library: ${lib.name}`,
    `<div class="v2-modal-scroll">${renderLibraryCard(lib, idx, true, v2)}</div>`,
    `<button type="button" class="secondary small-btn" data-v2-modal-close>Cancel</button> <button type="button" class="small-btn" id="v2-modal-save-library">Save</button>`
  );
}

function refreshTableModal(w: RpgSystem, idx: number): void {
  const v2 = ensureStudioV2(w);
  const tbl = v2.buildingBlocks.tables[idx];
  if (!tbl) return;
  replaceV2ModalLayer(
    `Table: ${tbl.name}`,
    `<div class="v2-modal-scroll">${renderTableCard(tbl, idx, true, v2)}</div>`,
    `<button type="button" class="secondary small-btn" data-v2-modal-close>Cancel</button> <button type="button" class="small-btn" id="v2-modal-save-table">Save</button>`
  );
}

export function wireStudio(opts: StudioWireOpts): void {
  const shell = document.getElementById("studio-shell");
  if (!shell) return;

  shell.querySelectorAll("[data-v2-blocks-tab]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      const tab = (btn as HTMLElement).dataset.v2BlocksTab ?? "components";
      shell.querySelectorAll("[data-v2-blocks-tab]").forEach((b) => {
        const on = b === btn;
        b.classList.toggle("is-active", on);
        (b as HTMLElement).setAttribute("aria-selected", on ? "true" : "false");
      });
      shell.querySelectorAll("[data-blocks-panel]").forEach((panel) => {
        const p = panel as HTMLElement;
        p.hidden = p.dataset.blocksPanel !== tab;
      });
    });
  });

  shell.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    const host = document.getElementById("v2-modal-host");
    if (host && !host.hidden) {
      const pop = document.getElementById("v2-dice-pool-popover");
      if (pop && !pop.hidden) {
        ev.preventDefault();
        pop.hidden = true;
        return;
      }
      ev.preventDefault();
      closeV2Modal();
      return;
    }
    const editing = shell.querySelector("tr.is-editing");
    if (editing) {
      ev.preventDefault();
      commitTableRowInputsToDisplay(editing as HTMLTableRowElement);
      editing.classList.remove("is-editing");
    }
  });

  shell.addEventListener("mousedown", (ev) => {
    const t = ev.target as HTMLElement;
    if (v2ModalIsOpen() && t.closest("#v2-modal-host")) {
      const pop = document.getElementById("v2-dice-pool-popover");
      if (pop && !pop.hidden) {
        if (!pop.contains(t) && !t.closest("[data-dice-pool-chip]")) pop.hidden = true;
      }
      return;
    }
    const editRow = t.closest("tr.is-editing");
    if (editRow && editRow.contains(t)) return;
    shell.querySelectorAll("tr.is-editing").forEach((tr) => {
      commitTableRowInputsToDisplay(tr as HTMLTableRowElement);
      tr.classList.remove("is-editing");
    });
  });

   shell.addEventListener("input", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.id === "v2-publish-slug" || t.id === "v2-publish-invite-key" || t.id === "v2-project-name") {
      updatePublishShareUi();
      queuePersist(opts);
      return;
    }
    if (t.id === "v2-modal-dice-formula") {
      refreshDiceFormulaModalUi();
      return;
    }
    if (t.closest("#v2-dice-pool-popover")) return;
    if (t.matches("[data-v2-gen-fixed]")) {
      const idx = Number((t as HTMLInputElement).dataset.statIndex);
      if (Number.isFinite(idx)) {
        const row = shell.querySelector(`#v2-stats-root tr[data-stat-row][data-stat-index="${idx}"]`);
        const h = row?.querySelector("[data-stat-start]") as HTMLInputElement | null;
        if (h) h.value = (t as HTMLInputElement).value;
      }
    }
    queuePersist(opts);
  }, { passive: true });
  shell.addEventListener("change", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.id === "v2-publish-use-password") {
      const keyInput = document.getElementById("v2-publish-invite-key") as HTMLInputElement | null;
      if ((t as HTMLInputElement).checked && keyInput && !keyInput.value.trim()) {
        keyInput.value = "super-secret-password";
      }
      updatePublishShareUi();
      queuePersist(opts);
      return;
    }
    if (t.id === "v2-dice-pool-mode") {
      syncDicePoolPopoverModeUi();
      return;
    }
    if (t.id === "v2-modal-dice-preset" || t.id === "v2-modal-dice-repeat") return;
    if (t.matches('input[name="v2-gen-method"]')) {
      const w = ensureWorking(opts.getSelectedId());
    syncWorkingFromDom(w);
      saveSystem(w);
      opts.rerender();
      return;
    }
    if (t.matches("[data-effect-type]")) {
      const card = t.closest(".v2-effect-card");
      if (card) syncEffectPanelsForCard(card);
    }
    if (t.matches("input.v2-cell-input--toggle")) {
      const row = t.closest("tr");
      if (row?.classList.contains("is-editing")) {
        const cell = t.closest(".v2-cell");
        const disp = cell?.querySelector(".v2-cell-display--check");
        if (disp) disp.textContent = (t as HTMLInputElement).checked ? "\u2713" : "\u2013";
      }
    }
    if (t.matches('input[name="v2-stat-usage"]')) {
      queuePersist(opts);
      return;
    }
    if (t.id === "v2-opt-stat-enable") {
      document.getElementById("v2-opt-stat-panel")?.toggleAttribute("hidden", !(t as HTMLInputElement).checked);
    }
    if (t.id === "v2-opt-tracked-enable") {
      document.getElementById("v2-opt-tracked-panel")?.toggleAttribute("hidden", !(t as HTMLInputElement).checked);
    }
    if (t.matches("[data-inv-table]") || t.matches("[data-inv-pick]")) {
      const row = t.closest("tr[data-inv-row]");
      if (row) {
        const wInv = ensureWorking(opts.getSelectedId());
        const v2Inv = ensureStudioV2(wInv);
        const cur = (row.querySelector("[data-inv-entry]") as HTMLSelectElement | null)?.value || undefined;
        repopulateInventoryEntrySelect(row as HTMLElement, v2Inv, cur);
      }
    }
    queuePersist(opts);
  }, { passive: true });

  shell.querySelectorAll("[data-v2-tab]").forEach((tab) => {
    tab.addEventListener("click", (ev) => {
      ev.preventDefault();
      const target = tab as HTMLElement;
      const nextTab = target.dataset.v2Tab ?? "settings";
      const w = ensureWorking(opts.getSelectedId());
      syncWorkingFromDom(w);
      saveSystem(w);
      scheduleCloudFlushAndPublish(opts);
      opts.setStudioView({ kind: "home" });
      opts.setActiveTab(nextTab);
      opts.rerender();
    });
  });

  document.getElementById("studio-v2-menu-btn")?.addEventListener("click", () => {
    document.getElementById("studio-v2-sidebar")?.classList.toggle("is-open");
  });

  document.getElementById("studio-download-backup")?.addEventListener("click", () => {
    const menu = document.getElementById("studio-save-split-menu") as HTMLDetailsElement | null;
    if (menu) menu.open = false;
    const w = ensureWorking(opts.getSelectedId());
    syncWorkingFromDom(w);
    downloadSystem(w);
  });

  document.getElementById("studio-save-as-version")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    const menu = document.getElementById("studio-save-split-menu") as HTMLDetailsElement | null;
    if (menu) menu.open = false;
    const w = ensureWorking(opts.getSelectedId());
    syncWorkingFromDom(w);
    const nextRev = getNextRevisionNumber(w.id);
    openV2ModalLayer(
      "Save as version",
      `<p class="muted small">Stores a snapshot in this browser (last 40 per project). Open other snapshots from <strong>Rev</strong> next to Last edited.</p>
      <label class="block"><span class="muted small">Revision</span>
        <input type="number" id="v2-modal-version-rev" class="inp" min="1" step="1" value="${nextRev}" />
      </label>
      <label class="block"><span class="muted small">Notes <span class="muted tiny">(optional)</span></span>
        <textarea id="v2-modal-version-notes" class="inp" rows="2" maxlength="2000" placeholder="What changed" autocomplete="off"></textarea>
      </label>
      <p id="v2-modal-version-err" class="v2-modal-inline-err" hidden role="alert"></p>`,
      `<button type="button" class="secondary small-btn" data-v2-modal-close>Cancel</button> <button type="button" class="small-btn" id="v2-modal-save-project-version">Save version</button>`,
    );
  });

  document.getElementById("v2-copy-share-url")?.addEventListener("click", () => {
    const el = document.getElementById("v2-share-url") as HTMLInputElement | null;
    const out = document.getElementById("v2-settings-feedback");
    if (!el?.value) return;
    void navigator.clipboard.writeText(el.value).then(
      () => {
        if (out) out.textContent = "Link copied.";
      },
      () => {
        el.select();
        if (out) out.textContent = "Select the link and copy manually (Cmd+C or Ctrl+C).";
      },
    );
  });

  document.getElementById("studio-delete")?.addEventListener("click", () => {
    const w = ensureWorking(opts.getSelectedId());
    if (!confirm(`Delete project "${w.name}"? This cannot be undone.`)) return;
    const id = w.id;
    deleteSystem(id);
    working = null;
    workingSourceId = null;
    opts.setSelectedId(null);
    window.location.hash = "#dashboard";
  });

  shell.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const w = ensureWorking(opts.getSelectedId());
    const v2 = ensureStudioV2(w);

    if (target.id === "v2-modal-save-project-version") {
      ev.preventDefault();
      const wVer = ensureWorking(opts.getSelectedId());
      syncWorkingFromDom(wVer);
      const errEl = document.getElementById("v2-modal-version-err");
      const revRaw = (document.getElementById("v2-modal-version-rev") as HTMLInputElement | null)?.value ?? "";
      const rev = Math.floor(Number(revRaw));
      if (!Number.isFinite(rev) || rev < 1) {
        if (errEl) {
          errEl.hidden = false;
          errEl.textContent = "Enter a revision number (1 or higher).";
        }
        return;
      }
      if (revisionNumberTaken(wVer.id, rev)) {
        if (errEl) {
          errEl.hidden = false;
          errEl.textContent = `Revision ${rev} already exists. Choose a different number.`;
        }
        return;
      }
      if (errEl) errEl.hidden = true;
      const notes = (document.getElementById("v2-modal-version-notes") as HTMLTextAreaElement | null)?.value ?? "";
      appendProjectVersion(wVer, { revision: rev, notes });
      if (!wVer.projectMeta) wVer.projectMeta = { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      wVer.projectMeta.activeRevision = rev;
      saveSystem(wVer);
      closeV2Modal();
      const out = document.getElementById("v2-settings-feedback");
      if (out) out.textContent = `Saved as revision ${rev}.`;
      opts.rerender();
      return;
    }

    if (target.id === "v2-open-revisions") {
      ev.preventDefault();
      openProjectRevisionsModal(opts);
      return;
    }

    if (target.matches("[data-v2-switch-revision]")) {
      ev.preventDefault();
      const vid = target.getAttribute("data-v2-switch-revision");
      const revAttr = target.getAttribute("data-v2-revision-num");
      const rev = revAttr != null ? Math.floor(Number(revAttr)) : NaN;
      const pid = opts.getSelectedId();
      if (!vid || !pid || !Number.isFinite(rev)) return;
      if (!confirm(`Open revision ${rev}? Unsaved changes in the editor will be lost.`)) return;
      const restored = restoreProjectVersion(pid, vid);
      if (!restored) {
        opts.setError("Could not load that revision.");
        closeV2Modal();
        opts.rerender();
        return;
      }
      const t = new Date().toISOString();
      restored.projectMeta = {
        createdAt: restored.projectMeta?.createdAt?.trim() || t,
        updatedAt: t,
        activeRevision: rev,
      };
      saveSystem(restored);
      working = null;
      workingSourceId = null;
      closeV2Modal();
      opts.rerender();
      return;
    }

    if (target.closest("[data-v2-modal-close]")) {
      ev.preventDefault();
      closeV2Modal();
      return;
    }
    if (target.matches("[data-v2-modal-back]")) {
      ev.preventDefault();
      popV2ModalLayer();
        return;
      }

    if (target.matches("[data-studio-nav-home]")) {
      ev.preventDefault();
      syncWorkingFromDom(w);
      saveSystem(w);
      opts.setStudioView({ kind: "home" });
      opts.rerender();
          return;
        }
    if (target.matches("[data-studio-view-component]")) {
      ev.preventDefault();
        syncWorkingFromDom(w);
      saveSystem(w);
      const idx = Number(target.getAttribute("data-studio-view-component") ?? -1);
      if (idx >= 0) opts.setStudioView({ kind: "component", index: idx });
      opts.rerender();
        return;
    }

    if (target.matches("[data-v2-gen-rd-edit]")) {
      ev.preventDefault();
      openRandomDiceFormulaModal(w);
      return;
    }

    if (target.id === "v2-modal-save-dice-formula") {
      ev.preventDefault();
      const ta = document.getElementById("v2-modal-dice-formula") as HTMLTextAreaElement | null;
      const raw = ta?.value.trim() ?? "";
      if (raw) {
        const err = validateDiceFormula(raw);
        if (err) {
          const status = document.getElementById("v2-modal-dice-formula-status");
          if (status) {
            status.className = "v2-dice-formula-status v2-dice-formula-status--err";
            status.textContent = `Fix the formula before saving: ${err}`;
          }
          return;
        }
      }
      const destTa = document.getElementById("v2-gen-rd-formula") as HTMLTextAreaElement | null;
      const destRepeat = document.getElementById("v2-gen-rd-repeat") as HTMLInputElement | null;
      const destPreset = document.getElementById("v2-gen-rd-preset") as HTMLSelectElement | null;
      const srcRepeat = document.getElementById("v2-modal-dice-repeat") as HTMLInputElement | null;
      const srcPreset = document.getElementById("v2-modal-dice-preset") as HTMLSelectElement | null;
      if (destTa) destTa.value = ta ? ta.value.trim() : "";
      if (destRepeat && srcRepeat) destRepeat.checked = srcRepeat.checked;
      if (destPreset && srcPreset) destPreset.value = srcPreset.value;
      document.getElementById("v2-dice-pool-popover")?.setAttribute("hidden", "");
      closeV2Modal();
      syncWorkingFromDom(w);
      saveSystem(w);
      opts.rerender();
      return;
    }

    if (target.id === "v2-modal-dice-preview-btn") {
      ev.preventDefault();
      const ta = document.getElementById("v2-modal-dice-formula") as HTMLTextAreaElement | null;
      const pre = document.getElementById("v2-modal-dice-preview-out");
      if (!ta || !pre) return;
      const r = evaluateDiceFormula(ta.value, true);
      pre.hidden = false;
      if (r.ok) pre.textContent = `Result: ${r.value}\n\n${r.lines.join("\n")}`;
      else pre.textContent = r.error;
      return;
    }

    const poolChip = target.closest("[data-dice-pool-chip]");
    if (poolChip) {
      ev.preventDefault();
      openDicePoolPopoverFromChip(poolChip as HTMLElement);
      return;
    }

    if (target.id === "v2-dice-pool-apply") {
      ev.preventDefault();
      applyDicePoolPopover();
      return;
    }

    if (target.id === "v2-dice-pool-popover-close") {
      ev.preventDefault();
      document.getElementById("v2-dice-pool-popover")?.setAttribute("hidden", "");
      return;
    }
    if (target.matches("[data-v2-gen-sa-edit]")) {
      ev.preventDefault();
      const wrap = target.closest("[data-v2-gen-sa-wrap]");
      wrap?.querySelector("[data-v2-gen-sa-summary]")?.setAttribute("hidden", "");
      const ed = wrap?.querySelector("[data-v2-gen-sa-editor]") as HTMLElement | null;
      if (ed) {
        ed.hidden = false;
        (ed.querySelector("input[data-v2-gen-sa-slot]") as HTMLInputElement | null)?.focus();
      }
      return;
    }
    if (target.matches("[data-v2-gen-sa-done]")) {
      ev.preventDefault();
      syncWorkingFromDom(w);
      saveSystem(w);
      opts.rerender();
      return;
    }

    if (target.matches("[data-v2-inline-edit]")) {
      ev.preventDefault();
      const tr = target.closest("tr");
      if (!tr) return;
      if (tr.classList.contains("is-editing")) {
        commitTableRowInputsToDisplay(tr as HTMLTableRowElement);
        tr.classList.remove("is-editing");
    } else {
        shell.querySelectorAll("tr.is-editing").forEach((r) => {
          if (r !== tr) {
            commitTableRowInputsToDisplay(r as HTMLTableRowElement);
            r.classList.remove("is-editing");
          }
        });
        tr.classList.add("is-editing");
        const focusEl = tr.querySelector("input.v2-cell-input:not(.v2-cell-input--toggle)") as HTMLInputElement | null;
        focusEl?.focus();
      }
      return;
    }

    const dispClick = target.closest(".v2-cell-display");
    if (dispClick && !target.closest("tr.is-editing") && !target.closest(".v2-td-actions")) {
      const trOpen = target.closest(
        "[data-stat-row],[data-substat-row],[data-other-row],[data-component-row],[data-library-row],[data-table-row]",
      );
      if (trOpen) {
        ev.preventDefault();
        shell.querySelectorAll("tr.is-editing").forEach((r) => {
          commitTableRowInputsToDisplay(r as HTMLTableRowElement);
          r.classList.remove("is-editing");
        });
        trOpen.classList.add("is-editing");
        const cell = dispClick.closest(".v2-cell");
        const inp =
          (cell?.querySelector("input.v2-cell-input:not(.v2-cell-input--toggle)") as HTMLInputElement | null) ??
          (cell?.querySelector("input.v2-cell-input--toggle") as HTMLInputElement | null);
        inp?.focus();
      return;
    }
    }

    if (target.id === "v2-modal-save-stat") {
      const body = document.getElementById("v2-modal-body");
      const idx = Number(body?.querySelector("[data-modal-stat-idx]")?.getAttribute("data-modal-stat-idx") ?? -1);
      if (idx < 0) return;
      syncWorkingFromDom(w);
      const stat = v2.trackedValues.stats[idx];
      if (!stat) return;
      const nameVal = (document.getElementById("v2-modal-stat-name") as HTMLInputElement | null)?.value.trim() ?? "";
      if (!nameVal) return;
      const idVal = (document.getElementById("v2-modal-stat-id") as HTMLInputElement | null)?.value.trim() ?? "";
      stat.name = nameVal;
      stat.id = idVal || nameVal.toLowerCase().replace(/\s+/g, "_");
      const startRaw = Number((document.getElementById("v2-modal-stat-start") as HTMLInputElement | null)?.value ?? stat.startValue);
      stat.startValue = Number.isFinite(startRaw) ? startRaw : stat.startValue;
      stat.abbreviation = (document.getElementById("v2-modal-stat-abbr") as HTMLInputElement | null)?.value.trim() || undefined;
      stat.usesProficiency = (document.getElementById("v2-modal-stat-prof") as HTMLInputElement | null)?.checked ?? false;
      stat.description = (document.getElementById("v2-modal-stat-desc") as HTMLTextAreaElement | null)?.value.trim() || undefined;
      applyStudioV2ToSystem(w);
      saveSystem(w);
      closeV2Modal();
      opts.rerender();
      return;
    }
    if (target.id === "v2-modal-save-sub") {
      const body = document.getElementById("v2-modal-body");
      const idx = Number(body?.querySelector("[data-modal-sub-idx]")?.getAttribute("data-modal-sub-idx") ?? -1);
      if (idx < 0) return;
      syncWorkingFromDom(w);
      const sub = v2.trackedValues.subStats[idx];
      if (!sub) return;
      const nameVal = (document.getElementById("v2-modal-sub-name") as HTMLInputElement | null)?.value.trim() ?? "";
      if (!nameVal) return;
      const idVal = (document.getElementById("v2-modal-sub-id") as HTMLInputElement | null)?.value.trim() ?? "";
      sub.name = nameVal;
      sub.id = idVal || nameVal.toLowerCase().replace(/\s+/g, "_");
      sub.parentStatId = (document.getElementById("v2-modal-sub-parent") as HTMLSelectElement | null)?.value.trim() ?? "";
      sub.proficiencyEnabled = (document.getElementById("v2-modal-sub-prof") as HTMLInputElement | null)?.checked ?? false;
      sub.description = (document.getElementById("v2-modal-sub-desc") as HTMLTextAreaElement | null)?.value.trim() || undefined;
      applyStudioV2ToSystem(w);
      saveSystem(w);
      closeV2Modal();
      opts.rerender();
      return;
    }
    if (target.id === "v2-modal-save-other") {
      const body = document.getElementById("v2-modal-body");
      const idx = Number(body?.querySelector("[data-modal-other-idx]")?.getAttribute("data-modal-other-idx") ?? -1);
      if (idx < 0) return;
      syncWorkingFromDom(w);
      const oth = v2.trackedValues.otherValues[idx];
      if (!oth) return;
      const nameVal = (document.getElementById("v2-modal-other-name") as HTMLInputElement | null)?.value.trim() ?? "";
      if (!nameVal) return;
      const idVal = (document.getElementById("v2-modal-other-id") as HTMLInputElement | null)?.value.trim() ?? "";
      oth.name = nameVal;
      oth.id = idVal || nameVal.toLowerCase().replace(/\s+/g, "_");
      const startRaw = Number((document.getElementById("v2-modal-other-start") as HTMLInputElement | null)?.value ?? oth.startValue);
      oth.startValue = Number.isFinite(startRaw) ? startRaw : oth.startValue;
      oth.abbreviation = (document.getElementById("v2-modal-other-abbr") as HTMLInputElement | null)?.value.trim() || undefined;
      oth.description = (document.getElementById("v2-modal-other-desc") as HTMLTextAreaElement | null)?.value.trim() || undefined;
      applyStudioV2ToSystem(w);
      saveSystem(w);
      closeV2Modal();
      opts.rerender();
      return;
    }
    if (target.id === "v2-modal-save-component" || target.id === "v2-page-save-component") {
      const wrap =
        document.querySelector("#v2-modal-body [data-modal-component]") ??
        document.querySelector("#v2-component-page [data-modal-component]");
      const idx = Number(wrap?.getAttribute("data-component-index") ?? -1);
      if (idx < 0) return;
      syncWorkingFromDom(w);
      const parsed = readStudioV2ComponentFromModal(w, idx);
      if (!parsed) return;
      v2.buildingBlocks.components[idx] = parsed;
      applyStudioV2ToSystem(w);
      saveSystem(w);
      if (target.id === "v2-page-save-component") {
        opts.setStudioView({ kind: "home" });
        opts.rerender();
      } else {
        closeV2Modal();
        opts.rerender();
      }
      return;
    }
    if (target.id === "v2-modal-save-option" || target.id === "v2-page-save-option") {
      const wrap =
        document.querySelector("#v2-modal-body [data-modal-option]") ??
        document.querySelector("#v2-option-page [data-modal-option]");
      const cIdx = Number(wrap?.getAttribute("data-component-index") ?? -1);
      const oIdx = Number(wrap?.getAttribute("data-option-index") ?? -1);
      if (cIdx < 0 || oIdx < 0) return;
      syncWorkingFromDom(w);
      const comp = v2.buildingBlocks.components[cIdx];
      const prevOpt = comp?.options[oIdx];
      if (!comp || !prevOpt) return;
      comp.options[oIdx] = readOptionDetailFromModal(prevOpt);
      applyStudioV2ToSystem(w);
      saveSystem(w);
      if (target.id === "v2-page-save-option") {
        opts.setStudioView({ kind: "component", index: cIdx });
        opts.rerender();
      return;
    }
      popV2ModalLayer();
      if (v2ModalStack.length) refreshComponentModal(w, cIdx);
      else {
        closeV2Modal();
        opts.rerender();
      }
      return;
    }
    if (target.matches("[data-open-option]")) {
      ev.preventDefault();
      syncWorkingFromDom(w);
      let cIdx = -1;
      let oIdx = -1;
      const modalComp = target.closest("[data-modal-component]");
      if (modalComp) {
        cIdx = Number(modalComp.getAttribute("data-component-index") ?? -1);
        oIdx = Number(target.getAttribute("data-open-option") ?? -1);
      } else {
        cIdx = Number(target.getAttribute("data-open-option") ?? -1);
        oIdx = Number(target.getAttribute("data-option-idx") ?? -1);
      }
      const comp = v2.buildingBlocks.components[cIdx];
      const opt = comp?.options[oIdx];
      if (!comp || !opt) return;
      closeV2Modal();
      opts.setActiveTab("blocks_components");
      opts.setStudioView({ kind: "option", componentIndex: cIdx, optionIndex: oIdx });
      opts.rerender();
      return;
    }
    if (target.matches("[data-component-expand]")) {
      ev.preventDefault();
      const tr = target.closest("[data-component-row]");
      const idx = rowIndex(tr, "componentIndex");
      if (idx < 0) return;
      const expanded = target.getAttribute("aria-expanded") === "true";
      const nextOpen = !expanded;
      target.setAttribute("aria-expanded", nextOpen ? "true" : "false");
      shell.querySelectorAll(`tr[data-component-opt-parent="${idx}"]`).forEach((r) => {
        (r as HTMLElement).hidden = !nextOpen;
      });
      return;
    }
    if (target.id === "v2-comp-add-option") {
      syncWorkingFromDom(w);
      const modalComp = target.closest("[data-modal-component]");
      const cIdx = Number(modalComp?.getAttribute("data-component-index") ?? -1);
      if (cIdx < 0) return;
      const comp = v2.buildingBlocks.components[cIdx];
      if (!comp) return;
      comp.options.push({ id: `option_${Date.now()}`, name: "New instance" });
      applyStudioV2ToSystem(w);
      if (document.getElementById("v2-component-page")) opts.rerender();
      else refreshComponentModal(w, cIdx);
      queuePersist(opts);
      return;
    }
    if (target.matches("[data-modal-remove-option]")) {
        syncWorkingFromDom(w);
      const modalComp = target.closest("[data-modal-component]");
      const cIdx = Number(modalComp?.getAttribute("data-component-index") ?? -1);
      const oIdx = Number(target.getAttribute("data-modal-remove-option") ?? -1);
      if (cIdx < 0 || oIdx < 0) return;
      v2.buildingBlocks.components[cIdx]?.options.splice(oIdx, 1);
      applyStudioV2ToSystem(w);
      if (document.getElementById("v2-component-page")) opts.rerender();
      else refreshComponentModal(w, cIdx);
      queuePersist(opts);
      return;
    }
    if (target.id === "v2-modal-save-library") {
      const row = document.querySelector("#v2-modal-body [data-library-row]");
      if (!row) return;
        syncWorkingFromDom(w);
      const idx = rowIndex(row, "libraryIndex");
      const prevLib = v2.buildingBlocks.libraries[idx];
      const parsed = readStudioV2LibraryFromRow(row, prevLib ?? null);
      if (idx < 0 || !parsed) return;
      v2.buildingBlocks.libraries[idx] = parsed;
      applyStudioV2ToSystem(w);
      saveSystem(w);
      closeV2Modal();
      opts.rerender();
      return;
    }
    if (target.id === "v2-modal-save-table") {
      const row = document.querySelector("#v2-modal-body [data-table-row]");
      if (!row) return;
        syncWorkingFromDom(w);
      const idx = rowIndex(row, "tableIndex");
      const prevTbl = v2.buildingBlocks.tables[idx];
      const parsed = readStudioV2TableFromRow(row, prevTbl ?? null);
      if (idx < 0 || !parsed) return;
      v2.buildingBlocks.tables[idx] = parsed;
      applyStudioV2ToSystem(w);
      saveSystem(w);
      closeV2Modal();
      opts.rerender();
      return;
    }

    if (target.matches("[data-stat-edit]")) {
      ev.preventDefault();
      syncWorkingFromDom(w);
      const row = target.closest("[data-stat-row]");
      const idx = rowIndex(row, "statIndex");
      const stat = v2.trackedValues.stats[idx];
      if (!stat) return;
      openV2ModalLayer(
        `Stat: ${stat.name}`,
        `<div class="v2-modal-form" data-modal-stat-idx="${idx}">
          <div class="form-grid-2">
            <label class="block"><span>Name</span><input id="v2-modal-stat-name" class="inp" value="${escapeHtml(stat.name)}" /></label>
            <label class="block"><span>Id</span><input id="v2-modal-stat-id" class="inp mono" value="${escapeHtml(stat.id)}" /></label>
          </div>
          <label class="block"><span>Starting score</span><input id="v2-modal-stat-start" type="number" class="inp" value="${stat.startValue}" /></label>
          <p class="muted small">Used when the score is not set by the generation method (fallback for extra stats or the <strong>Fixed</strong> method).</p>
          <label class="block"><span>Abbreviation</span><input id="v2-modal-stat-abbr" class="inp" value="${escapeHtml(stat.abbreviation ?? "")}" /></label>
          <label class="check"><input type="checkbox" id="v2-modal-stat-prof"${stat.usesProficiency ? " checked" : ""} /> Uses proficiency bonus</label>
          <label class="block"><span>Description</span><textarea id="v2-modal-stat-desc" class="inp" rows="4">${escapeHtml(stat.description ?? "")}</textarea></label>
        </div>`,
        `<button type="button" class="secondary small-btn" data-v2-modal-close>Cancel</button> <button type="button" class="small-btn" id="v2-modal-save-stat">Save</button>`
      );
      return;
    }
    if (target.matches("[data-sub-edit]")) {
      ev.preventDefault();
      syncWorkingFromDom(w);
      const row = target.closest("[data-substat-row]");
      const idx = rowIndex(row, "substatIndex");
      const sub = v2.trackedValues.subStats[idx];
      if (!sub) return;
      openV2ModalLayer(
        `Sub-stat: ${sub.name}`,
        `<div class="v2-modal-form" data-modal-sub-idx="${idx}">
          <div class="form-grid-2">
            <label class="block"><span>Name</span><input id="v2-modal-sub-name" class="inp" value="${escapeHtml(sub.name)}" /></label>
            <label class="block"><span>Id</span><input id="v2-modal-sub-id" class="inp mono" value="${escapeHtml(sub.id)}" /></label>
          </div>
          <label class="block"><span>Parent stat</span><select id="v2-modal-sub-parent" class="inp">${parentStatOptionsHtml(v2, sub.parentStatId)}</select></label>
          <label class="check"><input type="checkbox" id="v2-modal-sub-prof"${sub.proficiencyEnabled ? " checked" : ""} /> Proficiency applies</label>
          <label class="block"><span>Description</span><textarea id="v2-modal-sub-desc" class="inp" rows="4">${escapeHtml(sub.description ?? "")}</textarea></label>
        </div>`,
        `<button type="button" class="secondary small-btn" data-v2-modal-close>Cancel</button> <button type="button" class="small-btn" id="v2-modal-save-sub">Save</button>`
      );
        return;
    }
    if (target.matches("[data-other-edit]")) {
      ev.preventDefault();
      syncWorkingFromDom(w);
      const row = target.closest("[data-other-row]");
      const idx = rowIndex(row, "otherIndex");
      const oth = v2.trackedValues.otherValues[idx];
      if (!oth) return;
      openV2ModalLayer(
        `Value: ${oth.name}`,
        `<div class="v2-modal-form" data-modal-other-idx="${idx}">
          <div class="form-grid-2">
            <label class="block"><span>Name</span><input id="v2-modal-other-name" class="inp" value="${escapeHtml(oth.name)}" /></label>
            <label class="block"><span>Id</span><input id="v2-modal-other-id" class="inp mono" value="${escapeHtml(oth.id)}" /></label>
          </div>
          <label class="block"><span>Starting value</span><input id="v2-modal-other-start" type="number" class="inp" value="${oth.startValue}" /></label>
          <label class="block"><span>Abbreviation</span><input id="v2-modal-other-abbr" class="inp" value="${escapeHtml(oth.abbreviation ?? "")}" /></label>
          <label class="block"><span>Description</span><textarea id="v2-modal-other-desc" class="inp" rows="4">${escapeHtml(oth.description ?? "")}</textarea></label>
        </div>`,
        `<button type="button" class="secondary small-btn" data-v2-modal-close>Cancel</button> <button type="button" class="small-btn" id="v2-modal-save-other">Save</button>`
      );
      return;
    }
    if (target.matches("[data-component-edit]")) {
      ev.preventDefault();
      syncWorkingFromDom(w);
      saveSystem(w);
      const row = target.closest("[data-component-row]");
      const idx = rowIndex(row, "componentIndex");
      if (idx < 0) return;
      if (!v2.buildingBlocks.components[idx]) return;
      closeV2Modal();
      opts.setActiveTab("blocks_components");
      opts.setStudioView({ kind: "component", index: idx });
      opts.rerender();
        return;
    }
    if (target.matches("[data-library-edit]")) {
      syncWorkingFromDom(w);
      const row = target.closest("[data-library-row]");
      const idx = rowIndex(row, "libraryIndex");
      const lib = v2.buildingBlocks.libraries[idx];
      if (!lib) return;
      openV2ModalLayer(
        `Library: ${lib.name}`,
           `<div class="v2-modal-scroll">${renderLibraryCard(lib, idx, true, v2)}</div>`,
        `<button type="button" class="secondary small-btn" data-v2-modal-close>Cancel</button> <button type="button" class="small-btn" id="v2-modal-save-library">Save</button>`
      );
      return;
    }
    if (target.matches("[data-table-edit]")) {
          syncWorkingFromDom(w);
      const row = target.closest("[data-table-row]");
      const idx = rowIndex(row, "tableIndex");
      const tbl = v2.buildingBlocks.tables[idx];
      if (!tbl) return;
      openV2ModalLayer(
        `Table: ${tbl.name}`,
        `<div class="v2-modal-scroll">${renderTableCard(tbl, idx, true, v2)}</div>`,
        `<button type="button" class="secondary small-btn" data-v2-modal-close>Cancel</button> <button type="button" class="small-btn" id="v2-modal-save-table">Save</button>`
      );
      return;
    }

    if (target.matches("[data-add-effect]")) {
      const wrap = target.closest(".v2-effects");
      if (wrap) {
        const prefix = wrap.getAttribute("data-effects") ?? "fx";
        const n = wrap.querySelectorAll("[data-effect-row]").length;
        target.insertAdjacentHTML("beforebegin", defaultEffectDetails(prefix, n, w));
      }
      return;
    }

    if (target.id === "v2-add-stat") {
      syncWorkingFromDom(w);
      ensureStudioV2(w).trackedValues.stats.push({ id: `stat_${Date.now()}`, name: "New Stat", startValue: 0 });
      opts.rerender();
      return;
    }
    if (target.matches("[data-remove-stat]")) {
      syncWorkingFromDom(w);
      const idx = rowIndex(target.closest("[data-stat-row]"), "statIndex");
      if (idx >= 0) ensureStudioV2(w).trackedValues.stats.splice(idx, 1);
    opts.rerender();
      return;
    }
    if (target.id === "v2-add-substat") {
      syncWorkingFromDom(w);
      ensureStudioV2(w).trackedValues.subStats.push({
        id: `sub_${Date.now()}`,
        name: "New Skill",
        parentStatId: ensureStudioV2(w).trackedValues.stats[0]?.id ?? "",
        proficiencyEnabled: true,
      });
    opts.rerender();
      return;
    }
    if (target.matches("[data-remove-substat]")) {
      syncWorkingFromDom(w);
      const idx = rowIndex(target.closest("[data-substat-row]"), "substatIndex");
      if (idx >= 0) ensureStudioV2(w).trackedValues.subStats.splice(idx, 1);
      opts.rerender();
      return;
    }
    if (target.id === "v2-add-other") {
      syncWorkingFromDom(w);
      ensureStudioV2(w).trackedValues.otherValues.push({ id: `value_${Date.now()}`, name: "New Value", startValue: 0 });
      opts.rerender();
      return;
    }
    if (target.matches("[data-remove-other]")) {
      syncWorkingFromDom(w);
      const idx = rowIndex(target.closest("[data-other-row]"), "otherIndex");
      if (idx >= 0) ensureStudioV2(w).trackedValues.otherValues.splice(idx, 1);
      opts.rerender();
      return;
    }
    if (target.id === "v2-add-component") {
      syncWorkingFromDom(w);
      ensureStudioV2(w).buildingBlocks.components.push({
        id: `component_${Date.now()}`,
        name: "New Component",
        options: [],
      });
      opts.rerender();
      return;
    }
    if (target.matches("[data-remove-component]")) {
      syncWorkingFromDom(w);
      const idx = rowIndex(target.closest("[data-component-row]"), "componentIndex");
      if (idx >= 0) ensureStudioV2(w).buildingBlocks.components.splice(idx, 1);
      opts.rerender();
      return;
    }
    if (target.id === "v2-add-table-group") {
      syncWorkingFromDom(w);
      const bb = ensureStudioV2(w).buildingBlocks;
      if (!bb.tableGroups) bb.tableGroups = [];
      bb.tableGroups.push({ id: `tg_${Date.now()}`, name: "New group" });
      applyStudioV2ToSystem(w);
      opts.rerender();
      return;
    }
    if (target.matches("[data-remove-table-group]")) {
      syncWorkingFromDom(w);
      const idx = rowIndex(target.closest("[data-table-group-row]"), "groupIndex");
      if (idx >= 0) ensureStudioV2(w).buildingBlocks.tableGroups?.splice(idx, 1);
      applyStudioV2ToSystem(w);
      opts.rerender();
      return;
    }
    if (target.id === "v2-add-trait-def") {
      syncWorkingFromDom(w);
      const bb = ensureStudioV2(w).buildingBlocks;
      if (!bb.traits) bb.traits = [];
      bb.traits.push({ id: `trait_${Date.now()}`, name: "New trait" });
      applyStudioV2ToSystem(w);
      opts.rerender();
      return;
    }
    if (target.matches("[data-remove-trait-def]")) {
      syncWorkingFromDom(w);
      const idx = rowIndex(target.closest("[data-trait-row]"), "traitIndex");
      if (idx >= 0) ensureStudioV2(w).buildingBlocks.traits?.splice(idx, 1);
      applyStudioV2ToSystem(w);
      opts.rerender();
      return;
    }
    if (target.id === "v2-add-sheet-sec") {
      syncWorkingFromDom(w);
      const v2s = ensureStudioV2(w);
      if (!v2s.sheetLayout.tableSections) v2s.sheetLayout.tableSections = [];
      const tid = v2s.buildingBlocks.tables[0]?.id ?? "";
      v2s.sheetLayout.tableSections.push({
        id: `sheet_sec_${Date.now()}`,
        title: "New section",
        studioTableId: tid,
        showLabel: true,
        showDescription: false,
        showWeight: false,
      });
      applyStudioV2ToSystem(w);
      opts.rerender();
      return;
    }
    if (target.matches("[data-remove-sheet-sec]")) {
      syncWorkingFromDom(w);
      const idx = rowIndex(target.closest("[data-sheet-sec-row]"), "sheetSecIndex");
      const secs = ensureStudioV2(w).sheetLayout.tableSections;
      if (idx >= 0 && secs) secs.splice(idx, 1);
      applyStudioV2ToSystem(w);
      opts.rerender();
      return;
    }
    if (target.id === "v2-opt-add-inv") {
      syncWorkingFromDom(w);
      const wrap =
        document.querySelector("#v2-modal-body [data-modal-option]") ??
        document.querySelector("#v2-option-page [data-modal-option]");
      const cIdx = Number(wrap?.getAttribute("data-component-index") ?? -1);
      const oIdx = Number(wrap?.getAttribute("data-option-index") ?? -1);
      if (cIdx < 0 || oIdx < 0) return;
      const opt = v2.buildingBlocks.components[cIdx]?.options[oIdx];
      if (!opt) return;
      if (!opt.inventory) opt.inventory = [];
      const firstTable = v2.buildingBlocks.tables.find((t) => t.category === "inventory" || t.category === "weapons");
      opt.inventory.push({ tableId: firstTable?.id ?? "", pick: "random" });
      const comp = v2.buildingBlocks.components[cIdx];
      if (!comp) return;
      if (document.getElementById("v2-option-page")) opts.rerender();
      else {
        replaceV2ModalLayer(
          `${comp.name}: ${opt.name}`,
          `<div class="v2-modal-scroll">${renderOptionDetailBody(cIdx, oIdx, comp, opt, w)}</div>`,
          `<button type="button" class="secondary small-btn" data-v2-modal-back>Back</button> <button type="button" class="small-btn" id="v2-modal-save-option">Save</button>`,
        );
      }
      queuePersist(opts);
      return;
    }
    if (target.id === "v2-opt-add-trait-new") {
      syncWorkingFromDom(w);
      const wrap =
        document.querySelector("#v2-modal-body [data-modal-option]") ??
        document.querySelector("#v2-option-page [data-modal-option]");
      const cIdx = Number(wrap?.getAttribute("data-component-index") ?? -1);
      const oIdx = Number(wrap?.getAttribute("data-option-index") ?? -1);
      if (cIdx < 0 || oIdx < 0) return;
      const opt = v2.buildingBlocks.components[cIdx]?.options[oIdx];
      if (!opt) return;
      if (!opt.traitNew) opt.traitNew = [];
      opt.traitNew.push({ name: "" });
      const comp = v2.buildingBlocks.components[cIdx];
      if (!comp) return;
      if (document.getElementById("v2-option-page")) opts.rerender();
      else {
        replaceV2ModalLayer(
          `${comp.name}: ${opt.name}`,
          `<div class="v2-modal-scroll">${renderOptionDetailBody(cIdx, oIdx, comp, opt, w)}</div>`,
          `<button type="button" class="secondary small-btn" data-v2-modal-back>Back</button> <button type="button" class="small-btn" id="v2-modal-save-option">Save</button>`,
        );
      }
      queuePersist(opts);
          return;
        }
    if (target.matches("[data-remove-inv-row]")) {
      syncWorkingFromDom(w);
      const tr = target.closest("tr[data-inv-row]");
      const wrap =
        document.querySelector("#v2-modal-body [data-modal-option]") ??
        document.querySelector("#v2-option-page [data-modal-option]");
      const cIdx = Number(wrap?.getAttribute("data-component-index") ?? -1);
      const oIdx = Number(wrap?.getAttribute("data-option-index") ?? -1);
      const invIdx = Number((tr as HTMLElement | null)?.dataset.invRow ?? -1);
      const comp = v2.buildingBlocks.components[cIdx];
      const opt = comp?.options[oIdx];
      if (comp && opt?.inventory && invIdx >= 0) opt.inventory.splice(invIdx, 1);
      if (comp && opt) {
        if (document.getElementById("v2-option-page")) opts.rerender();
        else {
          replaceV2ModalLayer(
            `${comp.name}: ${opt.name}`,
            `<div class="v2-modal-scroll">${renderOptionDetailBody(cIdx, oIdx, comp, opt, w)}</div>`,
            `<button type="button" class="secondary small-btn" data-v2-modal-back>Back</button> <button type="button" class="small-btn" id="v2-modal-save-option">Save</button>`,
          );
        }
      }
      queuePersist(opts);
        return;
      }
    if (target.id === "v2-add-library") {
      syncWorkingFromDom(w);
      ensureStudioV2(w).buildingBlocks.libraries.push({
        id: `library_${Date.now()}`,
        name: "New Library",
        entries: [],
      });
        opts.rerender();
        return;
      }
    if (target.matches("[data-remove-library]")) {
      syncWorkingFromDom(w);
      const idx = rowIndex(target.closest("[data-library-row]"), "libraryIndex");
      if (idx >= 0) ensureStudioV2(w).buildingBlocks.libraries.splice(idx, 1);
      opts.rerender();
      return;
    }
    if (target.matches("[data-add-library-entry]")) {
      syncWorkingFromDom(w);
      const idx = rowIndex(target.closest("[data-library-row]"), "libraryIndex");
      if (idx >= 0) ensureStudioV2(w).buildingBlocks.libraries[idx]?.entries.push({ id: `entry_${Date.now()}`, name: "New Entry" });
      applyStudioV2ToSystem(w);
      if (v2ModalIsOpen() && targetInsideModalBody(target) && idx >= 0) {
        refreshLibraryModal(w, idx);
        queuePersist(opts);
      } else opts.rerender();
        return;
      }
    if (target.matches("[data-remove-library-entry]")) {
      syncWorkingFromDom(w);
      const row = target.closest("[data-library-entry-row]");
      const lIdx = rowIndex(row, "libraryIndex");
      const eIdx = rowIndex(row, "entryIndex");
      if (lIdx >= 0 && eIdx >= 0) ensureStudioV2(w).buildingBlocks.libraries[lIdx]?.entries.splice(eIdx, 1);
      applyStudioV2ToSystem(w);
      if (v2ModalIsOpen() && targetInsideModalBody(target) && lIdx >= 0) {
        refreshLibraryModal(w, lIdx);
        queuePersist(opts);
      } else opts.rerender();
        return;
      }
    if (target.id === "v2-add-table") {
      syncWorkingFromDom(w);
      ensureStudioV2(w).buildingBlocks.tables.push({ id: `table_${Date.now()}`, name: "New Table", entries: [] });
      opts.rerender();
      return;
    }
    if (target.matches("[data-remove-table]")) {
      syncWorkingFromDom(w);
      const idx = rowIndex(target.closest("[data-table-row]"), "tableIndex");
      if (idx >= 0) ensureStudioV2(w).buildingBlocks.tables.splice(idx, 1);
    opts.rerender();
      return;
    }
    if (target.matches("[data-add-table-entry]")) {
      syncWorkingFromDom(w);
      const idx = rowIndex(target.closest("[data-table-row]"), "tableIndex");
      if (idx >= 0) ensureStudioV2(w).buildingBlocks.tables[idx]?.entries.push({ id: `table_entry_${Date.now()}`, label: "New Entry" });
      applyStudioV2ToSystem(w);
      if (v2ModalIsOpen() && targetInsideModalBody(target) && idx >= 0) {
        refreshTableModal(w, idx);
        queuePersist(opts);
      } else opts.rerender();
      return;
    }
    if (target.matches("[data-remove-table-entry]")) {
      syncWorkingFromDom(w);
      const row = target.closest("[data-table-entry-row]");
      const tIdx = rowIndex(row, "tableIndex");
      const eIdx = rowIndex(row, "entryIndex");
      if (tIdx >= 0 && eIdx >= 0) ensureStudioV2(w).buildingBlocks.tables[tIdx]?.entries.splice(eIdx, 1);
      applyStudioV2ToSystem(w);
      if (v2ModalIsOpen() && targetInsideModalBody(target) && tIdx >= 0) {
        refreshTableModal(w, tIdx);
        queuePersist(opts);
      } else opts.rerender();
      return;
    }
    if (target.matches("[data-remove-effect]")) {
      const row = target.closest("[data-effect-row]");
      row?.remove();
      queuePersist(opts);
    }
  });

  if (document.getElementById("v2-settings-root")) {
    updatePublishShareUi();
  }
}

