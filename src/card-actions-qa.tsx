import React from "react";
import { createRoot } from "react-dom/client";
import { PersonCard } from "./features/family-tree-view/react/PersonCard.tsx";
import type { LayoutNode, TreePerson } from "./features/family-tree-view/types.ts";
import "./features/family-tree-view/react/familyTree.css";

const person: TreePerson = {
  id: "qa-person",
  displayName: "Дмитренко Петро Васильович",
  sex: "male",
  birth: { display: "24.07.1860" },
  death: { display: "10.03.1907" },
};

const node: LayoutNode = {
  occurrenceId: "person:qa-person",
  personId: "qa-person",
  kind: "person",
  generation: 0,
  x: 0,
  y: 0,
  width: 156,
  height: 166,
  orderKey: "qa",
  lineageRole: "focus",
};

createRoot(document.getElementById("root")!).render(
  <main className="ft-root" style={{ width: 760, height: 460, margin: "24px auto" }}>
    <section className="ft-viewport">
      <div
        className="ft-card-position"
        style={{
          width: 156,
          height: 166,
          transform: "translate3d(275px, 110px, 0) scale(1.45)",
        }}
      >
        <PersonCard
          node={node}
          person={person}
          duplicateCount={1}
          compact={false}
          selected
          branchesCollapsible
          onOpen={() => undefined}
          onFocus={() => undefined}
          onShowAllDescendants={() => undefined}
          onToggleBranches={() => undefined}
          onAddRelative={() => undefined}
        />
      </div>
    </section>
  </main>,
);
