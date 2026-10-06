# よみあげ文庫

Xのポスト・X記事、Web記事、Google Driveのメモを **本文だけ** 読み上げる、自分用の図書館アプリ（PWA）。
パソコンでもスマホでもブラウザで動き、ホーム画面に追加すればアプリのように使えます。

- ▶ で本文だけを読み上げ（メニュー・広告・URL・絵文字は読まない）
- 速度変更（0.75〜3倍）、文をタップするとそこから再生、読んでいる文をハイライト
- 途中でやめても **続きから**
- 2つの読み上げ方式
  - **端末の声**：完全無料・設定不要（Web Speech API）
  - **クラウド音声**：Google Cloud Text-to-Speech で音声ファイル化 → **画面オフ・別アプリでも止まらない**、ロック画面から操作可
- Google Drive 連携（自分のGoogle Apps Script経由）：取り込んだ記事をGoogleドキュメントで保存／Driveのメモを読み上げ／Web記事の本文取得
- 取り込み口：URL貼り付け、Androidの共有メニュー、iPhoneのショートカット、ブックマークレット、PC用ユーザースクリプト（Xに▶ボタン）

## 方式ごとにできること（正直な比較）

| | 端末の声（無料） | クラウド音声（無料枠） |
|---|---|---|
| パソコン | ◎ 別タブでも読み続ける | ◎ |
| Android | △ 画面オフで止まる機種あり（「バックグラウンド維持」で改善する場合あり） | ◎ 画面オフ・別アプリでもOK |
| iPhone | × 画面オフ・別アプリで必ず止まる（iOSの制約） | ◎ 画面オフ・別アプリでもOK |
| 声の自然さ | 端末次第（iPhoneは「拡張/プレミアム」の声をDLすると改善、PCはEdgeのNaturalが良い） | 高い（Chirp 3 HD など） |
| 費用 | 0円 | Chirp3-HD/Neural2：毎月100万字まで0円、Wavenet/Standard：毎月400万字まで0円（2026年10月時点の公式料金表）。要カード登録 |

> ブラウザの「端末の声」(Web Speech API) は、iPhoneでは画面オフで停止するのがOSの仕様で、Webアプリ側では回避できません。
> Substack の読み上げが画面オフでも続くのは「音声ファイル」を再生しているからで、本アプリのクラウド音声も同じ仕組みです。

## 公開（使えるようにする）

静的ファイルだけで動くので、どこかに置けばOKです。

- **GitHub Pages**：Settings → Pages → Source「Deploy from a branch」→ `main` / `(root)`。
  URLは `https://yayoi333.github.io/bookreader/`。
  ※ **非公開リポジトリでPagesを使うには有料プラン（GitHub Pro）が必要**です。無料で使うなら、リポジトリを公開にする（コードに秘密情報は入っていません。APIキー等は各端末の中だけに保存）か、
  Cloudflare Pages / Netlify（非公開リポジトリでも無料）に接続してください。
- 公開URLが `https://yayoi333.github.io/bookreader/` 以外になる場合は、ユーザースクリプトのメニュー「よみあげ文庫のURLを設定」で変更してください。

## 初期設定

アプリ内の「使い方」画面に、端末に合わせた手順が出ます。概要：

1. **クラウド音声**（画面オフで聞きたい場合）
   Google Cloud でプロジェクト作成 → 請求先アカウント設定 → 「Cloud Text-to-Speech API」を有効化 → APIキー作成
   → キーを制限（ウェブサイト＝アプリのURL、API＝Text-to-Speechのみ）→ 予算アラート設定 → アプリの設定に貼る
2. **Drive連携**：`gas/Code.gs` を Google Apps Script に貼る → `setup` を実行してトークンを控える → ウェブアプリとしてデプロイ（実行：自分／アクセス：全員）→ URLとトークンをアプリに入力
3. **iPhone**：ショートカットAppで「共有シートに表示」するショートカットを作る（URLエンコード → `アプリURL?q=` に連結 → URLを開く）
4. **Android**：Chromeで開いて「ホーム画面に追加」→ Xアプリの共有メニューに出てくる
5. **PC**：Tampermonkey に `userscript/yomiage-x.user.js` を入れると、Xのポスト/記事に ▶ が付く

## 仕組み

```
index.html / css / js/
  app.js          画面（本棚・読む・設定・Drive・使い方）
  player.js       再生の司令塔（方式切替・ロック画面操作・続きから・画面消灯防止）
  engines/speech.js  端末の声（文ごとに読み上げ。Chromeの長文途切れ対策込み）
  engines/cloud.js   クラウド音声（最初は短く生成してすぐ再生、残りは先読み。音声は端末にキャッシュ）
  text.js         文分割・読み上げ用の整形・音声化の分割（DOM非依存）
  x-article.js    X記事の取り込み（FxTwitter API）
  extract.js      URL/テキスト/HTML → 本文（Mozilla Readability）
  drive.js        GAS連携
gas/Code.gs       Drive連携のサーバー側（自分のGoogleアカウントで動く）
userscript/       PC用：Xに▶を付けるユーザースクリプト
vendor/           Mozilla Readability（Apache-2.0）
```

- Xの本文取得には無料の非公開API [FxTwitter](https://github.com/FxEmbed/FxEmbed)（`api.fxtwitter.com`）を使っています。Xの公式APIは有料のためです。
  非公式なので、X側の変更で一時的に取れなくなる可能性があります。その場合はテキストをコピーして貼り付けてください。
- 本棚・音声キャッシュはその端末のブラウザ内（IndexedDB）に保存されます。端末間で共有したいものは Drive に保存してください。

## テスト

```sh
npm install   # playwright（ブラウザテスト用）
npm test
```

`tests/text.test.mjs`・`tests/x-article.test.mjs` は単体テスト、`tests/e2e.test.mjs` は Chromium で
取り込み〜読み上げ〜続きから〜クラウド音声（複数ファイルのつなぎ目）〜Drive連携〜ブックマークレットまでを通しで確認します
（X・Google TTS・GAS・端末の音声は偽物に差し替え）。
