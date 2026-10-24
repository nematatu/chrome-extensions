## Architecture
- [x] Ground
- [x] Sketch
- [x] Agree
- [x] Implement
- [ ] Scrap (only if the design fails)

## Arena
- [x] Frame
- [x] Fan out
- [x] Cross-judge
- [x] Pick
- [x] Graft
- [x] Verify

## Delivery
- [x] Checkpoint all current source and push before changes: 51a3ff47c7083afbb8ca2a4b15afa4e0f36f42c8
- [x] Build one extension from existing Instagram and Gofile sources, preserving standalone editions
- [x] Module toggles, common popup/settings and versioned settings/history export/import
- [x] Protect saved history and keep transient URLs/tokens out of exports
- [x] Test combined downloads, toggles, worker recovery and import/export
- [x] Verify generated extension in browser and document setup/migration/rollback

Throughput checkpoint: load the generated extension, save one Instagram fixture file and one Gofile fixture file, then round-trip safe history/settings before adding migration convenience.

Final verification: 46 combined unit tests + 71 Gofile unit tests, generated extension browser 16 checks, standalone Instagram browser 38 checks. Independent reviewer rechecked both P2 fixes with 30 tests, no remaining findings. User Chrome migration and live-site combined downloads not performed.
