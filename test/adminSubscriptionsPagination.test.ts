import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { adminSubscriptionsParams, parseAdminSubscriptionsPage } from "../src/utils/adminSubscriptions.ts";

const row = (id: number) => ({ user_id: String(id), email: `person${id}@example.test`, display_name: null,
  plan_code: "free", status: "active", trial_ends_at: null, current_period_end: null, is_admin: false });

test("subscription pagination retains full counts beyond the Data API cap", () => {
  const first = parseAdminSubscriptionsPage({ total_count: 1027, filtered_count: 1027, page: 1, page_size: 50,
    items: Array.from({ length: 50 }, (_, i) => row(i + 1)) });
  assert.equal(first.totalCount, 1027);
  assert.equal(first.filteredCount, 1027);
  assert.equal(first.rows.length, 50);
  assert.equal(first.rows[0].displayName, "");
  const last = parseAdminSubscriptionsPage({ total_count: 1027, filtered_count: 1027, page: 21, page_size: 50,
    items: Array.from({ length: 27 }, (_, i) => row(i + 1001)) });
  assert.equal(last.page, 21);
  assert.equal(last.rows.length, 27);
  assert.equal(last.rows.at(-1)?.userId, "1027");
});

test("filtered/empty pages keep the directory total independent of visible rows", () => {
  const filtered = parseAdminSubscriptionsPage({ total_count: 1027, filtered_count: 1, page: 1, page_size: 50, items: [row(1026)] });
  assert.equal(filtered.filteredCount, 1);
  assert.equal(filtered.totalCount, 1027);
  const empty = parseAdminSubscriptionsPage({ total_count: 1027, filtered_count: 0, page: 1, page_size: 50, items: [] });
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.totalCount, 1027);
});

test("malformed/truncated responses are errors, not a misleading zero or 1000 total", () => {
  const valid = { total_count: 1, filtered_count: 1, page: 1, page_size: 50, items: [row(1)] };
  for (const data of [null, [], [row(1)], {}, { ...valid, total_count: undefined }, { ...valid, total_count: "1027" },
    { ...valid, filtered_count: 2 }, { ...valid, page: 0 }, { ...valid, page: 2 }, { ...valid, page_size: 1000 },
    { ...valid, items: [] }, { ...valid, items: [null] }, { ...valid, items: [{ ...row(1), user_id: "" }] },
    { ...valid, items: [{ ...row(1), status: "invalid" }] },
    { ...valid, total_count: 2, filtered_count: 2, items: [row(1), row(1)] }]) {
    assert.throws(() => parseAdminSubscriptionsPage(data), /некоректну сторінку/);
  }
});

test("request parameters are bounded and preserve literal substring filters", () => {
  assert.deepEqual(adminSubscriptionsParams({}), { p_page: 1, p_query: "", p_plan: "all", p_status: "all" });
  assert.deepEqual(adminSubscriptionsParams({ page: 21, query: "  100%_КОРЗУН  ", plan: "admin", status: "active" }),
    { p_page: 21, p_query: "100%_КОРЗУН", p_plan: "admin", p_status: "active" });
  for (const page of [-1, 0, NaN, Infinity]) assert.equal(adminSubscriptionsParams({ page }).p_page, 1);
  assert.equal(adminSubscriptionsParams({ page: 2.9 }).p_page, 2);
  assert.equal(adminSubscriptionsParams({ page: 1e20 }).p_page, 2_147_483_647);
  assert.equal(adminSubscriptionsParams({ query: "x".repeat(201) }).p_query.length, 200);
});

test("both subscription entry points share server paging and no full-directory loader", () => {
  const page = readFileSync("src/pages/SubscriptionPage.tsx", "utf8");
  const admin = readFileSync("src/pages/AdminPanelPage.tsx", "utf8");
  const service = readFileSync("src/services/subscriptionService.ts", "utf8");
  assert.match(page, /<AdminSubscriptions onChanged=\{refreshPage\}/);
  assert.match(admin, /<AdminSubscriptions \/>/);
  assert.doesNotMatch(admin, /loadAdminSubscriptions|refreshSubscriptions/);
  assert.doesNotMatch(page, /filteredRows|adminRows/);
  assert.match(page, /loadAdminSubscriptions\(request, controller.signal\)/);
  assert.match(page, /controller.abort\(\)/);
  assert.match(page, /if \(active\) setLoadState/);
  assert.match(page, /\.\.\.patch, page: 1/);
  assert.equal((page.match(/\{pagination\}/g) ?? []).length, 2);
  assert.match(service, /rpc\("admin_list_subscriptions_page_v1", adminSubscriptionsParams\(input\)\)/);
  assert.match(service, /request.abortSignal\(signal\)/);
  assert.doesNotMatch(service, /rpc\("admin_list_subscriptions"\)/);
});
