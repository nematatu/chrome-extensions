# Gofile 動画・画像一括ダウンローダー

Gofileの共有ページを開くと、一覧のツールバーに「動画・画像を一括保存」ボタンを追加するChrome拡張機能です。現行バージョンは **1.1.1** です。

## 機能

- 現在の共有フォルダ直下にある動画・画像を、全ページ分まとめて検出（音声やその他のファイルは対象外）
- 元のファイル名を維持して、Chromeで設定されたダウンロード先の `Gofile/<フォルダ名>/` に保存（標準設定では `Downloads/Gofile/<フォルダ名>/`）
- 同名ファイルがある場合は上書きせず、Chromeの連番で安全に保存
- 右下に全体パーセント、保存済み件数、保存中・待機中・失敗件数を表示
- 優先度の高い100件を、サムネイル、ファイル名、個別進捗とともに表示（全体件数と進捗は表示外も含む全件分）
- 4件ずつ並列保存し、大量接続による失敗を抑制
- 項目単位の分割データとして進捗を永続化し、最大1万件でもService Worker停止後やページ再読み込み後にキューを復元
- 残りのキャンセル、失敗分だけの再試行に対応
- Gofileのフィルターや表示中のページ番号に関係なく、共有フォルダ全体を確認

保存時は `Gofile/<フォルダ名>/<ファイル名>` を指定し、Chromeのダウンロード先直下へファイルを置く指定はしません。1.1.1では、復元キューや再試行でも保存開始の直前にこのパスを組み直し、古い保存先を引き継がないようにしています。サブディレクトリを含む相対パスの扱いは [Chrome Downloads APIの仕様](https://developer.chrome.com/docs/extensions/reference/api/downloads#property-DownloadOptions-filename)に従います。

サブフォルダは現在のGofileページとは別ページとして扱うため、自動的にはたどりません。各サブフォルダを開いて同じボタンを押してください。

## インストール

1. Chromeで `chrome://extensions` を開きます。
2. 右上の「デベロッパー モード」を有効にします。
3. 「パッケージ化されていない拡張機能を読み込む」を選びます。
4. この `gofile-bulk-video-downloader` ディレクトリを指定します。
5. `https://gofile.io/d/...` の共有ページを再読み込みします。

Chrome 111以降が必要です（`document_start` にMAIN worldの観測スクリプトを読み込むため）。[ChromeのManifest仕様](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts)と[MDNの互換性データ](https://github.com/mdn/browser-compat-data/blob/main/webextensions/manifest/content_scripts.json)を確認しています。

既にインストールしている場合は、`chrome://extensions` のこの拡張機能の再読み込みボタンを押し、**バージョン1.1.1と、Gofileのタブの再読み込みを確認してください**。観測処理はページ読み込み開始時に動くため、拡張機能だけの更新では既存タブの一覧を取得できません。

この拡張機能はmacOSキーチェーンを使用せず、キーチェーンの許可も必要ありません。

## 使い方

1. Gofileの共有ページを開き、一覧の読み込み完了を待ちます。
2. パスワード保護ページの場合は、先にGofile標準フォームで解除します。
3. 一覧ツールバーの「動画・画像を一括保存」を押します。
4. 右下のパネルで進捗を確認します。

Gofile側で凍結中、高負荷状態、期限切れ、アクセス不可になっているファイルは制限を回避せず、パネルに理由を表示します。認証切れとアクセス回数制限もエラーとして区別します。ChromeのSafe Browsingが確認を求めた場合は自動承認しません。

Gofileの戻る・進む操作で一覧がページ内キャッシュから表示された場合や、一覧取得から15分以上経過した場合は、Gofileの **Refresh** ボタンで一覧を取り直してから開始してください。開いてから6時間以上経過したタブでは、Gofile自身の認証生成処理の制約に合わせて追加の一覧取得を停止します。ページ全体を再読み込みしてください。

## 権限と安全性

| 権限 | 用途 |
| --- | --- |
| `downloads` | 動画・画像の保存開始、状態確認、ユーザーが選んだ一括処理のキャンセル |
| `scripting` | Gofile自身が取得済みのファイルメタデータをMAIN worldから読み取る |
| `storage` | 項目単位に分割した一括保存キューと進捗を端末内に保持・復元する |
| `unlimitedStorage` | 最大1万件の分割キューが通常の拡張ストレージ容量上限で欠落しないようにする |
| `https://gofile.io/*` | 共有ページ上でMAIN worldの収集処理を実行するためのホスト許可（常駐UIの自動読込は `https://gofile.io/d/*` だけ） |

- Cookieや保存アカウントの値は読み取りません。現行ページの一覧GETリクエスト設定（認証ヘッダ・解除済みパスワードのクエリを含む場合があります）を、ページ内の閉じた状態で最新1件だけ、最大15分間参照します。全ページの確認時は、その認証ヘッダとGofile自身の `generateWT()` を使い、同じフォルダの一覧取得エンドポイントに新しいWebsite Tokenで通信します。パスワードのクエリ値を取り出して処理することはありません。
- 認証ヘッダに含まれるアカウントtokenや、パスワード・パスワードハッシュは、Service Workerへ渡さず、拡張機能のストレージやログに保存しません。観測レスポンスも必要なファイル情報とページング情報に絞り、16MiBを超えるレスポンスは拒否します。[Chrome Downloadsの仕様](https://developer.chrome.com/docs/extensions/reference/api/downloads#method-download)に従い、保存リクエストは対象ホストに設定されているブラウザーのCookieを使います。
- MAIN worldから返ったURLはService Worker側でも再検証し、HTTPSのGofileダウンロードURL以外を拒否します。
- ダウンロードURLは実行中のキュー復元に必要な間だけ、項目ごとに拡張機能のローカルストレージへ保持し、完了した項目から削除します。取得メタデータや進捗を、Gofileへの通常の通信とは別の、拡張機能独自の外部サーバーへ送信しません。
- `downloads` 権限はChrome上のダウンロード履歴・操作へ広くアクセスできる権限です。通常は自ら開始したダウンロードIDだけを照会し、ID保存直前にService Workerが停止した場合のみ、同じURL・開始時刻帯の候補を拡張機能内で検索して、拡張機能IDまで一致した項目だけを復旧対象として採用します。ファイル削除の `chrome.downloads.removeFile()` と履歴削除の `chrome.downloads.erase()` は呼びません。
- `cookies`、`tabs`、`webRequest`、`<all_urls>` は使用せず、シークレットモードでの実行も許可しません。
- 公式のPremium ZIP生成APIやアクセス制限回避は使用せず、Gofileページが個別保存可能として返した動画・画像だけを処理します。
- 追加の権限やホスト許可はありません。現行構成ではページ内から `https://api.gofile.io/contents/<現在の共有ID>` へ一覧GETを行います。現在フォルダ以外の取得、アップロード、設定変更、ZIP生成には使いません。外部スクリプトの追加読込・動的importは行いません。

## テスト

```sh
cd /Users/nematatu/src/github.com/nematatu/chrome-extensions/gofile-bulk-video-downloader
node --test '*.test.cjs'
```

テスト対象には、URL偽装、危険なファイル名、Windows予約名、Unicode、動画・画像の識別、重複、ページング、フィルター、パスワード未解除、SPA遷移、拡張全体での4件並列制御、1万件キュー、Service Worker再起動、途中書込失敗からのキャンセル・再試行復旧、進捗計算、Manifest権限が含まれます。現行ページのfetch観測、新しいWebsite Tokenの発行、認証情報の非公開化、レスポンスサイズ制限、認証切れ・レート制限・古いタブでの停止も検証します。

2026年10月10日の更新時の検証:

- 1.1.1の自動テスト69件が成功しました。新規保存に加え、直下・絶対パス・親ディレクトリ参照のパスが残った復元キューと、失敗分の再試行でもサブフォルダーを指定することを確認しています。JavaScriptの構文確認と差分の空白チェックも成功しました。
- 1.1.0で更新した `page-bridge.js` / `collector.js` を実際のGofile一覧APIへ接続し、動画14件・画像7件の計21件を欠落・除外なしで収集できました。通常のCookie付きファイル取得も、追加の参照元ヘッダなしでHTTP 206を確認しました。
- 合成データを使うローカル画面で、ツールバー内のボタン、動画・画像の進捗表示、キャンセル後の件数表示を確認しました。この画面では操作ツールの制約に合わせ、検証ページ内だけShadow DOMをopenにしています。拡張機能本体はclosedのままです。
- Chrome拡張機能としての読み込みと、実際のChrome Downloads APIによる保存は、この更新時には未検証です。

## 現行Gofile仕様との接続点

2026年10月10日に、Gofileの公開画面と公開モジュールを確認しました。現行ページでは `appdata.fileManager.mainContent` / `getContent()` は使われず、ES modules内のFileManagerが一覧を保持しています。`page-bridge.js` がページ開始時に一覧GETのfetchレスポンスを観測し、`collector.js` が必要な情報だけを収集します。旧構成が残るページでは既存の読み取り方式も維持しています。

一覧の表示件数は100件ですが、拡張機能の確認処理は未フィルターの1ページ1,000件に揃えます。現在のフォルダ直下を最大100ページ・動画と画像の合計1万件まで確認します。内部構造が変わった場合はURLや認証値を推測せず、停止して再読み込みを促します。

確認した一次情報:

- [Gofileのルートモジュール](https://gofile.io/js/app.js)、[ルーティング](https://gofile.io/js/pages/index.js)、[FileManager](https://gofile.io/js/files/manager.js)
- [一覧取得処理](https://gofile.io/js/services/contents.js)、[API処理](https://gofile.io/js/services/api.js)、[Website Tokenとタブ寿命](https://gofile.io/js/core/wt.js)、[一覧キャッシュ](https://gofile.io/js/files/listingCache.js)

## UIの参照記録

- Gofileの現行公開共有画面を実ブラウザーで確認し、ファイル一覧の上にあるツールバー内の操作列にボタンを設置します。狭い幅では操作列を折り返します。既存の進捗パネル、キャンセル、再試行の操作は維持しています。Gofileの利用者数・評価は未確認です。
- 比較対象はGoogle Driveです。[公式ヘルプ](https://support.google.com/drive/answer/2423534?hl=ja)の「一覧の複数ファイルをまとめてダウンロードする」操作フローを参考にし、保存操作を一覧の近くに集約します。[米国App Storeの一次情報](https://apps.apple.com/us/app/google-drive/id507874739)では、確認時点で4.8/5・約780万件の評価が表示されています。これは評価件数であり、現在の利用者数は不明です。
