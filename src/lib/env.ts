export function supabaseConfigured(): boolean {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  return typeof url === "string" && url.length > 0 && typeof key === "string" && key.length > 0;
}
