// Which release promote.yml makes the 正式版: the version asked for, or the
// newest 試験版. Never one older than the 正式版 now (installed copies would
// not go back, and the newer 正式版's notes would be lost from the top).
//   node .github/scripts/promote-version.mjs releases.json [0.2.90]
// releases.json: `gh release list --json tagName,isPrerelease,isDraft,isLatest`.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const number = (tag) => tag.slice(1).split(".").map(Number);
const newer = (a, b) => {
  const [x, y] = [number(a), number(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

/** The tag to promote, or an error to show. */
export function promoteTag(releases, asked) {
  const versions = releases.filter((release) => !release.isDraft && /^v\d+\.\d+\.\d+$/.test(release.tagName));
  const stable = versions.filter((release) => !release.isPrerelease).reduce((best, release) => (!best || newer(release.tagName, best) ? release.tagName : best), null);
  let tag;
  if (asked) {
    if (!/^\d+\.\d+\.\d+$/.test(asked)) return { error: `版の番号が正しくありません: ${asked}` };
    const found = versions.find((release) => release.tagName === `v${asked}`);
    if (!found) return { error: `v${asked} のリリースがありません` };
    if (!found.isPrerelease) return { error: `v${asked} はもう正式版です` };
    tag = found.tagName;
  } else {
    tag = versions.filter((release) => release.isPrerelease).reduce((best, release) => (!best || newer(release.tagName, best) ? release.tagName : best), null);
    if (!tag) return { error: "正式版にできる試験版がありません" };
  }
  if (stable && !newer(tag, stable)) return { error: `${tag} は今の正式版 ${stable} より古い版です` };
  return { tag };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [file, asked] = process.argv.slice(2);
  const result = promoteTag(JSON.parse(readFileSync(file, "utf8")), (asked ?? "").trim());
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  console.log(result.tag);
}
