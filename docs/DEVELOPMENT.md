# 開発のしかた

Name Studio を直したり、自分でビルドしたりする人向けの説明です。使い方は [README](../README.md) と [使い方のくわしい説明](guide.md) にあります。

全体の組み立て（どこに何があるか、層の決まり、守り）は [ARCHITECTURE.md](ARCHITECTURE.md) にまとめてあります。
CSP のファイル形式の仕様は [csp-format の docs/spec](https://github.com/nanikasheila/csp-format/tree/main/docs/spec) が正本です
（このリポジトリの `docs/csp-*.md` は、Name Studio がその形式をどう使うかの覚え書き）。

## 構成

| 場所 | 中身 |
| --- | --- |
| `crates/clip-core` | .clip / .cmc の読み書きのうちこのツールの規則（レイヤーの種類、ページ枠、ページ一覧、ネーム用紙の取り込み、書き出し、サブツールの描き味）。形式そのもの（コンテナ・DB・画素のブロック・テキスト・ベクター・自己検査）は [csp-format](https://github.com/nanikasheila/csp-format) の `csp-format`、サブツール（.sut / .todb）は `csp-assets` に任せ、ルートの `Cargo.toml` で rev を決めて使う（C の zlib をビルドするので C コンパイラが要る） |
| `crates/name-model` | ネームデータ（正本、.namestudio）。ページ・コマ・セリフ・ラフ線・シーン・登場人物・感情の値。CSP の形式もアプリも知らない（いちばん遅く変わる層。`clip-core/tests/layering.rs` が確かめる） |
| `crates/name-cli` | コマンドライン（`inspect` / `cells` / `import` / `split` / `decode-time`） |
| `app/` | 画面（Tauri 2 + TypeScript）。`app/src-tauri` が Rust 側 |
| `skills/name-studio` | AI（Claude Code / Codex）用のスキル。`SKILL.md` と、.namestudio を読み書きする `scripts/namestudio.mjs`（`app/src/skill/cli.ts` と画面の計算の層 `assist.ts` などから `npm run build:skill` で作る。生成物だがスキルとして配るのでコミットし、CI が最新か確かめる）。アプリにも同じものを `include_str!` で入れている |
| `tools/compare_with_python.py` | もとになった Python 版（csp-name-splitter の `name_splitter/csp`）と `inspect`・分割の結果を突き合わせる |

Rust 版は Python 版の移植から始まりました。今の正解は csp-format の仕様と CSP 自身で、Python 版は参照用です。
CI の突き合わせは、決めたコミットの Python 版（`.github/workflows/ci.yml` の `REFERENCE_REF`）とだけ行います
（読み方が食い違ったら、どちらが正しいかを csp-format の仕様と CSP で確かめてから、合わせるほうを決めます）。

## ビルドと起動

Rust（`rust-toolchain.toml` の版を rustup が自動で入れます）、Node.js、C コンパイラが要ります。Linux では Tauri の WebView（webkit2gtk）も入れてください。

```bash
cd app
npm install
npm run tauri dev      # 画面を起動
npm run tauri build    # インストーラーを作る
```

## コマンドライン

```bash
cargo build --release -p name-cli
./target/release/name-studio-cli inspect page0001.clip --pixels
./target/release/name-studio-cli cells ネーム.clip
```

`inspect` の出力は Python 版の `csp-name-splitter inspect` と同じ形の JSON です（突き合わせのため）。

## 画面を操作せずに書き出す

アプリ自体も、画面を操作せずにネームを CSP へ書き出せます（書き出し画面と同じ処理。
終わると結果の JSON を書いて閉じ、読み直しで問題がなければ終了コード 0）:

```bash
name-studio-app --export-csp ネーム.namestudio (--template page.clip | --builtin) --out 書き出し先 \
  [--work-template 作品.cmc --work-name 第1話] [--story-index 1] [--donor 見本.clip] [--no-draft-rough] [--no-notes] [--no-marks] [--frame-folders | --panel-masks] [--update-dialogue] [--report 結果.json]
```

終了コード: 0 = 書き出して読み直しも問題なし、1 = 問題あり・失敗（理由は結果の JSON）、2 = 引数の誤り、3 = 結果の JSON を保存できなかった（ページは書き出してあることもある）。0 以外のときは理由を標準エラーにも出します。書き出し先の中を確かめられない（権限がない・フォルダーでない）ときは、何も書かずに 1 で終わります。

`--builtin` はひな形の代わりに、ネームに保存した CSP のページ設定（書き出し画面の「ツールで設定する」、なければネームの用紙・600 dpi）でページを作ります。`--work-name` があれば作品ファイルも作ります（[builtin-template.md](builtin-template.md)）。

## テスト

```bash
cargo test
(cd app && npm test)
# 画面のコードの lint（Biome。CI でも流す）と、既知の脆弱性（cargo install cargo-audit）
(cd app && npm run lint)
cargo audit
# 画面の通しテスト（ブラウザで開く・描く・元に戻す・失敗の取り消し・自動保存・連続表示と速さ）
(cd app && npx playwright install chromium && npm run e2e)
# 実アプリで書き出す（WebView・CSP・Rust 側との通信まで。Linux は xvfb-run を前に付ける）
(cd app && npx tauri build --no-bundle)
cargo run -p clip-core --features fixtures --example fixture_page -- /tmp/app-check/page.clip
(cd app && node e2e/realapp.mjs /tmp/app-check)
# 実アプリの画面の見た目（Windows の WebView2：配色・カスタム CSS が残るか、Shift を押しての起動、Ctrl+Shift+Alt+R。撮った画面を指定のフォルダーに）
(cd app && npx tauri build --no-bundle --config '{"identifier":"com.nanikasheila.namestudio.look"}' && node e2e/lookapp.mjs ../look-shots)
# AI 用スキルの CLI を作り直して試す（app/src の計算の層を変えたら。CI は差分があると落ちる）
(cd app && npm run build:skill)
# 相談の欄（Claude Code / Codex / ローカル LLM は Rust 側を差し替えて）
(cd app && npm run e2e:assist)
# Python 版との突き合わせ（実ファイルを引数に足せる）
CSP_NAME_SPLITTER=../csp-name-splitter python tools/compare_with_python.py [作品のファイル...]
```

Rust の版は `rust-toolchain.toml` で固定しています（rustup が自動で入れます）。上げるのは Dependabot の PR で、CI が通ってから。

作品のファイルはリポジトリに入れません。テストは合成したファイルだけを使います。

## ネームデータの型と画面の層

ネームデータの型は Rust（`crates/name-model/src/model.rs`）と画面（`app/src/model.ts`）の 2 か所にあります。項目や選択肢を足すときは両方に足し、`app/src/contract.test.ts` の全項目の見本にも足して `(cd app && npx vitest run -u src/contract.test.ts)` で `crates/name-model/tests/fixtures` を書き直してください。Rust の型を変えたら `UPDATE_TS=1 cargo test -p name-model --features ts --test typescript` で `app/src/generated/name-model.ts`（Rust の型を TypeScript にしたもの）を書き直してください。`app/src/modelcheck.test.ts` が型ごとに model.ts と突き合わせ、Rust にあって model.ts にない項目や、Rust が送る値が model.ts の型に合わないところを型チェックで落とします。片方に足し忘れると、型チェックか `cargo test`（`tests/contract.rs`・`tests/typescript.rs`）が落ちます。

Rust 側のコマンド（`#[tauri::command]`）を足したり、引数や結果の型を変えたりしたら、`cargo run -p ipc-types` で `app/src/generated/ipc.ts` を作り直してください。これは Rust のソースを読んで、コマンドの名前・引数・結果と、そこに出てくる構造体や列挙を TypeScript に書き出すものです（`crates/ipc-types`）。作り直し忘れると `cargo test` の `ipc-types` が落ち、作り直したあと画面側の使い方が合わなければ型チェックが落ちます。

- serde の属性は、使っているもの（`rename_all`・`default`・`flatten`・`skip…`・`untagged`・`tag`）だけ読みます。知らない属性は当て推量にせずエラーにします。
- Rust 側が中身を見ずに通す JSON（`serde_json::Value`・`RawValue`）は `unknown` になります。画面側が中身を知っているものは、`crates/ipc-types/src/lib.rs` の `OVERRIDES` か `app/src/backend.ts` の `Known` に書きます。
- ネームデータ（`Project` など）は書き出さず、`model.ts` のものを使います（上の `modelcheck.test.ts` が Rust と突き合わせています）。
- csp-format の型（ページ設定の `PageSetup`）も、`Cargo.lock` が指す版のソースから書き出します。csp-format を上げたときも作り直してください。

画面の色はすべて `app/src/styles.css` の先頭の CSS 変数（明るい・暗いを `light-dark()` で 1 行に）で書き、配色（`look.ts` の `THEMES`）はそれを上書きします。新しい色は変数を使うか足してください（紙面とその代わりの色は `--paper`・`--paper-ink` で、配色では変えません）。文字の大きさは 14 px のときの値を `calc(12 * var(--px))` のように書きます（設定の「画面の文字の大きさ」に合わせて変わります。`look.test.ts` が px のままの文字の大きさと `prefers-color-scheme` を落とします）。

画面側（`app/src`）のモジュールは、変わる速さで層に分けています（遅い順に 型・計算・仕組み・描画・書き出し・画面・起動）。どの層かは `app/src/architecture.test.ts` の `LAYERS` に書き、上の層から import すると落ちます。計算の層（ネームの操作）はブラウザ・保存場所・Rust 側に触らず、この PC に残す設定は `prefs.ts`（中身は `settings.ts`）、画像の読み込みは `pictures.ts`、キャンバスへの描画は `pagedraw.ts` を通します。ファイルを足したら `LAYERS` にも書いてください。

## README の画像

README と使い方の画像（`docs/images`）は、作り物のネーム（`app/e2e/demoname.js`、部室の短い場面 8 ページ）を
ブラウザで開いて撮っています。画面を変えたら撮り直してください（ffmpeg と日本語のフォント（Noto CJK など）が要ります）。

ラフの絵は作者の絵（完成原稿の一部）を線に起こしたもので、リポジトリには入れていません。
線のデータ（`art.json`: 切り出しごとの大きさと線の座標）の場所を `README_ART` で渡します（ないときはプロジェクトの共有フォルダーの
`readme-art/art.json`）。どちらもなければ、コードで描いた簡単な人物で撮ります。

```bash
(cd app && npm run readme-shots)
```

作品の原稿や、人の作品の画像は載せません。

## リリース

main にマージすると、CI と同時にインストーラーを作り、CI が通ったところで試験版が公開され、Actions の「Promote to 正式版」で正式版にします。手順・署名鍵・リリースノートの書き方は [release.md](release.md) にあります。

## ライセンス

Name Studio は GNU General Public License v3.0 以降（GPL-3.0-or-later、[LICENSE](../LICENSE)）です。送ってもらった変更も同じライセンスで配ります。
依存を足すときは GPL-3.0 と両立するライセンス（MIT・Apache-2.0・BSD・ISC・Zlib・MPL-2.0 など）か確かめてください。
組み込んでいるライブラリの一覧は [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)（インストール先にも入ります）。依存を変えたら `python tools/third_party.py` で作り直します（CI が古いままを止めます）。
