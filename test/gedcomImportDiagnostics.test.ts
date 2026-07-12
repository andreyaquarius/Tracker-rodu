import test from "node:test";
import assert from "node:assert/strict";
import {
  GedcomImportStageError,
  gedcomImportStageLabel,
  toGedcomImportStageError,
} from "../src/utils/gedcomImportDiagnostics.ts";

test("adds the failed GEDCOM persistence stage to a database timeout", () => {
  const databaseError = { code: "57014", message: "canceling statement due to statement timeout" };
  const error = toGedcomImportStageError(
    "findings",
    databaseError,
    "Сервер не встиг завершити запит. Спробуйте ще раз.",
  );

  assert.equal(error.stage, "findings");
  assert.equal(gedcomImportStageLabel(error.stage), "збереження подій і знахідок");
  assert.match(error.message, /етапі «збереження подій і знахідок»/);
  assert.match(error.message, /Сервер не встиг завершити запит/);
  assert.equal(error.cause, databaseError);
});

test("does not hide an already diagnosed inner GEDCOM stage", () => {
  const findingsError = new GedcomImportStageError("findings", "Помилка findings.");

  const outerError = toGedcomImportStageError("create-tree", findingsError);

  assert.equal(outerError, findingsError);
  assert.equal(outerError.stage, "findings");
  assert.equal(outerError.message.includes("формування родового дерева"), false);
});

test("extracts structured server details when no translated message is supplied", () => {
  const error = toGedcomImportStageError("documents", {
    message: "request failed",
    details: "documents table",
    hint: "retry",
  });

  assert.equal(
    error.message,
    "GEDCOM-імпорт зупинено на етапі «збереження джерел і документів». request failed documents table retry",
  );
});
