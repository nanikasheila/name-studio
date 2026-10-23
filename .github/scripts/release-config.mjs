// Prepare app/src-tauri/tauri.conf.json for a release build: the version
// (from the workflow run) and, when the repository has an updater key, the
// public key so the app checks signed updates.
//   node .github/scripts/release-config.mjs 0.2.15
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("usage: release-config.mjs <major.minor.patch>");
  process.exit(2);
}
const path = "app/src-tauri/tauri.conf.json";
const config = JSON.parse(readFileSync(path, "utf8"));
config.version = version;
const pubkey = (process.env.PUBKEY ?? "").trim();
config.plugins.updater.pubkey = pubkey;
config.bundle.createUpdaterArtifacts = pubkey !== "";
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
console.log(`version ${version}, updates ${pubkey ? "signed" : "off (no TAURI_UPDATER_PUBKEY)"}`);
