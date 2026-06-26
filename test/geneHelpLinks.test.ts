import test from "node:test";
import assert from "node:assert/strict";
import { authenticatedGeneHelpViewUrl } from "../src/utils/geneHelpLinks.ts";

test("routes GeneHelp request view links to the user's request list with request id", () => {
  assert.equal(
    authenticatedGeneHelpViewUrl(
      "https://genehelp.online/requests/8FY4R0CN",
      "https://genehelp.online/requests/8FY4R0CN/edit",
      "8FY4R0CN",
    ),
    "https://genehelp.online/uk/my/requests?request=8FY4R0CN",
  );
});

test("extracts request id from localized GeneHelp request links", () => {
  assert.equal(
    authenticatedGeneHelpViewUrl(
      "https://genehelp.online/uk/requests/8FY4R0CN",
      "https://genehelp.online/uk/requests/8FY4R0CN/edit",
    ),
    "https://genehelp.online/uk/my/requests?request=8FY4R0CN",
  );
});

test("keeps GeneHelp edit links and non-request pages unchanged", () => {
  assert.equal(
    authenticatedGeneHelpViewUrl("https://genehelp.online/uk/my/requests"),
    "https://genehelp.online/uk/my/requests",
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
