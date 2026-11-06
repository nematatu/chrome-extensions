# My Tools

このリポジトリの元拡張19本を、My Tools 1本へまとめるビルドです。元の拡張のソースと単独版は残し、配布用フォルダーだけを生成します。

## 生成・読み込み

Chrome / Chromium を対象とします。ほかのブラウザーは未検証です。Node.js と npm が必要です。Node.js v24.22.1 で検証しています。

```sh
npm ci --prefix unified-tools
node unified-tools/build.mjs
```

1. Chrome で `chrome://extensions` を開き、デベロッパー モードを有効にします。
2. 「パッケージ化されていない拡張機能を読み込む」で、リポジトリ内の `dist/my-tools` を選びます。
3. 下の履歴移行を済ませ、元の各拡張を無効にします。同時に有効だと操作ボタンが重複します。
4. 各機能の対象タブを開きます。反映されない場合は対象タブを再読み込みします。

更新時は同じコマンドで再生成し、拡張管理画面で My Tools を再読み込みします。再読み込み後は、既に開いている対象タブへの自動反映を試みます。反映されない場合は対象タブを再読み込みしてください。出力は生成専用です。編集は元の拡張か `unified-tools` 内で行ってください。生成・構文確認に失敗した場合は前の出力を保持します。出力切り替え中の強制終了・停電については未検証です。

`identity.json` は拡張IDを一定にする公開鍵です。秘密鍵は含みません。別ブラウザーの保存領域への移行は、以下の JSON 操作で行います。

## 使い方

My Tools の「機能」タブで、名前検索、19機能の切り替え、各機能の設定を操作します。Instagramの一括保存もここから実行できます。「バックアップ」タブで設定と保存履歴のJSONを書き出し・読み込みします。右上のボタンで同じ画面をタブ表示できます。

機能をオンにすると、開いている対象タブへの自動反映を試みます。オフにした場合や、オンでも表示されない場合は対象ページを再読み込みしてください。無効にしても開始済みの保存の完了・復旧・キャンセル処理は継続します。新しい保存・記録・翻訳の開始を拒否し、ページへの新しいスクリプト注入を停止します。既に開いていたページの見た目を消すには再読み込みが必要です。

### 対象ページに機能が表示されないとき

1. 対象タブで My Tools のポップアップを開きます。開いた時点で、そのタブへの反映を試みます。
2. `chrome://extensions` の My Tools →「詳細」→「サイトへのアクセス」を確認します。背景で開いている全タブへ自動反映するには「すべてのサイト」が必要です。「クリックされた場合のみ」でも、ポップアップを開いた対象タブへの反映を試みます。許可されない場合は「すべてのサイト」に変更して再読み込みしてください。
3. 対象タブを再読み込みします。動的コンテンツスクリプトは、登録前から開いていたタブへ自動では適用されません。
4. 直らない場合は、対象ページのデベロッパーツールのコンソールと、My Tools の Service Worker のエラーを確認します。

各機能の処理と画面は元の拡張を利用します。ポップアップは My Tools 内のフレームで開き、元のポップアップが参照するアクティブなWebページを維持します。Media Saver の設定ページは専用のタブで開きます。Birdscore の Alt+B は専用ウィンドウを開きます。アイコン上の数字は通知を持つ機能の数で、各機能の通知内容は一覧に表示します。

Media Saver は、フレーム内の再スキャンで現在のタブを調べ、通信検出とページ内検出をまとめて表示します。HLS/DASH の画質取得と結合は共通の裏側の画面にある専用フレームで行います。機能をOFFにすると新しいスキャン・画質取得・保存・通信検出を止め、開始済みの保存は継続します。

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

My Tools 内で保存した次の設定は、共通JSONに含めます。各元拡張からこれらすべてを自動取得する機能はありません。旧版からの専用履歴書き出しは Instagram のみです。ほかの元拡張の設定・履歴は、元拡張の保存領域に残ります。移行が必要なデータを確認してから、元拡張を削除してください。

| 機能 | 共通JSONに含める個別設定 |
| --- | --- |
| better-ig | 保存・高画質表示・ライブ回転の個別設定 |
| インハイTV操作 | スキップ秒数・キーボード操作 |
| KLTRA | 表示設定・翻訳設定 |
| R2 | URLテンプレート・サイズ・表示設定 |
| Xハッシュタグ | 指定テキスト |
| 寿司打 | CSV・JSON・ネットワーク結果の記録設定 |
| Google Photos | パネルの折りたたみ設定 |

R2の移行用URLテンプレートはHTTPS・認証情報なし・クエリーなし・フラグメントなしに制限します。これに合わない既存設定は移行できません。ハッシュタグは最大16,384文字です。これは移行ファイルの新しい入力制約です。

Google Photos のアルバム一覧、Momoniji の後で読む一覧・保存履歴、寿司打の結果履歴、Birdscore のキャッシュ、Media Saver の設定・ダウンロード履歴、全機能の進行中ジョブは共通JSONの対象外です。

## 権限・通信先

元拡張の権限を合算します。生成manifestが実際の一覧です。

- `downloads`・`storage`・`unlimitedStorage`・`alarms`: 保存、保存状態、各機能の設定と復旧。
- `scripting`: 機能ごとのスクリプト登録・解除と既存コレクター。
- `offscreen`: YouTube・Tweetfile・ページ動画保存・Media Saver の処理。共通の裏側の画面に独立した4フレームを置き、各処理のライブラリと状態を分けます。Media Saver の HLS/DASH 結合もこの専用フレームで行います。
- `contextMenus`: Momoniji の後で読むメニュー。
- `activeTab`・`tabs`・`webRequest`: 元拡張の対象タブ操作、寿司打の結果取得、Media Saver のメディア検出。
- Birdscore のウィンドウ表示には `chrome.windows` API を使います。独立した `windows` 権限は宣言しません。元manifestのこの無効な権限名は生成時に除外します。[Chrome Windows API](https://developer.chrome.com/docs/extensions/reference/api/windows) と [権限一覧](https://developer.chrome.com/docs/extensions/reference/permissions-list) に従います。
- 対象サイト・取得先のホスト権限: 元拡張の許可対象を合算します。Tweetfile が元から持つHTTP/HTTPSの広いホスト権限と、Media Saver が任意のサイトを検出するための `<all_urls>` も含みます。機能のOFFはChromeの許可そのものの取り消しではありません。
- 元拡張の任意ホスト権限が必須のHTTP/HTTPS権限に含まれる場合は、重複する宣言を生成しません。Birdscoreの既存の権限確認操作は維持しますが、統合版では既に許可された範囲になります。

全ローカル保存領域は `TRUSTED_CONTEXTS` に制限します。各機能のlocal・sync・sessionのキーと変更通知を分離します。Google Photos と KLTRA のページには許可した自機能のlocalキーだけを専用通信で返し、Instagram ページには検証済みの保存済み識別子を返します。設定の変更と履歴のインポート・エクスポートは、共通設定画面からのみ受け付けます。

## 構成・検証

Media Saver 統合後は、統合単体39件、管理画面・保存・移行の隔離ブラウザー20項目、全機能の隔離ブラウザー21項目、対象タブ修復（Instagram専用1項目、全18ページ機能18項目）、Media Saver 統合ブラウザー10項目が成功しました。キーボードのタブ切り替え、狭幅での横はみ出し、実表示の文字サイズ、ライト・ダーク表示、不正JSONでの状態保持、スイッチ更新失敗時の復元も確認しています。依存ライブラリのライセンス本文を生成物の `THIRD_PARTY_LICENSES.txt` に同梱します。

ポップアップの幅崩れが報告された後、HTMLへ最小幅380pxを指定し、利用中Chromeで拡張を再読み込みしてアイコンからの正常表示を確認しました。commit、push、外部へのデプロイは行っていません。下記の実サイト保存検証はUI変更前の統合版での結果です。

実際のポップアップの自動サイズも検査するには、以下を実行します。固定幅のタブ表示だけではこの経路を検証できません。隔離Chromiumの `chrome.action.openPopup()` で開いた実ポップアップについて、幅380〜800pxとInstagram操作の表示を確認し、`test-results/native-popup.png` を保存します。

```sh
cd unified-tools
NODE_PATH=../instagram-media-downloader/node_modules node tests/native-popup.cjs
```

`modules.mjs` が同梱ファイルと開始メッセージの一覧、`build.mjs` がビルド、`runtime.js` が切り替え・メッセージ配送・ダウンロードとoffscreenの共同管理、`client.js` が各機能のAPIの分離、`portable.js` と `transfer.js` が移行形式の検証です。管理画面のソースは `popup.jsx` と `popup.css` です。React、RadixのTabsとSwitch、Radix Colors、Lucideをesbuildでローカルファイルへまとめます。CDNからコードやフォントを読み込みません。依存のバージョンは `package-lock.json` で固定します。各機能の実装は元のディレクトリに残します。ソースのmanifest一覧とレジストリが一致しなければビルドを失敗させるため、新しい拡張の入れ忘れを検出できます。新しい拡張を追加する際は、配布ファイル・開始メッセージ・設定保存範囲をレジストリへ登録して検証します。

```sh
node --test unified-tools/tests/*.test.cjs
npm --prefix instagram-media-downloader test
node --test gofile-bulk-video-downloader/*.test.cjs
```

ブラウザ検証には Playwright と Chromium、ローカル HTTPS 用の OpenSSL が必要です。全機能の動画検証では、テスト素材の映像・音声分離と保存ファイルの検査に ffmpeg / ffprobe も使います。拡張本体の動作にはこれらの外部ツールは不要です。この作業環境では既存の Playwright を使い、以下を実行しました。

```sh
cd unified-tools
NODE_PATH=../instagram-media-downloader/node_modules node tests/browser.cjs
NODE_PATH=../instagram-media-downloader/node_modules node tests/all-browser-run.cjs
NODE_PATH=../instagram-media-downloader/node_modules node tests/media-browser.cjs
NODE_PATH=../instagram-media-downloader/node_modules node tests/repair-browser.cjs
NODE_PATH=../instagram-media-downloader/node_modules node tests/repair-all-browser.cjs
```

`tests/repair-browser.cjs` は、動的登録を解除した状態で開いた Instagram タブをポップアップから修復し、二重UIを作らずに1回だけ注入されることを確認します。

`tests/repair-all-browser.cjs` は、同じ停止状態を18のページ機能で再現します。各機能のページを開く前にコンテンツスクリプト登録をすべて解除し、ポップアップからの修復で機能DOMが復元されること、2回目の修復では追加注入されないことを確認します。対象は Instagram、Gofile、Google Photos、Badspi、Inhigh Links、Inhigh Skip、KLTRA、Koutairen、Momoniji、R2、Smashnet、Instagram HQ、Sushida、YouTube、Tweetfile、Page Media、Stripchat、X Hashtags です。KLTRA は既に開いている Cbox フレームへチャットスクリプトが入り、新着メッセージが弾幕になることも確認します。

検証結果（2026-10-26）:

- 統合版の単体検証39件が成功しました。client/runtime29件とビルド4件も成功し、報告された具体的な問題は修正を確認しています。
- native の保存名 listener は起動時・ダウンロード中・完了後のいずれも0件で、My Tools が Chrome の `onDeterminingFilename` に参加しないことを単体検証と隔離 Chromium で確認しました。ダウンロードは各機能が `downloads.download` に渡す `filename` を使い、別拡張の保存名決定に干渉しません。Chrome では listener が登録されているだけで他拡張の `filename` 指定が無視されるため、listener を持たないことを回帰テストで確認しています。
- Media Saver以外の既存の単体検証は合計415件が成功しました。対象はBadspi6、Gofile71、Instagram HQ7、Instagram保存33、KLTRA9、Momoniji120、ページメディア134、Stripchat14、Tweetfile9、YouTube11、寿司打1です。単体テストがない機能は件数に含めません。
- 生成した拡張を隔離 Chromium に読み込み、全20機能の切り替え、元の11設定画面、検索、保存領域の分離、16機能の模擬ページ動作を含む21項目が成功しました。
- 全18ページ機能について、登録を解除した状態で開いた既存タブをポップアップから修復し、各機能のDOMが復元されること、2回目の修復で重複注入されないことを確認しました。対象は Instagram、Gofile、Google Photos、Badspi、Inhigh Links、Inhigh Skip、KLTRA、Koutairen、Momoniji、R2、Smashnet、Instagram HQ、Sushida、YouTube、Tweetfile、Page Media、Stripchat、X Hashtags です。KLTRAでは既に開いているCboxフレームのチャットスクリプトも復元され、新着メッセージが弾幕表示されることを確認しました。
- Tweetfile HLS・ページメディア HLS・YouTube MP4変換を同時実行し、3本すべてを指定した保存名で保存しました。3本とも映像・音声のstreamとデコードを確認し、YouTubeは指定した0.4秒の区間の長さも確認しました。
- Media Saver 単体は、単体検証41件と隔離ブラウザ14項目が成功しました。HLSの音声分離結合、DASHの映像・音声分離、直接MP4/MP3/PNGのバイト一致、設定、履歴、テーマ、OFF制御を確認しています。
- Media Saver を My Tools に統合した隔離ブラウザ検証10項目が成功しました。20番目の機能として表示され、フレーム内ポップアップが現在のタブを維持すること、動的コンテンツスクリプトと通信検出、共有offscreenでのHLS画質取得、映像・音声入りMP4の保存、PNGのバイト一致、専用設定タブ、設定反映、狭幅表示、OFF時のスキャン・画質取得・開始・通信検出の停止を確認しています。
- Instagram・Gofileの実ファイル保存、共通一括保存、保存済み表示、JSONの実書き出し・読み込み、再起動後の保持も、別の隔離ブラウザ検証で確認しています。
- 利用中のChromeへMy Toolsを導入し、Media Saver統合前の19/19有効を確認しました。元Instagram拡張の保存済み識別情報481件を取り込み、統合バックアップJSONの保存完了を確認してから元拡張を無効化しました。元拡張とそのデータは残しています。
- 実際のInstagramでプロフィール右上から投稿3画像を保存し、各1440×1080の画像として確認しました。保存済み投稿の緑チェック表示も確認しました。長い投稿URLに対して通常のコードで応答が返るケースを修正し、指定URLからの個別保存完了と画像サイズ1179×1013を確認しました。
- 実際のリール画面で保存ボタンを確認し、MP4を保存しました。ホームから開いたストーリーで個別保存と一括保存2/2件が完了しました。リール・ストーリーのMP4はいずれも720×1280のH.264映像とAAC音声を持ち、ffmpegの全体デコードが成功しました。
- 最終修正後は統合単体39件、Instagram単体33件、Instagram隔離ブラウザ40項目が成功しています。保存履歴や配信URLは検証成果物に記録しません。
- Instagram以外の実サイト、Birdscoreのスコア取得とキーボード起動、外部翻訳、Google Photosのアルバム操作、Badspi・Smashnetの写真ファイル保存、Media Saverの実サイトのHLS/DASH配信は今回未検証です。模擬ページの成功を実サイト動作の保証として扱っていません。

生成物の保存名は各機能が `downloads.download` に渡す `filename` を使います。Chrome の `onDeterminingFilename` は全拡張へ配信され、listener が登録されているだけで他拡張の `filename` 指定が無視されることがあるため、My Tools は native listener を登録しません。モジュール側の既存 listener 登録は互換用の no-op にし、同じURLの開始だけをID確定まで直列化します。MAINとISOLATEDで共用するスクリプトは別URLに生成し、同時document_start登録で片側が実行されない現象を回避しています。

動的コンテンツスクリプトは1件ずつ登録します。Chromeは登録配列をまとめて検証するため、1件の拒否で全機能が無効にならないようにするためです。起動時、`runtime.onInstalled`、`runtime.onStartup`、管理画面の表示時に、開いている対象タブへ未注入の機能を追加します。`globalThis.MyToolsClient` を初期化済みマーカーにして二重UIを防ぎます。登録前から開いていたタブや、サイトへのアクセスが「クリックされた場合のみ」のタブは、ポップアップを開いたときにも修復を試みます。親ページに一致した機能が全フレーム用の登録を持つ場合（KLTRAのCboxチャットなど）は、その登録も同じタブの全フレームへ注入し、既に開いている埋め込み画面を修復します。

UIの参照元と採用箇所は [UI-DESIGN.md](UI-DESIGN.md) に記録しています。元の各機能の設定画面は既存の画面を引き続き利用します。

## ダウンロード名の競合

Chrome では、複数の拡張機能が同じダウンロードの保存名を同時に指定すると、後からインストールされた拡張機能の名前が採用され、ほかの拡張機能に「ダウンロード ファイルに名前を付けることができませんでした」と警告が出ます。`onDeterminingFilename` の listener が登録されているだけで、その拡張が `suggest()` を呼ばなくても、他の拡張の `downloads.download({filename})` が無視されることがあります。

My Tools は、native の `onDeterminingFilename` listener を一切登録しません。各機能が `downloads.download` に渡す `filename` を使うため、一括画像ダウンローダーなど別の拡張機能が開始したダウンロードの保存名決定に参加せず、空の保存名を提案することもありません。

- 別の拡張機能が同じダウンロードに保存名を提案した場合、Chrome がその拡張機能の名前を採用することがあります。Chrome の API では、他の拡張機能の提案内容を列挙・制御できません。
- My Tools 自身の保存名を確実に固定したい場合は、該当する拡張機能を一時的に無効にするか、Chrome のプロファイルを分けてください。
- 警告が出てもファイル自体は保存されている場合があります。`chrome://downloads` で保存名を確認し、必要なら手動で名前を変更してください。
- 実物の「一括画像ダウンローダー 1.2.0」との同時実行は、手元に対象拡張がないため未検証です。ただし My Tools は native listener を登録しないため、My Tools 側からこの競合警告を発生させません。
- My Tools に含まれる機能の単独版（ページ動画・画像 一括保存、Momoniji など）も同時に有効にすると、同じ機能が二重に動きます。保存名の競合とは別に、動作の重複を避けるため片方だけを有効にしてください。単独版は独自の listener を持つ場合があるため、My Tools と単独版を同時に有効にしないでください。

## 元に戻す

統合作業前の全ソースは [51a3ff4](https://github.com/nematatu/chrome-extensions/commit/51a3ff47c7083afbb8ca2a4b15afa4e0f36f42c8) として commit・push 済みです。

利用だけ戻す場合は My Tools を無効にして元の各拡張を有効にし、対象タブを再読み込みします。元の拡張を削除しなければ元の保存領域は残ります。統合後に増えた履歴は自動では元へ戻りません。元の単独版への履歴インポートは今回の対応範囲外です。


## better-igへの統合

Instagram保存とInstagram高画質表示は `better-ig` 1項目へ統合しました。投稿・リール・ストーリー保存、↓キー保存、高画質表示、Live横向き表示を同じ設定画面で操作します。保存側の内部ID `instagram` と保存履歴の名前空間を維持しています。

更新時に、旧 `instagramhq` の高画質・Live設定と、旧2項目それぞれの有効状態を移します。片方だけ有効だった場合も、対応する機能だけを有効にします。旧HQのコンテンツスクリプト登録は解除します。旧バックアップJSONも読み込めます。新しく書き出すJSONには `better-ig` の設定だけを含めます。

ビルド後はMy Toolsを再読み込みし、開いているInstagramタブも再読み込みしてください。別IDの旧単独版HQ拡張の設定をMy Toolsが直接読み出すことはできません。単独版からの移行はbetter-igのREADMEをご確認ください。
