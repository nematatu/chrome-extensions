- [x] Frame the feature as per-media completion records and verified all-media coverage.
- [x] Implement durable completion history without signed URLs or credentials.
- [x] Reflect individual and all-media coverage in button color, check icon, and accessible label.
- [x] Test completion, partial failure, cancellation, reload, and worker restart.
- [x] Verify on real Instagram and update documentation.

Throughput checkpoint: save one image and observe a check only after Downloads completion; reload and verify the check remains before adding batch cases.

2026年10月23日、ロック解除後に実Chromeへ反映。プロフィール3件・カルーセル個別1件・ストーリー個別1件と全2件の保存完了と緑色チェック、再読み込み保持を実画面で確認。ストーリーから戻ると全件メタデータが単一カバーで上書きされる問題を修正。単体28件・隔離ブラウザー35項目成功。修正前コピーは Expected saved=true, got false で失敗。独立コードレビュー実施済み。リール動画1件も完了・緑色チェック・再読み込み保持を実画面で確認。
