import test from "node:test";
import assert from "node:assert/strict";
import {
  authenticatedGeneHelpViewUrl,
  geneHelpLoginRedirectUrl,
} from "../src/utils/geneHelpLinks.ts";

test("wraps GeneHelp request view links through login redirect", () => {
  assert.equal(
    authenticatedGeneHelpViewUrl("https://genehelp.online/requests/8FY4R0CN"),
    "https://genehelp.online/login?redirect=%2Frequests%2F8FY4R0CN",
  );
});

test("keeps GeneHelp edit links and non-request pages unchanged", () => {
  assert.equal(
    authenticatedGeneHelpViewUrl("https://genehelp.online/requests/8FY4R0CN/edit"),
    "https://genehelp.online/requests/8FY4R0CN/edit",
  );
  assert.equal(
    authenticatedGeneHelpViewUrl("https://genehelp.online/profile"),
    "https://genehelp.online/profile",
  );
});

test("does not build login redirects for external hosts", () => {
  assert.equal(
    geneHelpLoginRedirectUrl("https://example.com/requests/8FY4R0CN"),
    "https://example.com/requests/8FY4R0CN",
  );
  assert.equal(authenticatedGeneHelpViewUrl("javascript:alert(1)"), null);
});
