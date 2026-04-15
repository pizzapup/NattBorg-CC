import type { RpgSystem } from "../types";
import { getSupabase } from "../lib/supabase";
import { normalizeSystem } from "../migrate";

export type PublishVisibility = "public" | "unlisted" | "invite";

function normalizeSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function fetchPublishedPayload(slug: string, inviteSecret: string): Promise<RpgSystem | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb.rpc("fetch_published_generator", {
    p_slug: normalizeSlug(slug),
    p_secret: inviteSecret ?? "",
  });
  if (error) throw new Error(error.message);
  if (data == null) return null;
  try {
    return normalizeSystem(data as RpgSystem);
  } catch {
    return null;
  }
}

export type PublishedRow = {
  slug: string;
  visibility: PublishVisibility;
  source_system_key: string;
  updated_at: string;
  invite_secret: string | null;
};

export async function listMyPublished(userId: string): Promise<PublishedRow[]> {
  const sb = getSupabase();
  if (!sb) return [];
  const { data, error } = await sb
    .from("published_generators")
    .select("slug,visibility,source_system_key,updated_at,invite_secret")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as PublishedRow[];
}

export async function upsertPublishedGenerator(opts: {
  userId: string;
  sourceSystemKey: string;
  slug: string;
  payload: RpgSystem;
  visibility: PublishVisibility;
}): Promise<{ slug: string; inviteSecret: string | null }> {
  const sb = getSupabase();
  if (!sb) throw new Error("Cloud not configured");
  const cleanSlug = normalizeSlug(opts.slug);
  if (!cleanSlug) throw new Error("Choose a URL slug using letters, numbers, and hyphens.");
  const normalized = normalizeSystem(structuredClone(opts.payload));

  const { data: existing, error: selErr } = await sb
    .from("published_generators")
    .select("id,invite_secret")
    .eq("user_id", opts.userId)
    .eq("slug", cleanSlug)
    .maybeSingle();
  if (selErr) throw new Error(selErr.message);

  let inviteSecret: string | null = null;
  if (opts.visibility === "invite") {
    const prev = (existing?.invite_secret as string | null) ?? null;
    inviteSecret = prev && prev.length > 0 ? prev : crypto.randomUUID().replace(/-/g, "");
  }

  const base = {
    user_id: opts.userId,
    source_system_key: opts.sourceSystemKey,
    slug: cleanSlug,
    payload: normalized as unknown as Record<string, unknown>,
    visibility: opts.visibility,
    invite_secret: inviteSecret,
    updated_at: new Date().toISOString(),
  };

  if (existing?.id) {
    const { error } = await sb.from("published_generators").update(base).eq("id", existing.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await sb.from("published_generators").insert(base);
    if (error) throw new Error(error.message);
  }

  return { slug: cleanSlug, inviteSecret };
}

export async function deletePublishedGenerator(userId: string, slug: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  const { error } = await sb
    .from("published_generators")
    .delete()
    .eq("user_id", userId)
    .eq("slug", normalizeSlug(slug));
  if (error) throw new Error(error.message);
}
