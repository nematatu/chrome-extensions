# Instagram ↓保存

- [x] Blocking first steps. Gates run before fan-out. 現在のcontent、Map、保存入口、README、既存ブラウザーフィクスチャと未コミット変更を確認。
- [x] Independent workstreams. n/a: 小さな一機能。content・README・ブラウザーテストを専用worktreeの一担当へ渡す。
- [x] Shared mutable state. 現行3ファイルのコピーと/tmp基準を保存。rootは担当worktreeを編集せず、変更差分だけを取り込む。
- [x] Smallest safe decomposition. entriesと既存個別保存ボタンを利用。新しい状態管理・保存処理・権限を追加しない。
- [x] 実装を基準ファイルから差分レビュー。
- [x] 単独版の単体・隔離ブラウザー保存検証。
- [x] My Toolsをビルドし生成されたcontentに反映確認。

対象はInstagram。ホームフィード/プロフィール一覧では無効。投稿詳細・投稿モーダル・リール・ストーリーの現在表示中1件を保存する。入力欄・修飾キーは妨げず、長押しで重複保存しない。commit/push/公開はしない。

検証結果は単体33/33、単独Chromium47項目、My Tools生成版20項目成功。統合版は↓キーからのMP4保存を実行。どちらも一時プロファイルと合成Instagram/CDNデータを使用。利用中Chromeへの反映と実Instagramのログイン済み画面は未検証。
