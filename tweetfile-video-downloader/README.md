# Tweetfile 動画一括ダウンローダー

Tweetfile のページ右下にダウンロードボタンとサムネイル付き選択パネルを追加する Chrome 拡張機能です。

## インストール

1. Chrome の `chrome://extensions` でデベロッパーモードを有効にします。
2. 「パッケージ化されていない拡張機能を読み込む」で、この `tweetfile-video-downloader` ディレクトリを指定します。
3. Tweetfile のページを再読み込みします。

## 使い方

- 初期状態では、ページに読み込まれた動画をすべて選択します。
- 右下のパネルでサムネイル横のチェックを外すと、その動画を除外できます。「全選択」「選択解除」も使えます。
- 丸いダウンロードアイコンを押すと、選択した動画を Chrome の保存先の `Tweetfile` フォルダに保存します。同名ファイルは上書きしません。
- 選択一覧は「×」で閉じ、「動画の選択」で開けます。
- フォルダ行は除外します。リンク先の一覧ページを巡回しません。
- ページのスクロールなどで追加読み込みされた動画は、自動的にパネルへ追加されます。未読み込みのページを先回りして取得しません。
- ダウンロード中は全体のパーセンテージ・プログレスバー・処理済み件数を表示します。動画1本を同じ重みとして、HLSは分割数、通常ファイルは受信サイズから計算します。サイズ不明のファイルは完了時に反映されます。失敗した動画も処理済みとして数え、失敗件数を別途表示します。
- 100%は選択した全動画の処理が終了した状態です。保存の成功・失敗はパネルと `chrome://downloads` で確認できます。

## 対応範囲

`https://tweetfile.com/*` とそのサブドメインが対象です。描画済み Vue コンポーネントの動画データ、および通常の video 要素・動画ファイルへの直接リンクを読み取ります。サイト構造の変更時には抽出処理の更新が必要になる場合があります。

HTTP(S) の動画ファイルと HLS (`.m3u8`) に対応します。HLS は最高帯域の映像・音声一体の配信を選び、分割データを結合し、MP4ファイルとして保存します。MPEG-TS配信は同梱の mux.js で再エンコードせずMP4に変換するため、画質・音質はそのままです。H.264映像とAAC音声に対応します。AES-128、相対URL、バイト範囲指定に対応しています。動画を1本ずつ処理し、処理中の動画をメモリ上で結合するため、非常に大きい動画ではメモリ不足になる場合があります。

ライブ配信、音声が別配信のHLS、DRM、アプリ専用の動画、既存の blob URL には対応しません。期限切れURLなどで保存に失敗する場合は、ページを再読み込みして再度試してください。

`downloads` はファイル保存、`offscreen` はHLS結合に使用します。動画CDNはページとは異なるホストになるため、HTTP(S)サイトへのアクセス権限を使って動画データを取得します。UIを追加するのはTweetfileのみです。解析・追跡サービスへのデータ送信は行いません。

## 検証

```sh
node --test tweetfile-video-downloader/tests/*.test.cjs
```

ブラウザーで拡張機能を読み込む統合テスト（合成データのみ使用）:

```sh
cd tweetfile-video-downloader
npm install
npx playwright install chromium
npm run test:browser
```

HLSからのMP4保存、途中と完了時の進捗表示、選択した動画だけの保存、フォルダ除外、追加動画の反映、パネル開閉、狭い画面での配置を確認します。通常の動作に npm やビルドは不要です。Chrome 116以降が必要です。

実装に使用するAPI: [Chrome Offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen)、[Chrome Downloads](https://developer.chrome.com/docs/extensions/reference/api/downloads)。

MP4変換には [mux.js 6.3.0](https://github.com/videojs/mux.js) を同梱しています。ライセンスは `vendor/mux.js-LICENSE` を参照してください。
