# Instagram High Quality Images

Instagramの投稿画像を最大解像度で表示し、縦長のInstagram Liveを横向き表示するChrome拡張機能です。

## 機能

- 投稿画像の `srcset` から最大解像度の候補を選び、表示に使用します。
- 縦長のInstagram Live動画を90度回転して表示します。
- ポップアップから各機能を個別に有効・無効にできます。

画像・動画のダウンロード機能はありません。

## インストール・更新

1. Chromeの `chrome://extensions` でデベロッパーモードを有効にします。
2. 「パッケージ化されていない拡張機能を読み込む」で、この `instagram-high-quality-images` フォルダを選びます。
3. Instagramのタブを再読み込みします。

更新時は拡張機能の更新ボタンを押してから、Instagramのタブも再読み込みしてください。Chrome 116以降が必要です。Edgeでは `edge://extensions` を使用します。

## 対応範囲と制約

- Instagramの投稿画像として判定でき、Instagram配信CDNのURLを持つ画像が高画質表示の対象です。
- Instagram側のHTML構造や配信仕様が変わると、対象画像を判定できない場合があります。
- Liveの横向き表示は、縦長で、Liveページ上にある動画または再生時間がLive配信として判定できる動画が対象です。
- `storage` 権限は設定の保存、`activeTab` 権限はポップアップから現在のInstagramタブの状態を確認するために使用します。

## 検証

```sh
npm test
```

ブラウザー統合テストは、Instagramページと画像配信を再現します。

```sh
npm install
npx playwright install chromium
npm run test:browser
```

最大解像度候補への切り替え、Live動画の回転、ダウンロード用UIが存在しないこと、manifestにダウンロード用権限・処理が存在しないことを検証します。通常の使用にビルドやnpmは不要です。
