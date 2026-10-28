# 開発のしかた

Name Studio を直したり、自分でビルドしたりする人向けの説明です。使い方は [README](../README.md) と [使い方のくわしい説明](guide.md) にあります。

CSP のファイル形式の解析結果は csp-name-splitter の
[docs/formats/csp-file-format.md](https://github.com/nanikasheila/csp-name-splitter/blob/main/docs/formats/csp-file-format.md) を参照してください。

## 構成

| 場所 | 中身 |
| --- | --- |
| `crates/clip-core` | .clip / .cmc の読み書きのうちこのツールの規則（レイヤーの種類、ページ枠、ページ一覧、ネーム用紙の取り込み、書き出し、サブツールの描き味）。形式そのもの（コンテナ・DB・画素のブロック・テキスト・ベクター・自己検査）は [csp-format](https://github.com/nanikasheila/csp-format) の `csp-format`、サブツール（.sut / .todb）は `csp-assets` に任せ、ルートの `Cargo.toml` で rev を決めて使う（C の zlib をビルドするので C コンパイラが要る） |
| `crates/name-model` | ネームデータ（正本、.namestudio）。ページ・コマ・セリフ・ラフ線・シーン・登場人物・感情の値。CSP の形式もアプリも知らない（いちばん遅く変わる層。`clip-core/tests/layering.rs` が確かめる） |
| `crates/name-cli` | コマンドライン（`inspect` / `cells` / `import` / `split` / `decode-time`） |
| `app/` | 画面（Tauri 2 + TypeScript）。`app/src-tauri` が Rust 側 |
| `tools/compare_with_python.py` | Python 版（csp-name-splitter の `name_splitter/csp`）と出力を突き合わせる |

Rust 版は Python 版の移植で、Python 版を正解として同じ結果になることを確かめながら進めます。

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

`inspect` の出力は Python 版の `csp-name-splitter inspect` と同じ JSON です。

## 画面を操作せずに書き出す

アプリ自体も、画面を操作せずにネームを CSP へ書き出せます（書き出し画面と同じ処理。
終わると結果の JSON を書いて閉じ、読み直しで問題がなければ終了コード 0）:

```bash
name-studio-app --export-csp ネーム.namestudio (--template page.clip | --builtin) --out 書き出し先 \
  [--work-template 作品.cmc --work-name 第1話] [--story-index 1] [--donor 見本.clip] [--no-draft-rough] [--no-notes] [--no-marks] [--frame-folders | --panel-masks] [--update-dialogue] [--report 結果.json]
```

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
# Python 版との突き合わせ（実ファイルを引数に足せる）
CSP_NAME_SPLITTER=../csp-name-splitter python tools/compare_with_python.py [作品のファイル...]
```

Rust の版は `rust-toolchain.toml` で固定しています（rustup が自動で入れます）。上げるのは Dependabot の PR で、CI が通ってから。

作品のファイルはリポジトリに入れません。テストは合成したファイルだけを使います。

## ネームデータの型と画面の層

ネームデータの型は Rust（`crates/name-model/src/model.rs`）と画面（`app/src/model.ts`）の 2 か所にあります。項目や選択肢を足すときは両方に足し、`app/src/contract.test.ts` の全項目の見本にも足して `(cd app && npx vitest run -u src/contract.test.ts)` で `crates/name-model/tests/fixtures` を書き直してください。Rust の型を変えたら `UPDATE_TS=1 cargo test -p name-model --features ts --test typescript` で `app/src/generated/name-model.ts`（Rust の型を TypeScript にしたもの）を書き直してください。`app/src/modelcheck.test.ts` が型ごとに model.ts と突き合わせ、Rust にあって model.ts にない項目や、Rust が送る値が model.ts の型に合わないところを型チェックで落とします。片方に足し忘れると、型チェックか `cargo test`（`tests/contract.rs`・`tests/typescript.rs`）が落ちます。Rust 側にコマンドを足したら `app/src/backend.ts` の `Commands` にも書いてください（`backend.test.ts` が `lib.rs` と突き合わせます）。

画面側（`app/src`）のモジュールは、変わる速さで層に分けています（遅い順に 型・計算・仕組み・描画・書き出し・画面・起動）。どの層かは `app/src/architecture.test.ts` の `LAYERS` に書き、上の層から import すると落ちます。計算の層（ネームの操作）はブラウザ・保存場所・Rust 側に触らず、この PC に残す設定は `prefs.ts`（中身は `settings.ts`）、画像の読み込みは `pictures.ts`、キャンバスへの描画は `pagedraw.ts` を通します。ファイルを足したら `LAYERS` にも書いてください。

## README の画像

README と使い方の画像（`docs/images`）は、作り物のネーム（`app/e2e/demoname.js`、屋上の短い場面 8 ページ。ラフ線もコードで描いています）を
ブラウザで開いて撮っています。画面を変えたら撮り直してください（ffmpeg と日本語のフォント（Noto CJK など）が要ります）。

```bash
(cd app && npm run readme-shots)
```

作品の原稿や、人の作品の画像は載せません。

## リリース

main にマージすると CI のあとで試験版が公開され、Actions の「Promote to 正式版」で正式版にします。手順・署名鍵・リリースノートの書き方は [release.md](release.md) にあります。

## ライセンス

Name Studio は GNU General Public License v3.0 以降（GPL-3.0-or-later、[LICENSE](../LICENSE)）です。送ってもらった変更も同じライセンスで配ります。
依存を足すときは GPL-3.0 と両立するライセンス（MIT・Apache-2.0・BSD・ISC・Zlib・MPL-2.0 など）か確かめてください。
組み込んでいるライブラリの一覧は [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)（インストール先にも入ります）。依存を変えたら `python tools/third_party.py` で作り直します（CI が古いままを止めます）。
