import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

// Only public API credentials and normal local authentication are used.
const config = Object.fromEntries(readFileSync(".env.photo-tags.local", "utf8")
  .split(/\r?\n/).filter((line) => line.includes("=") && !line.trim().startsWith("#"))
  .map((line) => { const split = line.indexOf("="); return [line.slice(0, split).trim(), line.slice(split + 1).trim()]; }));
if (config.VITE_SUPABASE_URL !== "http://127.0.0.1:54321") {
  throw new Error("Only the local Docker Supabase at 127.0.0.1:54321 is allowed.");
}
const client = createClient(config.VITE_SUPABASE_URL, config.VITE_SUPABASE_PUBLISHABLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });
const credentials = { email: "photo-tags-local@example.test", password: "PhotoTags-Docker-2026!" };
let result = await client.auth.signInWithPassword(credentials);
if (result.error) {
  result = await client.auth.signUp({ ...credentials,
    options: { data: { name: "Тест позначок фото", full_name: "Тест позначок фото" } } });
}
if (result.error) throw new Error(result.error.message);
if (!result.data.user || !result.data.session) {
  throw new Error("Local test account has no session. Check the local Auth confirmation settings.");
}
console.log(`Local test account ready: ${result.data.user.id}`);
