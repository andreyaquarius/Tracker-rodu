import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  isResearchGraphShareToken,
  parseAppRoute,
  researchGraphSharePath,
  researchGraphShareTokenFromLocation,
} from "../src/utils/appRoutes.ts";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
const spaRedirect = readFileSync(new URL("../public/spa-redirect.js", import.meta.url), "utf8");

test("shared graph uses a fragment-only opaque token and rejects token path routes", () => {
  const token = "a".repeat(43);
  assert.equal(isResearchGraphShareToken(token), true);
  assert.equal(researchGraphSharePath(token), `/shared-graph#${token}`);
  assert.deepEqual(parseAppRoute(`/shared-graph#${token}`), { kind: "graph-share" });
  assert.deepEqual(parseAppRoute(`/shared-graph/${token}`), { kind: "unknown" });
  assert.equal(isResearchGraphShareToken("short"), false);
  assert.equal(isResearchGraphShareToken(`${token}/leak`), false);
});

test("direct SPA share loading accepts only the exact fragment-only URL", () => {
  const token = `${"c".repeat(42)}_`;
  assert.equal(
    researchGraphShareTokenFromLocation("/shared-graph", "", `#${token}`),
    token,
  );
  assert.equal(
    researchGraphShareTokenFromLocation("/shared-graph", "", `#${"c".repeat(42)}%5F`),
    token,
  );
  for (const search of [
    `?token=${token}`,
    `?p_token=${token}`,
    `?${token}`,
    "?view=public",
  ]) {
    assert.equal(
      researchGraphShareTokenFromLocation("/shared-graph", search, `#${token}`),
      "",
      `${search} must invalidate the direct share load`,
    );
  }
  for (const pathname of ["/shared-graph/", "/shared-graph/extra", "/unrelated"]) {
    assert.equal(
      researchGraphShareTokenFromLocation(pathname, "", `#${token}`),
      "",
      `${pathname} must not receive the bearer`,
    );
  }
  assert.equal(researchGraphShareTokenFromLocation("/shared-graph", "", "#short"), "");
  assert.equal(researchGraphShareTokenFromLocation("/shared-graph", "", "#abc%ZZ"), "");
});

test("sensitive shared route is rendered before auth without workspace or analytics", () => {
  assert.match(app, /const isSensitiveSharedGraphRoute = route\.kind === "graph-share"/u);
  assert.match(app, /skipsWorkspaceState[\s\S]*?isSensitiveSharedGraphRoute/u);
  const shareRender = app.indexOf('if (route.kind === "graph-share")');
  const authGate = app.indexOf("if (!account)", shareRender);
  assert.ok(shareRender >= 0 && authGate > shareRender, "share viewer must render before the login gate");
  assert.match(
    app,
    /SharedResearchGraphPage[\s\S]*?token=\{researchGraphShareTokenFromLocation\([\s\S]*?location\.pathname,[\s\S]*?location\.search,[\s\S]*?location\.hash,[\s\S]*?\)\}/u,
  );
  assert.match(app, /!isSensitiveSharedGraphRoute[\s\S]*?setAuthenticatedEngagementEnabled/u);
  assert.match(app, /!isSensitiveSharedGraphRoute[\s\S]*?setProductAnalyticsEnabled/u);
  assert.match(
    app,
    /if \(isSensitiveSharedGraphRoute\) \{\s*setProductAnalyticsEnabled\(false\);\s*return;\s*\}\s*setProductAnalyticsPage/u,
  );
  assert.match(
    app,
    /useSubscription\(\s*isSensitiveSharedGraphRoute \? undefined : workspace\?\.projectId,[\s\S]*?!isSensitiveSharedGraphRoute && Boolean\(account\)/u,
  );
  assert.match(
    app,
    /setProductAnalyticsConsentOwnerId\(null\);\s*setProductAnalyticsEnabled\(false\);\s*if \(isSensitiveSharedGraphRoute\) return/u,
  );

  const bootstrapGuard = sourceBlock(
    app,
    "// A bearer-share viewer is deliberately isolated",
    "if (!isSupabaseConfigured) return;",
  );
  assert.match(bootstrapGuard, /if \(isSensitiveSharedGraphRoute\)/u);
  assert.match(bootstrapGuard, /setAccount\(null\)/u);
  assert.match(bootstrapGuard, /setWorkspace\(null\)/u);
  assert.match(bootstrapGuard, /setWorkspaces\(\[\]\)/u);
  assert.match(bootstrapGuard, /setAuthReady\(true\)/u);
  assert.match(bootstrapGuard, /lastPreparedUserRef\.current = null/u);
  assert.doesNotMatch(
    bootstrapGuard,
    /getSupabaseSession|reportPendingAuthSuccess|listSupabaseWorkspaces|ensureSupabaseWorkspace/u,
  );
});

test("shared graph metadata blocks indexing and referrer leakage", () => {
  const seo = sourceBlock(app, "function applySharedGraphSeo", "function withoutFindingPersonLinks");
  assert.match(seo, /noindex, nofollow, noarchive, nosnippet, noimageindex/u);
  assert.match(seo, /upsertMetaName\("referrer", "no-referrer"\)/u);
  assert.match(seo, /upsertCanonical\(null\)/u);
  assert.doesNotMatch(seo, /view\.name|savedView|token/u);
});

test("GitHub Pages transfers a share bearer through fragments without web storage", () => {
  const shareBranch = sourceBlock(
    spaRedirect,
    "const encodedFragment",
    "// Ordinary SPA deep links",
  );
  assert.match(shareBranch, /decodeURIComponent\(encodedFragment\)/u);
  assert.match(shareBranch, /normalizedPathname/u);
  assert.match(shareBranch, /\^\[A-Za-z0-9_-\]\{43\}\$/u);
  assert.match(shareBranch, /window\.location\.replace\(`\/#shared-graph=\$\{sharedGraphToken\}`\)/u);
  assert.match(shareBranch, /isHandoffBearerFragment[\s\S]*?window\.location\.replace\("\/"\)/u);
  assert.doesNotMatch(shareBranch, /sessionStorage|localStorage|window\.location\.href/u);

  const handoff = sourceBlock(
    main,
    "function parseSharedGraphBearerFragment",
    "// Restore the deep link captured",
  );
  assert.match(handoff, /decodeURIComponent/u);
  assert.match(handoff, /\^shared-graph=\(\[A-Za-z0-9_-\]\{43\}\)\$/u);
  assert.match(handoff, /`\/shared-graph#\$\{bearer\.token\}`/u);
  assert.doesNotMatch(handoff, /sessionStorage|localStorage/u);
  assert.ok(
    main.indexOf("restoreSharedGraphFragmentHandoff()") < main.indexOf("restoreSpaRedirect();"),
    "the fragment-only handoff must run before the ordinary storage restore",
  );

  const token = `${"b".repeat(42)}_`;
  const encodedToken = `${"b".repeat(42)}%5F`;
  const validShare = executeSpaRedirect("/shared-graph", `#${token}`);
  assert.deepEqual(validShare.stored, []);
  assert.deepEqual(validShare.replaced, [`/#shared-graph=${token}`]);
  for (const malformedPath of ["/shared-graph/extra", "/unrelated"]) {
    const malformed = executeSpaRedirect(malformedPath, `#${token}`);
    assert.deepEqual(malformed.stored, [], `${malformedPath} must not persist a bearer`);
    assert.deepEqual(malformed.replaced, ["/"], `${malformedPath} must discard the bearer`);
  }
  for (const markerPath of ["/shared-graph", "/shared-graph/extra", "/unrelated"]) {
    const marker = executeSpaRedirect(markerPath, `#shared-graph=${token}`);
    assert.deepEqual(marker.stored, [], `${markerPath} must not persist a handoff bearer`);
    assert.deepEqual(marker.replaced, ["/"], `${markerPath} must discard an unexpected handoff marker`);
  }
  const encodedShare = executeSpaRedirect("/shared-graph", `#${encodedToken}`);
  assert.deepEqual(encodedShare.stored, []);
  assert.deepEqual(encodedShare.replaced, [`/#shared-graph=${token}`]);
  for (const encodedPath of ["/shared-graph/extra", "/unrelated"]) {
    const encoded = executeSpaRedirect(encodedPath, `#${encodedToken}`);
    assert.deepEqual(encoded.stored, [], `${encodedPath} must not persist an encoded bearer`);
    assert.deepEqual(encoded.replaced, ["/"], `${encodedPath} must discard an encoded bearer`);
    const marker = executeSpaRedirect(encodedPath, `#shared-graph=${encodedToken}`);
    assert.deepEqual(marker.stored, [], `${encodedPath} must not persist an encoded handoff bearer`);
    assert.deepEqual(marker.replaced, ["/"], `${encodedPath} must discard an encoded handoff bearer`);
  }
  const encodedMarkerOnShare = executeSpaRedirect("/shared-graph", `#shared-graph=${encodedToken}`);
  assert.deepEqual(encodedMarkerOnShare.stored, []);
  assert.deepEqual(encodedMarkerOnShare.replaced, ["/"]);
  const malformedEncoding = executeSpaRedirect("/shared-graph", "#abc%ZZ");
  assert.deepEqual(malformedEncoding.stored, []);
  assert.deepEqual(malformedEncoding.replaced, ["/"]);
  const malformedNestedEncoding = executeSpaRedirect("/shared-graph/extra", "#abc%ZZ");
  assert.deepEqual(malformedNestedEncoding.stored, []);
  assert.deepEqual(malformedNestedEncoding.replaced, ["/"]);
  for (const sharePath of ["/shared-graph", "/shared-graph/extra"]) {
    for (const search of [
      `?token=${token}`,
      `?p_token=${token}`,
      `?${token}`,
      "?view=public",
    ]) {
      for (const hash of ["", "#abc%ZZ", `#${token}`]) {
        const queryBearer = executeSpaRedirect(sharePath, hash, search);
        assert.deepEqual(
          queryBearer.stored,
          [],
          `${sharePath}${search}${hash} must never reach session storage`,
        );
        assert.deepEqual(
          queryBearer.replaced,
          ["/"],
          `${sharePath}${search}${hash} must fail closed`,
        );
      }
    }
  }

  const legacyRestore = sourceBlock(main, "function restoreSpaRedirect", "if (!restoreSharedGraphFragmentHandoff())");
  assert.ok(
    legacyRestore.indexOf('sessionStorage.removeItem("tracker-rodu-redirect")')
      < legacyRestore.indexOf("parseSharedGraphBearerFragment(target.hash)"),
    "a legacy bearer must be deleted before it is inspected",
  );
  assert.match(
    legacyRestore,
    /bearer\?\.kind === "raw"[\s\S]*?normalizedPathname === "\/shared-graph"[\s\S]*?target\.search === ""[\s\S]*?`\/shared-graph#\$\{bearer\.token\}`[\s\S]*?: "\/"/u,
  );
  assert.match(
    legacyRestore,
    /\|\| isSharedGraphPath/u,
    "legacy share-path redirects must fail closed even when no fragment is present",
  );
  const ordinary = executeSpaRedirect("/projects/example", "#section");
  assert.equal(ordinary.stored.length, 1, "ordinary deep links keep the established fallback");
  assert.deepEqual(ordinary.replaced, ["/"]);
});

test("leaving the sensitive route cannot reuse an inactive workspace bootstrap", () => {
  const bootstrap = sourceBlock(
    app,
    "// A bearer-share viewer is deliberately isolated",
    "const notify = useCallback",
  );
  assert.match(bootstrap, /let active = true;[\s\S]*?let workspaceSetup: Promise<void> \| null = null/u);
  assert.match(bootstrap, /if \(workspaceSetup\) \{\s*await workspaceSetup;/u);
  assert.match(bootstrap, /workspaceSetup = \(async \(\) =>/u);
  assert.match(bootstrap, /finally \{\s*workspaceSetup = null;/u);
  assert.match(bootstrap, /\}, \[isSensitiveSharedGraphRoute\]\);/u);
  assert.doesNotMatch(app, /workspaceSetupRef/u);
});

function sourceBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function executeSpaRedirect(pathname: string, hash: string, search = ""): {
  stored: Array<[string, string]>;
  replaced: string[];
} {
  const stored: Array<[string, string]> = [];
  const replaced: string[] = [];
  const href = `https://trekerrodu.com.ua${pathname}${search}${hash}`;
  runInNewContext(spaRedirect, {
    window: {
      location: {
        pathname,
        search,
        hash,
        href,
        replace: (target: string) => replaced.push(target),
      },
    },
    sessionStorage: {
      setItem: (key: string, value: string) => stored.push([key, value]),
    },
  });
  return { stored, replaced };
}
