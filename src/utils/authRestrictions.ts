export const REGISTRATION_BLOCKED_EMAIL_DOMAIN_MESSAGE =
  "Реєстрація з цією email-адресою недоступна.";

export const REGISTRATION_BLOCKED_REGION_MESSAGE =
  "Доступ до сервісу з вашого регіону недоступний.";

const BLOCKED_EMAIL_TLDS = [".ru"];
const BLOCKED_COUNTRY_CODES = new Set(["RU", "RUS"]);

export function normalizeEmailForAuth(email: string): string {
  return email.trim().toLocaleLowerCase();
}

export function getEmailDomain(email: string): string {
  const normalized = normalizeEmailForAuth(email);
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex < 0) return "";
  return normalized.slice(atIndex + 1).replace(/\.+$/g, "");
}

export function isBlockedEmailDomain(email: string): boolean {
  const domain = getEmailDomain(email);
  if (!domain) return false;
  return BLOCKED_EMAIL_TLDS.some((blockedTld) => (
    domain === blockedTld.slice(1) || domain.endsWith(blockedTld)
  ));
}

export function isBlockedCountryCode(countryCode: string | null | undefined): boolean {
  const normalized = countryCode?.trim().toLocaleUpperCase();
  return normalized ? BLOCKED_COUNTRY_CODES.has(normalized) : false;
}

export function assertAllowedRegistrationEmail(email: string): void {
  if (isBlockedEmailDomain(email)) {
    throw new Error(REGISTRATION_BLOCKED_EMAIL_DOMAIN_MESSAGE);
  }
}

export function registrationBlockMessage(reason: string | null | undefined): string {
  if (reason === "blocked_region") return REGISTRATION_BLOCKED_REGION_MESSAGE;
  return REGISTRATION_BLOCKED_EMAIL_DOMAIN_MESSAGE;
}
