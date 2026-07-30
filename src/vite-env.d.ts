/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  readonly VITE_GOOGLE_PICKER_API_KEY?: string;
  readonly VITE_GOOGLE_DRIVE_APP_ID?: string;
  readonly VITE_LOCAL_EDGE_FUNCTIONS_URL?: string;
  readonly VITE_EXTERNAL_PDF_VIEWER_V2?: string;
  readonly VITE_EXTERNAL_PDF_SOURCE_REVALIDATE_MINUTES?: string;
  readonly VITE_PDF_CLIENT_EXPORT_MAX_BYTES?: string;
  readonly VITE_PDF_CLIENT_EXPORT_MAX_PAGES?: string;
  readonly VITE_PDF_EXPORT_MAX_IMAGE_SIDE?: string;
  readonly VITE_PDF_EXPORT_IMAGE_SCALE?: string;
  readonly VITE_PDF_EXPORT_MAX_ZIP_PIXELS?: string;
  readonly VITE_PDF_EXPORT_MAX_ZIP_MEMORY_BYTES?: string;
  readonly VITE_PDF_VIEWER_RANGE_CHUNK_SIZE?: string;
  readonly VITE_PDF_VIEWER_MAX_DEVICE_PIXEL_RATIO?: string;
  readonly VITE_PDF_VIEWER_MAX_RENDER_SCALE?: string;
  readonly VITE_PDF_VIEWER_MAX_CONCURRENT_RENDERS?: string;
  readonly VITE_PDF_VIEWER_MAX_CANVAS_PIXELS?: string;
  readonly VITE_PDF_VIEWER_MAX_CANVAS_SIDE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
