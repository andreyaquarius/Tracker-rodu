import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import App from "./App";
import "leaflet/dist/leaflet.css";
import "./styles.css";

// Restore the deep link captured by the GitHub Pages 404.html SPA fallback
// before the router reads window.location. Moved out of index.html so the
// production Content-Security-Policy can forbid inline scripts entirely.
function restoreSpaRedirect(): void {
  try {
    const redirect = sessionStorage.getItem("tracker-rodu-redirect");
    if (!redirect) return;
    sessionStorage.removeItem("tracker-rodu-redirect");
    const target = new URL(redirect);
    window.history.replaceState(
      null,
      "",
      target.pathname + target.search + target.hash,
    );
  } catch {
    // Ignore malformed redirect state.
  }
}

restoreSpaRedirect();

// A data router gives form screens a real navigation blocker.  The app still
// owns all route rendering in <App />, so this is intentionally a single
// catch-all route rather than a second route configuration.
const router = createBrowserRouter([
  { path: "*", element: <App /> },
]);

createRoot(document.getElementById("root")!).render(
  <RouterProvider router={router} />,
);
