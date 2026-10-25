# CSP のフォルダーとレイヤーマスク（.clip）

書き出しの「コマごとのフォルダー＋レイヤーマスク」（`--panel-masks`）で書く形式。
ユーザーが CSP EX 5.1.4 で作った見本（クリッピングとレイヤーマスクの両方の例）と、
仕上げ原稿のページで確かめた（2026-10-25）。

## フォルダー

ラスターレイヤーの行と次の列だけが違う。

| 列 | ラスター | フォルダー |
| --- | --- | --- |
| `LayerType` | 1 | 0 |
| `LayerFolder` | 0 | 1 |
| `LayerMasking` | 0 | 32 |
| `LayerColorTypeIndex` / `…BlackChecked` / `…WhiteChecked` | 値あり | NULL |

描画オフスクリーン（`LayerRenderMipmap`）は全段にあるが、画素は保存されない（`BlockData` の外部 ID に対応するチャンクがない）。
中のレイヤーは `LayerFirstChildIndex` から `LayerNextIndex` でつながる（下から上）。

## レイヤーマスク

- `LayerType` に 2 が立つ（フォルダー・ベクター 2、ラスター 3）。読むときはこのビットを外して種類を決める。
- `LayerVisibility` に 2 が立つ（3 = 表示＋マスク有効）。
- `LayerLayerMaskMipmap` / `LayerLayerMaskThumbnail` が描画用と同じ作りのミップマップ・サムネイルを指す。
- マスクのオフスクリーンの `Parameter` はキャンバスと同じ大きさで `pixel_kind 1, alpha_planes 1, color_planes 0, total_planes 1`、
  続く値は `0, 0, 0, 1, 256, 0, 256, 256`（コマ枠フォルダーのマスクと同じ）。
- 画素は 256×256 のブロックに 1 面（8 bit）。255 が見える、0 が隠れる。全部 0 のブロックは保存しない（隠れる）。
- オフセット（`LayerMaskOffsetX/Y`、`LayerMaskOffscrOffsetX/Y`）は 0 で書く（見本ではレイヤーを動かすと付く）。

## クリッピング（参考）

見本のもう一つの例: フォルダーの中で、コマの形に塗ったラスター「コマ塗り」の上に、`LayerClip = 1` のフォルダーを置く（下のレイヤーでクリッピング）。
書き出しはレイヤーマスクの方を使う（中に足したレイヤーもすべて隠れ、紙の白を塗らずに済む）。
