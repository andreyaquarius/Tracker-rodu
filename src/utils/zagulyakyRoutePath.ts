export type ZagulyakyRouteTab = "people" | "documents" | "mine";

/**
 * Keeps the UI tab names separate from their public URL segments.
 * The private "mine" tab deliberately uses `/my`, not `/mine`.
 */
export function zagulyakyTabPath(tab: ZagulyakyRouteTab): string {
  if (tab === "documents") return "/zahuliaky/documents";
  if (tab === "mine") return "/zahuliaky/my";
  return "/zahuliaky";
}
