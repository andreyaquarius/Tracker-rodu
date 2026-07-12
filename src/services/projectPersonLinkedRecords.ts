import type {
  ArchiveRequest,
  Finding,
  Hypothesis,
  TaskRecord,
} from "../types";
import { listPersonAnalysisRecords } from "./projectAnalysisRecords";
import { listPersonWorkRecords } from "./projectWorkRecords";

export type PersonLinkedRecords = {
  findings: Finding[];
  tasks: TaskRecord[];
  hypotheses: Hypothesis[];
  archiveRequests: ArchiveRequest[];
};

export function emptyPersonLinkedRecords(): PersonLinkedRecords {
  return {
    findings: [],
    tasks: [],
    hypotheses: [],
    archiveRequests: [],
  };
}

export async function listPersonLinkedRecords(
  projectId: string,
  personId: string,
): Promise<PersonLinkedRecords> {
  const [work, analysis] = await Promise.all([
    listPersonWorkRecords(projectId, personId),
    listPersonAnalysisRecords(projectId, personId),
  ]);
  return {
    ...work,
    ...analysis,
  };
}
