import type { ProductAnalyticsPageCode } from "./productAnalyticsRegistry.ts";

/** UI overlays never retain a route, record ID, title or query string. */
export function createProductAnalyticsPageScopes(onChange: (page: ProductAnalyticsPageCode) => void) {
  let base: ProductAnalyticsPageCode = "unknown";
  let current: ProductAnalyticsPageCode = base;
  const scopes = new Map<string, { page: ProductAnalyticsPageCode; base?: ProductAnalyticsPageCode }>();
  function update() {
    const matching = [...scopes.values()].filter((scope) => !scope.base || scope.base === base);
    const next = matching.at(-1)?.page ?? base;
    if (next !== current) { current = next; onChange(next); }
  }
  return {
    setBase(page: ProductAnalyticsPageCode) { base = page; update(); },
    setScope(key: string, page: ProductAnalyticsPageCode | null, basePage?: ProductAnalyticsPageCode) {
      if (page) scopes.set(key, { page, base: basePage });
      else scopes.delete(key);
      update();
    },
  };
}
