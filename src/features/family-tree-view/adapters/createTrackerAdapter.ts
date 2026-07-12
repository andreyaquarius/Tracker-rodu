import type {
  FamilyGraphData,
  ParentChildRelation,
  TreePerson,
  TreeUnion,
} from "../types.ts";

export interface TrackerSnapshot<
  TPerson,
  TFamilyGroup,
  TPartnerRelationship,
  TParentSet,
  TParentChild,
> {
  persons: readonly TPerson[];
  familyGroups: readonly TFamilyGroup[];
  partnerRelationships: readonly TPartnerRelationship[];
  parentSets: readonly TParentSet[];
  parentChildRelationships: readonly TParentChild[];
  graphVersion?: string | number;
  permissionFingerprint?: string;
}

export interface TrackerAdapterConfig<
  TPerson,
  TFamilyGroup,
  TPartnerRelationship,
  TParentSet,
  TParentChild,
> {
  mapPerson: (person: TPerson) => TreePerson;
  mapPartnerRelationship: (
    relationship: TPartnerRelationship,
    familyGroups: ReadonlyMap<string, TFamilyGroup>,
  ) => TreeUnion;
  mapParentSet: (
    parentSet: TParentSet,
    familyGroups: ReadonlyMap<string, TFamilyGroup>,
  ) => TreeUnion;
  mapParentChildRelationship: (
    relationship: TParentChild,
  ) => ParentChildRelation;
  getFamilyGroupId: (familyGroup: TFamilyGroup) => string;
}

/**
 * This is the only seam that should know the exact fields of the existing
 * `src/types/familyTree.ts`. The layout engine remains stable when the domain
 * schema evolves.
 */
export function createTrackerFamilyTreeAdapter<
  TPerson,
  TFamilyGroup,
  TPartnerRelationship,
  TParentSet,
  TParentChild,
>(
  config: TrackerAdapterConfig<
    TPerson,
    TFamilyGroup,
    TPartnerRelationship,
    TParentSet,
    TParentChild
  >,
): (
  snapshot: TrackerSnapshot<
    TPerson,
    TFamilyGroup,
    TPartnerRelationship,
    TParentSet,
    TParentChild
  >,
) => FamilyGraphData {
  return snapshot => {
    const familyGroups = new Map(
      snapshot.familyGroups.map(group => [config.getFamilyGroupId(group), group]),
    );
    const unions = [
      ...snapshot.partnerRelationships.map(relationship =>
        config.mapPartnerRelationship(relationship, familyGroups),
      ),
      ...snapshot.parentSets.map(parentSet =>
        config.mapParentSet(parentSet, familyGroups),
      ),
    ];
    const deduplicatedUnions = new Map(unions.map(union => [union.id, union]));
    const adapted: FamilyGraphData = {
      persons: snapshot.persons.map(config.mapPerson),
      unions: [...deduplicatedUnions.values()],
      parentChildRelations: snapshot.parentChildRelationships.map(
        config.mapParentChildRelationship,
      ),
    };
    return {
      ...adapted,
      ...(snapshot.graphVersion === undefined
        ? {}
        : { graphVersion: snapshot.graphVersion }),
      ...(snapshot.permissionFingerprint === undefined
        ? {}
        : { permissionFingerprint: snapshot.permissionFingerprint }),
    };
  };
}
