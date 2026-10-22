# name-studio

ネーム（漫画の絵コンテ）制作専用ツールです。CLIP STUDIO PAINT 本体には触らず、
.clip / .cmc ファイルの読み書きだけで CSP とつながります。ペン入れ以降は今までどおり CSP で行います。

構想と段階計画は [検討ドキュメント](https://claude.ai/artifact/PhzqeXUZhD9LZs2pbkRsLs) にあります。
ファイル形式の解析結果は csp-name-splitter の
[docs/formats/csp-file-format.md](https://github.com/nanikasheila/csp-name-splitter/blob/nanikasheila/feat-cmc-writer/docs/formats/csp-file-format.md) を参照してください。

## できること（N1 の途中）

- CSP のネーム用紙（.clip）を開いて、全体表示と右綴じの見開き表示で見直す
- ページ枠（テンプレートの四角形）から 1〜N ページを自動で割り当てる
- レイヤーの表示切り替え、ページごとのセリフ一覧（縦書きで表示）

## 構成

| 場所 | 中身 |
| --- | --- |
| `crates/clip-core` | .clip / .cmc の読み取り（レイヤーツリー、ラスター画素、ベクター、テキスト、ページ枠、ページ一覧） |
| `crates/name-cli` | コマンドライン（`name-studio-cli inspect` / `cells` / `decode-time`） |
| `app/` | 画面（Tauri 2 + TypeScript）。`app/src-tauri` が Rust 側 |
| `tools/compare_with_python.py` | Python 版（csp-name-splitter の `name_splitter/csp`）と出力を突き合わせる |

Rust 版は Python 版の移植で、Python 版を正解として同じ結果になることを確かめながら進めます。

## 使い方

Windows のインストーラーは GitHub Actions の「Build Windows app」が作ります（Artifacts から取得）。
署名していないため、初回は SmartScreen の警告が出ます。

開発する場合:

```bash
cd app
npm install
npm run tauri dev      # 画面を起動
npm run tauri build    # インストーラーを作る
```

コマンドライン:

```bash
cargo build --release -p name-cli
./target/release/name-studio-cli inspect page0001.clip --pixels
./target/release/name-studio-cli cells ネーム.clip
```

`inspect` の出力は Python 版の `csp-name-splitter inspect` と同じ JSON です。

## テスト

```bash
cargo test
(cd app && npm test)
# Python 版との突き合わせ（実ファイルを引数に足せる）
CSP_NAME_SPLITTER=../csp-name-splitter python tools/compare_with_python.py [作品のファイル...]
```

作品のファイルはリポジトリに入れません。テストは合成したファイルだけを使います。
