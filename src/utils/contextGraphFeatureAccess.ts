export const PERSON_CONTEXT_GRAPHS_FEATURE_KEY = "person_context_graphs_v1";

export type PersonContextGraphAccess = "loading" | "enabled" | "disabled";

export function resolvePersonContextGraphAccess(input: {
  authenticated: boolean;
  requestResolved: boolean;
  effectiveEnabled: boolean;
}): PersonContextGraphAccess {
  if (!input.authenticated) return "disabled";
  if (!input.requestResolved) return "loading";
  return input.effectiveEnabled ? "enabled" : "disabled";
}
