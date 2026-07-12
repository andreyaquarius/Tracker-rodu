import type { FamilyTreeIssueDto } from "../types/familyTree";

export type FamilyTreeIssueDisplay = {
  severity: string;
  title: string;
  description: string;
};

const ISSUE_LABELS: Record<string, Omit<FamilyTreeIssueDisplay, "severity">> = {
  missingTree: {
    title: "Дерево не знайдено",
    description: "Поточне родове дерево не знайдено або воно недоступне.",
  },
  missingRootPerson: {
    title: "Не вибрано центральну особу",
    description: "Для дерева ще не задано особу, від якої воно будується.",
  },
  selfRelationship: {
    title: "Особа пов’язана сама із собою",
    description: "У зв’язках є запис, де одна й та сама особа виступає з обох боків.",
  },
  duplicateParentChild: {
    title: "Повторний зв’язок батько/мати-дитина",
    description: "Один і той самий зв’язок між батьком/матір’ю та дитиною додано більше одного разу.",
  },
  biologicalCycle: {
    title: "Зациклення кровної лінії",
    description: "У біологічних зв’язках є коло: нащадок одночасно стає предком у тій самій лінії.",
  },
  repeatedAncestor: {
    title: "Предок повторюється в кількох гілках",
    description: "Та сама особа з’являється в дереві більше одного разу, бо належить до різних гілок.",
  },
  missingPreferredParentSet: {
    title: "???????? ???????? ???????? ???????",
    description: "??? ?????? ??????? ?????? ?????? ???????? ???????????. ????????, ???? ??????? ?????????? ????????? ? ??????.",
  },
  privateLivingPersonVisible: {
    title: "Приватна жива особа показана в дереві",
    description: "У цьому перегляді видно живу особу з приватним статусом. Це попередження про приватність, а не помилка зв’язків.",
  },
  personWithoutName: {
    title: "Особа без імені",
    description: "Для цієї особи не заповнено ім’я або запис імені.",
  },
  multipleBiologicalFathers: {
    title: "Кілька біологічних батьків",
    description: "Для однієї дитини додано більше одного біологічного батька. Перевірте, який зв’язок правильний.",
  },
  multipleBiologicalMothers: {
    title: "Кілька біологічних матерів",
    description: "Для однієї дитини додано більше однієї біологічної матері. Перевірте, який зв’язок правильний.",
  },
  dateConflict: {
    title: "������� ���",
    description: "� ����� � ����, �� ���������� ������ �����: �������� ����������, ������ ��� ����.",
  },
  parentAgeConflict: {
    title: "������� ��������� �� ������",
    description: "������ ������� ������� �� ������ ��� ����. �������, ���� ��� ������ ������� �����������.",
  },
  potentialDuplicatePerson: {
    title: "�������� ����� �����",
    description: "� ����� � ����� ��� � ��������� ϲ� � ��������� ��� �������� ����� ����������. ��������, �� �� �� ���� � �� ���� ������.",
  },
};

const SEVERITY_LABELS: Record<string, string> = {
  info: "Інформація",
  warning: "Попередження",
  critical: "Критично",
  needs_review: "Потрібна перевірка",
};

export function familyTreeIssueDisplay(issue: FamilyTreeIssueDto): FamilyTreeIssueDisplay {
  const mapped = ISSUE_LABELS[issue.code];
  return {
    severity: SEVERITY_LABELS[issue.severity] ?? "Перевірка",
    title: mapped?.title ?? issue.code,
    description: mapped?.description ?? issue.message,
  };
}
