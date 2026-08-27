import assert from "node:assert/strict";
import test from "node:test";
import {
  isKnownPersonNameLanguageCode,
  PERSON_NAME_LANGUAGE_OPTIONS,
  personNameLanguageLabel,
} from "../src/utils/personNameMetadataOptions.ts";

test("historical person-name language choices use stable codes and Ukrainian labels", () => {
  assert.equal(personNameLanguageLabel("uk"), "Українська");
  assert.equal(personNameLanguageLabel("cu"), "Церковнослов’янська");
  assert.equal(personNameLanguageLabel("pl"), "Польська");
  assert.equal(isKnownPersonNameLanguageCode("la"), true);
  assert.equal(new Set(PERSON_NAME_LANGUAGE_OPTIONS.map(({ value }) => value)).size, PERSON_NAME_LANGUAGE_OPTIONS.length);
});

test("unknown existing language codes remain visible instead of being silently remapped", () => {
  assert.equal(personNameLanguageLabel("x-historical"), "x-historical");
  assert.equal(isKnownPersonNameLanguageCode("x-historical"), false);
});
