// GitHub Pages SPA fallback: remember the requested deep link and bounce to the
// app root, where main.tsx restores it. Kept external so 404.html can ship a
// strict Content-Security-Policy with no inline scripts.
//
// A public graph token is a bearer secret. Pass it through the URL fragment
// only: unlike ordinary deep links, it must never be copied into web storage.
const encodedFragment = window.location.hash.slice(1);
let sharedGraphToken = "";
try {
  sharedGraphToken = decodeURIComponent(encodedFragment);
} catch {
  // Malformed percent encoding can never be a valid share handoff.
}
const isRawBearerFragment = /^[A-Za-z0-9_-]{43}$/.test(sharedGraphToken);
const isHandoffBearerFragment = /^shared-graph=[A-Za-z0-9_-]{43}$/.test(sharedGraphToken);
const normalizedPathname = window.location.pathname.replace(/\/+$/, "");
const isSharedGraphPath = normalizedPathname === "/shared-graph"
  || normalizedPathname.startsWith("/shared-graph/");
const hasShareMarkerPrefix = encodedFragment.startsWith("shared-graph=")
  || sharedGraphToken.startsWith("shared-graph=");
if (
  isRawBearerFragment
  && normalizedPathname === "/shared-graph"
  && window.location.search === ""
) {
  window.location.replace(`/#shared-graph=${sharedGraphToken}`);
} else if (
  isRawBearerFragment
  || isHandoffBearerFragment
  || hasShareMarkerPrefix
  || isSharedGraphPath
) {
  // A bearer on an unexpected route is invalid, but still secret. Drop it
  // instead of passing the complete URL to the ordinary storage fallback.
  window.location.replace("/");
} else {
  // Ordinary SPA deep links retain the established storage handoff.
  sessionStorage.setItem("tracker-rodu-redirect", window.location.href);
  window.location.replace("/");
}
