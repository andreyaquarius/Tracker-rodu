import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const srcRoot = fileURLToPath(new URL("../src/", import.meta.url));
const contextFeatureRoot = fileURLToPath(
  new URL("../src/features/context-graph/", import.meta.url),
);

test("context graph owns a dedicated feature namespace", () => {
  assert.ok(
    existsSync(contextFeatureRoot),
    "Create the context graph under src/features/context-graph instead of extending the family tree renderer.",
  );
  assert.ok(sourceFiles(contextFeatureRoot).length > 0, "The context graph namespace must contain production source.");
});

test("context graph and relation service do not depend on the family tree renderer or repository", () => {
  const contextFiles = [
    ...sourceFiles(contextFeatureRoot),
    join(srcRoot, "services", "contextRelationsService.ts"),
    join(srcRoot, "types", "contextGraph.ts"),
  ].filter(existsSync);

  const forbiddenFamilyImport = /(?:from\s+|import\s*\()["'][^"']*(?:features\/family-tree-view|components\/familyTree|familyTree(?:GraphService|Repository|MutationService))[^"']*["']/u;
  for (const file of contextFiles) {
    assert.doesNotMatch(
      readFileSync(file, "utf8"),
      forbiddenFamilyImport,
      `${file} must not reuse the classic family-tree runtime`,
    );
  }
});

test("classic family tree production files do not import the context relation service", () => {
  const familyFiles = sourceFiles(srcRoot).filter((file) =>
    /(?:[\\/]features[\\/]family-tree-view[\\/]|[\\/]components[\\/]familyTree[\\/]|[\\/]services[\\/]familyTree[^\\/]*\.ts$|[\\/]pages[\\/][^\\/]*FamilyTree[^\\/]*\.tsx$)/u.test(file)
  );
  assert.ok(familyFiles.length > 0, "Expected classic family tree production files to audit.");

  const forbiddenContextImport = /(?:from\s+|import\s*\()["'][^"']*(?:contextRelationsService|features\/context-graph)[^"']*["']/u;
  for (const file of familyFiles) {
    assert.doesNotMatch(
      readFileSync(file, "utf8"),
      forbiddenContextImport,
      `${file} must stay independent from the context graph`,
    );
  }
});

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(root)) {
    const absolute = join(root, entry);
    if (statSync(absolute).isDirectory()) {
      result.push(...sourceFiles(absolute));
    } else if (/\.(?:ts|tsx)$/u.test(entry)) {
      result.push(absolute);
    }
  }
  return result;
}
