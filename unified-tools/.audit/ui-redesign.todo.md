UI data contract: existing MyToolsConfig.modules[] registry; worker my-tools:get/set/export/import remain authoritative. Presentation state uses one selected view (tools|backup|module ID), search query, current worker snapshot and busy status. No extra persistence.
Candidate A: compact popup with two Radix tabs, grouped single-line modules, icon settings button + Radix Switch, module iframe detail; backup isolated into second tab. Candidate B: desktop sidebar + master/detail with persistent iframe. Choose A: all primary actions work in actual 420px popup and options tab without two interaction models. B wastes popup width.
Blocking first steps: inspect registry/RPC and reference sites; confirm dependencies.
Independent workstreams: UI-only delegate in isolated worktree; root owns build integration, tests, docs in main checkout.
Shared mutable state: no concurrent writers per checkout; copy delegate UI files after completion.
Smallest safe decomposition: single UI owner avoids inconsistent DOM/React ownership.
No commit/push/deploy. Kumo and Fluid references inform spacing/grouping. Use Radix Tabs/Switch and Colors plus Lucide; omit Kumo runtime to avoid second primitive framework, icon set, chart/highlighter dependencies. No dnd/resize/Motion/Zustand because current screen doesn't require those behaviors.

- [x] Ground. Confirmed same popup.html URL authorization and registry/RPC ownership; independent reader confirmed contracts.
- [x] Sketch. Compared compact tabs/list against sidebar/detail; chose shared narrow/wide tabs layout.
- [x] Agree. Applied user UI requirements; no additional approval needed.
- [x] Implement. UI delegated in isolated managed worktree, copied after completion, worktree archived. Root integrated build, tests, docs.
- [x] Scrap. n/a: chosen data and RPC contract held; only concrete browser findings were fixed.
- [x] Verify. Clean npm ci, generated build,34 unit tests,20 management/browser checks and21 all-module checks passed. Independent reviewer confirmed license fix and4 build tests.
- [x] Inspect. Viewed real narrow light/dark, wide options and backup screenshots. Fixed Chrome extension body font inheritance below12px. Source uses12/14/20px, Radix palette refs,0.5px borders, no shadow/gradient/transition.
- [x] Delivery. Source and ignored dist/my-tools prepared. No repository commit/push/deploy and no regular Chrome extension reload performed.
