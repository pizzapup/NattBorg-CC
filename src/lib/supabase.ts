import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseConfigured } from "./env";

let client: SupabaseClient | null = null;

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    return JSON.parse(atob(b64 + pad)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Service role keys must never run in the browser; Supabase rejects them with "Forbidden use of secret API key". */
function assertBrowserSafeKey(key: string): void {
  const payload = decodeJwtPayload(key);
  if (payload?.role === "service_role") {
    const msg =
      "VITE_SUPABASE_ANON_KEY is set to the service_role (secret) key. In Supabase → Project Settings → API, copy the anon public key into .env / Vercel — never the service_role key.";
    console.error(msg);
    throw new Error(msg);
  }
  if (payload?.role !== "anon" && payload != null) {
    console.warn(
      "Supabase JWT role is not 'anon'; if sign-in fails, confirm you are using the anon public API key."
    );
  }
}

export function getSupabase(): SupabaseClient | null {
  if (!supabaseConfigured()) return null;
  if (client) return client;
  const url = import.meta.env.VITE_SUPABASE_URL as string;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
  assertBrowserSafeKey(key);
  client = createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  return client;
}
