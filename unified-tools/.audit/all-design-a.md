# Candidate A. Registry build with scoped browser capabilities.

Read-only design grounded on 19 manifests in this repository. This extends the existing two-module generated build. It leaves original standalone directories authoritative and gives My Tools one native action, worker, storage origin, and offscreen owner. It does not concatenate worker code without adapters.

## User usage and interface contract

The one native action shows all 19 modules, enabled state, and a Settings/Open action when that module originally had a popup/options page. Detail UI is the original generated module page embedded in the action popup, so active-tab-dependent actions still refer to the web page rather than a newly active extension tab. Birdscore may open its existing dedicated window. Full settings can use a tab. Disabled modules stop new page injections, new user-start operations and autonomous capture, but maintain already accepted downloads, recovery, cancellation, cleanup, and status. Existing pages require reload after toggling. Disable menus and visual badge contributions immediately. No original installed extension is deleted or disabled by build.

All 19 module identities are explicit stable registry records. Names can change, IDs cannot. Registry includes source root, production file allowlist, original manifest, UI entry, message routes/start operations, content-safe storage keys, offscreen entry and side-effect events. Build fails for an unregistered source manifest, duplicate ID, missing asset, unsupported manifest field/API rather than silently omitting a feature. Existing saved two-module settings upgrade by adding default-enabled missing modules. Existing IG/Gofile IDs and namespace mapping remain stable, with a one-time explicit key migration if namespacing those existing keys.

## Proven obstacles

- `unified-tools/build.mjs` currently requires background.js for every module, flat assets without slash, parses importScripts arguments with JSON (single-quoted YouTube/Momoniji scripts fail), and syntax-checks all JS as classic scripts. It cannot include content-only modules, sushida src paths, Momoniji nested root, vendors, or YouTube ES modules as is.
- `instagram-media-downloader/background.js:16` and `youtube-five-second-clip/background.js:10-13` both use session.jobs. Instagram HQ and KLTRA share generic enabled settings in different areas. Sushida settings/results/debugEvents and Birdscore generic caches need namespace isolation.
- `gofile-bulk-video-downloader/background.js:1431`, `page-media-bulk-downloader/background.js:1851`, `momoniji-manga-viewer/extension/background.js:38` restrict the entire shared local area to TRUSTED_CONTEXTS. Google Photos content directly reads/writes local at 544, 664, 724. KLTRA content directly reads local at page.js:195 and observes changes at 200. Removing the restriction would expose recovery records containing media URLs to every content script.
- Three workers create their own offscreen.html. YouTube uses hasDocument; Tweetfile and page-media use getContexts(documentUrls). Their JS defines globals that collide (queue/jobs/running and vendor mux globals). They cannot all be executed in one unisolated window.
- Tweetfile background:55 and page-media background:47 validate Blob URLs with runtime.getURL(''). Actual Blob URL uses extension origin, not modules/id/. Prefixing the empty path breaks saving.
- YouTube accepts unprefixed list/clip/chunk/finish/abort/cancel messages; original IG/Gofile prefix routing is insufficient. KLTRA tab messages also use generic GET_STATUS and TOGGLE_FULLSCREEN.
- Momoniji background:122 hardcodes popup URL pathname '/popup.html'; copying to modules/momoniji/popup.html rejects its own library UI. Replace that comparison with exact runtime.getURL('popup.html') in standalone source, which also works unbundled.
- Momoniji background:146 calls contextMenus.removeAll, which is extension-wide. A scoped wrapper must remove only its own menu IDs. The click handler needs enable-gating because it can start a new save without runtime RPC.
- Momoniji background:172 and page-media background:1709 both register onDeterminingFilename. They all see the same byExtensionId after bundling, and several listeners may call suggest. Native event must have one combined suggestion broker. Download events can occur before downloads.download resolves, explicitly noted in page-media background:814 and Momoniji download-core:297.
- Sushida background:19 autonomously records webRequest before runtime starts. Disabling content scripts alone leaves capture active. Its top-level onInstalled/onStartup initializeStorage and action badge writes also need scoping/gating.
- Birdscore manifest has optional host permissions and Alt+B _execute_action, and popup.js:96 requests permissions. A permission union must preserve optional origins. A single _execute_action cannot retain Birdscore-specific behavior. Register custom birdscore-open with original shortcut and open its module window.
- Inhigh match-links fetches runtime.getURL('data/matches.json'); Sushida content injects runtime.getURL('src/page-bridge.js'). Build must remap web_accessible_resources and maintain relative files in nested directories.

## Data and signatures

```
ModuleSpec = {
 id, name, source, files, uiEntry?, contentRegistrations,
 messagePolicy: { routes, startTypes, allowedContentMatches },
 contentStorage: { local: {read: keys, write: keySchemas}, sync: ... },
 offscreenEntry?, commands?, sideEffectPolicy
}
createModuleChrome(moduleId, contextKind) -> scopedChrome
wrapWorker(moduleSpec, originalSource) -> generatedClassicScript
wrapIsolatedScript(moduleSpec, originalSource) -> generatedClassicScript
wrapExtensionPage(moduleSpec, originalHtml) -> generatedHtmlWithAdapterPrelude
OffscreenHost.ensure(moduleId) -> Promise<void>
OffscreenHost.has(moduleId) -> Promise<boolean>
OffscreenHost.contexts(moduleId, nativeFilter) -> Promise<moduleVirtualContext[]>
StorageBroker.run(authenticatedSender, moduleId, area, op, payload) -> Promise<result>
FilenameBroker.add(moduleId, originalListener) -> void
```

Common settings persist version plus enabled map keyed by stable IDs. Source storage schemas remain unchanged behind scoped adapters. Native storage keys use a literal escaped namespace e.g. my-tools:module:<id>:<originalKey>. Namespaced read accepts native get conventions string, array, null, defaults object. Return keys and onChanged keys are stripped. set/remove/clear/getBytesInUse handle only own keys, with Promise and callback compatibility and native lastError semantics. Storage session similarly scoped. `setAccessLevel` belongs to root and never relaxes trusted local restriction.

Messages use an internal envelope `{toolModule, payload}` only in generated code. Every runtime.sendMessage/tabs.sendMessage and corresponding listener receives adapter wrapping/unwrapping. Wrappers preserve sync false/undefined and sync true async response semantics. Source validators still see original message and real sender. Root validates sender.id plus actual source URL/frame against module registry before routing. Module label alone is never authorization. Native root management is exact root popup URL only. Unprefixed raw messages from unrelated modules never reach workers. getURL(path) prefixes nonempty paths; getURL('') returns native origin for Blob correctness. The adapter is injected before every module extension HTML script and ES module, and lexically supplied to ISOLATED code. MAIN scripts stay in MAIN and never gain chrome APIs. Main bridge event names/globals found in these sources are module-specific; retain unchanged and test coexistence (IG HQ+IG download, X hashtag+Sushida, Inhigh links+skip).

## Shared offscreen host

One native root offscreen.html hosts one extension iframe per active offscreen module. The iframe loads the original generated module offscreen.html, preserving ES module relative imports, mux globals, DOM environment and Blob ownership in separate windows. Root creates it once with BLOBS and records module iframe readiness. Adapter createDocument ignores only the original relative URL after exact manifest validation, asks broker to ensure root plus module iframe, and resolves only after module listener readiness. hasDocument and getContexts report module iframe liveness, not unrelated existing root. Context-query adapters preserve the caller's expected original module URL while using actual root/frame state internally. No root closure while any module frame remains alive. Module release/close affects own frame only. Worker restarts re-query root broker; iframe state persists and heartbeat routes to the correct worker.

Native worker listeners unwrap envelopes and verify sender.url equals the module iframe URL for offscreen traffic. No sender spoofing. Blob URLs remain native origin; signed URL/token validation in source stays in force. Offscreen root and all iframe messages must be generated and tested in real Chrome; iframe availability and sender shape are design assumptions until that test succeeds. If Chrome cannot support this surface, stop and redesign the offscreen host before altering original processors.

## Global events and filename broker

Keep background workers registered synchronously on service-worker evaluation, including disabled modules, to allow recovery. Module adapters gate autonomous side-effect events only (Sushida network capture, context-menu save, fresh UI start messages). Download change, erase, alarms and status handling remain active to settle accepted work. Alarms get namespaced names; callbacks receive original names. Context menus get namespaced IDs, parent IDs and callbacks; removeAll only removes that module's registered IDs. Disabled module menu is hidden/removed and restored from recorded definitions when enabled. Action badge adapters retain per-module contribution; root displays deterministic aggregate and details label it, rather than arbitrary last writer. Other native action mutations are root-owned.

FilenameBroker registers exactly one native onDeterminingFilename handler and invokes module listeners with separate local suggest callbacks. A no-argument suggestion means abstain. Wait for every async-return-true module callback before making one native suggestion. Same nonempty suggestion repeated is accepted once; exactly one nonempty choice is applied; conflicting nonempty suggestions yield a neutral suggestion and an internal visible error, never a race. Bound a hung module and report it. Do not block filename callbacks behind module's start queue, because pending download() may be waiting for filename response. Once download() returns, maintain module ownership map for later changed/erased routing where possible; keep source journal matching as recovery fallback.

## Build contract

Recursive allowlisted assets only, reject traversal/symlinks escaping source. JS wrappers should not regex-rewrite arbitrary chrome tokens. Supply lexical adapter to classic scripts; preload per-window adapter for extension HTML and ESM so original module text remains verbatim. Worker importScripts wrapper resolves validated source-relative paths, retaining any necessary script global exports. Static source files excluded from accidental production e.g. node_modules/tests/test-results/media dumps. Preserve manifest resources exactly with module path prefix, all_frames/world/run_at, required permissions union, optional hosts union minus already required hosts, CSP self, and minimum Chrome max=120. Dist output remains staged and swapped only after successful copy/parse; previous working artifact is retained on failure.

## History/migration

Existing unified export v1 with IG history continues importing. Expanding common export to arbitrary native storage is unsafe: download journals and Birdscore cached HTML/Google Photos album data carry different sensitivity and schemas. Add explicit portable-key/schema contracts per module and own legacy exports where meaningful. Do not export active jobs, signed CDN URLs, raw tokens, download/tab IDs or Blob contents. Document which old settings/history can be migrated and which start fresh. Do not claim all data transferred merely because all modules exist.

## Required verification before completion

1. Inventory exactly 19 source manifests and assert each registry module has generated behavior/UI entry; no silently unsupported field.
2. Classic and ES module graph/import/resource validation and previous-output failure preservation.
3. Storage collisions (IG/YouTube jobs; HQ/KLTRA enabled), defaults-object and callback forms, filtered onChanged, namespace clear, hostile sender cannot obtain Gofile/page-media/Momoniji records.
4. UI entry direct and iframe RPC including Momoniji library list, IG bulk current active tab, Birdscore permission request and own window.
5. Real Chrome simultaneous YouTube, Tweetfile HLS, page-media HLS saving with one offscreen root, separate frames; worker restart, Blob downloads and cancellation.
6. Filename callback one native invocation including pending download-before-ID, async no-op listener, competing claims, unrelated user download.
7. Module disable blocks Sushida webRequest and menu new saves; accepted job completes/cancels; reload removes content injection.
8. Same-site module coexistence and all existing extension tests, especially any local storage direct tests under TRUSTED_CONTEXTS.

Selection rationale. This candidate preserves original worker/page code and the current generated bundle direction. The extra shared APIs correspond to actual Chrome extension-wide resources proven in source, not speculative abstraction. Its main implementation cost is accurate adapter API behavior and offscreen frame proof. A candidate rewriting each module to bespoke integration hooks can avoid general callback/storage adapters, but requires touching and revalidating substantially more original source and makes standalone/unified behavior drift more likely.
