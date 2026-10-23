- [x] Reproduce it yourself on the matching surface via the driver skill.
- [x] Binary-search the cause.
- [x] Plan the fix.
- [x] Verify on the same surface.
- [x] Stage the commits so the failing repro lands before the fix in git history. skip: 利用者の指示によりコミットしない。
- [x] Run Opening a PR. skip: 利用者からPR作成・公開の依頼なし。

長いIDは実メディア情報のcode長39とURLとの完全一致を観測。20文字制限で破棄されることをコードで確認。
ホーム経由ストーリー、プロフィールの右上ボタン、長いIDの個別・全件保存を実画面で再確認する。

実確認完了。プロフィール右上から2件、長いIDの投稿は個別1件・全9件、ホーム経由ストーリーは個別1件・全11件。プロフィール2件、投稿9件、ストーリー11件のデコード成功。ストーリーのリロード後の両ボタンも確認。単体17件、隔離ブラウザー27項目成功。独立レビューに要修正の指摘なし。
