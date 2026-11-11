# 共有UI契約

生成物は各拡張のルートに `ui-kit.js`、`ui-tokens.css`、`UI-LICENSES.txt` を置きます。ソースは shared-ui/ に集約し、root担当が `node shared-ui/build.mjs` で生成します。npm依存は既存 unified-tools/ に集約します。各workerは生成物やmanifestを編集しません。

ISOLATED content scriptsでは既存スクリプトより前に ui-kit.js を読み、ui-tokens.css を既存CSSより前に読みます。MAIN worldへは追加しません。popup/optionsは ui-tokens.css を既存CSSより先にlinkし、ui-kit.jsを既存JSより先にscriptで読みます。HTMLやmanifestの追加配線はroot担当です。既存HTMLのbodyには `mt-ui`、popupのhtmlには `mt-popup` クラスを付けてください。

グローバル `MyToolsUI.css` は共有トークンとUI基本スタイルの文字列です。shadow rootの既存style.textContentの先頭へ加えます。通常DOMのスタイルはmanifestのCSSから変数を参照できます。共有CSSはホストページ全体の色・フォント・要素スタイルを変更しません。共通HTML UIはbody.mt-ui、shadow UIの基本フォントは:hostへ適用します。

変数は `--mt-gray-1`〜`--mt-gray-12`、`--mt-indigo-1`〜12、green、red、amber、gray-alpha `--mt-gray-a1`〜a12。強調背景上の文字は `--mt-on-accent`（公式whiteA12）、画像ビューアの暗幕は `--mt-overlay`（公式blackA10）を使用できます。ライト/ダークはOS設定へ追従します。背景1/2、操作背景3/4/5、線6/7/8、強調9/10、文字11/12。色はこれらだけを使います。透明はtransparent可。画像やサイト本体の色を変えません。

`MyToolsUI.icon(name)` は公式Lucideの静的SVG文字列を返します。innerHTMLへ入れて使えます。全SVGはaria-hidden、24viewBox、stroke=currentColor、fill=noneです。許可名は download, downloads, check, x, pause, play, settings, chevronLeft, chevronRight, chevronDown, chevronUp, maximize, minimize, copy, plus, minus, search, trash, folder, volume, volumeX, refresh, externalLink, image, video, file, more, eye, eyeOff, calendar, list, checkSquare, square, arrowLeft, arrowRight, save, upload, sun, moon, loader。必要な他の名前はrootへ連絡し、独自SVGを追加しないでください。変更は表示アイコンだけで、data属性・ariaラベル・イベントの意味を維持します。

文字は12/14/20pxを原則、最大4サイズ。borderは0.5px。影・グラデーション・装飾アニメーションを撤去します。必要な状態遷移のみ250ms ease-out、reduced-motionでは停止。タグライン、ヘルパー説明、重複見出しを撤去し、必要な入力ラベル・エラー・処理結果・実データは残します。既存機能・テストの意味を変えません。中点·を区切りに使わず改行・余白・独立spanで整理します。
