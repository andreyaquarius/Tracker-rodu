export type PublicPlanCode = "free" | "researcher" | "professional";

export interface PublicFeatureItem {
  title: string;
  description: string;
  planned?: boolean;
}

export interface PublicPlanLimit {
  label: string;
  value: string;
}

export interface PublicPricingPlan {
  code: PublicPlanCode;
  name: string;
  description: string;
  price: string;
  yearlyPrice?: string;
  limits: PublicPlanLimit[];
}

export const publicFeatures: PublicFeatureItem[] = [
  {
    title: "Дослідження",
    description: "Окремі дослідницькі напрями всередині проєкту з власними записами й контекстом.",
  },
  {
    title: "Документи",
    description: "Облік джерел, архівних реквізитів, місць, дат і пов'язаних записів.",
  },
  {
    title: "Запити в архів",
    description: "Фіксація звернень, статусів, архівів, відповідей і пов'язаних осіб.",
  },
  {
    title: "Матриця років",
    description: "Робота з роками, подіями, прогалинами та джерелами у хронологічному вигляді.",
  },
  {
    title: "Завдання",
    description: "Планування перевірок, пошуків, архівних дій і наступних кроків дослідження.",
  },
  {
    title: "Знахідки",
    description: "Збереження фактів, посилань, місць, учасників і документального підтвердження.",
  },
  {
    title: "Гіпотези",
    description: "Окремий простір для припущень, аргументів, статусів і перевірки висновків.",
  },
  {
    title: "Особи",
    description: "Картки людей із подіями, місцями, родинними зв'язками та пов'язаними матеріалами.",
  },
  {
    title: "Глобальний пошук",
    description: "Пошук по робочих розділах проєкту з індексуванням ключових дослідницьких полів.",
  },
  {
    title: "Власні розділи",
    description: "Користувацькі структури для тем, які не вкладаються у стандартні розділи.",
  },
  {
    title: "Власні поля",
    description: "Додаткові поля у стандартних розділах для специфіки конкретного дослідження.",
  },
  {
    title: "Командна робота",
    description: "Запрошення учасників до проєкту та розмежування доступу за ролями.",
  },
  {
    title: "Google Drive",
    description: "Підключення Google Drive для роботи з файлами й дослідницькими матеріалами.",
  },
  {
    title: "Резервні копії",
    description: "Створення й відновлення резервних копій даних проєкту.",
  },
  {
    title: "ШІ-перевірка гіпотез",
    description: "Перевірка дослідницьких гіпотез через серверну функцію та API-ключі.",
  },
  {
    title: "Біографічні довідки",
    description: "Окремі згенеровані або оформлені довідки за даними особи.",
    planned: true,
  },
];

export const publicPricingPlans: PublicPricingPlan[] = [
  {
    code: "free",
    name: "Старт",
    description: "Для першого родового дослідження.",
    price: "0 грн",
    limits: [
      { label: "Робочі простори", value: "1" },
      { label: "Родові дерева", value: "1" },
      { label: "Особи", value: "До 500" },
      { label: "Редактори, крім власника", value: "0" },
      { label: "Глядачі", value: "Без тарифного ліміту" },
      { label: "ШІ-кредити", value: "5 на місяць" },
      { label: "Основні модулі", value: "Включено" },
      { label: "GEDCOM імпорт та експорт", value: "У межах 500 осіб" },
    ],
  },
  {
    code: "researcher",
    name: "Дослідник",
    description: "Для системної особистої роботи.",
    price: "229 грн / місяць",
    yearlyPrice: "2290 грн / рік",
    limits: [
      { label: "Робочі простори", value: "Без тарифного ліміту" },
      { label: "Родові дерева", value: "Без тарифного ліміту" },
      { label: "Особи", value: "До 15 000" },
      { label: "Редактори, крім власника", value: "2" },
      { label: "Глядачі", value: "Без тарифного ліміту" },
      { label: "ШІ-кредити", value: "50 на місяць" },
      { label: "Основні модулі", value: "Включено" },
      { label: "GEDCOM імпорт та експорт", value: "Включено" },
      { label: "Власні поля та розділи", value: "Включено" },
    ],
  },
  {
    code: "professional",
    name: "Професійний",
    description: "Для великих досліджень і командної роботи.",
    price: "699 грн / місяць",
    yearlyPrice: "6990 грн / рік",
    limits: [
      { label: "Робочі простори", value: "Без тарифного ліміту" },
      { label: "Родові дерева", value: "Без тарифного ліміту" },
      { label: "Особи", value: "Без тарифного ліміту" },
      { label: "Редактори, крім власника", value: "5" },
      { label: "Глядачі", value: "Без тарифного ліміту" },
      { label: "ШІ-кредити", value: "100 на місяць" },
      { label: "Основні модулі", value: "Включено" },
      { label: "GEDCOM імпорт та експорт", value: "Включено" },
      { label: "Власні поля та розділи", value: "Включено" },
    ],
  },
];
