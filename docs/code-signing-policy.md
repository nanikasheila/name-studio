# コード署名の方針 / Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

（SignPath Foundation に申し込み中です。署名が始まるまでは、インストーラーは無署名です。）

## 何に署名するか / What is signed

- **正式版**（GitHub の latest リリース）の Windows インストーラー `NameStudio_<版>_x64-setup.exe`。
  The Windows installer of each stable release (the release GitHub marks as latest).
- 正式版に上げるとき（`.github/workflows/promote.yml`）、その版のコミット（タグ `v<版>`）から GitHub Actions の
  GitHub がホストするランナーでビルドし直し、同じ実行の成果物だけを SignPath に送ります。手元でビルドしたものには署名しません。
  The installer is rebuilt from the tagged commit on a GitHub-hosted runner in the promotion workflow, and only
  that run's artifact is submitted to SignPath. Nothing built on a personal machine is signed.
- 試験版（pre-release）は署名しません。Pre-releases are not code-signed.
- 署名するのはこのリポジトリのソースからビルドしたものだけです。Only binaries built from this repository's source are signed.

## 役割 / Team roles

| 役割 / Role | 人 / Members |
|---|---|
| コミッター・レビュアー / Committers and reviewers | [nanikasheila](https://github.com/nanikasheila) |
| 承認者 / Approvers | [nanikasheila](https://github.com/nanikasheila) |

署名の依頼は、承認者が SignPath で 1 件ずつ確かめて承認したときだけ署名されます。全員が GitHub と SignPath で多要素認証を使います。
Every signing request is approved manually by an approver. All members use multi-factor authentication on GitHub and SignPath.

## プライバシー / Privacy policy

このプログラムは、使う人やインストール・操作する人が求めたとき以外、ほかのネットワーク上のシステムに情報を送りません。
This program will not transfer any information to other networked systems unless specifically requested by the user
or the person installing or operating it.

求めたときに通信するのは次のとおりです / It connects only for:

- **更新の確認**: 起動時（設定で「確かめない」にできます）と「今すぐ確かめる」で、GitHub のリリース（`github.com`・`api.github.com`）から新しい版の情報とインストーラーを受け取ります。送るのは通常の HTTPS のリクエストだけです。
  **Update checks** at start-up (can be turned off in the settings) or on request: reads release information and installers from GitHub.
- **AI に相談**: 使う人が相談の欄で送ったときだけ、使う人が選んだもの（PC に入っている Claude Code・Codex、または設定したローカル LLM の URL）にネームの内容を渡します。それぞれのサービスの規約に従います。
  **AI assistance**: only when the user sends a request, the name is passed to the tool the user chose (Claude Code, Codex, or a local LLM URL they configured).

使われ方の記録（設定 › この PC › 使われ方）は PC の中だけに置き、送りません。
Usage statistics stay on the computer and are never sent.
