# better-igの設計とUI参照

## 所有範囲

2026年10月28日に保存版と高画質版をbetter-igへ統合しました。保存側の読み込み先と履歴形式を維持し、高画質表示とLive回転を同じ拡張・ポップアップで操作します。`downloadEnabled`、`enabled`（高画質）、`rotateLive`の3つをsync設定として扱います。保存オフは新しい保存開始を止め、進行中ジョブや保存履歴を削除しません。

`Model the Domain` 原則に従い、投稿・ストーリーの情報を `MediaGroup`、個々の画像・動画を `Media`、保存処理を `DownloadJob` として扱います。

| 所有ファイル | データ・責務 |
| --- | --- |
| `core.js` | URL・ファイル名の検証、REST・GraphQL応答のメディア抽出、描画矩形の計算 |
| `instagram-api.js` | Instagramの読み取りクエリ、取得上限・タイムアウト・中止 |
| `bridge.js` | MAIN worldでページのfetch・XHR応答からメディア情報だけを抽出 |
| `content.js` | DOMとメディアの関連付け、Shadow DOMのボタンと進捗、利用者操作 |
| `background.js` | Chrome Downloads API、session内のキュー、ワーカー再起動時の照合、local内の保存済み履歴 |

`MediaGroup` は文字列ID、shortcode、アカウント名、メディア配列、全件取得の可否を持ちます。`Media` はID、画像か動画か、検証済みURL、プレビューURL、順序を持ちます。`DownloadJob.items` は `queued`、`starting`、`active`、`complete`、`failed`、`canceled` のいずれかです。一時停止はジョブ単位で次の開始を制御します。

ページから渡される情報は信頼せず、content側で候補を制限し、background側でHTTPS・CDNホスト・保存先・件数を再検証します。ページの任意コマンドから保存を開始するbridgeは提供しません。

## ボタンの配置

メディアの親へのabsolute配置と、独立したfixed overlay配置を比較し、後者を採用しました。親のサイズが画像と異なる場合や、`object-fit: contain` の余白がある場合に、親の右上を画像の右上と取り違えないためです。

自然寸法と表示領域から描画矩形を計算し、その右上に個別保存ボタンを配置します。border・padding、祖先のoverflow、スクロール、ResizeObserver、画像load、動画loadedmetadata、SPA遷移に追随します。隣接するストーリーのプレビューにはボタンを出さず、中央の対象に2つのボタンを置きます。

投稿の一括保存ボタンは文字ラベルを持たず、アイコンのみの38px丸ボタンにします。アクセシビリティ用の `aria-label` と `title` は維持します。

通常の投稿表示では、同じ投稿内のInstagram保存（ブックマーク）ボタンを `aria-label` または `title` から検出し、その左隣へ高さ中央揃えで配置します。リール動画では、描画中メディアの右側にあり、画面内で操作可能な「いいね」ボタンを検出し、その中心の上へ `translate(-50%, -100%)` で配置します。候補はメディア右半分・縦範囲内・右端から180px以内に限定し、`elementFromPoint` で実際に操作できるものを採用します。リールの検出対象は `/reel/`・`/reels/`、または投稿コンテナ外の動画です。ラベルは日英の「いいね」「Like」等に対応します。保存ボタンやハートを検出できない場合は、描画領域の右下へフォールバックします。

2026年10月23日に [Instagramのホーム](https://www.instagram.com/) の動画から開く全画面リールを確認しました。この経路の動画は `main`・`article`・`role="dialog"` の外にあります。既存の `entries` Mapと描画領域による配置を維持し、リールURLでの動画探索だけを広げます。この時点では、ボタンの構造や配置、遮蔽判定は変更していません。

2026年10月26日に、一括ボタンの文字表示を廃止してアイコンのみにし、リールでは右側アクション列のハートを基準に上へ配置する検出を追加しました。ハートを基準にすることで、動画の描画領域や画面幅が変わっても、縦列の先頭に位置を揃えられます。ハートを検出できない場合は右下へフォールバックし、通常投稿のブックマーク左配置は維持します。

## UI参照

調査日は2026年10月22日です。数値は取得時点のChrome Web Store掲載値であり、利用者数や評価の独立監査はしていません。

| 参照 | 一次情報 | 確認内容と採用点 |
| --- | --- | --- |
| ユーザー添付の5画像 | この依頼に添付された画像 | ピンクからオレンジの丸ボタン、白いダウンロード記号、ストーリーの2ボタン、右下の黒い進捗パネルと青いバー |
| Media Downloader for Instagram | [Chrome Web Store](https://chromewebstore.google.com/detail/media-downloader-for-inst/cbnmngfnpibbjobleaghjkdlibjhphlf) | 掲載値4.9・449件・30,000ユーザー。ページ上の個別保存、ストーリーと投稿の一括保存、一時停止・再開という公開操作説明を参照。画面画像はこの取得方法では確認できず、画面配置の根拠にはしていません |
| Instagramの実画面と既存拡張の重なった画面 | [Instagram](https://www.instagram.com/) | ネイティブブラウザーで投稿・カルーセル・アクション列を確認。どの追加ボタンがどの既存拡張に由来するかは未特定です。画像外の余白を基準にボタンが置かれるケースを見て、描画領域基準の配置とテストを採用しました |

一般的な操作フローは公開されている類似拡張を確認し、具体的な画面構成はユーザー添付画像を優先しました。プロファイル全履歴の自動巡回、第三者サーバーへのURL送信、再投稿機能は採用していません。

## Instagram取得方式の根拠

旧 `/api/v1/media/<id>/info/` からPolarisクエリへの移行が報告された [Issue #38](https://github.com/hoaianle/Instagram-Downloader/issues/38) と [修正PR #39](https://github.com/hoaianle/Instagram-Downloader/pull/39/files) を確認しました。取得インターフェースの参考情報であり、第三者拡張のソースを製品コードへコピーしていません。

[投稿の取得コード](https://raw.githubusercontent.com/hoaianle/Instagram-Downloader/main/src/js/post.js) と [ストーリーの取得コード](https://raw.githubusercontent.com/hoaianle/Instagram-Downloader/main/src/js/story.js) から、クエリ名・ID・引数・応答フィールドを確認しました。これらはInstagramの公開API契約ではありません。現在のIDは `instagram-api.js` の `QUERIES` に集約しています。

`Prove It Works` 原則に従い、再現ページのテストと実Instagramでの読み取り確認を区別しています。確認範囲は [VERIFICATION.md](VERIFICATION.md) を参照してください。

## プロフィール一覧の追加仕様

利用者が指定したInstagramプロフィールの実グリッドを確認しました。サムネイルごとの右上の丸ボタンを、その投稿の全メディアを保存する操作とし、下側の一括ボタンを一覧では表示しません。通常の投稿表示では右上の個別保存と、保存（ブックマーク）ボタン左のアイコンのみの投稿一括保存を維持します。指定された実プロフィールURLは利用者の依頼文にあり、ここにはアカウント名を複製しません。

## 保存済み履歴

`Model the Domain` に従い、個別メディアの完了キーと、完全なメンバー集合を持つ投稿全件キーを分けました。保存状態は Chrome Downloads API の `complete` を確認してから `chrome.storage.local` へ記録します。記録の単一書き込み元は background です。UIはストレージ変更を購読し、緑色と白いチェックへ更新します。緑のボタンは再保存として動作します。

参照した一次情報は [Chrome Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage) と [Chrome Downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads) です。ページのlocalStorageと混ぜず、拡張専用のローカル保存領域を採用しました。Chromeの実ダウンロード履歴で使われる完了状態と、既存の丸ボタン構造を維持しています。

署名付きURLそのものは永続化しません。照合用には種別を含むURLパスのSHA-256とファイル名のSHA-256を利用します。個別保存の積み上げでも、全メンバーが完了した場合だけ投稿全件のキーへ昇格させます。ストーリーのアカウント全体を永続的に保存済みとするキーは作りません。
