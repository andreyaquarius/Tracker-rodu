export const ANALYTICS_MEASUREMENT_ID = "G-SF2725LS4P";
export const ANALYTICS_CONSENT_KEY = "tracker-rodu-analytics-consent-v1";
export const ANALYTICS_CONSENT_EVENT = "tracker-rodu-analytics-consent-changed";

const PUBLIC_PAGE_TITLES = Object.freeze({
  "/": "Трекер Роду — Не губи сліди свого роду",
  "/features": "Можливості Трекера Роду",
  "/pricing": "Тарифи Трекера Роду",
  "/privacy": "Політика конфіденційності — Трекер Роду",
  "/terms": "Умови користування — Трекер Роду",
});

const CONSENT_GRANTED = "granted";
const CONSENT_DENIED = "denied";
const TAG_ID_PATTERN = /^G-[A-Z0-9]+$/;

export function normalizePublicAnalyticsPath(value) {
  if (typeof value !== "string" || !value) return null;
  const withoutQuery = value.split(/[?#]/, 1)[0] || "/";
  const normalized = withoutQuery === "/"
    ? "/"
    : withoutQuery.replace(/\/+$/, "");
  return Object.prototype.hasOwnProperty.call(PUBLIC_PAGE_TITLES, normalized)
    ? normalized
    : null;
}

export function publicAnalyticsContext(pathname, origin = "https://trekerrodu.com.ua") {
  const path = normalizePublicAnalyticsPath(pathname);
  if (!path) return null;
  let safeOrigin;
  try {
    safeOrigin = new URL(origin).origin;
  } catch {
    return null;
  }
  return Object.freeze({
    pagePath: path,
    pageLocation: `${safeOrigin}${path}`,
    pageTitle: PUBLIC_PAGE_TITLES[path],
  });
}

export function safeAnalyticsReferrer(referrer, siteOrigin = "https://trekerrodu.com.ua") {
  if (typeof referrer !== "string" || !referrer) return "";
  try {
    const site = new URL(siteOrigin).origin;
    const source = new URL(referrer);
    if (source.origin !== site) return `${source.origin}/`;
    const path = normalizePublicAnalyticsPath(source.pathname);
    return path ? `${site}${path}` : "";
  } catch {
    return "";
  }
}

function installBrowserAnalytics(browserWindow, browserDocument) {
  if (!TAG_ID_PATTERN.test(ANALYTICS_MEASUREMENT_ID)) return;

  const disableKey = `ga-disable-${ANALYTICS_MEASUREMENT_ID}`;
  const dataLayer = browserWindow.dataLayer = browserWindow.dataLayer || [];
  function gtag() {
    dataLayer.push(arguments);
  }

  let tagRequested = false;
  let currentPublicContext = null;
  let lastTrackedPublicPath = "";
  let authEventSent = false;
  let banner = null;
  let preferencesControl = null;

  browserWindow[disableKey] = true;
  gtag("consent", "default", {
    analytics_storage: "denied",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    wait_for_update: 500,
  });

  function readConsent() {
    try {
      const value = browserWindow.localStorage.getItem(ANALYTICS_CONSENT_KEY);
      return value === CONSENT_GRANTED || value === CONSENT_DENIED ? value : null;
    } catch {
      return null;
    }
  }

  function writeConsent(value) {
    try {
      browserWindow.localStorage.setItem(ANALYTICS_CONSENT_KEY, value);
      return true;
    } catch {
      return false;
    }
  }

  function consentGranted() {
    return readConsent() === CONSENT_GRANTED;
  }

  function dispatchConsent(granted) {
    browserWindow.dispatchEvent(new CustomEvent(ANALYTICS_CONSENT_EVENT, {
      detail: { granted },
    }));
  }

  function deleteAnalyticsCookies() {
    const cookieNames = browserDocument.cookie
      .split(";")
      .map((entry) => entry.split("=", 1)[0]?.trim())
      .filter((name) => name === "_ga" || name?.startsWith("_ga_"));
    const hostname = browserWindow.location.hostname;
    const domainCandidates = [hostname, `.${hostname}`];
    for (const name of cookieNames) {
      browserDocument.cookie = `${name}=; Max-Age=0; path=/; SameSite=Lax`;
      for (const domain of domainCandidates) {
        browserDocument.cookie = `${name}=; Max-Age=0; path=/; domain=${domain}; SameSite=Lax`;
      }
    }
  }

  function disableCollection({ persist = false } = {}) {
    browserWindow[disableKey] = true;
    if (tagRequested) {
      gtag("consent", "update", {
        analytics_storage: "denied",
        ad_storage: "denied",
        ad_user_data: "denied",
        ad_personalization: "denied",
      });
    }
    if (persist) {
      writeConsent(CONSENT_DENIED);
      deleteAnalyticsCookies();
      dispatchConsent(false);
    }
  }

  function ensureTag(context) {
    if (!context || !consentGranted()) return false;
    browserWindow[disableKey] = false;
    gtag("consent", "update", {
      analytics_storage: "granted",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
    gtag("set", {
      page_location: context.pageLocation,
      page_path: context.pagePath,
      page_title: context.pageTitle,
    });

    if (!tagRequested) {
      tagRequested = true;
      gtag("js", new Date());
      const script = browserDocument.createElement("script");
      script.async = true;
      script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(ANALYTICS_MEASUREMENT_ID)}`;
      script.dataset.trackerRoduAnalyticsTag = "true";
      browserDocument.head.append(script);
    }

    gtag("config", ANALYTICS_MEASUREMENT_ID, {
      send_page_view: false,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      page_location: context.pageLocation,
      page_path: context.pagePath,
      page_title: context.pageTitle,
    });
    return true;
  }

  function injectConsentStyles() {
    if (browserDocument.getElementById("tracker-analytics-consent-styles")) return;
    const style = browserDocument.createElement("style");
    style.id = "tracker-analytics-consent-styles";
    style.textContent = `
      .tracker-analytics-consent{position:fixed;z-index:10000;right:18px;bottom:18px;width:min(440px,calc(100vw - 28px));padding:18px;border:1px solid #d6ddd8;border-radius:16px;background:#fffdf8;color:#20312d;box-shadow:0 18px 55px rgba(16,47,42,.2);font:14px/1.45 Arial,system-ui,sans-serif}
      .tracker-analytics-consent h2{margin:0 32px 8px 0;font-size:18px;color:#102f2a}
      .tracker-analytics-consent p{margin:0 0 14px;color:#4f5f5a}
      .tracker-analytics-consent a{color:#22574d;font-weight:700}
      .tracker-analytics-consent-actions{display:flex;flex-wrap:wrap;gap:8px}
      .tracker-analytics-consent button{min-height:40px;padding:9px 14px;border:1px solid #bfcac4;border-radius:10px;background:#fff;color:#173f38;font:700 13px Arial,system-ui,sans-serif;cursor:pointer}
      .tracker-analytics-consent button[data-choice=accept]{border-color:#075b50;background:#075b50;color:#fff}
      .tracker-analytics-consent-close{position:absolute;top:10px;right:10px;min-width:32px!important;min-height:32px!important;padding:2px!important;border:0!important;background:transparent!important;font-size:20px!important}
      .tracker-analytics-preferences{border:0;background:transparent;color:#22574d;font:700 11px Arial,system-ui,sans-serif;text-decoration:underline;cursor:pointer;padding:0}
      @media(max-width:560px){.tracker-analytics-consent{right:10px;bottom:10px;width:calc(100vw - 20px);padding:16px}.tracker-analytics-consent-actions button{flex:1 1 150px}}
    `;
    browserDocument.head.append(style);
  }

  function removeBanner() {
    banner?.remove();
    banner = null;
  }

  function setConsent(value) {
    if (value === CONSENT_DENIED) {
      disableCollection({ persist: true });
      removeBanner();
      return;
    }
    if (value !== CONSENT_GRANTED || !writeConsent(CONSENT_GRANTED)) return;
    dispatchConsent(true);
    removeBanner();
    if (currentPublicContext) {
      lastTrackedPublicPath = "";
      trackPublicPage(currentPublicContext.pagePath);
    }
  }

  function showConsentPreferences() {
    if (banner) {
      banner.querySelector("button")?.focus();
      return;
    }
    injectConsentStyles();
    const hasSavedChoice = readConsent() !== null;
    banner = browserDocument.createElement("aside");
    banner.className = "tracker-analytics-consent";
    banner.setAttribute("role", "dialog");
    banner.setAttribute("aria-modal", "false");
    banner.setAttribute("aria-labelledby", "tracker-analytics-consent-title");
    banner.innerHTML = `
      ${hasSavedChoice ? '<button type="button" class="tracker-analytics-consent-close" aria-label="Закрити">×</button>' : ""}
      <h2 id="tracker-analytics-consent-title">Аналітичні cookies</h2>
      <p>За вашою згодою ми рахуємо лише відвідування публічних сторінок, успішні авторизації та анонімний активний час після входу. Дані про проєкти, осіб, документи й дії всередині застосунку не передаються. <a href="/privacy">Докладніше</a>.</p>
      <div class="tracker-analytics-consent-actions">
        <button type="button" data-choice="reject">Відхилити</button>
        <button type="button" data-choice="accept">Дозволити аналітику</button>
      </div>
    `;
    banner.querySelector("[data-choice=reject]")?.addEventListener("click", () => setConsent(CONSENT_DENIED));
    banner.querySelector("[data-choice=accept]")?.addEventListener("click", () => setConsent(CONSENT_GRANTED));
    banner.querySelector(".tracker-analytics-consent-close")?.addEventListener("click", removeBanner);
    browserDocument.body.append(banner);
    banner.querySelector("button")?.focus();
  }

  function ensurePreferencesControl() {
    if (preferencesControl?.isConnected) return;
    const container = browserDocument.querySelector(".login-legal-links, footer");
    if (!container) return;
    injectConsentStyles();
    preferencesControl = browserDocument.createElement("button");
    preferencesControl.type = "button";
    preferencesControl.className = "tracker-analytics-preferences";
    preferencesControl.textContent = "Налаштування аналітики";
    preferencesControl.addEventListener("click", showConsentPreferences);
    container.append(preferencesControl);
  }

  function trackPublicPage(pathname) {
    const context = publicAnalyticsContext(pathname, browserWindow.location.origin);
    if (!context) return false;
    currentPublicContext = context;
    ensurePreferencesControl();
    const consent = readConsent();
    if (consent === null) {
      showConsentPreferences();
      return false;
    }
    if (consent !== CONSENT_GRANTED || lastTrackedPublicPath === context.pagePath) return false;
    if (!ensureTag(context)) return false;
    lastTrackedPublicPath = context.pagePath;
    gtag("event", "page_view", {
      page_location: context.pageLocation,
      page_path: context.pagePath,
      page_title: context.pageTitle,
      page_referrer: safeAnalyticsReferrer(browserDocument.referrer, browserWindow.location.origin),
    });
    return true;
  }

  function trackAuthSuccess(method) {
    if (authEventSent || (method !== "email" && method !== "google") || !consentGranted()) {
      return Promise.resolve(false);
    }
    const context = Object.freeze({
      pagePath: "/auth/success",
      pageLocation: `${browserWindow.location.origin}/auth/success`,
      pageTitle: "Успішна авторизація",
    });
    if (!ensureTag(context)) return Promise.resolve(false);
    authEventSent = true;
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve(true);
      };
      browserWindow.setTimeout(finish, 1200);
      gtag("event", "login", {
        method,
        page_location: context.pageLocation,
        page_path: context.pagePath,
        page_title: context.pageTitle,
        page_referrer: "",
        event_callback: finish,
        event_timeout: 1000,
      });
    });
  }

  function suspendForPrivateApp() {
    currentPublicContext = null;
    lastTrackedPublicPath = "";
    disableCollection();
  }

  const api = Object.freeze({
    activatePublicPage: trackPublicPage,
    hasConsent: consentGranted,
    openPreferences: showConsentPreferences,
    suspendForPrivateApp,
    trackAuthSuccess,
  });
  browserWindow.trackerRoduAnalytics = api;
  browserWindow.dispatchEvent(new Event("tracker-rodu-analytics-ready"));

  const bootstrapScript = Array.from(browserDocument.scripts).find((script) =>
    script.src.endsWith("/site-analytics.js")
  );
  if (bootstrapScript?.dataset.analyticsMode === "auto-public") {
    const activate = () => trackPublicPage(browserWindow.location.pathname);
    if (browserDocument.readyState === "loading") {
      browserDocument.addEventListener("DOMContentLoaded", activate, { once: true });
    } else {
      activate();
    }
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  installBrowserAnalytics(window, document);
}
