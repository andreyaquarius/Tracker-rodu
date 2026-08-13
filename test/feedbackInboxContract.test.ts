import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { pagePath, parseAppRoute } from "../src/utils/appRoutes.ts";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/pages/FeedbackPage.tsx", import.meta.url), "utf8");
const service = readFileSync(new URL("../src/services/feedbackService.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("feedback inbox has one account-level route and navigation entry", () => {
  assert.deepEqual(parseAppRoute("/feedback"), {
    kind: "settings",
    page: "feedback",
  });
  assert.equal(pagePath("ignored-project", "feedback"), "/feedback");
  assert.match(app, /case "feedback"/);
  assert.match(app, /<FeedbackPage account=\{account\} isAdmin=\{subscriptionAccess\.isAdmin\}/);
  assert.match(sidebar, /sidebar-feedback-label">Зворотний зв’язок/);
  assert.match(sidebar, /<FeedbackNavBadge accountId=\{accountId\}/);
  assert.match(sidebar, /className={`sidebar-feedback-action/);
  assert.match(sidebar, /sidebar-feedback-action[\s\S]*sidebar-privacy-copy/);
});

test("feedback UI is asynchronous, private and usable by users and administrators", () => {
  assert.match(page, /Це не онлайн-чат/);
  assert.match(page, /лише ви та адміністратор Трекера Роду/);
  assert.match(page, /Звернення користувачів/);
  assert.match(page, /Відповідь користувачу/);
  assert.match(page, /Нове звернення/);
  assert.match(page, /statusLabels/);
  assert.match(page, /adminFilter/);
  assert.match(styles, /\.feedback-workspace\s*\{/);
  assert.match(styles, /\.feedback-filters\s*\{[^}]*flex-wrap:\s*wrap;[^}]*overflow:\s*visible;/s);
  assert.doesNotMatch(styles, /\.feedback-filters\s*\{[^}]*overflow-x:\s*auto;/s);
  assert.match(styles, /@media \(max-width: 760px\)/);
});

test("feedback client writes only through authenticated RPC contracts", () => {
  for (const rpc of [
    "list_feedback_threads",
    "list_feedback_messages",
    "create_feedback_thread",
    "post_feedback_message",
    "mark_feedback_thread_read",
    "set_feedback_thread_status",
    "get_feedback_unread_count",
  ]) assert.match(service, new RegExp(`rpc\\("${rpc}"`));

  assert.doesNotMatch(service, /\.from\(["']feedback_(?:threads|messages)["']\)/);
  assert.match(service, /runAuthenticatedSupabaseRequest/);
});
