# Instagram downloader

- [x] Read the Principles section of the poteto-mode skill.
- [x] Phase A: Frame
- [x] Phase B: Design the workflow
- [x] Phase C: Run the loop
- [x] Phase D: Keep the audit trail
- [x] Phase E: Verify and hand back

## 検証可能な完了条件

新規MV3拡張をChromiumで読み込み、投稿、カルーセル、リール、ストーリーの個別保存と一括保存、画像描画領域右上への追随、実際のdownloads完了、失敗、停止、再開を再現データで確認する。実Instagramの認証済み検証可否は別記する。

## 実行手順

- [x] 既存拡張と変更済みファイルを確認する。
- [x] 独立拡張と既存拡張拡張の二案を比較する。既存の非ダウンロード契約を保つため独立拡張を選択する。
- [x] メディア候補と描画矩形の純粋関数、検証用fixtureを作る。
- [x] キューをqueued / active / complete / failed / canceledで管理し、Chromeの完了イベントを検証する。
- [x] 投稿とストーリーの取得、一括操作、添付画像を参考にしたUIを実装する。
- [x] ブラウザーで位置、SPA遷移、保存、エラーを検証する。
- [x] 独立レビューの指摘を確認し、READMEと検証記録を整える。

## Throughput checkpoint

最初のcoreテストと拡張読み込みが成功した時点で取得経路と配置方式を再評価する。失敗時は機能追加より先に検証経路を修正する。

コミット、push、公開は依頼されていないため実施しない。
