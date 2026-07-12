import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const viewport = readFileSync(
  new URL(
    "../src/features/family-tree-view/react/FamilyTreeViewport.tsx",
    import.meta.url,
  ),
  "utf8",
);
const personCard = readFileSync(
  new URL(
    "../src/features/family-tree-view/react/PersonCard.tsx",
    import.meta.url,
  ),
  "utf8",
);
const semanticList = readFileSync(
  new URL(
    "../src/features/family-tree-view/react/FamilyTreeSemanticList.tsx",
    import.meta.url,
  ),
  "utf8",
);
const styles = readFileSync(
  new URL(
    "../src/features/family-tree-view/react/familyTree.css",
    import.meta.url,
  ),
  "utf8",
);

test("viewport forwards the all-descendants command to both tree presentations", () => {
  assert.match(
    viewport,
    /onShowAllDescendants\?: \(personId: string, occurrenceId: string\) => void/,
  );
  assert.match(
    viewport,
    /<FamilyTreeSemanticList[\s\S]*?onShowAllDescendants=\{onShowAllDescendants\}/,
  );
  assert.match(
    viewport,
    /<PersonCard[\s\S]*?onShowAllDescendants=\{onShowAllDescendants\}/,
  );
});

test("person cards expose a separate labelled descendants command", () => {
  assert.match(
    personCard,
    /onShowAllDescendants\?:[\s\S]*?personId: string, occurrenceId: string/,
  );
  assert.match(personCard, /\{onShowAllDescendants \? \(/);
  assert.equal(
    personCard.includes("Показати всіх нащадків особи ${name}"),
    true,
  );
  assert.match(
    personCard,
    /onShowAllDescendants\(personId, node\.occurrenceId\)/,
  );
  assert.match(personCard, /<span aria-hidden="true">⇊<\/span>/);
});

test("the semantic list offers the same person-and-occurrence command", () => {
  assert.match(
    semanticList,
    /onShowAllDescendants\?:[\s\S]*?personId: string, occurrenceId: string/,
  );
  assert.match(
    semanticList,
    /\{personId && onShowAllDescendants \? \(/,
  );
  assert.equal(
    semanticList.includes(
      "Показати всіх нащадків особи ${person?.displayName ?? \"Особа\"}",
    ),
    true,
  );
  assert.match(
    semanticList,
    /onShowAllDescendants\(personId, node\.occurrenceId\)/,
  );
  assert.match(semanticList, /<span aria-hidden="true">⇊<\/span> Усі нащадки/);
  assert.match(styles, /grid-template-columns: minmax\(0, 1fr\) auto auto/);
  assert.match(styles, /\.ft-semantic-list \.ft-semantic-descendants/);
});
