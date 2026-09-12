import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(new URL("../src/components/CommunityResources.tsx", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const noscript = html.match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1] ?? "";

for (const [name, markup] of [["shared React resources", component], ["no-JavaScript homepage", noscript]]) {
  test(`${name} has the exact requested external links with safe new-tab access`, () => {
    const anchors = Array.from(markup.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g), ([anchor]) => anchor);
    for (const [url, label] of [
      ["https://t.me/myrodovid", "Telegram"],
      ["https://www.youtube.com/@Myrodovid", "YouTube"],
      ["https://suziria.trekerrodu.com.ua/", "Сузір’я Роду"],
    ]) {
      const matches = anchors.filter((anchor) => anchor.includes(`href="${url}"`));
      assert.equal(matches.length, 1, `${url} should appear once`);
      assert.match(matches[0], /target="_blank"/);
      assert.match(matches[0], /rel="noopener noreferrer"/);
      assert.match(matches[0], /aria-label="[^"]*у новій вкладці[^"]*"/);
      assert.ok(matches[0].includes(label));
    }
  });

  test(`${name} separates the video resource from the social channels and describes its subject`, () => {
    const socialNav = markup.match(/<nav\s+class(?:Name)?="community-social-links"[\s\S]*?<\/nav>/)?.[0] ?? "";
    assert.match(socialNav, /aria-label="Наші канали"/);
    assert.match(socialNav, /https:\/\/t\.me\/myrodovid/);
    assert.match(socialNav, /https:\/\/www\.youtube\.com\/@Myrodovid/);
    assert.doesNotMatch(socialNav, /suziria\.trekerrodu/);
    assert.match(markup, /class(?:Name)?="community-video-resource"/);
    assert.match(markup, /<span>Відео про дослідження роду та краєзнавство\.<\/span>/);
    assert.doesNotMatch(markup, /<iframe\b|youtube\.com\/embed|telegram-widget\.js/);
  });
}

test("public and signed-in home screens use the same links without account or plan restrictions", () => {
  for (const page of ["LoginPage", "DashboardPage", "ProjectsPage"]) {
    const source = readFileSync(new URL(`../src/pages/${page}.tsx`, import.meta.url), "utf8");
    assert.match(source, /import \{ CommunityResources \} from "\.\.\/components\/CommunityResources\.tsx"/);
    assert.match(source, page === "LoginPage" ? /<CommunityResources variant="home" \/>/ : /<CommunityResources \/>/);
  }
  assert.doesNotMatch(component, /useSubscription|isAdmin|effectivePlanCode|fetch\(|getSupabaseClient/);
});

test("resource links wrap and expose visible keyboard focus in both themes", () => {
  const styles = readFileSync(new URL("../src/components/communityResources.css", import.meta.url), "utf8");
  assert.match(styles, /\.community-social-links\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(styles, /\.community-social-links a\s*\{[^}]*min-height:\s*44px/s);
  assert.match(styles, /\.community-social-links a:focus-visible,/);
  assert.match(styles, /\.community-video-resource:focus-visible\s*\{[^}]*outline:/s);
  assert.match(styles, /--community-text: var\(--app-ink,/);
  assert.match(styles, /\.community-resources--home\s*\{/);
});
