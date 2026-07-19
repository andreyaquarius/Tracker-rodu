import type {
  FamilyTreeEdgeDto,
  FamilyTreeGraphDto,
  FamilyTreeNodeDto,
  FamilyTreeOccurrenceDto,
} from "../types/familyTree.ts";

type PathStep = "up" | "down" | "partner" | "other";

export function familyTreeKinshipLabel(
  graph: FamilyTreeGraphDto,
  occurrence: FamilyTreeOccurrenceDto,
  person?: FamilyTreeNodeDto,
): string {
  if (graph.rootPersonId && occurrence.personId === graph.rootPersonId && occurrence.generation === 0) {
    return "центральна особа";
  }

  const pathSteps = relationshipPathSteps(graph, occurrence.path);
  const signature = pathSteps.map((step) => step.kind).join("");
  const targetGender = genderSide(person?.gender);

  if (!pathSteps.length) return generationFallbackLabel(occurrence.generation, targetGender);
  if (signature === "partner") return spouseLabel(targetGender);
  if (pathSteps.some((step) => step.kind === "other")) return "родич";

  if (pathSteps.every((step) => step.kind === "up")) {
    return ancestorLabel(pathSteps.length, targetGender, pathSteps.at(-1)?.edge);
  }
  if (pathSteps.every((step) => step.kind === "down")) {
    return descendantLabel(pathSteps.length, targetGender);
  }

  if (signature === "updown") return siblingLabel(targetGender);
  if (signature === "upupdown") return uncleAuntLabel(targetGender);
  if (signature === "upupdowndown") return cousinLabel(targetGender);
  if (signature === "downpartner") return childPartnerLabel(targetGender);
  if (signature === "updownpartner") return siblingPartnerLabel(targetGender);
  if (signature === "upupdownpartner") return uncleAuntPartnerLabel(targetGender);

  if (pathSteps.some((step) => step.kind === "partner")) {
    return "родич за шлюбом";
  }

  if (pathSteps[0]?.kind === "up" && pathSteps.some((step) => step.kind === "down")) {
    return "родич бічної гілки";
  }
  if (pathSteps[0]?.kind === "down" && pathSteps.some((step) => step.kind === "up")) {
    return "родич бічної гілки нащадків";
  }

  return generationFallbackLabel(occurrence.generation, targetGender);
}

function relationshipPathSteps(
  graph: FamilyTreeGraphDto,
  path: string[],
): Array<{ kind: PathStep; edge?: FamilyTreeEdgeDto }> {
  const steps: Array<{ kind: PathStep; edge?: FamilyTreeEdgeDto }> = [];
  for (let index = 0; index < path.length - 1; index += 1) {
    const fromPersonId = path[index];
    const toPersonId = path[index + 1];
    const edge = graph.edges.find((candidate) =>
      ((candidate.fromPersonId === fromPersonId && candidate.toPersonId === toPersonId) ||
        (candidate.fromPersonId === toPersonId && candidate.toPersonId === fromPersonId)) &&
      (candidate.kind === "parent_child" || candidate.kind === "partner"),
    );
    if (!edge) {
      steps.push({ kind: "other" });
      continue;
    }
    if (edge.kind === "partner") {
      steps.push({ kind: "partner", edge });
      continue;
    }
    if (edge.fromPersonId === toPersonId && edge.toPersonId === fromPersonId) {
      steps.push({ kind: "up", edge });
    } else if (edge.fromPersonId === fromPersonId && edge.toPersonId === toPersonId) {
      steps.push({ kind: "down", edge });
    } else {
      steps.push({ kind: "other", edge });
    }
  }
  return steps;
}

function ancestorLabel(depth: number, gender: "male" | "female" | "unknown", edge: FamilyTreeEdgeDto | undefined): string {
  if (depth === 1) {
    const type = String(edge?.relationshipType ?? "");
    if (type === "adoptive") return gendered(gender, "прийомний батько", "прийомна мати", "прийомний батько/мати");
    if (type === "step") return gendered(gender, "вітчим", "мачуха", "нерідний батько/мати");
    if (type === "guardian") return gendered(gender, "опікун", "опікунка", "опікун/опікунка");
    return gendered(gender, "батько", "мати", "батько/мати");
  }
  if (depth === 2) return gendered(gender, "дідусь", "бабуся", "дідусь/бабуся");
  if (depth === 3) return gendered(gender, "прадідусь", "прабабуся", "прадідусь/прабабуся");
  if (depth === 4) return gendered(gender, "прапрадідусь", "прапрабабуся", "прапрадідусь/прапрабабуся");
  if (depth === 5) return gendered(gender, "прапрапрадідусь", "прапрапрабабуся", "прапрапрадідусь/прапрапрабабуся");
  return `предок ${depth} покоління`;
}

function descendantLabel(depth: number, gender: "male" | "female" | "unknown"): string {
  if (depth === 1) return gendered(gender, "син", "донька", "дитина");
  if (depth === 2) return gendered(gender, "онук", "онука", "онук/онука");
  if (depth === 3) return gendered(gender, "правнук", "правнучка", "правнук/правнучка");
  if (depth === 4) return gendered(gender, "праправнук", "праправнучка", "праправнук/праправнучка");
  if (depth === 5) return gendered(gender, "прапраправнук", "прапраправнучка", "прапраправнук/прапраправнучка");
  return `нащадок ${depth} покоління`;
}

function siblingLabel(gender: "male" | "female" | "unknown"): string {
  return gendered(gender, "брат", "сестра", "брат/сестра");
}

function uncleAuntLabel(gender: "male" | "female" | "unknown"): string {
  return gendered(gender, "дядько", "тітка", "дядько/тітка");
}

function cousinLabel(gender: "male" | "female" | "unknown"): string {
  return gendered(gender, "двоюрідний брат", "двоюрідна сестра", "двоюрідний брат/сестра");
}

function spouseLabel(gender: "male" | "female" | "unknown"): string {
  return gendered(gender, "чоловік", "дружина", "партнер/партнерка");
}

function childPartnerLabel(gender: "male" | "female" | "unknown"): string {
  return gendered(gender, "зять", "невістка", "партнер/партнерка дитини");
}

function siblingPartnerLabel(gender: "male" | "female" | "unknown"): string {
  return gendered(gender, "чоловік сестри", "дружина брата", "партнер/партнерка брата або сестри");
}

function uncleAuntPartnerLabel(gender: "male" | "female" | "unknown"): string {
  return gendered(gender, "чоловік тітки", "дружина дядька", "партнер/партнерка дядька або тітки");
}

function generationFallbackLabel(generation: number, gender: "male" | "female" | "unknown"): string {
  if (generation < 0) return ancestorLabel(Math.abs(generation), gender, undefined);
  if (generation > 0) return descendantLabel(generation, gender);
  return "родич того ж покоління";
}

function gendered(gender: "male" | "female" | "unknown", male: string, female: string, unknown: string): string {
  if (gender === "male") return male;
  if (gender === "female") return female;
  return unknown;
}

function genderSide(value: string | undefined): "male" | "female" | "unknown" {
  const normalized = String(value ?? "").toLocaleLowerCase("uk");
  if (normalized.includes("жін") || normalized.includes("female")) return "female";
  if (normalized.includes("чолов") || normalized.includes("male")) return "male";
  return "unknown";
}
