import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
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

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);
