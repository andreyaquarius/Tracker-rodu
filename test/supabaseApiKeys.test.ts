import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveSupabasePublishableKey,
  resolveSupabaseSecretKey,
  supabaseServerKeyHeaders,
} from "../supabase/functions/_shared/supabaseApiKeys.ts";

test("modern standalone Supabase keys take precedence over managed and legacy values", () => {
  assert.equal(resolveSupabaseSecretKey({
    SUPABASE_SECRET_KEY: " sb_secret_standalone ",
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sb_secret_managed" }),
    SUPABASE_SERVICE_ROLE_KEY: "legacy-service-role",
  }), "sb_secret_standalone");
  assert.equal(resolveSupabasePublishableKey({
    SUPABASE_PUBLISHABLE_KEY: " sb_publishable_standalone ",
    SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: "sb_publishable_managed" }),
    SUPABASE_ANON_KEY: "legacy-anon",
  }), "sb_publishable_standalone");
});

test("hosted Edge Functions read the default key from managed JSON maps", () => {
  assert.equal(resolveSupabaseSecretKey({
    SUPABASE_SECRET_KEYS: JSON.stringify({ secondary: "sb_secret_secondary", default: "sb_secret_default" }),
  }), "sb_secret_default");
  assert.equal(resolveSupabasePublishableKey({
    SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ secondary: "sb_publishable_secondary", default: "sb_publishable_default" }),
  }), "sb_publishable_default");
});

test("managed key parsing is deterministic and falls back safely", () => {
  assert.equal(resolveSupabaseSecretKey({
    SUPABASE_SECRET_KEYS: JSON.stringify({ zed: "sb_secret_zed", alpha: "sb_secret_alpha" }),
  }), "sb_secret_alpha");
  assert.equal(resolveSupabaseSecretKey({
    SUPABASE_SECRET_KEYS: "not-json",
    SUPABASE_SERVICE_ROLE_KEY: "legacy-service-role",
  }), "legacy-service-role");
});

test("opaque secret keys use apikey only while legacy JWT keys retain Bearer auth", () => {
  assert.deepEqual(supabaseServerKeyHeaders("sb_secret_worker"), {
    apikey: "sb_secret_worker",
  });
  assert.deepEqual(supabaseServerKeyHeaders("legacy-service-role-jwt"), {
    apikey: "legacy-service-role-jwt",
    Authorization: "Bearer legacy-service-role-jwt",
  });
  assert.deepEqual(supabaseServerKeyHeaders("  "), {});
});
