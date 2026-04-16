import type { RpgSystem } from "./types";
import { DEFAULT_SYSTEM } from "./data/defaultSystem";
import { normalizeSystem } from "./migrate";
import { supabaseConfigured } from "./lib/env";
import { deleteDesignerSystemRow, listDesignerSystems, upsertDesignerSystem } from "./cloud/systemsRepo";
import { deleteProjectVersionsForProject } from "./projectVersions";

const KEY = "rpg-gen-systems-v1";

const DEFAULT_SYSTEM_NORMALIZED: RpgSystem = (() => {
  try {
    return normalizeSystem(structuredClone(DEFAULT_SYSTEM));
  } catch {
    return structuredClone(DEFAULT_SYSTEM);
  }
})();

let customCache: Record<string, RpgSystem> = {};
/** When set, generator uses only these systems (published play mode). */
let playModeSystems: RpgSystem[] | null = null;
let cloudUserId: string | null = null;
type TimerHandle = ReturnType<typeof globalThis.setTimeout>;
const cloudSyncTimers = new Map<string, TimerHandle>();
const CLOUD_DEBOUNCE_MS = 900;

function loadRawLocal(): Record<string, RpgSystem> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, RpgSystem>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistLocalMirror(): void {
  const all: Record<string, RpgSystem> = {};
  for (const [k, v] of Object.entries(customCache)) {
    if (k !== DEFAULT_SYSTEM.id) all[k] = v;
  }
  localStorage.setItem(KEY, JSON.stringify(all));
}

export function isCloudMode(): boolean {
  return supabaseConfigured() && cloudUserId != null;
}

export function setPlayModeSystems(systems: RpgSystem[] | null): void {
  playModeSystems = systems;
}

/**
 * Load systems into memory. Call after auth changes or on startup.
 * When logged in and Supabase is configured, loads from cloud (and mirrors to local cache build).
 * Otherwise loads from localStorage.
 */
export async function hydrateStorage(userId: string | null): Promise<void> {
  cloudUserId = userId;
  customCache = {};

  for (const [k, v] of Object.entries(loadRawLocal())) {
    if (k === DEFAULT_SYSTEM.id) continue;
    try {
      customCache[k] = normalizeSystem(structuredClone(v));
    } catch {
      /* */
    }
  }

  if (userId && supabaseConfigured()) {
    try {
      const rows = await listDesignerSystems(userId);
      for (const r of rows) {
        try {
          customCache[r.system_key] = normalizeSystem(structuredClone(r.data as RpgSystem));
        } catch {
          /* skip invalid row */
        }
      }
    } catch {
      /* offline: keep local merge only */
    }
  }
  persistLocalMirror();
}

function scheduleCloudUpsert(system: RpgSystem): void {
  const uid = cloudUserId;
  if (!uid || !supabaseConfigured()) return;
  const id = system.id;
  const prev = cloudSyncTimers.get(id);
  if (prev) clearTimeout(prev);
  cloudSyncTimers.set(
    id,
    globalThis.setTimeout(() => {
      cloudSyncTimers.delete(id);
      void upsertDesignerSystem(uid, system).catch(() => {
        /* surfaced on next explicit save or refresh */
      });
    }, CLOUD_DEBOUNCE_MS)
  );
}

export function getAllSystems(): RpgSystem[] {
  if (playModeSystems?.length) return playModeSystems;

  const normalizedCustom = Object.values(customCache)
    .filter((s) => s.id !== DEFAULT_SYSTEM.id)
    .map((s) => {
      try {
        return normalizeSystem(structuredClone(s));
      } catch {
        return null;
      }
    })
    .filter((s): s is RpgSystem => s !== null);

  const list = [structuredClone(DEFAULT_SYSTEM_NORMALIZED), ...normalizedCustom];
  const seen = new Set<string>();
  return list.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}

export function getSystem(id: string): RpgSystem | undefined {
  if (playModeSystems?.length) {
    return playModeSystems.find((s) => s.id === id);
  }
  if (id === DEFAULT_SYSTEM.id) return structuredClone(DEFAULT_SYSTEM_NORMALIZED);
  const custom = customCache[id];
  if (!custom) return undefined;
  try {
    return normalizeSystem(structuredClone(custom));
  } catch {
    return undefined;
  }
}

export function saveSystem(system: RpgSystem): void {
  if (system.id === DEFAULT_SYSTEM.id) return;
  const normalized = normalizeSystem(structuredClone(system));
  const t = new Date().toISOString();
  const pm = normalized.projectMeta;
  normalized.projectMeta = {
    createdAt: pm?.createdAt?.trim() || t,
    updatedAt: t,
    ...(pm?.activeRevision != null ? { activeRevision: pm.activeRevision } : {}),
  };
  customCache[normalized.id] = normalized;
  persistLocalMirror();
  scheduleCloudUpsert(normalized);
}

export function deleteSystem(id: string): void {
  if (id === DEFAULT_SYSTEM.id) return;
  delete customCache[id];
  deleteProjectVersionsForProject(id);
  persistLocalMirror();
  const uid = cloudUserId;
  if (uid && supabaseConfigured()) {
    void deleteDesignerSystemRow(uid, id).catch(() => {});
  }
}

export function exportSystemJson(system: RpgSystem): string {
  return JSON.stringify(system, null, 2);
}

export function importSystemJson(text: string): RpgSystem {
  return normalizeSystem(JSON.parse(text));
}

/** Push one system to cloud immediately (e.g. before sign-out). */
export async function flushSystemToCloud(system: RpgSystem): Promise<void> {
  const uid = cloudUserId;
  if (!uid || !supabaseConfigured()) return;
  await upsertDesignerSystem(uid, system);
}
