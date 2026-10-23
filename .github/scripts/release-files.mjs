// Gather what a release publishes into <out>: the installer (renamed without
// spaces, which GitHub would turn into dots) and, when it was signed for the
// updater, its signature and latest.json, which installed copies read to find
// the new version. The release notes go to release-notes.md beside <out>.
//   node .github/scripts/release-files.mjs 0.2.15 release
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [version, out] = process.argv.slice(2);
if (!version || !out) {
  console.error("usage: release-files.mjs <version> <out dir>");
  process.exit(2);
}
const bundle = "target/release/bundle/nsis";
const setup = readdirSync(bundle).find((name) => name.endsWith("-setup.exe") && name.includes(version));
if (!setup) {
  console.error(`no installer for ${version} in ${bundle}: ${readdirSync(bundle).join(", ")}`);
  process.exit(1);
}
mkdirSync(out, { recursive: true });
const installer = `NameStudio_${version}_x64-setup.exe`;
copyFileSync(join(bundle, setup), join(out, installer));

const repository = process.env.GITHUB_REPOSITORY ?? "nanikasheila/name-studio";
const notes = (process.env.NOTES ?? "").trim() || `Name Studio ${version}`;
const signature = join(bundle, `${setup}.sig`);
if (existsSync(signature)) {
  copyFileSync(signature, join(out, `${installer}.sig`));
  const latest = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {
      "windows-x86_64": {
        signature: readFileSync(signature, "utf8").trim(),
        url: `https://github.com/${repository}/releases/download/v${version}/${installer}`,
      },
    },
  };
  writeFileSync(join(out, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);
  console.log(`${installer} with signature and latest.json`);
} else {
  console.log(`${installer} (not signed for the updater: no TAURI_SIGNING_PRIVATE_KEY)`);
}
writeFileSync(
  "release-notes.md",
  `${notes}\n\nWindows: \`${installer}\` を実行して入れてください。入れたアプリは起動時に新しい版へ自動で更新します。\n`,
);
