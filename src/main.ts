import "./styles.css";
import type { Session } from "@supabase/supabase-js";
import type { GeneratedCharacter, ModifierScope, RpgSystem } from "./types";
import { generateCharacter, resolveArchetypeSelections } from "./engine/generate";
import { getAllSystems, getSystem, hydrateStorage, isCloudMode, setPlayModeSystems } from "./storage";
import { ensureWorking, renderStudioBody, wireStudio } from "./studio";
import { supabaseConfigured } from "./lib/env";
import { getSupabase } from "./lib/supabase";
import { fetchPublishedPayload } from "./cloud/publishedRepo";

type AppRoute = { kind: "generate" } | { kind: "studio" } | { kind: "play"; slug: string };

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function parseHashRoute(): AppRoute {
  const raw = (location.hash.replace(/^#/, "") || "generate").split("?")[0] ?? "generate";
  if (raw === "studio") return { kind: "studio" };
  if (raw.startsWith("play/")) {
    const slug = raw.slice("play/".length).trim();
    if (slug) return { kind: "play", slug };
  }
  return { kind: "generate" };
}

function renderHeader(active: "generate" | "studio", opts: { showStudioTab: boolean; playBanner?: string }): string {
  const email = authSession?.user?.email;
  const authBlock = supabaseConfigured()
    ? authSession
      ? `<div class="site-header-auth">
          <span class="site-header-auth__email muted small" title="${escapeHtml(email ?? "")}">${escapeHtml(email ?? "Signed in")}</span>
          <button type="button" class="secondary small-btn" id="auth-signout">Sign out</button>
        </div>`
      : `<div class="site-header-auth">
          <span class="muted small">Not signed in</span>
        </div>`
    : `<div class="site-header-auth"><span class="muted tiny">Local mode</span></div>`;

  const studioTab = opts.showStudioTab
    ? `<a href="#studio" class="${active === "studio" ? "active" : ""}">System studio</a>`
    : `<span class="tabs__disabled" title="Studio is only available in the main app">System studio</span>`;

  const banner = opts.playBanner
    ? `<div class="play-banner no-print"><p class="play-banner__text">${escapeHtml(opts.playBanner)}</p></div>`
    : "";

  return `
    ${banner}
    <header class="site-header">
      <div class="site-header__row">
        <h1>RPG Character Generator Studio</h1>
        ${authBlock}
      </div>
      <nav class="tabs">
        <a href="#generate" class="${active === "generate" ? "active" : ""}">Generate</a>
        ${studioTab}
      </nav>
    </header>
  `;
}

let lastGenerated: GeneratedCharacter | null = null;
let studioSelectedId: string | null = null;
let studioActiveTab = "overview";
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

function renderAuthGate(): string {
  return `
    ${renderHeader("studio", { showStudioTab: true })}
    <div class="panel no-print auth-gate">
      <h2>Sign in to use the studio</h2>
      <p class="muted">Projects are saved to your account. The character generator can be shared separately with players.</p>
      <div class="auth-gate__form">
        <label class="block"><span>Email</span>
          <input type="email" id="auth-email" class="inp" autocomplete="email" placeholder="you@example.com" />
        </label>
        <button type="button" class="primary" id="auth-send-link">Send magic link</button>
      </div>
      <p id="auth-message" class="muted small" role="status"></p>
      <p class="muted tiny">After Supabase sends the email, click the link to return here. Add this URL under Authentication → URL configuration in Supabase.</p>
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

  const sheetHtml = lastGenerated ? renderSheet(lastGenerated) : "<p>Select a system and generate a character.</p>";

  return `
    ${renderHeader("generate", { showStudioTab: !isPlay, playBanner: playNote || undefined })}
    ${errPanel}
    <div class="panel no-print">
      <h2>Generator</h2>
      <div class="row">
        <label class="block">
          <span>System</span>
          <select id="sys-select">${options}</select>
        </label>
        ${dimRows}
      </div>
      <div class="actions">
        <button type="button" class="primary" id="btn-gen">Generate</button>
        <button type="button" id="btn-rand">Randomize picks</button>
        <button type="button" id="btn-print">Print sheet</button>
      </div>
      <small class="hint">One pick per character dimension. Sub-tables on each choice roll automatically. Stat method is configured in the studio.</small>
    </div>
    <div class="panel print-area">
      <div id="sheet-out">${sheetHtml}</div>
    </div>
    ${
      lastGenerated
        ? `
    <div class="panel breakdown no-print">
      <h2>Stat sources</h2>
      ${renderStatBreakdown(lastGenerated)}
      <h2>Resource sources</h2>
      ${renderResourceBreakdown(lastGenerated)}
      <h2>Roll log</h2>
      <div class="roll-log">${escapeHtml(lastGenerated.rollLog.join("\n"))}</div>
    </div>`
        : ""
    }
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

function renderSheet(ch: GeneratedCharacter): string {
  const sys = getSystem(ch.systemId);

  const statEntries = Object.entries(ch.stats)
    .map(([id, v]) => {
      const def = sys?.stats.find((s) => s.id === id);
      const name = def?.name ?? id;
      const note = def?.sheetExplanation?.trim()
        ? `<p class="sheet-track-note">${escapeHtml(def.sheetExplanation.trim())}</p>`
        : "";
      const mods = ch.statBreakdown.filter((m) => m.statId === id);
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
    const container = document.querySelector(".panel.no-print .row");
    if (!sys || !container) return;
    const dims = container.querySelectorAll(".pick-dim");
    dims.forEach((el) => el.remove());
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
    lastGenerated = generateCharacter(sys, selections);
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
}

function renderStudioPage(): string {
  if (supabaseConfigured() && !authSession) {
    return renderAuthGate();
  }

  const systems = getAllSystems();
  const pickId =
    studioSelectedId && systems.some((s) => s.id === studioSelectedId)
      ? studioSelectedId
      : (systems[0]?.id ?? null);
  studioSelectedId = pickId;
  if (studioActiveTab === "resources") studioActiveTab = "stats";
  if (studioActiveTab === "weapons" || studioActiveTab === "catalog" || studioActiveTab === "sheetlists") {
    studioActiveTab = "lists";
  }
  const w = ensureWorking(studioSelectedId);

  return `
    ${renderHeader("studio", { showStudioTab: true })}
    <div class="panel no-print studio-page">
      <h2>Project studio</h2>
      ${studioError ? `<div class="msg-error">${escapeHtml(studioError)}</div>` : ""}
      ${renderStudioBody(w, studioActiveTab, studioDimFocus)}
    </div>
  `;
}

let hashWired = false;

function render() {
  const app = document.getElementById("app");
  if (!app) return;
  const route = parseHashRoute();
  if (!hashWired) {
    hashWired = true;
    window.addEventListener("hashchange", () => {
      void routeChange();
    });
  }

  if (route.kind === "studio") {
    setPlayModeSystems(null);
    app.innerHTML = renderStudioPage();
    if (supabaseConfigured() && !authSession) {
      wireAuthGate();
      return;
    }
    wireAuthHeader();
    wireStudio({
      getSelectedId: () => studioSelectedId,
      setSelectedId: (id) => {
        studioSelectedId = id;
      },
      getActiveTab: () => studioActiveTab,
      setActiveTab: (tab) => {
        studioActiveTab = tab;
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
    return;
  }

  app.innerHTML = renderGenerate();
  wireAuthHeader();
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
