import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import test from "node:test";

const EDGE_ENTRYPOINT = resolve(
  process.cwd(),
  "supabase/functions/process-gedcom-exports/index.ts",
);
const DEPLOY_WORKFLOW = readFileSync(
  resolve(process.cwd(), ".github/workflows/deploy-supabase-functions.yml"),
  "utf8",
);

test("GEDCOM export Edge graph uses explicit file imports", () => {
  const visited = new Set<string>();
  const pending = [EDGE_ENTRYPOINT];

  while (pending.length) {
    const modulePath = pending.pop();
    if (!modulePath || visited.has(modulePath)) continue;
    visited.add(modulePath);

    const source = readFileSync(modulePath, "utf8");
    for (const specifier of localModuleSpecifiers(source)) {
      const importedPath = resolve(dirname(modulePath), specifier);
      assert.ok(
        existsSync(importedPath),
        `${modulePath} imports a missing local module: ${specifier}`,
      );
      assert.ok(
        !statSync(importedPath).isDirectory(),
        `${modulePath} imports a directory instead of a file: ${specifier}`,
      );
      assert.ok(
        extname(importedPath),
        `${modulePath} must include the file extension in Edge import: ${specifier}`,
      );
      pending.push(importedPath);
    }
  }

  assert.ok(visited.size > 1, "Expected to inspect the transitive Edge import graph");
});

test("Edge deployment watches the shared application module roots", () => {
  assert.match(DEPLOY_WORKFLOW, /- "src\/types\/\*\*"/);
  assert.match(DEPLOY_WORKFLOW, /- "src\/utils\/\*\*"/);
});

test("Supabase deployment applies pending database migrations before Edge functions", () => {
  assert.match(DEPLOY_WORKFLOW, /- "supabase\/migrations\/\*\*"/);
  assert.match(
    DEPLOY_WORKFLOW,
    /supabase link --project-ref "\$SUPABASE_PROJECT_REF" --yes/,
  );
  const migrationPosition = DEPLOY_WORKFLOW.indexOf("supabase db push --linked --yes");
  const functionPosition = DEPLOY_WORKFLOW.indexOf("supabase functions deploy");
  assert.ok(migrationPosition >= 0, "Expected the workflow to apply pending migrations");
  assert.ok(
    functionPosition > migrationPosition,
    "Database migrations must finish before compatible Edge Functions deploy",
  );
});

function localModuleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const staticImport = /(?:from\s*|import\s*)["'](\.{1,2}\/[^"']+)["']/g;
  const dynamicImport = /import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
  for (const pattern of [staticImport, dynamicImport]) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}
