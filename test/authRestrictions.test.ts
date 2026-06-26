import test from "node:test";
import assert from "node:assert/strict";
import {
  assertAllowedRegistrationEmail,
  getEmailDomain,
  isBlockedCountryCode,
  isBlockedEmailDomain,
  normalizeEmailForAuth,
} from "../src/utils/authRestrictions.ts";

test("normalizes auth email before registration checks", () => {
  assert.equal(normalizeEmailForAuth("  USER@MAIL.RU  "), "user@mail.ru");
});

test("extracts email domain without trailing dots", () => {
  assert.equal(getEmailDomain("person@example.com."), "example.com");
});

test("blocks .ru email domains and subdomains", () => {
  assert.equal(isBlockedEmailDomain("user@mail.ru"), true);
  assert.equal(isBlockedEmailDomain("user@sub.domain.ru"), true);
  assert.equal(isBlockedEmailDomain("USER@YANDEX.RU"), true);
});

test("does not block non-ru domains", () => {
  assert.equal(isBlockedEmailDomain("user@example.com"), false);
  assert.equal(isBlockedEmailDomain("user@rural.example"), false);
  assert.equal(isBlockedEmailDomain("invalid-email"), false);
});

test("throws a public message for blocked registration email", () => {
  assert.throws(
    () => assertAllowedRegistrationEmail("user@mail.ru"),
    /Реєстрація з цією email-адресою недоступна/,
  );
});

test("blocks Russian country codes when provided by infrastructure", () => {
  assert.equal(isBlockedCountryCode("RU"), true);
  assert.equal(isBlockedCountryCode("rus"), true);
  assert.equal(isBlockedCountryCode("UA"), false);
  assert.equal(isBlockedCountryCode(null), false);
});
