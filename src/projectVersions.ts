import { DEFAULT_SYSTEM } from "./data/defaultSystem";
import { normalizeSystem } from "./migrate";
import type { RpgSystem } from "./types";

const VERSIONS_KEY = "rpg-gen-project-versions-v1";
const MAX_VERSIONS_PER_PROJECT = 40;

export type ProjectVersionSummary = {
  id: string;
  savedAt: string;
  revision: number;
  notes?: string;
  /** @deprecated prefer notes; still shown if notes missing */
  label?: string;
};

type StoredVersion = ProjectVersionSummary & { json: string };

function migrateList(list: StoredVersion[]): { list: StoredVersion[]; changed: boolean } {
  if (!list.some((e) => typeof e.revision !== "number" || !Number.isFinite(e.revision))) {
    return { list, changed: false };
  }
  let maxR = 0;
  for (const e of list) {
    if (typeof e.revision === "number" && Number.isFinite(e.revision) && e.revision > maxR) {
      maxR = Math.floor(e.revision);
    }
  }
  const out = list.map((e) => ({ ...e }));
  const missing = out
    .filter((e) => typeof e.revision !== "number" || !Number.isFinite(e.revision))
    .sort((a, b) => new Date(a.savedAt).getTime() - new Date(b.savedAt).getTime());
  for (const e of missing) {
    maxR += 1;
    const idx = out.findIndex((x) => x.id === e.id);
    if (idx >= 0) out[idx] = { ...out[idx], revision: maxR };
  }
  return { list: out, changed: true };
}

function loadMap(): Record<string, StoredVersion[]> {
  try {
    const raw = localStorage.getItem(VERSIONS_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw) as Record<string, StoredVersion[]>;
    if (!p || typeof p !== "object") return {};
    let mutated = false;
    const next: Record<string, StoredVersion[]> = { ...p };
    for (const pid of Object.keys(next)) {
      const list = next[pid];
      if (!Array.isArray(list)) continue;
      const { list: fixed, changed } = migrateList(list as StoredVersion[]);
      if (changed) {
        next[pid] = fixed;
        mutated = true;
      }
    }
    if (mutated) localStorage.setItem(VERSIONS_KEY, JSON.stringify(next));
    return next;
  } catch {
    return {};
  }
}

function saveMap(m: Record<string, StoredVersion[]>): void {
  localStorage.setItem(VERSIONS_KEY, JSON.stringify(m));
}

export function projectVersionDisplayNote(v: ProjectVersionSummary): string | undefined {
  const n = v.notes?.trim();
  if (n) return n;
  return v.label?.trim() || undefined;
}

/** Next revision number (max existing + 1, or 1). */
export function getNextRevisionNumber(projectId: string): number {
  const all = loadMap();
  const list = all[projectId] ?? [];
  let maxR = 0;
  for (const e of list) {
    if (typeof e.revision === "number" && Number.isFinite(e.revision) && e.revision > maxR) {
      maxR = Math.floor(e.revision);
    }
  }
  return maxR + 1;
}

export function revisionNumberTaken(projectId: string, revision: number, excludeVersionId?: string): boolean {
  const all = loadMap();
  const r = Math.floor(revision);
  return (all[projectId] ?? []).some((v) => v.revision === r && v.id !== excludeVersionId);
}

/** Append a snapshot of the project (browser-only). */
export function appendProjectVersion(system: RpgSystem, opts: { revision: number; notes?: string }): void {
  const id = system.id;
  if (id === DEFAULT_SYSTEM.id) return;
  const rev = Math.floor(opts.revision);
  if (!Number.isFinite(rev) || rev < 1) return;
  const clone = normalizeSystem(structuredClone(system));
  const entry: StoredVersion = {
    id: `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
    savedAt: new Date().toISOString(),
    revision: rev,
    ...(opts.notes?.trim() ? { notes: opts.notes.trim() } : {}),
    json: JSON.stringify(clone),
  };
  const all = loadMap();
  const list = all[id] ?? [];
  list.unshift(entry);
  all[id] = list.slice(0, MAX_VERSIONS_PER_PROJECT);
  saveMap(all);
}

export function listProjectVersionSummaries(projectId: string): ProjectVersionSummary[] {
  const all = loadMap();
  const rows = (all[projectId] ?? []).map(({ id, savedAt, revision, notes, label }) => ({
    id,
    savedAt,
    revision,
    ...(notes ? { notes } : {}),
    ...(label ? { label } : {}),
  }));
  return rows.sort((a, b) => b.revision - a.revision);
}

export function getProjectVersionData(projectId: string, versionId: string): RpgSystem | null {
  const all = loadMap();
  const row = (all[projectId] ?? []).find((v) => v.id === versionId);
  if (!row) return null;
  try {
    return normalizeSystem(JSON.parse(row.json));
  } catch {
    return null;
  }
}

export function deleteProjectVersionsForProject(projectId: string): void {
  const all = loadMap();
  delete all[projectId];
  saveMap(all);
}

/** Restore snapshot into an existing project id (overwrites current data). */
export function restoreProjectVersion(projectId: string, versionId: string): RpgSystem | null {
  const data = getProjectVersionData(projectId, versionId);
  if (!data) return null;
  data.id = projectId;
  return normalizeSystem(data);
}
