# リリースと自動更新

main にマージするたび、GitHub Actions の「Release Windows app」（`.github/workflows/build-app.yml`）が
そのコミットから Windows のインストーラーを作り、`v0.2.<実行番号>` の**試験版**（GitHub の pre-release）として公開します。
インストーラーのビルドと確認は CI（`.github/workflows/ci.yml`）と同時に走り、公開は同じコミットで CI が通ってからです。
CI が失敗したコミットは配られません。マージから試験版まではおよそ CI の長さで済みます（前は CI のあとで一からビルドしていました）。
続けてマージして、あとのマージの版が先に出たときは、前のマージの版は公開しません（試験版の更新先が古い版に戻らないように）。

Actions の「Release Windows app」→ Run workflow で手で流すこともできます。main で流すと（その版の CI が通っていれば）公開しますが、
ほかのブランチで流したときはインストーラーを作って確かめ、実行結果の Artifacts（`name-studio-windows-installer`）に
置くだけで公開しません（レビュー前のビルドが自動更新で配られないように）。

インストールしたアプリは、起動すると正式版（試験版も受け取る設定なら試験版）の `latest.json` を見て、新しい版があれば取り込んで再起動します。
ネームを開いているときは自動では入れ替えず、ツールバーの「更新」ボタンを押したときに、
自動保存で書いてから入れ替えます。PC で自分でビルドしたもの（`NAME_STUDIO_RELEASE` なし）は更新しません。

起動したときどうするかは、設定（歯車）→「この PC」→「更新」で選べます:
「新しい版を確かめて、自動で入れる」（初期）／「確かめて、知らせるだけ」（右上の「更新」を押すまで入れない）／
「確かめない」（起動時にネットを見ない）。どれでも「今すぐ確かめる」でその場で確かめられます。

## 試験版と正式版

1. main へのマージ → CI → 試験版 `v0.2.N` ができ、`channel-beta` リリースの `latest.json` がそれを指します。
   設定（歯車）→「この PC」→「更新」で「試験版も受け取る」にしたアプリだけが、すぐ受け取ります。
2. 試験版を PC の CLIP STUDIO PAINT で確かめます（書き出したページ・作品が開けて、変更マーク「*」がない、など）。
3. Actions →「Promote to 正式版」→ Run workflow（版を空にすると、いちばん新しい試験版）。その版が GitHub の
   latest になり、ふつうの設定のアプリ（正式版だけ）はこれを受け取ります。今の正式版より古い版は正式版にできません。
   コード署名の設定があれば、その前にインストーラーを署名つきに差し替えます（SignPath での承認が要ります。下の「コード署名」）。

試験版で困ったときは、「前の版に戻す」（一覧に「試験版」と出ます）で正式版に戻せます。

### いつ正式版に上げるか

試験版だけが増え続けると、ふつうの設定の人に直したものが届きません。**週に 1 回か、正式版のあと試験版が
10 本たまったら**、いちばん新しい試験版を 2. のとおり確かめてから 3. で正式版に上げます。確かめるのは、
その版で書き出した見本のページと作品（左右の綴じ・見開き・セリフ・フォント・ペンの線・塗り・指示のレイヤー）
を CSP で開いて、絵と文字が正しく、「*」がつかないことです。困ることが見つかったら上げずに直し、直した
試験版でもう一度確かめます。

## リリースノート

リリースノートと「更新」ボタンの説明には、マージした PR の本文の `## 使う人への変更` の節がそのまま出ます
（`.github/pull_request_template.md`、`.github/scripts/release-notes.mjs`）。節がないか空なら PR の題を使います。
使う人に見える変化を、使う人の言葉で書いてください。

## 更新の署名鍵（最初に一度だけ）

アプリは、署名が正しい更新だけを入れます。鍵ができるまでは、リリースにインストーラーだけが載り、自動更新は動きません。

1. PC の PowerShell で鍵を作ります（パスワードを聞かれます。忘れないものを入れてください）。

   ```powershell
   cd C:\Users\SHEILA\source\repos\name-studio-pr8\app
   npx tauri signer generate -w "$env:USERPROFILE\.tauri\name-studio.key"
   ```

   `name-studio.key`（秘密鍵）と `name-studio.key.pub`（公開鍵）ができます。秘密鍵は人に渡さず、PC に置いたままにします。

2. GitHub の name-studio → Settings → Secrets and variables → Actions を開きます。

   - 「Secrets」タブ → New repository secret を 2 つ:
     - `TAURI_SIGNING_PRIVATE_KEY`: `name-studio.key` の中身をそのまま貼る
       （`Get-Content "$env:USERPROFILE\.tauri\name-studio.key" | Set-Clipboard` でコピーできます）
     - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: 1. で入れたパスワード
   - 「Variables」タブ → New repository variable を 1 つ:
     - `TAURI_UPDATER_PUBKEY`: `name-studio.key.pub` の中身

3. Actions → Release Windows app → Run workflow で一度流すと、署名付きのリリースができます。
   その版をインストーラーで入れると、以後は起動するだけで新しい版になります。

鍵をなくすと、それまでに入れたアプリは新しい版を受け付けません（インストーラーで入れ直せば直ります）。

## コード署名（SignPath Foundation、正式版だけ）

インストーラーの Authenticode のコード署名は、[SignPath Foundation](https://signpath.org/)（オープンソース向け、無料）の
証明書で、**正式版に上げるときだけ**します（方針: [code-signing-policy.md](code-signing-policy.md)）。更新の署名（上の鍵）とは別物です。
署名すると SmartScreen の「詳細情報 → 実行」が要らなくなっていきます。発行元は「SignPath Foundation」と出ます。

「Promote to 正式版」を流すと（`.github/workflows/promote.yml`）:

1. その版のタグ `v0.2.N` のコミットから、同じ実行の中でインストーラーをビルドし直し、起動と書き出しを確かめます
   （`.github/actions/installer`。SignPath は、その実行が自分でビルドしたものにしか署名しないため）。
2. SignPath に署名を依頼します。**作者に SignPath からメールが来るので、signpath.io で依頼を開いて承認します**（5 時間まで待ちます）。
3. 署名が正しくタイムスタンプつきかを確かめ、署名後のファイルに更新の署名（`.sig`）を付け直します。
4. リリースの無署名のインストーラーを署名つきに差し替え、その版を指す `latest.json`（その版のリリースと、
   まだその版を指していれば `channel-beta`）の署名を書き換えてから、正式版にします。

承認を待つ間も、試験版の公開（build-app.yml）は止まりません。承認しなかった・断ったときは、正式版にはなりません
（もう一度流せばやり直せます）。署名の設定（下の変数）がないときは、今までどおり署名なしで正式版にします。

### 最初に一度だけ（作者がすること）

1. GitHub で 2 段階認証（Settings → Password and authentication）がオンになっていること。
2. [signpath.org/apply](https://signpath.org/apply) から申し込む。聞かれたら:
   リポジトリ `https://github.com/nanikasheila/name-studio`、ライセンス GPL-3.0-or-later、
   ダウンロードのページ `https://github.com/nanikasheila/name-studio/releases/latest`、
   署名の方針 `https://github.com/nanikasheila/name-studio/blob/main/docs/code-signing-policy.md`、
   ビルドは GitHub Actions（GitHub がホストするランナー）。審査に数日かかります。
3. 受け入れられたら、SignPath の案内に従って SignPath にサインインし、2 段階認証をオンにする。プロジェクトは:
   - プロジェクトの slug `name-studio`（違う名前になったら下の変数 `SIGNPATH_PROJECT_SLUG` に）
   - Trusted Build System に「GitHub.com」をつなぐ
   - 署名ポリシーは release-signing（違う名前なら `SIGNPATH_POLICY_SLUG`）。許すブランチは `main`、承認者は自分
   - 成果物の設定（Artifact configuration）に、リポジトリの `.signpath/artifact-configuration.xml` の中身を貼って既定にする
4. SignPath で CI 用の API トークンを作る（Users → CI ユーザーを作る、または自分の API トークン。
   プロジェクトの「Submitter」の役割が要る）。
5. GitHub の name-studio → Settings → Secrets and variables → Actions:
   - Secrets に `SIGNPATH_API_TOKEN`（4. のトークン）
   - Variables に `SIGNPATH_ORGANIZATION_ID`（SignPath の組織 ID。SignPath の画面の URL や Settings に出る）
   - slug が上と違うときだけ Variables に `SIGNPATH_PROJECT_SLUG`・`SIGNPATH_POLICY_SLUG`

これで次の「Promote to 正式版」から署名つきになります。`SIGNPATH_ORGANIZATION_ID` を消せば、署名なしに戻ります。

### 選ばなかった方法（2026-11 の調べ）

| 方法 | 費用 | 選ばなかったわけ |
|---|---|---|
| Azure Artifact Signing（旧 Trusted Signing） | 月 約 10 ドル | 個人は米国・カナダのみ。日本は法人だけ |
| Certum Open Source Code Signing（クラウド） | 年 49 ユーロ | 発行元に本名が出る。スマホのアプリのコードが要り、無人の CI では難しい |

EV 証明書ですぐ信頼される扱いは 2024 年になくなったので、どの方法でも、新しい証明書はしばらく警告が出ることがあります。

## 版の番号

`tauri.conf.json` の `version`（0.1.0）は手元のビルド用です。リリースでは、ワークフローが
`.github/scripts/release-config.mjs` で `0.2.<実行番号>` に書き換えてからビルドします。

## 前の版に戻す・自動更新を止める

新しい版で困ったときは、設定（歯車）→「この PC」→「更新」で:

- 「前の版に戻す」で版を選び「この版を入れる…」を押すと、その版のリリースの `latest.json` から
  署名を確かめて入れ替え、起動し直します（作業は自動保存してから）。一覧は GitHub のリリースのうち、
  署名付き（`latest.json` のある版、v0.2.25 から）だけです。
- 戻すと「起動したとき」が「知らせるだけ」になります（自動で入れると、次の起動でまた新しい版に戻るため）。
  「自動で入れる」に戻すと、次の起動から新しい版を入れます。
  「知らせるだけ」の間も、新しい版があれば右上の「更新」ボタンは出ます。

## リリースの前の確認

「Release Windows app」はインストーラーを作ったあと、そのリリースビルドで `app/e2e/realapp.mjs`
（窓を開いてネームを CSP 用に書き出す）を流し、通ったときだけ公開します。起動できない版は配られません。
その前に、同じコミットで CI の全部（Rust の全テスト、画面の単体テストと e2e、保存の競合や
シリーズの保存失敗を含む）が通っていることが条件です。
