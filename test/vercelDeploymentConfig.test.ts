import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type JsonRecord = Record<string, unknown>;

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as JsonRecord;
const packageLock = JSON.parse(
  readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
) as JsonRecord;
const vercel = JSON.parse(
  readFileSync(new URL("../vercel.json", import.meta.url), "utf8"),
) as JsonRecord;
const gitignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");

function record(value: unknown, label: string): JsonRecord {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as JsonRecord;
}

test("Vercel uses the reproducible Vite build and publishes only dist", () => {
  assert.equal(vercel.$schema, "https://openapi.vercel.sh/vercel.json");
  assert.equal(vercel.framework, "vite");
  assert.equal(vercel.installCommand, "npm ci");
  assert.equal(vercel.buildCommand, "npm run build:vercel");
  assert.equal(vercel.outputDirectory, "dist");
});

test("Vercel preserves generated files before falling back to the Vite SPA", () => {
  assert.deepEqual(vercel.rewrites, [
    {
      source: "/(.*)",
      destination: "/index.html",
    },
  ]);
  assert.equal(vercel.routes, undefined, "legacy routes must not replace Vercel's filesystem-first rewrites");
  assert.equal(vercel.cleanUrls, undefined, "clean URLs can shadow generated */index.html pages");
});

test("Vercel applies conservative security, privacy, and immutable asset headers", () => {
  assert.deepEqual(vercel.headers, [
    {
      source: "/(.*)",
      headers: [
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
        {
          key: "Permissions-Policy",
          value: "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
        },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
      ],
    },
    {
      source: "/assets/(.*)",
      headers: [
        { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
      ],
    },
    {
      source: "/shared-graph/:path*",
      headers: [
        { key: "Cache-Control", value: "private, no-store, max-age=0" },
        { key: "Referrer-Policy", value: "no-referrer" },
        {
          key: "X-Robots-Tag",
          value: "noindex, nofollow, noarchive, nosnippet, noimageindex",
        },
      ],
    },
  ]);

  const serializedHeaders = JSON.stringify(vercel.headers);
  assert.doesNotMatch(serializedHeaders, /Strict-Transport-Security/u);
});

test("the Vercel build generates and verifies public pages after Vite", () => {
  const scripts = record(packageJson.scripts, "package.json scripts");
  assert.equal(
    scripts["build:vercel"],
    "npm run verify:vercel-config && npm run build && node scripts/generate-zagulyaky-public-pages.mjs && npm run verify:hosting",
  );
  assert.equal(scripts["verify:hosting"], "node scripts/verify-hosting-build.mjs");
  assert.equal(scripts["verify:pages"], "node scripts/verify-pages-build.mjs");
  assert.equal(
    scripts["verify:vercel-config"],
    "node --test test/vercelDeploymentConfig.test.ts",
  );

  const steps = String(scripts["build:vercel"])
    .split("&&")
    .map((step) => step.trim());
  assert.deepEqual(steps, [
    "npm run verify:vercel-config",
    "npm run build",
    "node scripts/generate-zagulyaky-public-pages.mjs",
    "npm run verify:hosting",
  ]);
});

test("Vercel and npm ci use the same Node 24 contract", () => {
  assert.deepEqual(packageJson.engines, { node: "24.x" });

  const packages = record(packageLock.packages, "package-lock.json packages");
  const rootPackage = record(packages[""], "package-lock.json root package");
  assert.deepEqual(rootPackage.engines, { node: "24.x" });
});

test("local Vercel project metadata stays outside version control", () => {
  assert.match(gitignore, /^\.vercel\/$/mu);
});
