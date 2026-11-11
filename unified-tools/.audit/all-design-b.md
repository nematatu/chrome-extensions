# Candidate B. Source-native feature registration

This is a read-only architecture candidate. No repository source changes were made.

## Grounded scope

There are 19 source manifest.json files excluding generated output and node_modules. They include the nested momoniji-manga-viewer/extension root. Candidate B includes all 19 as registry entries, including content-only modules and popup-only Birdscore. The existing two-entry registry is insufficient.

The user installs one generated manifest and one action popup. The popup lists all 19 independent toggles plus each module's existing settings/status entry. Standalone source extensions keep their existing manifests and standalone entry points.

## Structurally different boundary

Do not generate a generic imitation chrome object and run unchanged backgrounds against it. Convert extension entry points into named feature registration functions which accept the small set of services they actually need. Keep domain engines unchanged. Standalone bootstraps use native services; the unified bootstrap passes scoped services. This costs more source edits but removes hidden behavior changes from object inheritance, property shadowing, sender fabrication and getURL rewriting.

Usage sketch:

```
const instagram = registerInstagram({messages, local, session, alarms, downloads, assets, senderPolicy});
const youtube = registerYouTube({messages, session, downloads, offscreen, assets, senderPolicy});
const momoniji = registerMomoniji({messages, local, menus, badges, alarms, downloads, assets, senderPolicy});
```

Every services object is module-owned. The module code does not receive another module's storage, offscreen endpoint, menu registry, or message listeners.

```
FeatureDefinition = {
  id, sourceRoot, productionFiles, contentScripts, popup?, options?,
  registerBackground?, registerOffscreen?,
  portable: { localKeys, syncKeys, validate, merge },
  capabilities: { messages, downloadStarts, menus, networkObservers }
}
ModuleServices = {
  messages: {listen, sendToWorker, sendToPage},
  storage: {local, sync, session, onChanged},
  assets: {url, origin},
  offscreen: {ensure, request},
  lifecycle: {installed, startup},
  availability: {enabled, guardStart},
  menus: {replaceOwn, onClick},
  badges: {publish}
}
```

The explicit source factories preserve separate browser contexts. Content code remains browser code. Each ISOLATED registration begins with its own module initialization that supplies storage/message helpers; MAIN code is unchanged and receives no extension capability. Existing original HTML popups load a standalone bootstrap, while generated HTML loads a unified module bootstrap before that same popup entry. Dynamic registration keeps original world, timing, order, frames, CSS and URL match patterns.

Do not put module context in one mutable global shared between unrelated scripts. The script's module ID is a literal constant or closure parameter. Instagram HQ and downloader coexist on Instagram; X autofill and Sushida coexist on X.

## Required ownership rules

### Storage

Store namespaced physical keys for local/sync/session, with default-key and get-all semantics implemented in the storage service, and filtered onChanged notifications. Explicitly migrate the current unified Instagram savedMedia and session jobs into its namespace once. Instagram and YouTube both currently use the physical session key jobs. Multiple settings modules use enabled and other generic keys.

Native storage.local remains TRUSTED_CONTEXTS for the entire extension because both Gofile and Momoniji require it. Google Photos and KLTRA content local access must be brokered through the worker. The broker accepts only declared keys, methods, value validation, and exact expected sender hosts/frames. A content request cannot name an arbitrary module or arbitrary storage key. The native sync area can remain directly accessible only if all scoped names and no cross-module reads are safe; a common broker is simpler to audit and keeps one storage interface.

Callback compatibility belongs in standalone bootstrap only where old code uses it; domain modules should use promises after entrypoint conversion. Do not override native Chrome or change global accessLevel per module.

### Messages and sender authorization

Use one envelope {module, type, data} for unified internal transport and dispatch exactly once. Retain original message payload in source handlers. Do not depend only on string prefixes. YouTube listens to generic clip/list/cancel/chunk/finish and replies to unknown messages; it currently threatens every other listener's response.

Sender policy receives the actual sender. Native extension ID remains unchanged. Module popup identity is explicitly configured as native root/modules/id/popup.html; update Momoniji's hard-coded '/popup.html' source check through this policy, rather than rewriting sender.url.

Assets have two separate methods. assets.url(path) resolves module files. assets.origin() returns chrome-extension://ID/. Existing PageMedia and Tweetfile validate blob URLs against native getURL(''); a generic getURL prefix shim would incorrectly reject real blob URLs.

### Offscreen

One top-level generated offscreen.html and one creation promise own native createDocument/getContexts. The offscreen page registers three independent engines via registerOffscreen(services), preserving module-local Maps, conversion imports and libraries. Explicit message envelopes route commands and responses by module. Do not let generic target:'offscreen' handlers see another engine's messages. Blob URLs live at extension origin; source authorization checks use configured common offscreen URL and module token, never a fabricated old path.

Keep shared page alive while any engine has work or unreleased blobs. Do not close it just because one engine becomes idle. Engines have their own per-module cancellation/release. The PageMedia OPFS folder remains its own namespace. A top-level ES module entry imports per-engine modules; classic vendor libraries should load once if identical, or be packaged into explicitly scoped per-engine namespace if not identical. Avoid unverified iframe assumptions.

Official documentation verified 2026-10-23: https://developer.chrome.com/docs/extensions/reference/api/offscreen states that normally one offscreen document can be open, and only runtime is an available extension API within it. It also currently lists offscreen.hasDocument() as Chrome 150+. Use runtime.getContexts, available from 116. Unified minimum is at least 120 due to Momoniji.

### Lifecycle and active work

Keep all worker event listeners installed regardless of toggle so existing download queues finish, cancellation works and recovery is deterministic. Disabled means deny new starts, retries, background network capture, translation and context menu actions, and unregister future content scripts. Existing content UI requires reload and communicates a clear disabled response when clicked.

Sushida's webRequest callback must check enabled before collecting or downloading. Recovery callbacks may initialize storage without creating new work. Momoniji's menu setup uses menus.replaceOwn instead of native removeAll, and disable removes its specific menu IDs. Menu handlers recheck enabled.

Publish badges per module to common badge owner. Avoid native last-writer-wins Momoniji unread/Sushida check badge. A simple aggregate pending/unread count is acceptable if explained in UI; original status screens retain their own detail.

Birdscore Alt+B must become explicit command birdscore-open with handler opening its module window. A merged _execute_action would open the wrong common popup. Preserve Birdscore optional host permissions and gesture-triggered request. Include source WAR entries with prefixed nested assets and unchanged host restrictions.

### Migration

Version 2 backup contains module availability and safe portable module records. Export/import validators are per module, allowlist fields, cap byte size and collection counts at true supported limits. Keep v1 two-module backup accepted and merge only supplied module settings with defaults for newly added modules. Do not require all 19 keys from legacy two-key enabled maps.

Portable examples: Instagram savedMedia, GooglePhotos albums/panel preference, X hashtags, Instagram HQ preference, Inhigh skip options, KLTRA visual/translation preference, R2 preview options, Sushida normalized typing results/settings, Momoniji validated library/read state, Birdscore user preferences. Exclude recovery queues, signed URLs, caches, debug/network raw events, tab/download IDs and raw media. Stateless modules have no portable data. Do not invent a per-module migration exporter unless needed to move existing data. Provide a reviewed migration utility in original extension context for declared safe fields, or integrate an export button into those source popups/options.

## Verification contract

Build discovers manifest roots and fails when registry coverage differs from all 19 expected roots. Copy only explicit production assets including nested src/vendor/data and .mjs without allowing path traversal. Include optional host permissions, commands and WAR, generate minimum Chrome >=120, syntax-check classic and module formats appropriately.

Each feature gets a runnable isolated fixture verifying its visible operation and toggle absence/reload. Tests must also exercise cross-module collisions: concurrent Instagram/YouTube jobs, simultaneous three-engine offscreen tasks, Gofile TRUSTED_CONTEXTS with GooglePhotos/KLTRA settings, Momoniji/Sushida badge interaction, off-state Sushida webRequest, Momoniji context menu, real module popup authorization, actual exported/imported portable records and v1 settings migration. Existing standalone test suites continue to pass.

## Tradeoff and synthesis advice

Candidate B is viable and easier to reason about once complete, but it edits many currently independent entry points and needs broad standalone regression testing. For this repository's immediate goal it likely costs materially more than a bounded generated integration layer. If candidate A wins, graft these explicit boundaries: preserve native extension origin separately from asset base, exact module sender policy, module-prefixed storage with safe local IPC, one owner for offscreen lifecycle, gate non-message lifecycle sources, and per-module backup allowlists. Those are correctness constraints, not optional polish.
