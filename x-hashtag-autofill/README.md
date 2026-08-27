# X Hashtag Autofill

X の投稿画面を開いたとき、設定したハッシュタグを末尾へ自動挿入し、カーソルを本文の先頭に戻す Chrome/Edge 拡張です。

```text
ここから本文を入力


#test_hashtag
```

## 機能

- 投稿画面を開いたときに、設定したハッシュタグを末尾へ自動挿入
- 本文入力用の空行を確保し、カーソルを投稿欄の先頭へ移動
- スペース、改行、カンマ区切りによる複数ハッシュタグ指定
- `#` を省略した設定値の自動補完
- 同じ投稿画面への重複挿入を防止

## インストール

1. Chrome で `chrome://extensions`（Edge は `edge://extensions`）を開く
2. 「デベロッパー モード」を有効にする
3. 「パッケージ化されていない拡張機能を読み込む」を選ぶ
4. このディレクトリを指定する
5. 拡張機能のアイコンを押し、自動挿入するハッシュタグを保存する

投稿画面を新しく開くと、空行の後にハッシュタグが入り、カーソルは先頭に置かれます。

## 対応サイト

- `https://x.com/*`
- `https://twitter.com/*`

## 開発時の確認

```sh
node --check content.js
node --check popup.js
node -e 'JSON.parse(require("fs").readFileSync("manifest.json", "utf8"))'
```

コードを変更した場合は、`chrome://extensions` で拡張機能を再読み込みし、開いているXのタブも再読み込みしてください。
