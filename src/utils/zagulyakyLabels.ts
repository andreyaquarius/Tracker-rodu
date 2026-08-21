import type {
  ZagulyakaDatePrecision,
  ZagulyakaEventType,
  ZagulyakaVerificationStatus,
  ZagulyakaWorkflowStatus,
} from "../types/zagulyaky";

export const zagulyakaEventLabels: Record<ZagulyakaEventType, string> = {
  birth: "Народження",
  baptism: "Хрещення",
  marriage: "Шлюб",
  death: "Смерть",
  burial: "Поховання",
  residence: "Проживання",
  census: "Перепис",
  military: "Військова служба",
  migration: "Переселення",
  witness: "Свідок",
  godparent: "Хрещений батько або мати",
  other: "Інша подія",
};

export const zagulyakaVerificationLabels: Record<ZagulyakaVerificationStatus, string> = {
  unverified: "Не перевірено",
  plausible: "Імовірно",
  corroborated: "Є підтвердження",
  verified: "Джерело перевірено",
  disputed: "Суперечливо",
};

export const zagulyakaWorkflowLabels: Record<ZagulyakaWorkflowStatus, string> = {
  draft: "Чернетка",
  pending_review: "На модерації",
  needs_changes: "Потребує уточнення",
  published: "Опубліковано",
  rejected: "Відхилено",
  withdrawn: "Відкликано",
  merged: "Об’єднано з дублем",
  archived: "В архіві",
};

export const zagulyakaDatePrecisionLabels: Record<ZagulyakaDatePrecision, string> = {
  exact: "Точна дата",
  month: "Місяць і рік",
  year: "Тільки рік",
  range: "Діапазон",
  approximate: "Приблизно",
  before: "До вказаної дати",
  after: "Після вказаної дати",
  unknown: "Дата невідома",
};
