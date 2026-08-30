import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import App from "./App";
import { ApplicationRouteError } from "./components/ApplicationRouteError.tsx";
import { installChunkLoadRecovery } from "./utils/chunkLoadRecovery.ts";
import "leaflet/dist/leaflet.css";
import "./styles.css";

// GitHub Pages first serves 404.html for a direct public-share deep link. Its
// external redirect script transfers the bearer only in the root fragment;
// restore the real route before the router or any analytics can observe it.
function parseSharedGraphBearerFragment(hash: string): {
  kind: "raw" | "handoff";
  token: string;
} | null {
  let decoded = "";
  try {
    decoded = decodeURIComponent(hash.startsWith("#") ? hash.slice(1) : hash);
  } catch {
    return null;
  }
  if (/^[A-Za-z0-9_-]{43}$/.test(decoded)) return { kind: "raw", token: decoded };
  const handoff = /^shared-graph=([A-Za-z0-9_-]{43})$/.exec(decoded);
  return handoff ? { kind: "handoff", token: handoff[1] } : null;
}

function restoreSharedGraphFragmentHandoff(): boolean {
  const bearer = parseSharedGraphBearerFragment(window.location.hash);
  if (window.location.pathname !== "/" || bearer?.kind !== "handoff") return false;
  window.history.replaceState(
    null,
    "",
    `/shared-graph#${bearer.token}`,
  );
  return true;
}

// Restore the deep link captured by the GitHub Pages 404.html SPA fallback
// before the router reads window.location. Moved out of index.html so the
// production Content-Security-Policy can forbid inline scripts entirely.
function restoreSpaRedirect(): void {
  try {
    const redirect = sessionStorage.getItem("tracker-rodu-redirect");
    if (!redirect) return;
    sessionStorage.removeItem("tracker-rodu-redirect");
    const target = new URL(redirect);
    const bearer = parseSharedGraphBearerFragment(target.hash);
    const normalizedPathname = target.pathname.replace(/\/+$/, "");
    const isSharedGraphPath = normalizedPathname === "/shared-graph"
      || normalizedPathname.startsWith("/shared-graph/");
    const hasShareMarkerPrefix = target.hash.startsWith("#shared-graph=");
    if (
      bearer
      || hasShareMarkerPrefix
      || isSharedGraphPath
    ) {
      window.history.replaceState(
        null,
        "",
        bearer?.kind === "raw"
          && normalizedPathname === "/shared-graph"
          && target.search === ""
          ? `/shared-graph#${bearer.token}`
          : "/",
      );
      return;
    }
    window.history.replaceState(
      null,
      "",
      target.pathname + target.search + target.hash,
    );
  } catch {
    // Ignore malformed redirect state.
  }
}

if (!restoreSharedGraphFragmentHandoff()) {
  restoreSpaRedirect();
}
installChunkLoadRecovery();

// A data router gives form screens a real navigation blocker.  The app still
// owns all route rendering in <App />, so this is intentionally a single
// catch-all route rather than a second route configuration.
const router = createBrowserRouter([
  {
    path: "*",
    element: <App />,
    errorElement: <ApplicationRouteError />,
  },
]);

createRoot(document.getElementById("root")!).render(
  <RouterProvider router={router} />,
);
