import { getSupabaseClient, isSupabaseConfigured } from "./supabaseAuth.ts";
import { runAuthenticatedSupabaseRequest } from "../utils/authenticatedSupabaseRequest.ts";

export const PRODUCT_ANALYTICS_CONSENT_VERSION = 2;
export const PRODUCT_ANALYTICS_CONSENT_KEY = "tracker-rodu-product-analytics-consent-v2";
export const PRODUCT_ANALYTICS_CONSENT_EVENT = "tracker-rodu:product-analytics-consent";

export type ProductAnalyticsConsentChoice = "granted" | "denied" | "unset";

export interface ProductAnalyticsConsentRecord {
  granted: boolean;
  consentVersion: number;
  decidedAt?: string;
  updatedAt?: string;
}

function browserAvailable(): boolean {
  return typeof window !== "undefined";
}

function parseRecord(value: unknown): ProductAnalyticsConsentRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.granted !== "boolean" || !Number.isInteger(record.consentVersion)) {
    return null;
  }
  return {
    granted: record.granted,
    consentVersion: Number(record.consentVersion),
    decidedAt: typeof record.decidedAt === "string" ? record.decidedAt : undefined,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : undefined,
  };
}

function writeLocalChoice(choice: ProductAnalyticsConsentChoice): void {
  if (!browserAvailable()) return;
  if (choice === "unset") window.localStorage.removeItem(PRODUCT_ANALYTICS_CONSENT_KEY);
  else window.localStorage.setItem(PRODUCT_ANALYTICS_CONSENT_KEY, choice);
  window.dispatchEvent(new CustomEvent(PRODUCT_ANALYTICS_CONSENT_EVENT, {
    detail: { choice },
  }));
}

export function productAnalyticsConsentChoice(): ProductAnalyticsConsentChoice {
  if (!browserAvailable()) return "unset";
  const value = window.localStorage.getItem(PRODUCT_ANALYTICS_CONSENT_KEY);
  return value === "granted" || value === "denied" ? value : "unset";
}

export function productAnalyticsConsentGranted(): boolean {
  return productAnalyticsConsentChoice() === "granted";
}

export async function loadMyProductAnalyticsConsent(): Promise<ProductAnalyticsConsentRecord | null> {
  if (!isSupabaseConfigured) return null;
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(client, async () => {
    const result = await client.rpc("get_my_product_analytics_consent");
    return { data: result.data, error: result.error };
  });
  if (error) throw error;
  const parsed = parseRecord(data);
  const current = parsed && parsed.consentVersion === PRODUCT_ANALYTICS_CONSENT_VERSION
    ? parsed
    : null;
  writeLocalChoice(current ? (current.granted ? "granted" : "denied") : "unset");
  return current;
}

export async function saveMyProductAnalyticsConsent(
  granted: boolean,
): Promise<ProductAnalyticsConsentRecord> {
  if (!isSupabaseConfigured) throw new Error("Supabase is not configured.");
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(client, async () => {
    const result = await client.rpc("set_my_product_analytics_consent", {
      p_granted: granted,
      p_consent_version: PRODUCT_ANALYTICS_CONSENT_VERSION,
    });
    return { data: result.data, error: result.error };
  });
  if (error) throw error;
  const parsed = parseRecord(data);
  if (!parsed) throw new Error("Invalid product analytics consent response.");
  writeLocalChoice(granted ? "granted" : "denied");
  return parsed;
}
