# 拡張機能の共有UI

19本の単独拡張とMy Toolsに同じRadix ColorsとLucideを同梱します。既存の設定、保存処理、通信、ショートカットは各拡張で維持します。

## 更新

リポジトリのルートで実行します。

```sh
npm ci --prefix unified-tools
npm run build --prefix unified-tools
node --test shared-ui/tests.cjs
```

生成された `ui-kit.js`、`ui-tokens.css`、`UI-LICENSES.txt` は単独版にも必要です。各拡張のフォルダーをChromeの「パッケージ化されていない拡張機能を読み込む」で指定できます。更新時は拡張機能を再読み込みし、既に開いている対象サイトのタブも再読み込みしてください。My Toolsは `dist/my-tools` を読み込みます。

依存パッケージは `unified-tools/package.json` とlockfileに集約します。単独版のためのnpm依存は増やしません。生成時に公式LucideコンポーネントをSVGへ変換し、公式Radixパレットとライセンスを同梱します。原本は `build.mjs` と `base.css`、利用方法は [CONTRACT.md](CONTRACT.md) にあります。

## 規範

文字は12・14・20pxを基本とし、境界は0.5px、色はRadixトークンを使います。操作の種類が同じならアイコンも同じにします。タグライン、重複説明、装飾用の影・グラデーション・アニメーションを撤去します。ライト・ダークに対応し、既存のテーマ選択も維持します。

Kumo、Radix、Fluid Functionalismを画面と操作の参照に使い、既存のReact管理画面ではRadixのSwitchとTabsを使用します。既存のHTMLフォームには標準要素を維持します。現在存在しないドラッグ、分割ペイン、新しい状態管理を導入するためだけの依存追加は行いません。弾幕の移動、ユーザーが選んだ表示サイズ、進捗表示は機能として維持します。

共有CSSの要素スタイルは `.mt-ui` 内に限定し、サイト本体の要素を変更しません。`:where()`で詳細度を抑え、個別画面の操作サイズや配置を優先します。サイトの画像そのものや、同梱ライブラリの原本は変更しません。

## 参照

2026-10-24に公開情報を確認しました。利用者数や評価の比較はしていません。

| 一次情報 | 採用した画面構造・操作 |
| --- | --- |
| [Kumo Switch](https://kumo-ui.com/components/switch/) | 設定名と操作を同じ行へ揃える配置 |
| [Radix Playground](https://www.radix-ui.com/themes/playground) | 中立色の背景と操作状態による階層 |
| [Radix Colors](https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale) | 背景1–2、状態3–5、境界6–8、強調9–10、文字11–12 |
| [Fluid Functionalism](https://www.fluidfunctionalism.com/docs/switch) | 小さな設定画面の整列と余白 |
| [Transitions](https://transitions.dev/library.html) | 遷移の用途を確認。今回は装飾的な遷移を追加せず、動作に必要な進捗を維持 |
| [Laws of UX](https://lawsofux.com/) | 関連する操作のグループ化、選択肢の整理 |
| [Nielsenの10原則](https://www.nngroup.com/articles/ten-usability-heuristics/) | 状態・処理結果を操作箇所で表示 |
| [GOV.UK Design System](https://design-system.service.gov.uk/) | 明示的な入力ラベルと一貫したフォーム |
| [Inclusive Components](https://inclusive-components.design/) | 標準コントロールとキーボード操作の維持 |
| [Apple HIG](https://developer.apple.com/design/human-interface-guidelines/) | 操作と内容の階層を整理する方針 |
| [スロップ表現100連発](https://zenn.dev/todesking/articles/5bc43f449ecdf6) | 重複する説明、抽象的な標語、装飾見出しを削除 |

## ブラウザー検証

Playwrightがある環境で、リポジトリのルートから実行します。利用中のChromeプロファイルは使いません。

```sh
NODE_PATH=instagram-media-downloader/node_modules node unified-tools/tests/all-ui-browser.cjs
NODE_PATH=instagram-media-downloader/node_modules node unified-tools/tests/native-popup.cjs
NODE_PATH=instagram-media-downloader/node_modules node unified-tools/tests/standalone-native.cjs
```

単独のpopup/optionsをライト・ダークで開き、実ファイルの読み込み、実行エラー、横溢れ、12px未満の文字を確認します。実actionポップアップの自動寸法も別に確認します。My Toolsの既存機能・保存テストは `unified-tools/README.md` の手順を使用します。サイト内UIの検証には合成フィクスチャを使用します。外部サイトの将来の仕様や、ログインが必要な実データを網羅する検証ではありません。
