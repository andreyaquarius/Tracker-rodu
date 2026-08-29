/**
 * Detects only the rolling-deploy window where the three additive historical
 * place columns have not reached person_timeline_events yet. Other database,
 * authorization and timeout errors must stay visible to the caller.
 */
export function isMissingHistoricalPlaceEventColumnsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code ?? "") : "";
  if (code !== "42703" && code !== "PGRST204") return false;
  const message = "message" in error ? String(error.message ?? "") : "";
  const details = "details" in error ? String(error.details ?? "") : "";
  const hint = "hint" in error ? String(error.hint ?? "") : "";
  const text = `${message} ${details} ${hint}`.toLowerCase();
  return ["place_id", "place_original_text", "place_resolution_status"]
    .some((columnName) => text.includes(columnName));
}
