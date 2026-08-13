import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const componentSource = readFileSync(
  new URL("../src/components/AiAgentSettings.tsx", import.meta.url),
  "utf8",
);
const serviceSource = readFileSync(
  new URL("../src/services/aiAgent.ts", import.meta.url),
  "utf8",
);
const edgeFunctionSource = readFileSync(
  new URL("../supabase/functions/save-ai-key/index.ts", import.meta.url),
  "utf8",
);

test("saved AI key is optional when only model or mode changes", () => {
  assert.match(componentSource, /if \(!settings\?\.configured && !normalizedApiKey\)/);
  assert.match(componentSource, /normalizedApiKey \? \{ apiKey: normalizedApiKey \} : \{\}/);
  assert.match(componentSource, /Зберегти налаштування/);
  assert.match(serviceSource, /apiKey\?: string/);
});

test("save-ai-key updates only preferences when a replacement key is omitted", () => {
  assert.match(edgeFunctionSource, /if \(!apiKey\)/);
  assert.match(
    edgeFunctionSource,
    /\.update\(\{ model, mode, updated_at: new Date\(\)\.toISOString\(\) \}\)/,
  );
  assert.match(edgeFunctionSource, /\.select\("api_key_last4"\)/);
  assert.match(edgeFunctionSource, /if \(!updatedSettings\)/);
  assert.match(edgeFunctionSource, /keyUpdated: false/);
  assert.match(edgeFunctionSource, /keyUpdated: true/);
});
