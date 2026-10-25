# リリースと自動更新

main にマージするたび、GitHub Actions の「Release Windows app」（`.github/workflows/build-app.yml`）が
Windows のインストーラーを作り、`v0.2.<実行番号>` のリリースとして公開します。

インストールしたアプリは、起動するとリリースの `latest.json` を見て、新しい版があれば取り込んで再起動します。
ネームを開いているときは自動では入れ替えず、ツールバーの「更新」ボタンを押したときに、
自動保存で書いてから入れ替えます。PC で自分でビルドしたもの（`NAME_STUDIO_RELEASE` なし）は更新しません。

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

## 版の番号

`tauri.conf.json` の `version`（0.1.0）は手元のビルド用です。リリースでは、ワークフローが
`.github/scripts/release-config.mjs` で `0.2.<実行番号>` に書き換えてからビルドします。

## 前の版に戻す・自動更新を止める

新しい版で困ったときは、設定（歯車）→「この PC」→「更新」で:

- 「前の版に戻す」で版を選び「この版を入れる…」を押すと、その版のリリースの `latest.json` から
  署名を確かめて入れ替え、起動し直します（作業は自動保存してから）。一覧は GitHub のリリースのうち、
  署名付き（`latest.json` のある版、v0.2.25 から）だけです。
- 戻すと自動更新は止まります（止めないと、次の起動でまた新しい版に戻るため）。
  「起動したとき、新しい版を自動で入れる」を入れ直すと、次の起動から新しい版を入れます。
  止めている間も、新しい版があれば右上の「更新」ボタンは出ます。

## リリースの前の確認

「Release Windows app」はインストーラーを作ったあと、そのリリースビルドで `app/e2e/realapp.mjs`
（窓を開いてネームを CSP 用に書き出す）を流し、通ったときだけ公開します。起動できない版は配られません。
