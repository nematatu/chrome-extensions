> Historical two-module architecture. Current all19-module contract is [ALL-MODULES.md](ALL-MODULES.md). The namespace, transport and shared-resource adapters described there supersede this initial design.

# My Tools architecture

Checkpoint before integration: 51a3ff47c7083afbb8ca2a4b15afa4e0f36f42c8, pushed to origin/main.

## Synthesis

Compare /tmp/unified-design-a.md (generated IIFE workers) and /tmp/unified-design-b.md (source worker factories). Choose A, supported by independent cross-judge /tmp/unified-design-verdict.md. It preserves existing standalone directories and tests and avoids moving worker implementations. Adopt B’s explicit privileged history channel. Keep both download engines, no shared download rewrite. No external dependencies. Existing Map media-to-controls shape stays module-owned.

## Files and contracts

- modules.mjs: single registry {id,name,source,files,startTypes,prefix}; reads existing manifests, generates registration descriptors namespaced under modules/<id>/.
- build.mjs: allowlist copy production assets, wrap original background in IIFE with scoped chrome and scoped importScripts resolver, combine manifest, emit dist/my-tools. Stable public key checked in identity.json, no private key. Output generated only.
- runtime.js: trusted settings owner and moduleChrome(id) adapter. Original background listeners are synchronous, module namespaces routed separately, only new starts/retries gated. Both workers always run to recover/complete/cancel active jobs. Own dynamic script registrations reconciled on boot and toggle, preserving MAIN/ISOLATED/world/runAt/file order.
- transfer.js: pure MyToolsTransfer, UMD Node require supported. parseBackup(value) validates complete payload, makeBackup(settings,history) creates only allowlisted fields. Uses IGMediaCore.validateHistory(map). Limits 20 MiB on UI file input and serialized RPC input; durable history has no arbitrary entry-count cutoff. Strict known format/version/keys.
- popup.html/popup.js/popup.css: one common management page used for action popup and options_ui. Accessible checkboxes per module, reload notice, Instagram page-save action, native JSON export/import and result text.
- Instagram source: dedicated ig-download-history getter and no-value history changed notification, IGMediaHistory.read()/merge() queue-owned worker capabilities, safe legacy popup export. Gofile original code stays unchanged.

## State

Store unifiedSettingsV1 = {version:1,enabled:{instagram:boolean,gofile:boolean}} in trusted local storage. Defaults both true. Module storage keys unchanged, all local remains TRUSTED_CONTEXTS. Instagram content uses safe IPC so no trusted storage read needed. Gofile active URLs/queue state and session jobs never exported. Gofile has no durable saved-history feature in this version.

## Management protocol

Accept management messages only exact native root popup.html (also options_ui page), sender.id matching native runtime.id, no tab-origin bypass.

- {type:"my-tools:get"} -> {ok:true,settings,historyCount}
- {type:"my-tools:set",module:"instagram"|"gofile",enabled:boolean} -> {ok:true,settings,historyCount}
- {type:"my-tools:export"} -> {ok:true,backup}
- {type:"my-tools:import",backup:object} -> {ok:true,settings,historyCount}
- errors -> {ok:false,error:Japanese plain string}; report partial history merge if settings application later fails.

Backup = {format:"nematatu-tools",version:1,settings?:{enabled:{instagram:boolean,gofile:boolean}},instagram:{savedMedia:Record<validHistoryKey,positiveTimestamp>}}. Standalone export omits settings. parseBackup returns canonical validated same shape, rejects unknown nested fields/modules/prototype keys, invalid/future timestamp and oversize. makeBackup takes full stored settings (version included) but emits settings.enabled only.

## Toggle and import semantics

Settings reconciler serializes startup and all settings changes. Gate module starts on same settled settings boundary. Only IG ig-download-start and Gofile gofile-bulk:start/retry rejected when disabled; status/cancel/dismiss/pause existing job continue. Already accepted operations may finish. Existing pages require reload to show/remove controls; do not auto-reload user tabs. Pending new starts from stale UI are blocked.

Import validates before any mutation, merges history through IGMediaHistory.merge inside IG run queue, preserving current downloads and newer records. Then optional settings apply via same reconciler. If settings fails after history merged, return clear partial completion/retry-safe error. Never send management messages to own runtime and wait in same queue. Module adapter getURL resolves module resources; root manager validates with unadapted native getURL.

## Verification

Build twice deterministic, only source allowlists, no tests/media secrets bundled, generated JS syntax and manifest refs valid. Run both original suites plus actual generated extension in isolated Chromium. Prove both real Downloads API paths, trusted local denied to content but IG saved button works, toggles/navigation, import/export invalid input no write, merge and worker reload, legacy export round-trip. UI references: Chrome built-in extension manager per https://support.google.com/chrome/answer/2664769?hl=ja and https://developer.chrome.com/docs/extensions/reference/api/storage (label + native checkbox/options pattern). No external service user-count claims.
