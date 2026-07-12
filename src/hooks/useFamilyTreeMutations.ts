import { useCallback, useState } from "react";
import {
  addChildToPerson,
  attachExistingChildToPerson,
  attachExistingParentToPerson,
  attachExistingPartnerToPerson,
  addParentToPerson,
  addPartnerToPerson,
  addSiblingToPerson,
  createPersonInTree,
  createRootPersonInTree,
  deleteRelationship,
  setFamilyTreeRoot,
  updateParentChildRelationship,
  updatePartnerRelationship,
  type AddChildToPersonInput,
  type AddParentToPersonInput,
  type AddPartnerToPersonInput,
  type AddSiblingToPersonInput,
  type AttachExistingChildToPersonInput,
  type AttachExistingParentToPersonInput,
  type AttachExistingPartnerToPersonInput,
  type FamilyTreeCreatePersonInput,
  type FamilyTreeCreateRootPersonInput,
} from "../services/familyTreeMutationService";

type MutationTask<T> = () => Promise<T>;

export function useFamilyTreeMutations() {
  const [isMutating, setIsMutating] = useState(false);
  const [error, setError] = useState("");

  const runMutation = useCallback(async <T,>(task: MutationTask<T>): Promise<T | null> => {
    setIsMutating(true);
    setError("");
    try {
      return await task();
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : "Не вдалося оновити родове дерево.");
      return null;
    } finally {
      setIsMutating(false);
    }
  }, []);

  return {
    isMutating,
    error,
    resetError: () => setError(""),
    createPersonInTree: (input: FamilyTreeCreatePersonInput) =>
      runMutation(() => createPersonInTree(input)),
    createRootPersonInTree: (input: FamilyTreeCreateRootPersonInput) =>
      runMutation(() => createRootPersonInTree(input)),
    setFamilyTreeRoot: (input: Parameters<typeof setFamilyTreeRoot>[0]) =>
      runMutation(() => setFamilyTreeRoot(input)),
    addParentToPerson: (input: AddParentToPersonInput) =>
      runMutation(() => addParentToPerson(input)),
    addPartnerToPerson: (input: AddPartnerToPersonInput) =>
      runMutation(() => addPartnerToPerson(input)),
    addChildToPerson: (input: AddChildToPersonInput) =>
      runMutation(() => addChildToPerson(input)),
    addSiblingToPerson: (input: AddSiblingToPersonInput) =>
      runMutation(() => addSiblingToPerson(input)),
    attachExistingParentToPerson: (input: AttachExistingParentToPersonInput) =>
      runMutation(() => attachExistingParentToPerson(input)),
    attachExistingPartnerToPerson: (input: AttachExistingPartnerToPersonInput) =>
      runMutation(() => attachExistingPartnerToPerson(input)),
    attachExistingChildToPerson: (input: AttachExistingChildToPersonInput) =>
      runMutation(() => attachExistingChildToPerson(input)),
    updateParentChildRelationship: (input: Parameters<typeof updateParentChildRelationship>[0]) =>
      runMutation(() => updateParentChildRelationship(input)),
    updatePartnerRelationship: (input: Parameters<typeof updatePartnerRelationship>[0]) =>
      runMutation(() => updatePartnerRelationship(input)),
    deleteRelationship: (input: Parameters<typeof deleteRelationship>[0]) =>
      runMutation(() => deleteRelationship(input)),
  };
}
