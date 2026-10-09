# 後で読む UI の参照

確認日: 2026-10-09。サービスの画面と操作を先に確認し、下記の既存の構造をこの拡張機能の用途に適用しています。ユーザー数・評価は確認時点のストア表示であり、固定した性質や将来の評価を示すものではありません。

## Raindrop.io: 検索・一覧・保存済み

[公式 Chrome Web Store](https://chromewebstore.google.com/detail/raindropio/ldgfbffkinooeloadekpmfoklnobpien?hl=en) で 500,000 ユーザー、4.1 / 5（786 件の評価）の表示を確認しました。

[公式ヘルプ: Bookmarks](https://help.raindrop.io/bookmarks) の `Finding bookmarks` と `Saving bookmarks` のスクリーンショットを実際に確認しました。参照画像の原本は、公式の [search-results.png](https://github.com/raindropio/help/blob/master/assets/search-results.png) と [extension-intro.png](https://github.com/raindropio/help/blob/master/assets/extension-intro.png) です。

この拡張機能では以下を採用しています。

- 上部の検索欄、結果件数、白地と薄い区切り線で構成する縦の項目一覧。
- 左側の小さな識別アイコン、右側の作品タイトル、グレーのサイト名と保存日。
- チェック付きの「保存済み」表示。追加後は追加ボタンが保存済みに変わります。
- 検索入力に合わせてその場で一覧を絞り込む操作。

[公式リリース記事](https://blog.raindrop.io/raindrop-io-5-0/) にも検索入力時の即時検索と目立つ保存状態、コンテキストメニューからの保存が記載されています。

## Chrome リーディング リスト: 未読・読了と項目操作

[Google Chrome の公式ヘルプ](https://support.google.com/chrome/answer/7343019?hl=ja&co=GENIE.Platform%3DDesktop) で右クリックからの追加と、一覧からの編集・削除操作を確認しました。リーディング リスト単独のユーザー数や評価は確認していないため、数値による評価はしません。

Chrome の現行 UI の構造は公式 Chromium ソースの [reading_list_app.html.ts](https://github.com/chromium/chromium/blob/main/chrome/browser/resources/side_panel/reading_list/reading_list_app.html.ts) と [reading_list_item.html.ts](https://github.com/chromium/chromium/blob/main/chrome/browser/resources/side_panel/reading_list/reading_list_item.html.ts) でも確認しました。

- 未読・読了の区分。
- タイトルとサイト情報のある行の右端に、読了 / 未読切り替えと削除の操作。
- 一覧の下部に現在のページを追加するボタン。
- 件数が増えても表示処理が重くならないよう、Chrome の lazy list を参考に初期の表示を 100 件に限定し、追加表示します。検索は保存した全件から行います。

この拡張機能ではダウンロード済みの記録も同じ行のチェック付きラベルで表示し、ダウンロード済みの一覧を追加しています。作品の画像そのものを保存する操作と、後で読むためにリンクを記録する操作は別のボタンにしています。

## この用途への適用と素材

一覧から作品を探す用途ではリモートの表紙画像を読み込みません。ローカルの単純なブックマーク図形を表示します。これにより、一覧を開いただけでサイトへの画像アクセスが発生しません。Chrome の色・余白・行内操作になじむ静かな構成とし、ライト / ダークは OS の設定に合わせます。

参照サービスのロゴ、スクリーンショット、HTML、CSS、アイコン素材は拡張機能へ同梱していません。参照したのは上記の画面構造と操作です。実装コードと単純な SVG 図形は本リポジトリで記述しています。

後で読むから削除した直後は「元に戻す」で復元できます。削除しても、完了したダウンロードの記録は消しません。読了はユーザーが明示的に切り替え、作品を開くだけでは自動変更しません。
