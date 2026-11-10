# 設計のあらまし

Name Studio がどう組み立ててあるかを、1 か所で読めるようにまとめたものです。
ビルドやテストの手順は [DEVELOPMENT.md](DEVELOPMENT.md)、リリースは [release.md](release.md) にあります。
ここに書いた決まりの多くはテストが守っています（どのテストかも書いてあります）。決まりを変えるときは、テストと一緒にここも直してください。

## 何がどこにあるか

```
ネームデータ（.namestudio）  ←  正本。ここだけが「本当のこと」
        │
        ├─ 画面（app/src、TypeScript）        読む・描く・直す
        │       │  call()（backend.ts）
        │       ▼
        ├─ アプリの Rust 側（app/src-tauri）   ファイル・ダイアログ・書き出し・相談
        │       │
        │       ▼
        ├─ clip-core（crates/clip-core）       このツールの決まりで CSP のページを作る
        │       │
        │       ▼
        └─ csp-format（別リポジトリ）          CSP の形式そのもの（読む・検査する・書き戻す）
```

| 場所 | 役目 | 知っていること・知らないこと |
| --- | --- | --- |
| `crates/name-model` | ネームデータ（正本）の型、保存、検査、版の履歴 | CSP もアプリも知らない |
| `crates/clip-core` | ネームを CSP のページ・作品にする決まり（レイヤーの種類、ページ枠、見開き、セリフだけ反映、自己確認） | 形式そのものは csp-format に任せる |
| `crates/name-cli` | コマンドライン（調べる・分ける・検査する） | 画面を知らない |
| `app/src-tauri` | アプリの Rust 側。画面からのコマンドを受ける | 画面の中身は知らない |
| `app/src` | 画面 | CSP の形式を知らない（Rust 側に頼む） |
| `skills/name-studio` | AI 用のスキル（`app/src` の計算の層から作る） | 画面を知らない |
| [csp-format](https://github.com/nanikasheila/csp-format) | CSP の .clip / .cmc / .sut の形式。仕様は `docs/spec` | Name Studio を知らない |

依存は上から下への一方向です。`name-model` が CSP の形式にもアプリにも依存しないことは `crates/clip-core/tests/layering.rs` が確かめます。
CSP のファイルの中（SQLite の表）を書き換えるのは csp-format の関数だけで、`clip-core`・`name-cli`・アプリが SQL を直接書いていないことも同じテストが確かめます。

## 変わる速さで分ける（ペースレイヤリング）

速く変わるものが、ゆっくり変わるものに寄りかかるようにしてあります。逆向きの依存は作りません。

| 速さ | 層 | 例 | 変えるときの重さ |
| --- | --- | --- | --- |
| いちばん遅い | ファイルの形式 | .namestudio の項目、CSP の形式（csp-format） | 古いファイルが読めるかを互換テストで確かめる |
| 遅い | ネームの言葉と計算 | コマ・セリフ・ラフ線・物語、その操作 | 単体テスト |
| 中くらい | 編集の仕組み | 取り消し、表示の位置、ツール、キー | 単体テストと画面の通しテスト |
| 速い | 画面 | 欄・ダイアログ・見た目 | 画面の通しテスト |
| いちばん速い | 配布 | 試験版・正式版 | CI と実アプリの書き出し確認、CSP での確認 |

### 画面のコード（`app/src`）の層

`app/src/architecture.test.ts` の `LAYERS` に全モジュールを載せ、上の層を import すると落ちます。循環も落ちます。新しいファイルは、どの層かを決めて `LAYERS` に書いてください。

| 層（遅い順） | 中身 | してはいけないこと |
| --- | --- | --- |
| `model` | ネームデータの型と平面の計算 | ほかのモジュールの import |
| `domain` | ネームとその操作（コマ・セリフ・物語・書き出しの計算） | ブラウザ・保存・Rust 側に触る |
| `editing` | 編集の計算（配置・当たり判定・取り消し・コマンド・キー） | 同上 |
| `platform` | この PC と Rust 側（`backend.ts`・`dialogs.ts`・設定・DOM の道具） | 画面を知る |
| `render` | キャンバスへの描画（画面と書き出しで共通） | |
| `service` | 画面のための仕事（自動保存・書き出し） | |
| `ui` | 画面 | |
| `app` | 起動（`main.ts`） | |

入口を 1 か所にしているもの（どれもテストが守ります）:

- Rust 側を呼ぶのは `backend.ts` の `call()` だけ。コマンドの名前・引数・戻り値の型は手で書かず、Rust のソースから作ります（`cargo run -p ipc-types` が `app/src/generated/ipc.ts` を書く）。Rust 側を変えて作り直し忘れると `cargo test`（`crates/ipc-types/tests/fresh.rs`）が落ち、画面側が合わなくなったところは型チェックが落とします。
- システムのダイアログ（ファイルを選ぶ・聞く・知らせる）は `dialogs.ts` だけ。
- この PC に残す設定は `prefs.ts`（中身の決まりは `settings.ts`）。
- ネームデータの型は Rust（`name-model`）と画面（`model.ts`）の 2 か所にあり、`contract.test.ts`・`modelcheck.test.ts` と Rust の `tests/contract.rs`・`tests/typescript.rs` が揃っていることを確かめます。

### アプリの Rust 側（`app/src-tauri/src`）

| モジュール | 役目 |
| --- | --- |
| `lib.rs` | 起動とコマンドの一覧 |
| `project_io.rs` | ネームの読み書き・自動保存・版・復旧 |
| `viewer.rs` | ネーム用紙（.clip）を開く・取り込む |
| `name_export.rs` | CSP のページ・作品の書き出し（1 ページずつ） |
| `files.rs` | PDF・画像・台本・サブツールなど、そのほかのファイル |
| `dialogs.rs`・`paths.rs` | ファイルを選ぶダイアログと、選ばれた場所の記録（下の「守り」） |
| `ai/` | 相談（Claude Code・Codex・ローカル LLM）。`programs`・`session`・`cli`・`local`・`models`・`history` |
| `proctree.rs` | 起動したプログラムを、それが起動したものごと止める |
| `updates.rs` | 更新と前の版に戻す |
| `batch.rs` | 画面を操作しない書き出し（`--export-csp`） |
| `fonts.rs`・`errorlog.rs`・`ipc.rs` | フォントの一覧・エラーの記録・コマンドの共通の道具 |

## データを失わないために

- 保存は「別の名前で書いてから入れ替える」（`name_model::atomic`）。書いている途中で落ちても、前のファイルが残ります。
- 自動保存はネームごとの復旧ファイルに書き、次の起動で 1 件ずつ聞きます。同じ中身なら書きません。
- 取り消しは、変わらなかったページを共有するスナップショット（`snapshot.ts`）。点の並びは作り直すだけで書き換えないので、覚えるのに場所を取りません。開発中は共有した並びを凍らせて、その場での書き換えを見つけます。
- 知らない項目のあるネーム（新しい版で保存したもの）は、項目を落とさずに持ち回り、書き出すときは何を出さないかを先に知らせます。
- CSP への書き出しは、元のファイルを読むだけで、新しいファイルに書きます。書いたページは読み直して、送ったものと同じか確かめます（`clip-core` の `write/verify.rs`）。

## 守り（画面と Rust 側の境目）

窓の中で動くのはこのアプリ自身のコードですが、ネームのファイル・CSP のページ・AI の返事といった外から来た文字を表示します。そこで間違いがあっても「どこにでも書ける」「何でも動かせる」にならないよう、Rust 側が自分で確かめます。

- **書く場所** ファイルを選ぶダイアログは Rust 側が開き、選ばれた場所を覚えます（`paths.rs` の `Chosen`。次の起動にも残します）。PDF・画像・台本・サブツールを書くコマンドは、その種類の拡張子で、選ばれた場所にだけ書きます。「前回と同じ設定で書き出す」は、覚えている場所が選ばれたものかを先に聞き、違えば保存先を聞き直します。
- **動かすプログラム** 相談で動かすのは、自動で見つかった Claude Code・Codex か、「参照…」で選ばれたものだけです。動かすフォルダーは相談ごとのフォルダー（アプリのデータの中）だけで、AI は読むだけの設定で動かします。変更は「変更の案」として返ってきたものを、人が確かめてから当てます。
- **画面の決まり** Content-Security-Policy で、外のスクリプトを読み込みません。AI の返事の Markdown は自前の変換で、HTML をそのまま差し込みません。
- **秘密** API のキーはシステムの資格情報の置き場に入れ、ファイルには書きません。
- **更新** 署名の合う更新だけを入れます。

## 配布

main にマージすると CI と同時にインストーラーを作り、CI が通ったら**試験版**として公開します。CSP で確かめてから**正式版**に上げます（[release.md](release.md)）。

- GitHub Actions は、使う Action をコミットで固定し、書き込みの権限は公開するジョブだけに渡します（`.github/scripts/workflows.test.mjs` が守ります）。上げるのは Dependabot の PR です。
- Rust の版は `rust-toolchain.toml`、ライブラリは `Cargo.lock`・`package-lock.json` で固定し、既知の脆弱性は CI の `cargo audit` で見ます。

## CSP の形式について

形式の仕様と、その確かめ方は [csp-format の docs/spec](https://github.com/nanikasheila/csp-format/tree/main/docs/spec) が正本です。
このリポジトリの `docs/csp-*.md`・`docs/builtin-template.md` は、Name Studio がその形式を**どう使うか**（どのレイヤーをどう作るか）の覚え書きです。形式そのものについて新しく分かったことは、csp-format の仕様に書いてください。

もとになった Python 版（[csp-name-splitter](https://github.com/nanikasheila/csp-name-splitter)）は参照用です。CI は決めたコミットの Python 版と `inspect` の結果を突き合わせますが、正解は csp-format の仕様と CSP 自身です。
