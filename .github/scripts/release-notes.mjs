// The release notes people who use the app read (the update button, the
// release page, 前の版に戻す): the 「使う人への変更」 section of the pull
// request that made the commit, not the commit message (merge lines,
// co-author lines, links to sessions).
//   node .github/scripts/release-notes.mjs <sha> > notes.md
// Reads GITHUB_REPOSITORY and GH_TOKEN; with no pull request (a release by
// hand), the commit message's first line that says something.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const SECTION = "使う人への変更";

/** The 「使う人への変更」 section of a pull request's body, or "" when it has none or left it empty. */
export function userSection(body) {
  const lines = (body ?? "").replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^#{2,3}\\s*${SECTION}\\s*$`).test(line.trim()));
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,3}\s/.test(line.trim()));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}

/** The first line of a commit message worth showing (not 「Merge pull request #… from …」). */
export function commitLine(message) {
  return (
    (message ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !/^Merge (pull request|branch)\b/.test(line)) ?? ""
  );
}

/** The notes for a release: the section, else the pull request's title, else the commit's line. */
export function releaseNotes({ body, title, message }) {
  return userSection(body) || (title ?? "").trim() || commitLine(message);
}

async function pullRequestOf(repository, sha, token) {
  const response = await fetch(`https://api.github.com/repos/${repository}/commits/${sha}/pulls`, {
    headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!response.ok) return null;
  const pulls = await response.json();
  return pulls.find((pull) => pull.merge_commit_sha === sha) ?? pulls.find((pull) => pull.merged_at) ?? null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const sha = process.argv[2];
  if (!sha) {
    console.error("usage: release-notes.mjs <sha>");
    process.exit(2);
  }
  const repository = process.env.GITHUB_REPOSITORY ?? "nanikasheila/name-studio";
  const pull = await pullRequestOf(repository, sha, process.env.GH_TOKEN).catch(() => null);
  const message = execFileSync("git", ["log", "-1", "--format=%B", sha], { encoding: "utf8" });
  process.stdout.write(`${releaseNotes({ body: pull?.body, title: pull?.title, message })}\n`);
}
