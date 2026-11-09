// Before build-app.yml publishes a 試験版: the newest release already out that
// is newer than it (printed), or nothing. Merges built side by side can finish
// out of order; the later merge's release stays the newest, and channel-beta's
// latest.json never goes back to an older one.
//   node .github/scripts/newer-release.mjs releases.json 0.2.120
// releases.json: `gh release list --json tagName,isPrerelease,isDraft,isLatest`.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { newer } from "./promote-version.mjs";

/** The newest released tag newer than `version`, or null. */
export function newerRelease(releases, version) {
  const tag = `v${version}`;
  return (
    releases
      .filter((release) => !release.isDraft && /^v\d+\.\d+\.\d+$/.test(release.tagName) && newer(release.tagName, tag))
      .reduce((best, release) => (!best || newer(release.tagName, best) ? release.tagName : best), null) ?? null
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [file, version] = process.argv.slice(2);
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
    console.error("usage: newer-release.mjs <releases.json> <major.minor.patch>");
    process.exit(2);
  }
  const found = newerRelease(JSON.parse(readFileSync(file, "utf8")), version);
  if (found) console.log(found);
}
