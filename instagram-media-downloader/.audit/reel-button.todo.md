- [x] 1. Reproduce it yourself on the matching surface via the driver skill (Non-negotiables), even when a debug or instrumentation protocol says to ask the user to reproduce. Ask the user only with a stated, specific reason the control surface cannot reach the target, and only after driving it as far as it goes. If it won't reproduce directly, synthesize the trigger, tighten conditions, or instrument until it fires.
- [x] 2. Binary-search the cause. Form the candidate hypotheses, then rule them out until one survives. Seed them with `how` over the affected subsystem and the **why** skill for regression history. Each pass, take the split that cuts the most remaining problem space, get runtime evidence, eliminate. When program state is unclear, add instrumentation or logging and read it as the code runs. Don't guess. Drive a long or stubborn hunt with Claude Code's `loop` skill. Confirm the surviving *mechanism* with runtime evidence before the step-3 architect/interrogate fan-out.
- [x] 3. Plan the fix. If it crosses a function boundary, `architect` first. Delegate implementation to a subagent using your configured bug-fix model (default in poteto-mode's Models section) with a specific scope.
- [x] 4. Verify on the same surface. The original repro now passes. "Inconclusive" or wrong-surface is not a pass. Flag it. Unit tests show branch behavior, not bug absence.
- [x] 5. Stage the commits so the failing repro lands before the fix in git history. See the **tdd** skill for the failing-test-first cadence when the bug has a cheap local test path. Skip it when the test would be expensive, integration-heavy, or unclear.
- [x] 6. Run **Opening a PR**.

Throughput checkpoint: reproduce one missing reel button, establish the DOM condition, then verify the same route after the fix.
Git staging and PR steps skip: user prohibits unrequested commits/push/PR work.

修正前の回帰は個別ボタン表示待ちTimeout15000で失敗。修正後は単体28件・隔離ブラウザー36項目成功。独立レビューで具体的不備なし。実Chromeへ反映し、ホームから開く全画面リールの右上個別・右下一括ボタン、MP4の1/1・2.3MB完了、次のリールの右上表示を確認。5/6のgit操作は上記理由でskip。
