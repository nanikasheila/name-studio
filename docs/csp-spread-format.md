# CSP の見開きページの形式

CSP EX 5.1.4 が作った見開きページ（作品のページ管理で「見開きページに変更」したもの）と、
同じ作品の単ページを中の SQLite で比べた結果です（2026-10-23）。`clip-core` の
`write::spread` は、この形に合わせて単ページのひな形から見開きのひな形を作ります。

## キャンバス

- `CanvasWidth` が単ページの 2 倍（297 mm → 594 mm、600 dpi で 7016 px → 14031 px。px は mm から丸め直す）。
  高さは同じ。
- `CanvasDoublePage` = 1、`ComicIsLeftPage` = 0、`ComicPageIndex` は右開きなら右ページ（番号の若いほう）の位置。
- `ComicStoryRightLayerCreated` / `ComicNombreRightLayerCreated` = 1（単ページには列がない）。
- 枠の値（`CropFrameWidth/Height`、`CropFrameInner*`、裁ち落とし）は **1 ページ分のまま**。
  2 ページの仕上がり枠はノド（キャンバスの真ん中）で合わさる。
  左ページの仕上がりは `ceil((W2 - 2T) / 2)` から、右ページはノド `= その値 + T` から始まる（T は 1 ページの仕上がり幅 px）。
- `CropFrameOptionFlag`: 単ページの左右の印（2 = 左、4 = 右）が消え、5.1.4 で作り直した見開きは 17。

## 作品情報・ノンブル

- `ComicStoryInfoType` 1（作品情報）と 2（ノンブル）のテキストレイヤーが各ページに 1 組、計 2 組。
- 右ページ用は Layer の `ComicStoryInfoForRightPage` = 1、左ページ用は NULL（単ページには列がない）。
  レイヤー名は 4 つとも単ページと同じ「(作品情報)」「(ノンブル)」。
- 文字ブロックの bbox（TLV 0x2A、レイヤー座標。`LayerOffsetX` を足すとキャンバス座標）は単ページの位置を
  各ページの仕上がりまでずらしたもの。ノンブルはノド側にある（左ページは右端、右ページは左端 = ノド）。
- テキストの描画キャッシュ（TLV 0x32 → Offscreen）は CSP が開くときに作り直す。

## ピクセルの入れ物

- Offscreen の `Attribute` は、先頭 16 バイトが BE の u32 で [16, Parameter 節の長さ, InitColor 節の長さ, BlockSize 節の長さ]。
  - Parameter 節: 名前、width, height, blocks_x, blocks_y, 0x21, 1, 4, 5、そのあと大きさに関係しない 38 バイト。
  - InitColor 節: 用紙だけ白（flag 1、ffffffff）。
  - BlockSize 節: 名前、12、ブロック数 n、4、ブロックごとの u32 が n 個（ペイロードの各ブロックレコードの長さ。空は 0x68）。
- ミップマップは 8 段、各段は前の段の半分（切り捨て）。ルートはキャンバスちょうど、ほかのレイヤーは 256 の倍数に切り上げた大きさ。
- 多くの段は外部チャンクがない（ID だけ）。CSP が開くときに作る。
- `LayerThumbnail` の `ThumbnailCanvasWidth/Height` はキャンバスの大きさ。サムネイル自体は 512×512 のまま。
- `CanvasPreview` はキャンバスの 1/8（見開きなら 1753×1240）。

## 作品（.cmc）

- `CanvasNode` は見開きも 1 行。`PageFlag` = 1、`LinkWidth` が 2 倍（594）。
- ページファイルの番号は見開きで 2 つ進む（page0002 が見開きなら次は page0004）。
