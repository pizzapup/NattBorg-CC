import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseConfigured } from "./env";

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!supabaseConfigured()) return null;
  if (client) return client;
  const url = import.meta.env.VITE_SUPABASE_URL as string;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
  client = createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  return client;
}
