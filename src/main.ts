import "./styles.css";
import type { Session } from "@supabase/supabase-js";
import type { GeneratedCharacter, ModifierScope, RpgSystem } from "./types";
import { generateCharacter, resolveArchetypeSelections } from "./engine/generate";
import {
  deleteSystem,
  exportSystemJson,
  getAllSystems,
  getSystem,
  hydrateStorage,
  importSystemJson,
  isCloudMode,
  saveSystem,
  setPlayModeSystems,
} from "./storage";
import { createBlankSystem } from "./data/blankSystem";
import { DEFAULT_SYSTEM } from "./data/defaultSystem";
import {
  listProjectVersionSummaries,
  projectVersionDisplayNote,
  restoreProjectVersion,
} from "./projectVersions";
import { ensureWorking, normalizeStudioView, renderStudioBody, wireStudio, type StudioViewState } from "./studio";
import { studioAuthBypassEnabled, supabaseConfigured } from "./lib/env";
import { getSupabase } from "./lib/supabase";
import { fetchPublishedPayload } from "./cloud/publishedRepo";

type AppRoute =
  | { kind: "generate" }
  | { kind: "studio"; projectId?: string }
  | { kind: "dashboard" }
  | { kind: "play"; slug: string };

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Inline SVG for header icon-only menu triggers (stroke inherits `currentColor`). */
const HEADER_MENU_ICON_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>`;

function parseHashRoute(): AppRoute {
  const full = location.hash.replace(/^#/, "").trim() || "generate";
  const [pathPart, queryPart] = full.split("?");
  const raw = pathPart || "generate";
  const params = new URLSearchParams(queryPart ?? "");
  if (raw === "dashboard") return { kind: "dashboard" };
  if (raw === "studio") return { kind: "studio", projectId: params.get("project") ?? undefined };
  if (raw.startsWith("play/")) {
    const slug = raw.slice("play/".length).trim();
    if (slug) return { kind: "play", slug };
  }
  return { kind: "generate" };
}

function renderHeader(
  active: "generate" | "studio" | "dashboard",
  opts: {
    showStudioTab: boolean;
    playBanner?: string;
    studioAuthBypass?: boolean;
    studioProjectName?: string | null;
  }
): string {
  const email = authSession?.user?.email;
  const bypassStudio = Boolean(opts.studioAuthBypass) && active === "studio";
  const localOnlyHint = escapeHtml(
    "Projects stay in this browser only until you sign in. Publishing and cloud sync need an account."
  );
  const offlineHint = escapeHtml(
    "Projects stay in this browser only. Cloud sync and publishing need the hosted app with an account."
  );
  const authBlock =
    bypassStudio && supabaseConfigured() && !authSession
      ? `<div class="site-header-auth"><span class="muted small" title="${localOnlyHint}">Local studio</span></div>`
      : supabaseConfigured()
        ? authSession
          ? `<div class="site-header-auth">
          <span class="site-header-auth__email muted small" title="${escapeHtml(email ?? "")}">${escapeHtml(email ?? "Signed in")}</span>
          <button type="button" class="secondary small-btn" id="auth-signout">Sign out</button>
        </div>`
          : `<div class="site-header-auth"><span class="muted small" title="${localOnlyHint}">Log in</span></div>`
        : `<div class="site-header-auth"><span class="muted tiny" title="${offlineHint}">Local mode</span></div>`;

  const workspaceLinks = opts.showStudioTab
    ? `<a href="#generate" class="${active === "generate" ? "active" : ""}">Character Generator</a>
       <a href="#studio" class="${active === "studio" ? "active" : ""}">System Studio</a>
       <a href="#dashboard" class="${active === "dashboard" ? "active" : ""}">Projects</a>`
    : `<a href="#generate" class="${active === "generate" ? "active" : ""}">Character Generator</a>
       <span class="tabs__disabled" title="Studio is only available in the main app">System Studio</span>
       <span class="tabs__disabled" title="Projects are only available in the main app">Projects</span>`;

  const banner = opts.playBanner
    ? `<div class="play-banner no-print"><p class="play-banner__text">${escapeHtml(opts.playBanner)}</p></div>`
    : "";

  const studioMenuBtn =
    active === "studio" && opts.studioProjectName != null
      ? `<button
        type="button"
        class="site-header__menu-btn studio-v2-menu-btn"
        id="studio-v2-menu-btn"
        aria-label="Open studio navigation"
      >${HEADER_MENU_ICON_SVG}</button>`
      : "";
  const studioProjectLabel =
    active === "studio" && opts.studioProjectName != null
      ? `<span class="site-header__studio-project muted small">${escapeHtml(opts.studioProjectName ?? "")}</span>`
      : "";

  const headerClass = active === "studio" ? "site-header site-header--studio" : "site-header";

  return `
    ${banner}
    <header class="${headerClass}" id="site-header">
      <button
        type="button"
        class="site-header__menu-btn"
        id="site-nav-toggle"
        aria-label="Open menu"
        aria-expanded="false"
        aria-controls="site-nav-drawer"
      >
        ${HEADER_MENU_ICON_SVG}
      </button>
      <a href="#generate" class="site-header__logo">TTRP-CC</a>
      ${studioMenuBtn}
      ${studioProjectLabel}
      <div class="site-header__end">${authBlock}</div>
      <nav class="site-nav-drawer" id="site-nav-drawer" aria-label="Main menu">
        <p class="site-nav-drawer__heading muted tiny">Workspace</p>
        <div class="site-nav-drawer__links tabs">${workspaceLinks}</div>
      </nav>
    </header>
  `;
}

let lastGenerated: GeneratedCharacter | null = null;
let studioSelectedId: string | null = null;
let studioActiveTab = "settings";
let studioView: StudioViewState = { kind: "home" };
let studioDimFocus: string | null = null;
let studioError = "";
let authSession: Session | null = null;
let playLoadError: string | null = null;

async function loadPlayPayload(slug: string): Promise<void> {
  playLoadError = null;
  const secret = new URL(location.href).searchParams.get("k") ?? "";
  try {
    const sys = await fetchPublishedPayload(slug, secret);
    if (!sys) {
      playLoadError = "This generator was not found, or the link or invite key is wrong.";
      setPlayModeSystems([]);
      return;
    }
    setPlayModeSystems([sys]);
 } catch (e) {
    playLoadError = e instanceof Error ? e.message : String(e);
    setPlayModeSystems([]);
  }
}

function renderAuthGate(headerActive: "studio" | "dashboard" = "studio"): string {
  return `
    ${renderHeader(headerActive, { showStudioTab: true })}
    <div class="panel no-print auth-gate">
      <div class="panel__head">
        <h2>Sign in</h2>
        <p class="panel__lede muted">Studio projects sync to your account. Players only need the shared generator link.</p>
      </div>
      <div class="auth-gate__form">
        <label class="block"><span>Email</span>
          <input type="email" id="auth-email" class="inp" autocomplete="email" placeholder="you@example.com" />
        </label>
        <button type="button" class="primary auth-gate__submit" id="auth-send-link">Send magic link</button>
      </div>
      <p id="auth-message" class="muted small" role="status"></p>
      <p class="muted tiny">After Supabase sends the email, open the link to return here. Add this site URL under Authentication → URL configuration in Supabase.</p>
    </div>
  `;
}

function wireAuthGate(): void {
  const msg = document.getElementById("auth-message");
  document.getElementById("auth-send-link")?.addEventListener("click", async () => {
    const sb = getSupabase();
    const email = (document.getElementById("auth-email") as HTMLInputElement | null)?.value?.trim();
    if (!sb || !email) {
      if (msg) msg.textContent = "Enter your email.";
      return;
    }
    if (msg) msg.textContent = "Sending…";
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin + window.location.pathname },
    });
    if (msg) msg.textContent = error ? error.message : "Check your email for the sign-in link.";
  });
}

function wireAuthHeader(): void {
  document.getElementById("auth-signout")?.addEventListener("click", () => {
    void (async () => {
      const sb = getSupabase();
      await sb?.auth.signOut();
    })();
  });
}

function wireSiteHeaderNav(): void {
  siteHeaderMqCleanup?.();
  siteHeaderMqCleanup = null;
  siteHeaderViewportCleanup?.();
  siteHeaderViewportCleanup = null;

  const header = document.querySelector(".site-header");
  const toggle = document.getElementById("site-nav-toggle");
  const drawer = document.getElementById("site-nav-drawer");
  if (!header || !toggle || !drawer) return;

  const setOpen = (open: boolean): void => {
    header.classList.toggle("is-nav-open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.setAttribute("aria-label", open ? "Close site menu" : "Open site menu");
  };

  toggle.addEventListener("click", () => {
    setOpen(!header.classList.contains("is-nav-open"));
  });

  drawer.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener("click", () => setOpen(false));
  });

  const mq = window.matchMedia("(min-width: 768px)");
  const onMq = (): void => {
    if (mq.matches) setOpen(false);
  };
  mq.addEventListener("change", onMq);
  siteHeaderMqCleanup = () => mq.removeEventListener("change", onMq);

  const syncHeaderBottom = (): void => {
    const rect = header.getBoundingClientRect();
    const bottom = Math.max(0, Math.round(rect.bottom));
    document.documentElement.style.setProperty("--site-header-bottom", `${bottom}px`);
  };
  syncHeaderBottom();
  window.addEventListener("resize", syncHeaderBottom, { passive: true });
  window.addEventListener("scroll", syncHeaderBottom, { passive: true });
  siteHeaderViewportCleanup = () => {
    window.removeEventListener("resize", syncHeaderBottom);
    window.removeEventListener("scroll", syncHeaderBottom);
    document.documentElement.style.removeProperty("--site-header-bottom");
  };
}

function renderGenerate(): string {
  const systems = getAllSystems();
  const isPlay = parseHashRoute().kind === "play";
  const options = systems.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join("");
  const sys = systems[0] ? (getSystem(systems[0].id) ?? systems[0]) : undefined;

  const dimRows =
    sys?.archetypeGroups
      .map((g) => {
        const opts =
          `<option value="">Random</option>` +
          g.options.map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.name)}</option>`).join("");
        return `<label class="block">
          <span>${escapeHtml(g.label)} (optional)</span>
          <select class="pick-dim" data-dim="${escapeHtml(g.id)}">${opts}</select>
        </label>`;
      })
      .join("") ?? "";

  const playNote = isPlay
    ? playLoadError
      ? ""
      : "You are using a shared generator link. Sign in on the main site to edit projects."
    : !isCloudMode() && supabaseConfigured()
      ? "Sign in to load your saved systems in the generator."
      : "";

  const errPanel = playLoadError
    ? `<div class="msg-error">${escapeHtml(playLoadError)}</div>`
    : !systems.length && isPlay
      ? `<div class="msg-error">No generator loaded.</div>`
      : "";

  const emptyState = `
    <div class="empty-state">
      <div class="empty-state__art" aria-hidden="true">
        <span class="empty-state__icon"></span>
      </div>
      <p class="empty-state__title">No character yet</p>
      <p class="empty-state__desc muted">Choose a system, optionally lock dimensions, then run <strong>Generate</strong> in the sidebar. Your sheet and roll details will show here.</p>
    </div>`;

  const sheetInner = lastGenerated ? renderSheet(lastGenerated) : emptyState;

  const debugPanel = lastGenerated
    ? `<div class="debug-panel breakdown">
      <h3 class="debug-panel__h">Stat sources</h3>
      ${renderStatBreakdown(lastGenerated)}
      <h3 class="debug-panel__h">Resource sources</h3>
      ${renderResourceBreakdown(lastGenerated)}
      <h3 class="debug-panel__h">Roll log</h3>
      <div class="roll-log" tabindex="0">${escapeHtml(lastGenerated.rollLog.join("\n"))}</div>
    </div>`
    : "";

  const previewBody = lastGenerated
    ? `
    <div class="preview-tabs no-print" role="tablist" aria-label="Character preview">
      <button type="button" class="preview-tabs__btn is-active" role="tab" id="gen-tab-sheet" aria-selected="true" aria-controls="gen-panel-sheet">Sheet</button>
      <button type="button" class="preview-tabs__btn" role="tab" id="gen-tab-debug" aria-selected="false" aria-controls="gen-panel-debug" tabindex="-1">Sources &amp; log</button>
    </div>
    <div id="gen-panel-sheet" class="preview-panel" role="tabpanel" aria-labelledby="gen-tab-sheet">${sheetInner}</div>
    <div id="gen-panel-debug" class="preview-panel preview-panel--scroll no-print" role="tabpanel" aria-labelledby="gen-tab-debug" hidden>${debugPanel}</div>`
    : `<div id="gen-panel-sheet" class="preview-panel preview-panel--empty" role="region" aria-label="Character preview">${sheetInner}</div>`;

  const dimSection = `<section class="form-section form-section--dims" aria-labelledby="gen-dim-heading">
        <h3 class="form-section__title" id="gen-dim-heading">Dimensions</h3>
        <p class="form-section__hint muted small">Leave as Random to roll. Locks apply on the next generation.</p>
        <div class="row" id="gen-dim-row">${dimRows}</div>
      </section>`;

  return `
    ${renderHeader("generate", { showStudioTab: !isPlay, playBanner: playNote || undefined })}
    ${errPanel}
    <div class="generate-workspace">
      <aside class="generate-sidebar no-print">
        <div class="panel panel--controls no-print">
          <div class="panel__head">
            <h2>Character generator</h2>
            <p class="panel__lede muted">Set up the roll, then generate a character.</p>
          </div>
          <section class="form-section" aria-labelledby="gen-sys-heading">
            <h3 class="form-section__title" id="gen-sys-heading">System</h3>
            <label class="block">
              <span>Active ruleset</span>
              <select id="sys-select">${options}</select>
            </label>
          </section>
          ${dimSection}
          <div class="action-bar">
            <button type="button" class="primary action-bar__primary" id="btn-gen">Generate</button>
            <div class="action-bar__secondary">
              <button type="button" class="secondary" id="btn-rand">Randomize picks</button>
              <button type="button" class="secondary" id="btn-print">Print sheet</button>
            </div>
          </div>
          <details class="disclosure disclosure--muted no-print">
            <summary class="disclosure__summary">Advanced</summary>
            <div class="disclosure__body">
              <label class="check"><input type="checkbox" id="stat-verbose" /> Show full stat roll steps (dice faces, pipeline)</label>
              <p class="muted tiny disclosure__fineprint">One pick per dimension; nested tables resolve automatically. Chargen math is configured in System studio.</p>
            </div>
          </details>
        </div>
      </aside>
      <div class="generate-main">
        <div class="panel panel--sheet print-area">
          <div class="panel__head no-print">
            <h2>Preview</h2>
            <p class="panel__lede muted">Sheet is print-ready. Sources and the roll log live under the second tab.</p>
          </div>
          <div id="sheet-out" class="sheet-preview">${previewBody}</div>
        </div>
      </div>
    </div>
  `;
}

function scopeLabel(scope: ModifierScope): string {
  return scope === "permanent" ? "Permanent" : "Conditional";
}

function renderStatBreakdown(ch: GeneratedCharacter): string {
  const statNames = new Map<string, string>();
  const sys = getSystem(ch.systemId);
  if (sys) for (const s of sys.stats) statNames.set(s.id, s.name);

  const rows = ch.statBreakdown
    .map(
      (m) =>
        `<tr><td>${escapeHtml(statNames.get(m.statId) ?? m.statId)}</td><td>${m.amount >= 0 ? "+" : ""}${m.amount}</td><td>${escapeHtml(scopeLabel(m.scope))}</td><td>${escapeHtml(m.source)}</td></tr>`
    )
    .join("");
  return `<table><thead><tr><th>Stat</th><th>Value / Δ</th><th>Kind</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderResourceBreakdown(ch: GeneratedCharacter): string {
  const names = new Map<string, string>();
  const sys = getSystem(ch.systemId);
  if (sys) for (const r of sys.resources) names.set(r.id, r.name);

  const rows = ch.resourceBreakdown
    .map(
      (m) =>
        `<tr><td>${escapeHtml(names.get(m.resourceId) ?? m.resourceId)}</td><td>${m.amount >= 0 ? "+" : ""}${m.amount}</td><td>${escapeHtml(scopeLabel(m.scope))}</td><td>${escapeHtml(m.source)}</td></tr>`
    )
    .join("");
  return `<table><thead><tr><th>Resource</th><th>Value / Δ</th><th>Kind</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function modListItems(mods: { amount: number; source: string }[]): string {
  if (!mods.length) return `<li class="muted">—</li>`;
  return mods
    .map(
      (m) =>
        `<li><span class="sheet-mod-amt">${m.amount >= 0 ? "+" : ""}${m.amount}</span> ${escapeHtml(m.source)}</li>`
    )
    .join("");
}

function sheetModifierDetails(
  permanent: { amount: number; source: string }[],
  conditional: { amount: number; source: string }[]
): string {
  return `<details class="sheet-mod-sources">
    <summary>Modifier sources</summary>
    <div class="sheet-mod-columns">
      <div>
        <p class="sheet-mod-kicker">Permanent (defaults &amp; character choices)</p>
        <ul class="sheet-mod-list">${modListItems(permanent)}</ul>
      </div>
      <div>
        <p class="sheet-mod-kicker">Conditional (gear, rolled tables, …)</p>
        <ul class="sheet-mod-list">${modListItems(conditional)}</ul>
      </div>
    </div>
  </details>`;
}

function blockTitle(slot: string, sys: RpgSystem | null | undefined): string {
  if (slot.startsWith("list:")) {
    const listId = slot.slice("list:".length);
    const t = sys?.sheetLists[listId]?.sheetTitle?.trim();
    return t || listId;
  }
  switch (slot) {
    case "description":
      return "Description";
    case "traits":
      return "Term definitions";
    case "special":
      return "Special attributes";
    case "notes":
      return "Notes";
    default:
      return "Notes";
  }
}

function sheetScoreModifierHints(sys: RpgSystem | null | undefined): {
  hideScoreIds: Set<string>;
  modFromScore: Map<string, { scoreId: string; subtle: boolean }>;
} {
  const hideScoreIds = new Set<string>();
  const modFromScore = new Map<string, { scoreId: string; subtle: boolean }>();
  const post = sys?.statPostProcess;
  if (!post || post.kind !== "score_to_modifier") return { hideScoreIds, modFromScore };
  for (const x of post.pairs) {
    hideScoreIds.add(x.scoreStatId);
    modFromScore.set(x.modifierStatId, {
      scoreId: x.scoreStatId,
      subtle: x.scoreOnSheet === "subtle",
    });
  }
  return { hideScoreIds, modFromScore };
}

function formatSheetModifierNumber(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

function renderSheet(ch: GeneratedCharacter): string {
  const sys = getSystem(ch.systemId);
  const statUsage = sys?.studioV2?.trackedValues.statUsage ?? "modifier_only";
  const { hideScoreIds, modFromScore } = sheetScoreModifierHints(sys);

  const statEntries = (sys?.stats ?? [])
    .map((def) => {
      const id = def.id;
      if (hideScoreIds.has(id)) return "";
      const v = ch.stats[id] ?? 0;
      const name = def.name ?? id;
      const note = def.sheetExplanation?.trim()
        ? `<p class="sheet-track-note">${escapeHtml(def.sheetExplanation.trim())}</p>`
        : "";
      const mods = ch.statBreakdown.filter((m) => m.statId === id);
      const permanent = mods.filter((m) => m.scope === "permanent");
      const conditional = mods.filter((m) => m.scope === "conditional");
      const details = mods.length ? sheetModifierDetails(permanent, conditional) : "";
      const pair = modFromScore.get(id);
      let valueHtml: string;
      if (pair && statUsage !== "score_only") {
        const scoreVal = ch.stats[pair.scoreId];
        const subtle =
          statUsage === "score_and_modifier" && pair.subtle && scoreVal !== undefined
            ? `<span class="sheet-score-subtle" title="Score">(${scoreVal})</span>`
            : "";
        valueHtml = `<div class="sheet-value-row">${formatSheetModifierNumber(v)}${subtle}</div>`;
      } else {
        valueHtml = statUsage === "modifier_only" ? `${formatSheetModifierNumber(v)}` : `${v}`;
      }
      return `<div class="stat sheet-track">
        <div class="name">${escapeHtml(name)}</div>
        <div class="value">${valueHtml}</div>
        ${note}
        ${details}
      </div>`;
    })
    .join("");

  const resEntries = Object.entries(ch.resources)
    .map(([id, v]) => {
      const def = sys?.resources.find((r) => r.id === id);
      const name = def?.name ?? id;
      const note = def?.sheetExplanation?.trim()
        ? `<p class="sheet-track-note">${escapeHtml(def.sheetExplanation.trim())}</p>`
        : "";
      const mods = ch.resourceBreakdown.filter((m) => m.resourceId === id);
      const permanent = mods.filter((m) => m.scope === "permanent");
      const conditional = mods.filter((m) => m.scope === "conditional");
      const details = mods.length ? sheetModifierDetails(permanent, conditional) : "";
      return `<div class="stat sheet-track">
        <div class="name">${escapeHtml(name)}</div>
        <div class="value">${v}</div>
        ${note}
        ${details}
      </div>`;
    })
    .join("");

  const blocks = ch.blocks
    .map((b) => {
      const title = blockTitle(b.slot, sys);
      const lis = b.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("");
      return `<section><h3>${escapeHtml(title)}</h3><ul>${lis}</ul></section>`;
    })
    .join("");

  const refSections = (ch.referenceTables ?? [])
    .map((rt) => {
      const lis = rt.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("");
      return `<section class="sheet-ref-table"><h3>${escapeHtml(rt.name)}</h3><ul>${lis}</ul></section>`;
    })
    .join("");

  const picks = ch.archetypePicks
    .map(
      (p) =>
        `<strong>${escapeHtml(p.groupLabel)}:</strong> ${escapeHtml(p.option.name)}`
    )
    .join(" &nbsp;·&nbsp; ");

  return `
    <div class="sheet">
      <h3 class="sheet-heading">${escapeHtml(ch.systemName)} — Character</h3>
      <p class="sheet-lineage">${picks}</p>
      <h3 class="sheet-sub">Stats</h3>
      <div class="stat-grid">${statEntries}</div>
      <h3 class="sheet-sub">Resources</h3>
      <div class="stat-grid">${resEntries}</div>
      ${blocks}
      ${refSections}
    </div>
  `;
}

function wireGenerate() {
  const sysSelect = document.getElementById("sys-select") as HTMLSelectElement | null;

  function refreshDimensionSelects() {
    const id = sysSelect?.value;
    const sys = id ? getSystem(id) : undefined;
    const container = document.getElementById("gen-dim-row");
    if (!sys || !container) return;
    container.replaceChildren();
    for (const g of sys.archetypeGroups) {
      const opts =
        `<option value="">Random</option>` +
        g.options.map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.name)}</option>`).join("");
      const lab = document.createElement("label");
      lab.className = "block";
      lab.innerHTML = `<span>${escapeHtml(g.label)} (optional)</span><select class="pick-dim" data-dim="${escapeHtml(g.id)}">${opts}</select>`;
      container.appendChild(lab);
    }
  }

  function readLocks(): Record<string, string> {
    const locks: Record<string, string> = {};
    document.querySelectorAll(".pick-dim").forEach((el) => {
      const id = (el as HTMLElement).dataset.dim;
      const v = (el as HTMLSelectElement).value;
      if (id && v) locks[id] = v;
    });
    return locks;
  }

  function restoreLastPicks() {
    if (!lastGenerated || !sysSelect) return;
    if (!sysSelect.querySelector(`option[value="${CSS.escape(lastGenerated.systemId)}"]`)) return;
    sysSelect.value = lastGenerated.systemId;
    refreshDimensionSelects();
    for (const p of lastGenerated.archetypePicks) {
      const sel = document.querySelector(`.pick-dim[data-dim="${CSS.escape(p.groupId)}"]`) as HTMLSelectElement | null;
      if (sel?.querySelector(`option[value="${CSS.escape(p.option.id)}"]`)) sel.value = p.option.id;
    }
  }

  restoreLastPicks();

  sysSelect?.addEventListener("change", () => {
    refreshDimensionSelects();
  });

  function runGenerate() {
    const id = sysSelect?.value;
    const sys = id ? getSystem(id) : undefined;
    if (!sys) return;
    const locks = readLocks();
    const selections = resolveArchetypeSelections(sys, locks);
    lastGenerated = generateCharacter(sys, selections, {
      verboseStatRolls: (document.getElementById("stat-verbose") as HTMLInputElement | null)?.checked ?? false,
    });
    render();
  }

  document.getElementById("btn-gen")?.addEventListener("click", runGenerate);
  document.getElementById("btn-rand")?.addEventListener("click", () => {
    document.querySelectorAll(".pick-dim").forEach((el) => {
      (el as HTMLSelectElement).value = "";
    });
    runGenerate();
  });
  document.getElementById("btn-print")?.addEventListener("click", () => window.print());

  wirePreviewTabs();
}

function wirePreviewTabs(): void {
  const elSheetTab = document.getElementById("gen-tab-sheet");
  const elDebugTab = document.getElementById("gen-tab-debug");
  const elSheetPanel = document.getElementById("gen-panel-sheet");
  const elDebugPanel = document.getElementById("gen-panel-debug");
  if (!elSheetTab || !elDebugTab || !elSheetPanel || !elDebugPanel) return;

  const sheetTab = elSheetTab;
  const debugTab = elDebugTab;
  const sheetPanel = elSheetPanel;
  const debugPanel = elDebugPanel;

  function activate(showSheet: boolean): void {
    sheetTab.classList.toggle("is-active", showSheet);
    debugTab.classList.toggle("is-active", !showSheet);
    sheetTab.setAttribute("aria-selected", String(showSheet));
    debugTab.setAttribute("aria-selected", String(!showSheet));
    sheetTab.tabIndex = showSheet ? 0 : -1;
    debugTab.tabIndex = showSheet ? -1 : 0;
    sheetPanel.hidden = !showSheet;
    debugPanel.hidden = showSheet;
  }

  activate(true);

  sheetTab.addEventListener("click", () => activate(true));
  debugTab.addEventListener("click", () => activate(false));

  const tabs = [sheetTab, debugTab] as const;
  tabs.forEach((tab, i) => {
    tab.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
        ev.preventDefault();
        const next = ev.key === "ArrowRight" ? (i + 1) % 2 : (i - 1 + 2) % 2;
        const target = tabs[next];
        activate(target === sheetTab);
        target.focus();
      }
    });
  });
}

function formatDashboardTs(iso: string | undefined): string {
  if (!iso?.trim()) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return "—";
  }
}

function downloadSystemFile(sys: import("./types").RpgSystem): void {
  const data = exportSystemJson(sys);
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${sys.id || "project"}.rpg-system`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function renderDashboardPage(): string {
  if (supabaseConfigured() && !authSession && !studioAuthBypassEnabled()) {
    return renderAuthGate("dashboard");
  }
  const systems = getAllSystems().filter((s) => s.id !== DEFAULT_SYSTEM.id);
  const rows = systems
    .map((s) => {
      const c = formatDashboardTs(s.projectMeta?.createdAt);
      const u = formatDashboardTs(s.projectMeta?.updatedAt);
      const versions = listProjectVersionSummaries(s.id);
      const verList =
        versions.length === 0
          ? `<p class="muted tiny">No saved versions yet. In the studio: <strong>Project file</strong> → <strong>Save as version…</strong>.</p>`
          : `<ul class="dashboard-version-list">
        ${versions
          .map(
            (v) => {
              const note = projectVersionDisplayNote(v);
              return `<li class="dashboard-version-list__item">
            <span class="muted small">${escapeHtml(formatDashboardTs(v.savedAt))} · Rev ${v.revision}${note ? ` — ${escapeHtml(note)}` : ""}</span>
            <button type="button" class="secondary small-btn" data-dash-restore="${escapeHtml(s.id)}" data-version-id="${escapeHtml(v.id)}" data-revision="${v.revision}">Restore</button>
          </li>`;
            },
          )
          .join("")}
      </ul>`;
      return `<tr>
        <td>
          <strong>${escapeHtml(s.name)}</strong>
          <div class="muted tiny mono">${escapeHtml(s.id)}</div>
        </td>
        <td class="muted small">${escapeHtml(c)}</td>
        <td class="muted small">${escapeHtml(u)}</td>
        <td>
          <a href="#studio?project=${encodeURIComponent(s.id)}" class="secondary small-btn">Open in studio</a>
          <button type="button" class="secondary small-btn" data-dash-download="${escapeHtml(s.id)}">Download</button>
          <button type="button" class="danger small-btn" data-dash-delete="${escapeHtml(s.id)}">Delete</button>
          <details class="dashboard-snaps">
            <summary class="muted small">Versions (${versions.length})</summary>
            ${verList}
          </details>
        </td>
      </tr>`;
    })
    .join("");

  return `
    ${renderHeader("dashboard", { showStudioTab: true })}
    <div class="dashboard-page no-print">
      <div class="panel dashboard-panel">
        <div class="panel__head">
          <h2>Projects</h2>
          <p class="panel__lede muted">Your game systems live here. Open one in System Studio to edit rules, tables, and the character sheet.</p>
        </div>
        <div class="dashboard-toolbar">
          <button type="button" class="primary" id="dash-new-project">New project</button>
          <label class="secondary small-btn dashboard-import-label">Import file<input id="dash-import" type="file" accept=".json,.rpg-system,application/json,text/plain" hidden /></label>
        </div>
        <div class="v2-table-wrap dashboard-table-wrap">
          <table class="v2-data-table dashboard-table">
            <thead>
              <tr><th>Project</th><th>Created</th><th>Last edited</th><th>Actions</th></tr>
            </thead>
            <tbody>${
              rows ||
              `<tr><td colspan="4" class="muted">No projects yet. Create one or import a backup file.</td></tr>`
            }</tbody>
          </table>
        </div>
        <p class="muted tiny dashboard-footnote">Version snapshots are stored in this browser only (last 40 per project).</p>
      </div>
    </div>
  `;
}

function wireDashboard(): void {
  document.getElementById("dash-new-project")?.addEventListener("click", () => {
    const sys = createBlankSystem();
    saveSystem(sys);
    location.hash = `#studio?project=${encodeURIComponent(sys.id)}`;
  });
  document.getElementById("dash-import")?.addEventListener("change", (ev) => {
    const input = ev.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = importSystemJson(String(reader.result ?? ""));
        saveSystem(parsed);
        location.hash = `#studio?project=${encodeURIComponent(parsed.id)}`;
      } catch (e) {
        alert(e instanceof Error ? e.message : "Import failed");
      }
    };
    reader.readAsText(file);
    input.value = "";
  });

  document.querySelectorAll("[data-dash-download]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = (btn as HTMLElement).getAttribute("data-dash-download");
      const sys = id ? getSystem(id) : undefined;
      if (sys && sys.id !== DEFAULT_SYSTEM.id) downloadSystemFile(sys);
    });
  });
  document.querySelectorAll("[data-dash-delete]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = (btn as HTMLElement).getAttribute("data-dash-delete");
      const sys = id ? getSystem(id) : undefined;
      if (!sys || !id) return;
      if (!confirm(`Delete project "${sys.name}"? This cannot be undone.`)) return;
      deleteSystem(id);
      render();
    });
  });
  document.querySelectorAll("[data-dash-restore]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const projectId = (btn as HTMLElement).getAttribute("data-dash-restore");
      const versionId = (btn as HTMLElement).getAttribute("data-version-id");
      if (!projectId || !versionId) return;
      if (!confirm("Replace this project’s current data with this version? Unsaved studio changes will not be merged.")) return;
      const restored = restoreProjectVersion(projectId, versionId);
      if (!restored) {
        alert("Could not restore that version.");
        return;
      }
      const revAttr = (btn as HTMLElement).getAttribute("data-revision");
      const rev = revAttr != null ? Math.floor(Number(revAttr)) : NaN;
      const t = new Date().toISOString();
      restored.projectMeta = {
        createdAt: restored.projectMeta?.createdAt?.trim() || t,
        updatedAt: t,
        ...(Number.isFinite(rev) ? { activeRevision: rev } : {}),
      };
      saveSystem(restored);
      render();
    });
  });
}

function renderStudioPage(): string {
  const bypass = studioAuthBypassEnabled();
  if (supabaseConfigured() && !authSession && !bypass) {
    return renderAuthGate();
  }

  const route = parseHashRoute();
  const projectFromUrl = route.kind === "studio" ? route.projectId : undefined;
  const customSystems = getAllSystems().filter((s) => s.id !== DEFAULT_SYSTEM.id);
  const pickId =
    projectFromUrl && customSystems.some((s) => s.id === projectFromUrl)
      ? projectFromUrl
      : studioSelectedId && customSystems.some((s) => s.id === studioSelectedId)
        ? studioSelectedId
        : customSystems[0]?.id ?? null;
  studioSelectedId = pickId;

  if (!pickId) {
    return `
    ${renderHeader("studio", {
      showStudioTab: true,
      studioAuthBypass: bypass,
      studioProjectName: null,
    })}
    <div class="studio-page no-print panel v2-empty-studio">
      <h2 class="v2-empty-studio__title">No projects yet</h2>
      <p class="muted">Create or import a project from the Projects page.</p>
      <p><a href="#dashboard" class="primary">Go to Projects</a></p>
    </div>`;
  }

  if (studioActiveTab === "overview") studioActiveTab = "settings";
  if (studioActiveTab === "stats") studioActiveTab = "v2_stats";
  if (studioActiveTab === "resources" || studioActiveTab === "tracked") studioActiveTab = "v2_tracked";
  if (studioActiveTab === "chargen" || studioActiveTab === "stat_rules" || studioActiveTab === "v2_generation") {
    studioActiveTab = "v2_stats";
  }
  if (
    studioActiveTab === "weapons" ||
    studioActiveTab === "catalog" ||
    studioActiveTab === "sheetlists" ||
    studioActiveTab === "lists" ||
    studioActiveTab === "gear" ||
    studioActiveTab === "dimensions" ||
    studioActiveTab === "tables" ||
    studioActiveTab === "traits" ||
    studioActiveTab === "blocks"
  ) {
    studioActiveTab = "blocks_components";
  }
  if (studioActiveTab === "advanced") studioActiveTab = "settings";
  const w = ensureWorking(studioSelectedId);
  studioView = normalizeStudioView(w, studioView);

  const localStudioHint = Boolean(bypass && supabaseConfigured() && !authSession);
  return `
    ${renderHeader("studio", {
      showStudioTab: true,
      studioAuthBypass: bypass,
      studioProjectName: w.name,
    })}
    <div class="studio-page no-print">
      ${studioError ? `<div class="msg-error">${escapeHtml(studioError)}</div>` : ""}
      ${renderStudioBody(w, studioActiveTab, studioView, studioDimFocus, localStudioHint)}
    </div>
  `;
}

let hashWired = false;
let siteHeaderMqCleanup: (() => void) | null = null;
let siteHeaderViewportCleanup: (() => void) | null = null;

function render() {
  const app = document.getElementById("app");
  if (!app) return;
  const route = parseHashRoute();
  app.dataset.route =
    route.kind === "studio"
      ? "studio"
      : route.kind === "dashboard"
        ? "dashboard"
        : route.kind === "play"
          ? "play"
          : "generate";
  if (!hashWired) {
    hashWired = true;
    window.addEventListener("hashchange", () => {
      void routeChange();
    });
  }

  if (route.kind === "dashboard") {
    setPlayModeSystems(null);
    app.innerHTML = renderDashboardPage();
    if (supabaseConfigured() && !authSession && !studioAuthBypassEnabled()) {
      wireAuthGate();
      wireSiteHeaderNav();
      return;
    }
    wireAuthHeader();
    wireSiteHeaderNav();
    wireDashboard();
    return;
  }

  if (route.kind === "studio") {
    setPlayModeSystems(null);
    app.innerHTML = renderStudioPage();
    if (supabaseConfigured() && !authSession && !studioAuthBypassEnabled()) {
      wireAuthGate();
      wireSiteHeaderNav();
      return;
    }
    wireAuthHeader();
    wireSiteHeaderNav();
    if (document.getElementById("studio-shell")) {
      wireStudio({
        getSelectedId: () => studioSelectedId,
        setSelectedId: (id) => {
          studioSelectedId = id;
        },
        getActiveTab: () => studioActiveTab,
        setActiveTab: (tab) => {
          studioActiveTab = tab;
        },
        getStudioView: () => studioView,
        setStudioView: (v) => {
          studioView = v;
        },
        getDimFocus: () => studioDimFocus,
        setDimFocus: (groupId) => {
          studioDimFocus = groupId;
        },
        rerender: () => render(),
        setError: (msg) => {
          studioError = msg;
        },
        getUserId: () => authSession?.user?.id ?? null,
      });
    }
    return;
  }

  app.innerHTML = renderGenerate();
  wireAuthHeader();
  wireSiteHeaderNav();
  wireGenerate();
}

async function routeChange(): Promise<void> {
  const route = parseHashRoute();
  if (route.kind === "play") {
    await loadPlayPayload(route.slug);
  } else {
    setPlayModeSystems(null);
    playLoadError = null;
  }
  render();
}

async function boot(): Promise<void> {
  const sb = getSupabase();
  if (sb) {
    const { data } = await sb.auth.getSession();
    authSession = data.session ?? null;
    await hydrateStorage(authSession?.user?.id ?? null);
    sb.auth.onAuthStateChange((_event, session) => {
      void (async () => {
        authSession = session;
        await hydrateStorage(session?.user?.id ?? null);
        render();
      })();
    });
  } else {
    authSession = null;
    await hydrateStorage(null);
  }

  const route = parseHashRoute();
  if (route.kind === "play") {
    await loadPlayPayload(route.slug);
  }
  render();
}

void boot();
