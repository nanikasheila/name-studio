---
name: name-studio
description: Name Studio のネーム（漫画の絵コンテ、.namestudio ファイル）を読んで相談に乗る・セリフやコマ割りや構成を書き足す・新しいネームを作るときに使う。Use when the user asks for help with a manga storyboard (ネーム) in a .namestudio file, or wants one read, critiqued, drafted or changed.
---

# Name Studio のネームを手伝う

`.namestudio` は Name Studio（漫画のネームを作るアプリ）のファイルです。中身は JSON で、
ページ・コマ（読む順・形・演出メモ）・セリフ（話者・種類・フキダシ）・ラフ線・付箋・
登場人物・シーン・感情の推移・目標ページ数が入っています。

このスキルの `scripts/namestudio.mjs`（Node.js 18 以上で動く）で、アプリを使わずに読み書きできます。
アプリと同じ処理で変更するので、アプリで開いたときに崩れません。JSON を手で書き換えないでください
（id の重複や座標の誤りで、アプリで開けなくなります）。

以下 `NS` は `node <このスキルのフォルダー>/scripts/namestudio.mjs` のことです。

## 読む

```bash
NS brief ネーム.namestudio                 # 要約: 構成・人物・シーン・ページごとのコマとセリフ
NS brief ネーム.namestudio --pages 5-8     # その範囲だけくわしく（ほかは 1 行ずつ）
NS script ネーム.namestudio                # 台本の形（セリフだけを順に）
NS check ネーム.namestudio                 # 開けるか・書き出し前に気になるところ
```

要約の読み方:
- ページは `p1`…、コマは読む順に `コマ1`…（右綴じは右上から左下へ）。位置と大きさは基本枠に対して。
- セリフは `[line12]（種類・形） 話者「本文」`。`line12` が直すときの id です。
- 「演出メモ」はコマの狙い、「メモ」はページの狙い、「付箋」は未決のことです。
- 絵（ラフ線）は本数だけ。絵の中身は分からないので、聞かれたら作者にたずねてください。

## 変える

変更は「変更の案」（操作の JSON 配列）で当てます。`NS ops` で全部の操作の説明が出ます。

```bash
NS apply ネーム.namestudio 案.json --dry-run   # 何が起きるかだけ見る
NS apply ネーム.namestudio 案.json             # 当てて保存（前の中身は ネーム.namestudio.bak に）
echo '[...]' | NS apply ネーム.namestudio -     # 標準入力から
NS apply ネーム.namestudio 案.json --out 別案.namestudio   # 元はそのまま、別のファイルに
```

1 つでもできない操作があると何も保存しません（理由が出るので直して当て直す）。

主な操作（くわしくは `NS ops`）:

| 操作 | 例 |
| --- | --- |
| script | `{"op":"script","text":"### 1ページ\n[1]\nミカ「おはよう」","startPage":1}` 台本を流し込む（コマのないページにはコマを作る） |
| setTitle | `{"op":"setTitle","title":"…"}` |
| setPageMemo | `{"op":"setPageMemo","page":3,"memo":"…","append":true}` |
| addPages / deletePages / movePage | `{"op":"addPages","after":3,"count":2}` `{"op":"deletePages","pages":[5]}` `{"op":"movePage","page":5,"to":2}` |
| panels | `{"op":"panels","page":3,"pattern":"basic4"}` または `{"op":"panels","page":3,"count":5}` コマ割りし直し（中身は順に移る） |
| setPanelNote | `{"op":"setPanelNote","page":3,"panel":2,"note":"アップ、間をとる"}` |
| addLine | `{"op":"addLine","page":3,"panel":2,"speaker":"ミカ","text":"…","kind":"speech","after":"line12"}` |
| setLine / removeLine | `{"op":"setLine","line":"line12","text":"…","shape":"spike"}` `{"op":"removeLine","line":"line12"}` |
| addSticky | `{"op":"addSticky","page":3,"panel":2,"text":"ここは見開きにしてもいいかも"}` 提案を紙面に残す |
| addCharacter / setCharacter | `{"op":"addCharacter","name":"…","tone":"口調のメモ"}` |
| setScene | `{"op":"setScene","title":"…","firstPage":1,"lastPage":4,"summary":"…"}` |
| setEmotion | `{"op":"setEmotion","character":"ミカ","page":5,"value":-0.6}` |
| setPlan | `{"op":"setPlan","targetPages":24,"structure":"kishotenketsu"}` |

ページ番号はその操作の時点の番号です（ページを足したあとの操作は、足したあとの番号で）。
セリフの本文に改行は要りません（アプリがフキダシに合わせて折り返します）。

### 台本の書き方（script 操作）

```
## シーン名
### 1ページ
ページのメモ（ト書き）
#### コマ1  （または [1]）
コマの演出メモ
ミカ「セリフ」
ミカ（心の声）
ナレーション：…
SE：ドン
ミカ〔電話〕「…」    ← 電子音のフキダシ。（叫び）でトゲ、（小声）で破線
型：opening          ← そのページのコマ割りの型
```

コマ割りの型: basic4（基本の4段）、three、opening（導入）、bigInset、action、sequence、pause（間）、flashback、splash（1枚絵）。

## 新しく作る

```bash
NS new 第1話.namestudio --title "題" --pages 24 --kind right   # right=右綴じ・left=左綴じ・scroll=縦スクロール
```

## ネームの相談の進め方

- まず `brief` で全体をつかみ、作者が何に行き詰まっているかを聞く・言葉にする。
- 直すより先に、選べる案を 2〜3 出す（狙い・読者の感じ方・ページ数への影響を添えて）。
- 作者のセリフや演出を勝手に書き換えない。頼まれたら変更の案にし、迷うところは付箋（addSticky）で残す。
- コマ割りは読む順・ページめくり（めくった最初のコマ・見開き）・間（コマの大きさと数）を見る。
- 構成は目標ページ数・話の型・シーンの配分・感情の推移（要約の「構成の気づき」）を見る。

## Name Studio の「相談」欄から呼ばれたとき

アプリが開いているネームの写し（`ネーム.namestudio`）と要約（`ネーム.md`）、ページの絵（`pages/`）が
作業フォルダーにあります。写しは保存しても作者のネームには届きません。変更は返事の中に

````
```namestudio-ops
[{"op":"setLine","line":"line12","text":"…"}]
```
````

の形で書いてください。作者が中身を確かめてから「当てる」を押すと、アプリで当たります（元に戻せます）。
