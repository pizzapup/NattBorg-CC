import type { RpgSystem } from "../types";
import { getSupabase } from "../lib/supabase";
import { normalizeSystem } from "../migrate";

type DesignerRow = {
  system_key: string;
  title: string;
  data: unknown;
};

export async function listDesignerSystems(userId: string): Promise<DesignerRow[]> {
  const sb = getSupabase();
  if (!sb) return [];
  const { data, error } = await sb
    .from("designer_systems")
    .select("system_key,title,data")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as DesignerRow[];
}

export async function upsertDesignerSystem(userId: string, system: RpgSystem): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  const normalized = normalizeSystem(structuredClone(system));
  const { error } = await sb.from("designer_systems").upsert(
    {
      user_id: userId,
      system_key: normalized.id,
      title: normalized.name,
      data: normalized as unknown as Record<string, unknown>,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,system_key" }
  );
  if (error) throw new Error(error.message);
}

export async function deleteDesignerSystemRow(userId: string, systemKey: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  const { error } = await sb
    .from("designer_systems")
    .delete()
    .eq("user_id", userId)
    .eq("system_key", systemKey);
  if (error) throw new Error(error.message);
}
