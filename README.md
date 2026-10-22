# name-studio

ネーム（漫画の絵コンテ）制作専用ツールの Rust 実装です。CLIP STUDIO PAINT 本体には触らず、
.clip / .cmc ファイルの読み書きだけで CSP とつながります。構想と段階計画は
[検討ドキュメント](https://claude.ai/artifact/PhzqeXUZhD9LZs2pbkRsLs) にあります。

いまは独立したリポジトリができるまで、csp-name-splitter の中に置いています。

## 構成

| 場所 | 中身 |
| --- | --- |
| `crates/clip-core` | .clip / .cmc の読み取り（レイヤーツリー、ラスター画素、ベクター、テキスト、ページ一覧） |
| `crates/name-cli` | コマンドライン（`name-studio-cli inspect` など） |
| `tools/compare_with_python.py` | Python 版（`name_splitter/csp`）と出力を突き合わせる |

形式の解析結果は [docs/formats/csp-file-format.md](../docs/formats/csp-file-format.md) を参照してください。
Rust 版は Python 版の移植で、Python 版を正解として同じ結果になることを確かめながら進めます。

## 使い方

```bash
cd name-studio
cargo build --release
./target/release/name-studio-cli inspect page0001.clip --pixels
./target/release/name-studio-cli decode-time ネーム.clip   # ラスター復元の時間を測る
```

`inspect` の出力は Python 版の `csp-name-splitter inspect` と同じ JSON です。

## テスト

```bash
cd name-studio && cargo test
# Python 版との突き合わせ（リポジトリのルートで。実ファイルを引数に足せる）
python name-studio/tools/compare_with_python.py [作品のファイル...]
```

作品のファイルはリポジトリに入れません。テストは合成したファイルだけを使います。
