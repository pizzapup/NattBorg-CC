export function supabaseConfigured(): boolean {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  return typeof url === "string" && url.length > 0 && typeof key === "string" && key.length > 0;
}

/**
 * When true, the system studio is available without signing in (even if Supabase env is set).
 * Use only on your machine via `.env.local` — do not enable on public deploys.
 */
export function studioAuthBypassEnabled(): boolean {
  const v = import.meta.env.VITE_BYPASS_STUDIO_AUTH;
  return v === "true" || v === "1";
}
