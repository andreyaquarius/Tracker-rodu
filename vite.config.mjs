import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const HOMEPAGE_JSON_LD = JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": "https://trekerrodu.com.ua/#website",
      name: "Трекер Роду",
      alternateName: "Trekerrodu",
      url: "https://trekerrodu.com.ua/",
      inLanguage: "uk",
    },
    {
      "@type": "WebApplication",
      "@id": "https://trekerrodu.com.ua/#webapplication",
      name: "Трекер Роду",
      alternateName: "Trekerrodu",
      url: "https://trekerrodu.com.ua/",
      applicationCategory: "ReferenceApplication",
      operatingSystem: "Web",
      inLanguage: "uk",
      description:
        "Керуйте родовим дослідженням: від першої зачіпки до підтвердженого факту.",
      image: "https://trekerrodu.com.ua/tracker-rodu-logo.png",
    },
  ],
});

const JSON_LD_SCRIPT_HASH = `'sha256-${createHash("sha256")
  .update(HOMEPAGE_JSON_LD)
  .digest("base64")}'`;

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
  `script-src 'self' ${JSON_LD_SCRIPT_HASH} https://accounts.google.com https://apis.google.com https://www.gstatic.com https://www.googletagmanager.com`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://www.googleapis.com https://content.googleapis.com https://accounts.google.com https://oauth2.googleapis.com https://www.gstatic.com https://www.googletagmanager.com https://www.google-analytics.com https://region1.google-analytics.com",
  "frame-src https://accounts.google.com https://content.googleapis.com https://drive.google.com https://docs.google.com",
].join("; ");

function injectSecurityMeta() {
  return {
    name: "inject-security-meta",
    apply: "build",
    transformIndexHtml(html) {
      const tags = [
        `<script type="application/ld+json">${HOMEPAGE_JSON_LD}</script>`,
        `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`,
        `<meta name="referrer" content="strict-origin-when-cross-origin" />`,
      ].join("\n    ");
      return html.replace("</head>", `    ${tags}\n  </head>`);
    },
  };
}

function warnLegalConfigGaps() {
  return {
    name: "warn-legal-config-gaps",
    apply: "build",
    buildStart() {
      const source = readFileSync(new URL("./src/config/legal.ts", import.meta.url), "utf8");
      const requiredFields = [
        ["operator.legalName", /legalName:\s*null/],
        ["operator.registrationNumber", /registrationNumber:\s*null/],
        ["operator.address", /address:\s*null/],
        ["contacts.supportEmail", /supportEmail:\s*null/],
        ["contacts.privacyEmail", /privacyEmail:\s*null/],
        ["providers.payments", /payments:\s*null/],
      ];
      const missing = requiredFields
        .filter(([, pattern]) => pattern.test(source))
        .map(([field]) => field);

      if (missing.length) {
        this.warn(
          `Legal config has unconfirmed fields: ${missing.join(", ")}. ` +
            "Do not publish contact/payment/operator claims until these values are confirmed.",
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), injectSecurityMeta(), warnLegalConfigGaps()],
  base: "/",
});
