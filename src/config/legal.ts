export const legalConfig = {
  serviceName: "Трекер Роду",
  brandName: "Trekerrodu",
  siteUrl: "https://trekerrodu.com.ua",
  currentRevision: {
    id: "2026-07-16",
    label: "16 липня 2026 року",
  },
  operator: {
    displayName: "Власник вебзастосунку «Трекер Роду»",
    legalName: null,
    registrationNumber: null,
    taxNumber: null,
    address: null,
    phone: null,
  },
  contacts: {
    supportEmail: null,
    privacyEmail: null,
  },
  providers: {
    database: "Supabase",
    auth: "Supabase Auth, Google Auth",
    storage: "Supabase Storage, Google Drive за підключенням користувача",
    ai: "Google Gemini через серверні функції або власний API-ключ користувача",
    analytics: "Google Analytics 4",
    email: "Resend або SMTP-провайдер, якщо поштові повідомлення увімкнено",
    payments: null,
  },
} as const;

export const missingLegalFields = [
  legalConfig.operator.legalName ? null : "operator.legalName",
  legalConfig.operator.registrationNumber ? null : "operator.registrationNumber",
  legalConfig.operator.address ? null : "operator.address",
  legalConfig.contacts.supportEmail ? null : "contacts.supportEmail",
  legalConfig.contacts.privacyEmail ? null : "contacts.privacyEmail",
  legalConfig.providers.payments ? null : "providers.payments",
].filter((item): item is string => Boolean(item));
