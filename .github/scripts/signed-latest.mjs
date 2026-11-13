// After promote.yml code-signs a version's installer, the file's bytes are
// new, so the updater's signature of it is new too: put that signature into a
// latest.json that points at this version (the version's own release, and
// channel-beta's when the 試験版 channel still points at it). A latest.json
// for another version is left as it is.
//   node .github/scripts/signed-latest.mjs latest.json NameStudio_0.2.90_x64-setup.exe.sig 0.2.90
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** latest.json with the new signature, or null when it is for another version. */
export function withSignature(latest, version, signature) {
  if (latest.version !== version) return null;
  const platform = latest.platforms?.["windows-x86_64"];
  if (!platform) throw new Error("latest.json has no windows-x86_64 entry");
  if (!signature.trim()) throw new Error("the signature is empty");
  return {
    ...latest,
    platforms: { ...latest.platforms, "windows-x86_64": { ...platform, signature: signature.trim() } },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [file, sig, version] = process.argv.slice(2);
  if (!file || !sig || !version) {
    console.error("usage: signed-latest.mjs <latest.json> <installer.sig> <version>");
    process.exit(2);
  }
  const latest = JSON.parse(readFileSync(file, "utf8"));
  const next = withSignature(latest, version, readFileSync(sig, "utf8"));
  if (next) {
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`${file}: the signature of the code-signed installer of ${version}`);
  } else {
    console.log(`${file}: points to ${latest.version}, not ${version}; left as it is`);
    process.exitCode = 3;
  }
}
