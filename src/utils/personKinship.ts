import type { PersonGender } from "../types";

export type PersonKinshipKind =
  | "root"
  | "ancestor"
  | "descendant"
  | "collateral"
  | "affinal";

export interface PersonKinshipDescriptor {
  kind: PersonKinshipKind;
  upSteps: number;
  downSteps: number;
  partnerSteps: number;
  orderPath: string;
  /** Blood relative through whom an affinal relationship is formed. */
  viaPersonId?: string;
}

export interface PersonKinshipLabelContext {
  gender?: PersonGender | string;
  viaGender?: PersonGender | string;
}

/**
 * Produces one user-facing relationship name relative to the persisted root
 * person of a tree. The descriptor is deliberately independent from the
 * currently focused card or visualisation mode.
 */
export function personKinshipLabel(
  kinship: PersonKinshipDescriptor,
  context: PersonKinshipLabelContext = {},
): string {
  const gender = genderSide(context.gender);

  if (kinship.kind === "root") return "Коренева особа";
  if (kinship.kind === "ancestor") return ancestorLabel(kinship.upSteps, gender);
  if (kinship.kind === "descendant") return descendantLabel(kinship.downSteps, gender);
  if (kinship.kind === "affinal") {
    return affinalLabel(kinship.upSteps, kinship.downSteps, gender, genderSide(context.viaGender));
  }
  return collateralLabel(kinship.upSteps, kinship.downSteps, gender);
}

function ancestorLabel(depth: number, gender: GenderSide): string {
  if (depth === 1) return gendered(gender, "Батько", "Мати", "Батько або мати");
  if (depth === 2) return gendered(gender, "Дідусь", "Бабуся", "Дідусь або бабуся");
  if (depth === 3) return gendered(gender, "Прадідусь", "Прабабуся", "Прадідусь або прабабуся");
  if (depth === 4) return gendered(gender, "Прапрадідусь", "Прапрабабуся", "Прапрадідусь або прапрабабуся");
  if (depth === 5) return gendered(gender, "Прапрапрадідусь", "Прапрапрабабуся", "Прапрапрадідусь або прапрапрабабуся");
  return gendered(
    gender,
    `Предок ${depth}-го покоління`,
    `Предкиня ${depth}-го покоління`,
    `Предок ${depth}-го покоління`,
  );
}

function descendantLabel(depth: number, gender: GenderSide): string {
  if (depth === 1) return gendered(gender, "Син", "Донька", "Дитина");
  if (depth === 2) return gendered(gender, "Онук", "Онука", "Онук або онука");
  if (depth === 3) return gendered(gender, "Правнук", "Правнучка", "Правнук або правнучка");
  if (depth === 4) return gendered(gender, "Праправнук", "Праправнучка", "Праправнук або праправнучка");
  if (depth === 5) return gendered(gender, "Прапраправнук", "Прапраправнучка", "Прапраправнук або прапраправнучка");
  return gendered(
    gender,
    `Нащадок ${depth}-го покоління`,
    `Нащадниця ${depth}-го покоління`,
    `Нащадок ${depth}-го покоління`,
  );
}

function collateralLabel(upSteps: number, downSteps: number, gender: GenderSide): string {
  if (upSteps === 1 && downSteps === 1) {
    return gendered(gender, "Брат", "Сестра", "Брат або сестра");
  }
  if (upSteps === 2 && downSteps === 1) {
    return gendered(gender, "Дядько", "Тітка", "Дядько або тітка");
  }
  if (upSteps === 1 && downSteps === 2) {
    return gendered(gender, "Племінник", "Племінниця", "Племінник або племінниця");
  }
  if (upSteps === downSteps && upSteps >= 2) {
    const degree = cousinDegreeLabel(upSteps);
    return gendered(
      gender,
      `${degree} брат`,
      `${degreeFeminine(degree)} сестра`,
      `${degree} брат або ${degreeFeminine(degree)} сестра`,
    );
  }

  if (upSteps > downSteps) {
    return olderCollateralLabel(upSteps, downSteps, gender);
  }
  if (downSteps > upSteps) {
    return youngerCollateralLabel(upSteps, downSteps, gender);
  }
  return "Родич того ж покоління";
}

function olderCollateralLabel(upSteps: number, downSteps: number, gender: GenderSide): string {
  const generationGap = upSteps - downSteps;
  if (downSteps === 1) {
    if (generationGap === 1) {
      return gendered(gender, "Дядько", "Тітка", "Дядько або тітка");
    }
    const directTitle = ancestorTitleForCollateral(generationGap, gender);
    return gendered(
      gender,
      `Двоюрідний ${lowercaseFirst(directTitle)}`,
      `Двоюрідна ${lowercaseFirst(directTitle)}`,
      `Двоюрідний родич: ${lowercaseFirst(directTitle)}`,
    );
  }

  const degree = cousinDegreeLabel(downSteps);
  if (generationGap === 1) {
    return gendered(
      gender,
      `${degree} дядько`,
      `${degreeFeminine(degree)} тітка`,
      `${degree} дядько або ${degreeFeminine(degree)} тітка`,
    );
  }
  const directTitle = ancestorTitleForCollateral(generationGap, gender);
  return `${gender === "female" ? degreeFeminine(degree) : degree} ${lowercaseFirst(directTitle)}`;
}

function youngerCollateralLabel(upSteps: number, downSteps: number, gender: GenderSide): string {
  const generationGap = downSteps - upSteps;
  if (upSteps === 1) {
    if (generationGap === 1) {
      return gendered(gender, "Племінник", "Племінниця", "Племінник або племінниця");
    }
    if (generationGap === 2) {
      return gendered(gender, "Внучатий племінник", "Внучата племінниця", "Внучатий племінник або племінниця");
    }
    return gendered(
      gender,
      `Племінник у ${generationGap}-му поколінні`,
      `Племінниця у ${generationGap}-му поколінні`,
      `Племінник або племінниця у ${generationGap}-му поколінні`,
    );
  }

  const degree = cousinDegreeLabel(upSteps);
  if (generationGap === 1) {
    return gendered(
      gender,
      `${degree} племінник`,
      `${degreeFeminine(degree)} племінниця`,
      `${degree} племінник або ${degreeFeminine(degree)} племінниця`,
    );
  }
  const descendant = descendantTitleForCollateral(generationGap, gender);
  return `${gender === "female" ? degreeFeminine(degree) : degree} ${lowercaseFirst(descendant)}`;
}

function affinalLabel(
  viaUpSteps: number,
  viaDownSteps: number,
  gender: GenderSide,
  viaGender: GenderSide,
): string {
  if (viaUpSteps === 0 && viaDownSteps === 0) {
    return gendered(gender, "Чоловік", "Дружина", "Партнер або партнерка");
  }
  if (viaUpSteps === 0 && viaDownSteps === 1) {
    return gendered(gender, "Зять", "Невістка", "Партнер або партнерка дитини");
  }
  if (viaUpSteps === 1 && viaDownSteps === 0) {
    return gendered(gender, "Вітчим", "Мачуха", "Партнер або партнерка батька чи матері");
  }
  if (viaUpSteps === 1 && viaDownSteps === 1) {
    const relative = viaGender === "male" ? "брата" : viaGender === "female" ? "сестри" : "брата або сестри";
    return gendered(gender, `Чоловік ${relative}`, `Дружина ${relative}`, `Партнер або партнерка ${relative}`);
  }
  if (viaUpSteps === 2 && viaDownSteps === 1) {
    const relative = viaGender === "male" ? "дядька" : viaGender === "female" ? "тітки" : "дядька або тітки";
    return gendered(gender, `Чоловік ${relative}`, `Дружина ${relative}`, `Партнер або партнерка ${relative}`);
  }

  const bloodRelation = collateralOrDirectLabel(viaUpSteps, viaDownSteps, viaGender);
  return `Родич за шлюбом (${lowercaseFirst(bloodRelation)})`;
}

function collateralOrDirectLabel(upSteps: number, downSteps: number, gender: GenderSide): string {
  if (upSteps === 0 && downSteps === 0) return "коренева особа";
  if (downSteps === 0) return ancestorLabel(upSteps, gender);
  if (upSteps === 0) return descendantLabel(downSteps, gender);
  return collateralLabel(upSteps, downSteps, gender);
}

function ancestorTitleForCollateral(depth: number, gender: GenderSide): string {
  if (depth === 1) return gendered(gender, "Батько", "Мати", "Батько або мати");
  if (depth === 2) return gendered(gender, "Дідусь", "Бабуся", "Дідусь або бабуся");
  if (depth === 3) return gendered(gender, "Прадідусь", "Прабабуся", "Прадідусь або прабабуся");
  return gendered(gender, `Предок ${depth}-го покоління`, `Предкиня ${depth}-го покоління`, `Предок ${depth}-го покоління`);
}

function descendantTitleForCollateral(depth: number, gender: GenderSide): string {
  if (depth === 1) return gendered(gender, "Син", "Донька", "Дитина");
  if (depth === 2) return gendered(gender, "Онук", "Онука", "Онук або онука");
  if (depth === 3) return gendered(gender, "Правнук", "Правнучка", "Правнук або правнучка");
  return gendered(gender, `Нащадок ${depth}-го покоління`, `Нащадниця ${depth}-го покоління`, `Нащадок ${depth}-го покоління`);
}

function cousinDegreeLabel(upSteps: number): string {
  const degree = Math.max(2, Math.floor(upSteps));
  const known: Record<number, string> = {
    2: "Двоюрідний",
    3: "Троюрідний",
    4: "Чотирирідний",
    5: "П’ятирідний",
    6: "Шестирідний",
    7: "Семирідний",
    8: "Восьмирідний",
  };
  return known[degree] ?? `Родич ${degree}-го ступеня`;
}

function degreeFeminine(value: string): string {
  if (value.endsWith("ний")) return `${value.slice(0, -3)}на`;
  return value;
}

type GenderSide = "male" | "female" | "unknown";

function genderSide(value: PersonGender | string | undefined): GenderSide {
  const normalized = String(value ?? "").trim().toLocaleLowerCase("uk");
  if (normalized.includes("жін") || normalized === "female" || normalized === "f") return "female";
  if (normalized.includes("чолов") || normalized === "male" || normalized === "m") return "male";
  return "unknown";
}

function gendered(gender: GenderSide, male: string, female: string, unknown: string): string {
  if (gender === "male") return male;
  if (gender === "female") return female;
  return unknown;
}

function lowercaseFirst(value: string): string {
  return value ? `${value[0].toLocaleLowerCase("uk")}${value.slice(1)}` : value;
}
