import test from "node:test";
import assert from "node:assert/strict";
import { authenticatedGeneHelpViewUrl } from "../src/utils/geneHelpLinks.ts";

test("uses GeneHelp protected edit route as the auth-safe view entry", () => {
  assert.equal(
    authenticatedGeneHelpViewUrl(
      "https://genehelp.online/requests/8FY4R0CN",
      "https://genehelp.online/requests/8FY4R0CN/edit",
    ),
    "https://genehelp.online/requests/8FY4R0CN/edit",
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
    authenticatedGeneHelpViewUrl(
      "https://example.com/requests/8FY4R0CN",
      "https://genehelp.online/requests/8FY4R0CN/edit",
    ),
    "https://example.com/requests/8FY4R0CN",
  );
  assert.equal(authenticatedGeneHelpViewUrl("javascript:alert(1)"), null);
});
