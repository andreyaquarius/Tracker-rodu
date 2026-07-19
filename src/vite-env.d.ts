/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  readonly VITE_GOOGLE_PICKER_API_KEY?: string;
  readonly VITE_GOOGLE_DRIVE_APP_ID?: string;
  readonly VITE_LOCAL_EDGE_FUNCTIONS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
