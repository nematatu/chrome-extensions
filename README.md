# Chrome Extensions

個人開発している Chrome 拡張機能をまとめたモノレポです。

## Extensions

| Directory | Extension |
| --- | --- |
| [`unified-tools`](./unified-tools) | My Tools・リポジトリ内19拡張の統合ビルド |
| [`media-saver`](./media-saver) | ページの動画・音声・画像検出、HLS/DASH 保存 |
| [`instagram-media-downloader`](./instagram-media-downloader) | better-ig（保存・高画質表示・Live横向き表示） |
| [`kltra-danmaku`](./kltra-danmaku) | KLTRA 弾幕チャット |
| [`youtube-download-queue`](./youtube-download-queue) | YouTube ダウンロードキュー（Auto-YTDLP の links.txt への追加と登録済み・ダウンロード済み表示） |
| [`momoniji-manga-viewer`](./momoniji-manga-viewer) | Momoniji 漫画ビューア・一括保存 |
| [`tweetfile-video-downloader`](./tweetfile-video-downloader) | Tweetfile 動画一括ダウンローダー |
| [`stripchat-live-hover`](./stripchat-live-hover) | Stripchat ライブ・ホバープレビュー |
| [`gofile-bulk-video-downloader`](./gofile-bulk-video-downloader) | Gofile 動画・画像一括ダウンローダー |
| [`page-media-bulk-downloader`](./page-media-bulk-downloader) | ページ動画・画像 一括保存 |
| [`badspi-hq-downloader`](./badspi-hq-downloader) | バドスピ 高画質画像ダウンローダー |
| [`koutairen-gallery-fix`](./koutairen-gallery-fix) | 全国高体連バドミントン 写真送り修正 |
| [`inhigh-tv-skip-extension`](./inhigh-tv-skip-extension) | インハイTV スキップ操作 |
| [`GooglePhoto-utils`](./GooglePhoto-utils) | Google Photos Album Sorter |
| [`inhigh-tv-match-links`](./inhigh-tv-match-links) | インハイTV 試合リンク |
| [`smashAndNetTV-better-photo-garally`](./smashAndNetTV-better-photo-garally) | SMASH and NET. TV Photo Gallery Plus |
| [`birdcore-popup`](./birdcore-popup) | Birdscore Popup |
| [`r2-image-preview`](./r2-image-preview) | R2 Image Preview |
| [`sushida-log`](./sushida-log) | Sushida Log |
| [`x-hashtag-autofill`](./x-hashtag-autofill) | X Hashtag Autofill |

## ローカルでの読み込み

1. Chrome で `chrome://extensions` を開きます。
2. 「デベロッパー モード」を有効にします。
3. 「パッケージ化されていない拡張機能を読み込む」を選びます。
4. 使用する拡張機能のディレクトリを指定します。

各拡張機能の詳細や開発方法は、それぞれのディレクトリ内の README を参照してください。

## UIの更新

全拡張の共通スタイルとアイコンは [shared-ui](shared-ui/README.md) で管理します。単独版には生成済みのUI資材を同梱します。開発時は `node shared-ui/build.mjs`、続いて `node unified-tools/build.mjs` を実行してください。Chromeへの再読み込み後は対象サイトのタブも再読み込みしてください。

Instagram関連の2拡張は `better-ig` に統合しました。既存の保存履歴と拡張IDを維持するため、読み込み先は引き続き `instagram-media-downloader` です。My Toolsには `better-ig` が1項目だけ表示されます。
