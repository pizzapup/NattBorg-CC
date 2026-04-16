/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** When "true", studio skips the sign-in gate (local dev only). */
  readonly VITE_BYPASS_STUDIO_AUTH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

