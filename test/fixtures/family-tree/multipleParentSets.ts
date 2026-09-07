import type { FamilyGraphData, ParentChildRelation, TreePerson, TreeUnion } from "../../../src/features/family-tree-view/types.ts";

/** Seven generations, asymmetric alternative families, no real personal data. */
export function multipleParentSetsPedigree() {
  const persons: TreePerson[] = [{ id: "root", displayName: "Центральна особа" }];
  const unions: TreeUnion[] = [];
  const parentChildRelations: ParentChildRelation[] = [];
  const parentsByChild = new Map<string, string[]>();
  const alternativeChildren = new Set(["root", "root/01", "root/00/00", `root${"/00".repeat(6)}`]);
  function addAncestors(childId: string, depth: number, remaining: number, alternatives: boolean) {
    if (!remaining) return;
    const parents: string[] = [];
    for (let group = 0; group < (alternatives && alternativeChildren.has(childId) ? 2 : 1); group++) {
      const unionId = `parents:${childId}:${group}`;
      const memberIds = [0, 1].map(side => `${childId}/${group}${side}`);
      unions.push({ id: unionId, kind: "parent-set", memberIds });
      memberIds.forEach((id, side) => {
        persons.push({ id, displayName: `${group ? "Прийомні" : "Предки"} ${depth + 1} · ${id.slice(5)}`, sex: side ? "female" : "male" });
        parentChildRelations.push({
          id: `r:${id}`, childId, parentId: id, unionId,
          kind: group ? "adoptive" : "biological", role: side ? "mother" : "father",
        });
        parents.push(id);
        addAncestors(id, depth + 1, group ? Math.min(2, remaining - 1) : remaining - 1, alternatives && !group);
      });
    }
    parentsByChild.set(childId, parents);
  }
  addAncestors("root", 0, 7, true);
  return { graph: { persons, unions, parentChildRelations } satisfies FamilyGraphData, parentsByChild };
}
