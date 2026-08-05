# R2 Image Preview

Cloudflare R2 のダッシュボード一覧に画像プレビュー列を追加する Chrome 拡張です。

## 使い方
1. Chrome の拡張機能ページで「パッケージ化されていない拡張機能を読み込む」
2. このフォルダを選択
3. オプション画面で「プレビューURLテンプレート」を必要に応じて設定

## URLテンプレートの例
- `https://{bucket}.{accountId}.r2.cloudflarestorage.com/{key}`
- `https://{accountId}.r2.cloudflarestorage.com/{bucket}/{key}`
- `https://your-domain.example.com/{key}`

`{bucket}`, `{accountId}`, `{key}` が置換されます。

## 注意
- 公開バケット、または公開ドメインが前提です。
- 非公開の場合はプレビューが表示できません。
