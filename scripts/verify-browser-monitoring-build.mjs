import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function verifyNoPublicSourceMaps(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) verifyNoPublicSourceMaps(path);
    else if (entry.name.endsWith(".map")) {
      throw new Error("Refusing to publish source maps. Check the Sentry upload and deletion step.");
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  verifyNoPublicSourceMaps(resolve("dist"));
  console.log("Browser monitoring build verified: no public source maps.");
}
