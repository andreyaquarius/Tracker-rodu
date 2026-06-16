// GitHub Pages SPA fallback: remember the requested deep link and bounce to the
// app root, where main.tsx restores it. Kept external so 404.html can ship a
// strict Content-Security-Policy with no inline scripts.
sessionStorage.setItem("tracker-rodu-redirect", window.location.href);
window.location.replace("/");
