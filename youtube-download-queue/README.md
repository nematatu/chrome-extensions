# YouTube ダウンロードキュー

YouTube の動画を、Auto-YTDLP のダウンロードキュー `links.txt` にワンクリックで追加します。キューに登録済みの動画とダウンロード済みの動画には、YouTube の画面で緑のチェックを付けます。

スマホやほかの PC からは、YouTube の「保存」で決めた再生リストに入れます。母艦（`links.txt` がある Mac）が10分ごとにその再生リストを読み、`links.txt` に取り込みます。

ダウンロード自体は行いません。Auto-YTDLP は自分で起動してください。Google アカウントの連携や API キーは不要です。

```
母艦の Chrome（拡張機能）──────────────────────────────────┐
                                                           ├→ links.txt ← Auto-YTDLP（自分で起動）
スマホ・ほかの PC（YouTube の「保存」）→ 再生リスト ─ 10分ごとに取り込み ┘
```

## 画面での表示（母艦）

- サムネイル左上に、キューに登録済みの動画とダウンロード済みの動画は緑のチェックを表示します。ツールチップと読み上げで「キューに登録済み」「ダウンロード済み」を区別します。
- まだの動画は、サムネイルにポインターを合わせると、緑のチェックと同じ左上に「＋」が出ます。押すとすぐ `links.txt` に追加し、緑のチェックに変わります。動画は開きません。
- 再生プレビューに切り替わっても、同じ位置に同じ表示が出ます。プレビューが表示される瞬間は、YouTube のフェードに合わせて一瞬薄くなります。
- 動画ページでは、タイトルの左に同じ表示が出ます。
- 検索結果、関連動画、チャンネルの動画一覧、再生リスト、検索結果の Shorts 欄で確認しています。無限スクロールと YouTube 内の画面遷移に追従します。ログインした状態のホーム画面は、自動テストで確認していません。
- 1つのタブで追加すると、開いているほかの YouTube のタブも更新されます。
- 追加に失敗したときは、画面左下に理由を5秒間表示します。チェックは付きません。

## スマホ・ほかの PC から

- YouTube アプリまたはブラウザーの「保存」で、`setup` で指定した再生リストに入れるだけです。ほかの PC には拡張機能も `yt-queue` も要りません。
- 母艦は10分ごとに再生リストを `yt-dlp` で読みます。キューに無く、まだダウンロードしていない動画だけを `links.txt` に追加します。
- 再生リストからは削除しません。ダウンロード済みの動画は記録で判別するため、二度は追加しません。再生リストの上限は5,000本なので、たまに整理してください。
- 取り込みの記録は `~/Library/Logs/yt-queue.log` に残ります。何も追加しなかった回は記録しません。母艦がスリープ中は実行されず、復帰後に実行されます。

## 準備（母艦）

macOS、Python 3、`yt-dlp`、Auto-YTDLP が必要です。

```sh
mkdir -p ~/bin
ln -s "$PWD/youtube-download-queue/cli/yt-queue" ~/bin/yt-queue
~/bin/yt-queue setup --queue-dir ~/youtube-queue --playlist 'https://www.youtube.com/playlist?list=PL…'
```

- `--queue-dir`：`links.txt` と `download_archive.txt` を置くフォルダー
- `--playlist`：スマホやほかの PC から保存する再生リスト（省略可）。公開範囲は「限定公開」にしてください。非公開の再生リストは読めません。

`setup` はネイティブホスト（Chrome から `yt-queue` を呼ぶ仕組み）を登録します。`--playlist` を指定したときは、10分ごとの取り込み（`~/Library/LaunchAgents/com.nematatu.yt-queue.plist`）も登録します。設定を変えるときは、もう一度 `setup` を実行します。

Auto-YTDLP は、キューのフォルダーで起動します。

```sh
cd ~/youtube-queue && auto-ytdlp
```

Auto-YTDLP は既定で、起動したフォルダーの `links.txt` と `download_archive.txt` を使います。拡張機能はこの `download_archive.txt` でダウンロード済みを判定します。Auto-YTDLP の `--archive-file` で別の場所を指定すると、ダウンロード済みの表示が出ません。

### Chrome 拡張機能

1. `setup` の後に Chrome を再起動します。
2. `chrome://extensions` でデベロッパー モードを有効にし、「パッケージ化されていない拡張機能を読み込む」で `youtube-download-queue` を選びます。My Tools を使う場合は、[My Tools の手順](../unified-tools/README.md)で `dist/my-tools` を読み込みます。
3. 拡張機能のアイコンから画面を開き、追加先と件数が表示されることを確認します。My Tools では一覧の「YouTube ダウンロードキュー」から開きます。
4. 開いている YouTube のタブを再読み込みします。

拡張機能を更新したら、`chrome://extensions` で再読み込みし、開いている YouTube のタブも再読み込みしてください。

## コマンド

```sh
yt-queue add 'https://youtu.be/xxxxxxxxxxx' 'https://www.youtube.com/playlist?list=PL…'
yt-queue state
yt-queue uninstall
```

- `add`：動画の URL（`watch?v=`、`youtu.be/`、`shorts/`、`live/`）、動画 ID、再生リストの URL を混在して指定できます。
  - 再生リストは動画ごとの行に展開します。Auto-YTDLP は1行ごとに `yt-dlp` を1つ起動するため、再生リストの URL を1行のまま渡すと `--concurrent` が効きません。
  - `watch?v=…&list=…` は、その動画1本だけを追加します。
- `state`：追加先と件数を表示します。
- `uninstall`：設定、ネイティブホスト、定期取り込みを削除します。

## 権限と通信

| 権限 | 理由 |
| --- | --- |
| `nativeMessaging` | `yt-queue` を通じて `links.txt` に追加し、登録済み・ダウンロード済みの動画 ID を受け取る |
| `https://www.youtube.com/*` | 表示と追加ボタン。追加の後に、開いている YouTube のタブへ表示の更新を伝える |

拡張機能自体は外部と通信しません。`yt-queue` の通信は、`yt-dlp` による再生リストの取得だけです。

拡張機能から渡せるのは「状態の取得」と「11文字の動画 ID の追加」だけです。拡張機能からファイルのパスやコマンドは指定できません。`setup` は再生リストの URL を検証します。

## 制約

- **ほかの PC での表示：** 緑のチェックと追加ボタンは母艦の Chrome だけで使えます。ほかの PC は再生リストに保存するだけで、画面には何も表示しません。
- **表示のキャッシュ：** 表示する状態は最大30秒間キャッシュします。再生リストから取り込んだ動画をすぐ反映するには、拡張機能の画面で「読み込み直す」を押します。キャッシュ中に既に登録済みの動画を押した場合は「既に links.txt にあります」と表示し、二重には追加しません。
- **追加が失われることがある：** Auto-YTDLP は完了した行を `links.txt` から消すとき、ファイルを読み直して置き換えます。その瞬間に追加が重なると、追加した行が失われることがあります。拡張機能から追加した場合は緑のチェックが消えるので、もう一度押してください。再生リストの動画は、次の回に入り直します。
- **対象ページ：** 対象は `https://www.youtube.com/` です。`m.youtube.com`、YouTube Music、Shorts の再生画面のタイトルには表示しません。
- **対応環境：** `yt-queue` は macOS の Google Chrome と Chromium に対応します。
- **件数の上限：** キューとダウンロード履歴は、合わせて約7万件までです。ネイティブメッセージングの1回の応答は1MBが上限です。
- **YouTube の画面変更：** YouTube の画面構造に依存するセレクターは、`content.js` 冒頭の `THUMBNAILS`・`WATCH_TITLE`・`WATCH_TITLE_TEXT` にまとめています。

## テスト

```sh
cd youtube-download-queue
npm ci
npx playwright install chromium
npm test              # URL 解析と yt-queue（偽の yt-dlp・launchctl）の単体テスト
npm run test:browser  # My Tools を生成し、単体版と My Tools を Chromium に読み込んで実際の youtube.com で確認
npm run test:live     # 実際の yt-dlp で公開再生リストを展開して追加
```

`test:browser` は、単体版を YouTube のライトテーマ、My Tools を YouTube のダークテーマで実行します。`yt-queue setup` で一時フォルダーにネイティブホストを登録し、テストが `links.txt` を直接確認します。確認する項目は次のとおりです。

- 未設定時の案内
- 追加先と件数の表示
- 裏で開いているタブと別タブの自動更新
- チェックの位置・色・可視性
- 再生プレビュー上の表示
- 動画を開かないワンクリック追加
- 連打しても1回だけ追加されること
- 登録済みの動画が二重に入らないこと
- 書き込めないときの表示
- 再生リストから取り込んだ動画が「読み込み直す」で緑になること（偽の yt-dlp）
- 無限スクロール、Shorts、チャンネル、再生リスト
- 動画ページのタイトルと画面遷移
- My Tools での表示とオン・オフ

次の項目は、開発時に実際の環境で確認しました。

- **実際の launchd：** 一時フォルダーの設定で登録し、起動時の実行を確認しました。実際の再生リストを読み、まだの動画だけを `links.txt` に追加したことを確認しています。その後 `uninstall` で削除しました。
- **Auto-YTDLP との連携：** キューのフォルダーで Auto-YTDLP 1.2.0 を既定の設定で起動しました。追加した動画がダウンロードされて `links.txt` から消え、`yt-queue` がダウンロード済みとして返すことを確認しています。

画面は `test-results/` に出力します。
