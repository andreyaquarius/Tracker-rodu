import test from "node:test";
import assert from "node:assert/strict";
import {
  databaseStatementTimeoutMessage,
  isDatabaseStatementTimeout,
} from "../src/utils/databaseErrors.ts";

test("Postgres statement timeouts are recognized by code and server wording", () => {
  assert.equal(isDatabaseStatementTimeout({ code: "57014", message: "query canceled" }), true);
  assert.equal(isDatabaseStatementTimeout(new Error("canceling statement due to statement timeout")), true);
  assert.equal(isDatabaseStatementTimeout({ message: "Warp server error: Thread killed by timeout manager" }), true);
  assert.equal(
    isDatabaseStatementTimeout(new Error("Сервер не встиг завершити запит. Спробуйте ще раз.")),
    true,
  );
  assert.equal(isDatabaseStatementTimeout({ code: "23505", message: "duplicate key" }), false);
});

test("raw database timeout text is replaced with a user-facing Ukrainian message", () => {
  const message = databaseStatementTimeoutMessage({
    message: "canceling statement due to statement timeout",
  });
  assert.ok(message?.startsWith("Сервер не встиг завершити запит."));
  assert.equal(message?.includes("canceling statement"), false);
});
