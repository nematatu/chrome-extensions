# My Tools

このリポジトリの元拡張19本を、My Tools 1本へまとめるビルドです。元の拡張のソースと単独版は残し、配布用フォルダーだけを生成します。

## 生成・読み込み

Chrome / Chromium を対象とします。ほかのブラウザーは未検証です。Node.js が必要です。Node.js v24.22.1 で検証しています。追加パッケージなしで生成できます。

```sh
node unified-tools/build.mjs
```

1. Chrome で `chrome://extensions` を開き、デベロッパー モードを有効にします。
2. 「パッケージ化されていない拡張機能を読み込む」で、リポジトリ内の `dist/my-tools` を選びます。
3. 下の履歴移行を済ませ、元の各拡張を無効にします。同時に有効だと操作ボタンが重複します。
4. 各機能の対象タブを再読み込みします。

更新時は同じコマンドで再生成し、拡張管理画面で My Tools を更新してから対象タブを再読み込みします。出力は生成専用です。編集は元の拡張か `unified-tools` 内で行ってください。生成・構文確認に失敗した場合は前の出力を保持します。出力切り替え中の強制終了・停電については未検証です。

`identity.json` は拡張IDを一定にする公開鍵です。秘密鍵は含みません。別ブラウザーの保存領域への移行は、以下の JSON 操作で行います。

## 使い方

My Tools のアイコンを開くと、19機能の有効・無効、名前検索、元の設定・状態画面、Instagram の表示済み投稿の一括保存、設定・履歴の書き出しと読み込みを操作できます。右上の矢印で同じ設定をタブ表示できます。

機能の切り替え後は対象ページを再読み込みしてください。無効にしても開始済みの保存の完了・復旧・キャンセル処理は継続します。新しい保存・記録・翻訳の開始を拒否し、ページへの新しいスクリプト注入を停止します。既に開いていたページの見た目を消すには再読み込みが必要です。

各機能の処理と設定画面は元の拡張を利用します。設定画面は My Tools 内のフレームで開き、元のポップアップが参照するアクティブなWebページを維持します。Birdscore の Alt+B は専用ウィンドウを開きます。アイコン上の数字は通知を持つ機能の数で、各機能の通知内容は一覧に表示します。

投稿・ストーリー・リールの保存操作と Gofile の収集・保存処理も元の拡張を利用します。対応範囲やサイト側の制約は、それぞれの [Instagram README](../instagram-media-downloader/README.md) と [Gofile README](../gofile-bulk-video-downloader/README.md) も参照してください。

## 既存の Instagram 保存履歴を移す

旧版と統合版は別の保存領域を使うため、自動で履歴は引き継がれません。

1. 拡張管理画面で元の Instagram Media Downloader を更新し、Instagram のタブを再読み込みします。
2. 元の拡張のポップアップから「移行用に保存履歴を書き出す」を選び、JSON を保存します。
3. My Tools の「読み込む」で、その JSON を選択します。
4. 履歴が読み込まれたことを確認します。元の拡張の進行中の保存が完了してから、元の拡張を無効にします。

別のブラウザーへ移る場合は、My Tools の「設定・履歴を書き出す」で JSON を保存し、移行先に同じ拡張を読み込んでから JSON を読み込みます。既存の履歴は削除せず、同じ識別子には新しい日時を採用します。元の Instagram 拡張の JSON には機能設定がないため、履歴だけを追加します。

移行ファイルは最大20MiBです。設定の反映に失敗した場合、履歴だけが追加済みになることがあります。その場合は画面に部分完了を表示します。同じファイルで再実行できます。

書き出すのは全19機能の有効・無効、下表の個別設定、Instagram の保存済み識別子・日時です。ログイン情報、Cookie、進行中ジョブのメディアURL、ダウンロードID、ファイル本体は含みません。Gofile の現在の実装には移行対象となる永続的な保存済み履歴がないため、復旧用のジョブ情報は書き出しません。ファイル本体は必要に応じて別に移してください。

## 個別設定の移行対象

My Tools 内で保存した次の設定は、共通JSONに含めます。旧版19本からこれらすべてを自動取得する機能はありません。旧版からの専用履歴書き出しは Instagram のみです。ほかの元拡張の設定・履歴は、元拡張の保存領域に残ります。移行が必要なデータを確認してから、元拡張を削除してください。

| 機能 | 共通JSONに含める個別設定 |
| --- | --- |
| Instagram 高画質 | 有効設定・ライブ回転 |
| インハイTV操作 | スキップ秒数・キーボード操作 |
| KLTRA | 表示設定・翻訳設定 |
| R2 | URLテンプレート・サイズ・表示設定 |
| Xハッシュタグ | 指定テキスト |
| 寿司打 | CSV・JSON・ネットワーク結果の記録設定 |
| Google Photos | パネルの折りたたみ設定 |

R2の移行用URLテンプレートはHTTPS・認証情報なし・クエリーなし・フラグメントなしに制限します。これに合わない既存設定は移行できません。ハッシュタグは最大16,384文字です。これは移行ファイルの新しい入力制約です。

Google Photos のアルバム一覧、Momoniji の後で読む一覧・保存履歴、寿司打の結果履歴、Birdscore のキャッシュ、全機能の進行中ジョブは共通JSONの対象外です。

## 権限・通信先

元拡張の権限を合算します。生成manifestが実際の一覧です。

- `downloads`・`storage`・`unlimitedStorage`・`alarms`: 保存、保存状態、各機能の設定と復旧。
- `scripting`: 機能ごとのスクリプト登録・解除と既存コレクター。
- `offscreen`: YouTube・Tweetfile・ページ動画保存の処理。共通の裏側の画面に独立した3フレームを置き、各処理のライブラリと状態を分けます。
- `contextMenus`: Momoniji の後で読むメニュー。
- `activeTab`・`tabs`・`webRequest`: 元拡張の対象タブ操作と寿司打の結果取得。
- Birdscore のウィンドウ表示には `chrome.windows` API を使います。独立した `windows` 権限は宣言しません。元manifestのこの無効な権限名は生成時に除外します。[Chrome Windows API](https://developer.chrome.com/docs/extensions/reference/api/windows) と [権限一覧](https://developer.chrome.com/docs/extensions/reference/permissions-list) に従います。
- 対象サイト・取得先のホスト権限: 元拡張の許可対象を合算します。Tweetfile が元から持つHTTP/HTTPSの広いホスト権限も含みます。機能のOFFはChromeの許可そのものの取り消しではありません。
- 元拡張の任意ホスト権限が必須のHTTP/HTTPS権限に含まれる場合は、重複する宣言を生成しません。Birdscoreの既存の権限確認操作は維持しますが、統合版では既に許可された範囲になります。

全ローカル保存領域は `TRUSTED_CONTEXTS` に制限します。各機能のlocal・sync・sessionのキーと変更通知を分離します。Google Photos と KLTRA のページには許可した自機能のlocalキーだけを専用通信で返し、Instagram ページには検証済みの保存済み識別子を返します。設定の変更と履歴のインポート・エクスポートは、共通設定画面からのみ受け付けます。

## 構成・検証

`modules.mjs` が同梱ファイルと開始メッセージの一覧、`build.mjs` がビルド、`runtime.js` が切り替え・メッセージ配送・保存名とoffscreenの共同管理、`client.js` が各機能のAPIの分離、`portable.js` と `transfer.js` が移行形式の検証です。各機能の実装は元のディレクトリに残します。ソースのmanifest一覧とレジストリが一致しなければビルドを失敗させるため、新しい拡張の入れ忘れを検出できます。新しい拡張を追加する際は、配布ファイル・開始メッセージ・設定保存範囲をレジストリへ登録して検証します。

```sh
node --test unified-tools/tests/*.test.cjs
npm --prefix instagram-media-downloader test
node --test gofile-bulk-video-downloader/*.test.cjs
```

ブラウザ検証には Playwright と Chromium、ローカル HTTPS 用の OpenSSL が必要です。全機能の動画検証では、テスト素材の映像・音声分離と保存ファイルの検査に ffmpeg / ffprobe も使います。拡張本体の動作にはこれらの外部ツールは不要です。この作業環境では既存の Playwright を使い、以下を実行しました。

```sh
cd unified-tools
NODE_PATH=../instagram-high-quality-images/node_modules node tests/browser.cjs
NODE_PATH=../instagram-high-quality-images/node_modules node tests/all-browser-run.cjs
```

検証結果（2026-10-24）:

- 統合版の単体検証34件が成功しました。独立レビューでもclient/runtime24件とビルド4件が成功し、報告された具体的な問題は修正を確認しています。
- 既存の単体検証は合計415件が成功しました。対象はBadspi6、Gofile71、Instagram HQ7、Instagram保存33、KLTRA9、Momoniji120、ページメディア134、Stripchat14、Tweetfile9、YouTube11、寿司打1です。単体テストがない機能は件数に含めません。
- 生成した拡張を隔離 Chromium に読み込み、全19機能の切り替え、元の10設定画面、検索、保存領域の分離、16機能の模擬ページ動作を含む21項目が成功しました。
- Tweetfile HLS・ページメディア HLS・YouTube MP4変換を同時実行し、3本すべてを指定した保存名で保存しました。3本とも映像・音声のstreamとデコードを確認し、YouTubeは指定した0.4秒の区間の長さも確認しました。
- Instagram・Gofileの実ファイル保存、共通一括保存、保存済み表示、JSONの実書き出し・読み込み、再起動後の保持も、別の隔離ブラウザ検証で確認しています。
- 利用中のChromeへMy Toolsを導入し、19/19有効を確認しました。元Instagram拡張の保存済み識別情報481件を取り込み、統合バックアップJSONの保存完了を確認してから元拡張を無効化しました。元拡張とそのデータは残しています。
- 実際のInstagramでプロフィール右上から投稿3画像を保存し、各1440×1080の画像として確認しました。保存済み投稿の緑チェック表示も確認しました。長い投稿URLに対して通常のコードで応答が返るケースを修正し、指定URLからの個別保存完了と画像サイズ1179×1013を確認しました。
- 実際のリール画面で保存ボタンを確認し、MP4を保存しました。ホームから開いたストーリーで個別保存と一括保存2/2件が完了しました。リール・ストーリーのMP4はいずれも720×1280のH.264映像とAAC音声を持ち、ffmpegの全体デコードが成功しました。
- 最終修正後は統合単体34件、Instagram単体33件、Instagram隔離ブラウザ39項目が成功しています。保存履歴や配信URLは検証成果物に記録しません。
- Instagram以外の実サイト、Birdscoreのスコア取得とキーボード起動、外部翻訳、Google Photosのアルバム操作、Badspi・Smashnetの写真ファイル保存は今回未検証です。模擬ページの成功を実サイト動作の保証として扱っていません。

生成物の保存名イベントは各機能の提案を1つのChrome listenerで集約します。提案がない場合も元のdownload要求のfilenameを保ち、同じURLの開始だけをID確定まで直列化します。MAINとISOLATEDで共用するスクリプトは別URLに生成し、同時document_start登録で片側が実行されない現象を回避しています。

UI は Chrome の公開された拡張管理・設定操作を参考にし、ラベル付きの機能切り替えと個別の設定ページを採用しています。参照: [Chrome 拡張の管理](https://support.google.com/chrome/answer/2664769?hl=ja)、[Chrome Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)。利用者数や評価の比較は行っていません。

## 元に戻す

統合作業前の全ソースは [51a3ff4](https://github.com/nematatu/chrome-extensions/commit/51a3ff47c7083afbb8ca2a4b15afa4e0f36f42c8) として commit・push 済みです。

利用だけ戻す場合は My Tools を無効にして元の各拡張を有効にし、対象タブを再読み込みします。元の拡張を削除しなければ元の保存領域は残ります。統合後に増えた履歴は自動では元へ戻りません。元の単独版への履歴インポートは今回の対応範囲外です。
