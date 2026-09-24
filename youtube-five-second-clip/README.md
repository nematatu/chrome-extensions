# YouTube 範囲指定 MP4クリップ

YouTubeの動画ページに「範囲を指定して保存」ボタンを追加します。表示されたタイムラインのハンドルで指定した区間を、再生を止めずにブラウザー内でMP4へ変換して保存します（最大5分）。

## 使い方

1. Chrome 116以降で `chrome://extensions` を開き、デベロッパーモードを有効にします。
2. 「パッケージ化されていない拡張機能を読み込む」で、この `youtube-five-second-clip` フォルダーを選択します。
3. YouTubeの動画タブを再読み込みします。
4. 動画下の操作欄（高評価・共有・保存が並ぶ場所）にある「範囲を指定して保存」を押します。直近20秒のタイムラインで「直前5秒」「直前10秒」「直前20秒」を選ぶか、開始・終了プレビューを見ながら丸いハンドルをドラッグして、「この範囲を保存」を押します。

保存先はChromeで設定した通常のダウンロード先で、ファイル名は `YouTube_<タイトル>_<動画ID>_<開始>-<終了>s.mp4` です。拡張アイコンを押すと変換と保存の状態を確認できます。

## 動作方式

画面録画や外部サーバー、`yt-dlp`、FFmpeg、Native Messagingは使いません。YouTubeのプレイヤーが再生用に読み込んだMP4 / WebMのメディアセグメントをページ側で短時間キャッシュし、クリック後に拡張のoffscreen documentへ渡します。offscreen document内の同梱ライブラリー Mediabunnyで指定範囲をトリミングし、WebCodecsでMP4（H.264映像・AAC音声）へ変換します。

データは拡張内で処理し、外部通信、Cookie・トークンの読み取り、動画URLの保存は行いません。ユーザーが明示的に押したクリック以外では保存を開始しません。

## 制約

- デスクトップ版YouTubeの通常動画に対応します。Shorts、ライブ配信、DRM動画、埋め込みプレイヤーは対象外です。
- 指定した区間のデータがブラウザーのメモリーに残っている必要があります。再生直後や大きくシークした直後は、その区間を少し再生してから再試行してください。
- MP4変換はChromeのWebCodecs対応状況に依存します。H.264またはAACをエンコードできない環境では保存できません。
- YouTubeの配信形式、広告、DOM、セグメント仕様が変更されると動作しなくなる場合があります。
- トリミングはキーフレーム境界の影響で、開始・終了にフレーム単位の誤差が出る場合があります。
- 変換中にページを閉じても転送済みの処理は続きます。Chrome自体を終了した場合は中断されます。

## 権限

`offscreen` は非表示の拡張ページでメディア変換を実行するため、`downloads` はMP4を保存するため、`storage` は保存状況を保持するために使用します。content scriptは `https://www.youtube.com/*` にのみ読み込みます。

Mediabunny 1.56.2（MPL-2.0）を `vendor/mediabunny.mjs` に同梱しています。CDNや追加インストールは不要です。

## テスト

```sh
cd youtube-five-second-clip
node --test clip.test.cjs tests/background.test.cjs
node --check clip.js content.js background.js collector.js stream-cache.js popup.js convert.mjs offscreen.mjs
```
