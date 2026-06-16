import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Content-Security-Policy for the production build. Injected as a <meta> tag
// (GitHub Pages cannot set response headers). Inline scripts were removed from
// index.html/404.html so script-src can forbid 'unsafe-inline', which is the
// primary defence against javascript:/inline-script XSS. The Google origins are
// required for Sign-in (GSI) and Drive; Supabase needs REST + realtime (wss).
//
// NOTE: frame-ancestors, X-Content-Type-Options and HSTS cannot be enforced via
// <meta> and require a real header layer (e.g. Cloudflare) — see
// SECURITY_OPERATIONS.md. Validate the Google login + Drive flow in staging
// whenever these origins change.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
  "script-src 'self' https://accounts.google.com https://apis.google.com https://www.gstatic.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://www.googleapis.com https://content.googleapis.com https://accounts.google.com https://oauth2.googleapis.com https://www.gstatic.com",
  "frame-src https://accounts.google.com https://content.googleapis.com https://drive.google.com",
].join("; ");

function injectSecurityMeta() {
  return {
    name: "inject-security-meta",
    apply: "build",
    transformIndexHtml(html) {
      const tags = [
        `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`,
        `<meta name="referrer" content="strict-origin-when-cross-origin" />`,
      ].join("\n    ");
      return html.replace("</head>", `    ${tags}\n  </head>`);
    },
  };
}

export default defineConfig({
  plugins: [react(), injectSecurityMeta()],
  base: "/",
});
