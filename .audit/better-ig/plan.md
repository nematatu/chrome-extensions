# better-ig 統合

- [x] poteto-mode Principlesと既存構成を確認。現在の単独2拡張とMy Toolsの20登録が対象。
- [x] 最新の本体未コミット変更を作業用worktreeへ同期し、baseline.patchへ記録。↓保存を維持。
- [x] Phase A: 保存、高画質、Live回転を1つのmanifest/popup/My Tools項目へ統合する。保存側のsource path/module id/履歴を維持。
- [x] Phase B: 保存側パッケージ統合とMy Tools移行を別checkout・別所有者で分離。rootは統合・検証・レビューを担当。
- [x] Phase C: 2本の実装を照合。旧高画質単独manifest撤去、既存機能・設定・旧バックアップ互換を確認。
- [x] Phase D: 単体、単独Chrome、統合Chrome、実ポップアップで検証し、観測と修正を記録。
- [x] Phase E: 独立レビューと最終差分を確認。元checkoutへ対象差分のみ同期。

## 判断

保存履歴を維持するため、読み込みフォルダーinstagram-media-downloaderとMy Tools id=instagramを変えず、利用者に表示する名前をbetter-igへ変更する。単独高画質版のIDに属するChrome設定は新拡張から直接読めないため、利用者が2設定を合わせる手順を記載する。My Tools内の旧設定は自動移行する。旧高画質モジュールの動的script登録も解除する。

動作の正本は既存保存フローと高画質/回転コード。新設定downloadEnabledは旧2モジュールの独立ON/OFFを統合後も保つために必要。新しいダウンロードエンジン・状態ライブラリ・通信先・仮定的なセキュリティ対策は追加しない。commit/push/公開や利用中Chromeの旧版削除は行わない。

## UI参照

2026-10-28に Kumo Switch https://kumo-ui.com/components/switch/ と Radix Switch https://www.radix-ui.com/primitives/docs/components/switch を参照。設定名と操作を同じ行へ配置する既存ポップアップの構造を再利用する。利用者数・評価の比較は未確認のため断定しない。

## 最終結果 2026-10-29

本体と作業worktreeへ統合済み。全体単体503/503成功。保存ブラウザー47、高画質・設定5、My Tools20、全機能21、既存タブ修復17機能、単独実ポップアップ9本が成功。better-ig実popup370×331、3設定ONを確認。独立レビューは16設定組の移行/履歴/バックアップ再読込を検証し、阻害する指摘なし。旧単独HQ設定確認の手順を訂正。

全体テストで見つかったMedia Saverの固定日付期待は、そのテスト内だけDateを固定し、製品コードを変えずに修正。本体ビルドのconfigでbetter-igが1項目、instagramhqなし、旧HQmanifestなしをassertした。利用中Chromeと実Instagramは未検証。commit/push/公開/Chromeの旧版削除はしていない。
