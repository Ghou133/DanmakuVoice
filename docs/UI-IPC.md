# Desktop IPC contract

The bundled frontend calls `window.__TAURI__.core.invoke('snapshot')` and
`invoke('dispatch', { action, payload })`. Polling passes `{ configRevision }`
to `snapshot`: when `config_unchanged` is true, merge the returned dynamic fields
into the prior snapshot with the same `config_revision`. Otherwise replace the
entire snapshot. Initial loads, commands and recovery always request full state.
Snapshots are assembled on a blocking worker instead of the window event thread. Normal actions return the current safe
snapshot; operation-specific data is added as `result`. Rejected commands reject
the promise with a user-facing error. Secrets never occur in a normal snapshot
or export. Credentials are entered or pasted explicitly into the account form.

Window close and tray Exit emit `exit-requested` to the local frontend. The frontend
flushes pending autosaves and calls `invoke('finish_exit', { saved: true })` to stop
playback and this app's owned local TTS processes before exit. Invalid or failed
edits call it with `saved: false`, which reveals the window and retains the draft.
Minimizing or losing focus keeps Rust live/audio work running; window close requests
exit. An already-running external TTS process is never adopted or stopped.

`ui_activity` returns native window activity. `resource-mode` events carry a boolean:
false stops UI polling/animations (not Rust live/audio) while native WebView2 targets
low memory; true restores normal memory and immediate UI refresh. `data.clear`
requires `{confirmed:true}`; the native middleware awaits WebView2 profile clearing
before the engine resets its own managed application data and returns fresh onboarding.
Original reference audio is never deleted, including files selected from an older
build's `references` folder.

`check_update` checks the fixed public GitHub latest-release endpoint on demand,
with a 15 second timeout, 1 MiB metadata limit and 60 second cache. It returns
`{current_version,latest_version,status,release_url,download_url}`; status is
`available`, `up_to_date` or `no_release`. It rejects in offline test mode.
`external.open` accepts `fish_keys`, `fish_discovery`, `project`, `releases`, or
`update_download` as `page`. Download URLs must match this repository, the checked
semantic version and the uploaded `DanmakuVoice.exe` asset. The system browser
handles downloads; the application never overwrites its running executable.

Snapshot keys: `onboarding_done`, `setup:{mode,uid,room_id,tts_enabled}`,
`account:{user_id}`, `qr:{provider,status,image_data_url,message}`,
`live:{running,connecting,room_id,state,message,received,events}`,
`queue:{accepting,current,pending,history}`, `connections`, `presets`, `bindings`,
`assets`, `rules`, `preferences`, `devices`, `doubao_voices`,
`fish_audio_settings:{[connection_id]:FishPlaybackSettings}`,
`local_services:{dots,gpt_sovits}` with each service view
`{directory,state,message,owned,manual_stopped}`,
`status:{error,message}`, `data_dir`, `ffmpeg_path`, `startup_enabled`,
`network_disabled`. `uid` and `room_id` are numbers or null. Chat events use the
engine's serializable `LiveEvent` schema. Only genuine received events are listed.
Queue jobs expose `{id,origin,text,user_name}`; no prepared clients or credentials.
Device entries are `{name,is_default,selection}`; selection is `"default"` or
`{"named":"device name"}`. Binding entries are `{id,binding:VoiceBinding}`.
`VoiceBinding` contains `{platform,user_id?,user_name?,legacy_user_name?,preset_id,enabled}`.
New `user_name` bindings match the displayed name exactly when no UID binding
matches; imported `legacy_user_name` remains pending and never routes audio.
`RuleSet.default_preset_explicitly_cleared` remembers a deliberate empty primary
choice, so adding another connection or voice does not override it.

## First run and normal use

| Action | Payload |
| --- | --- |
| `bili.qr.begin`, `bili.qr.poll`, `bili.qr.cancel` | `{}` |
| `onboarding.anonymous` | `{uid:"123"}` broadcaster UID, resolved to room |
| `doubao.qr.begin` | `{connection_id?:"id"}` omit for setup default |
| `doubao.qr.poll`, `doubao.qr.cancel` | `{}` |
| `onboarding.finish` | `{tts_enabled:true,connect:true}` final user action |
| `onboarding.reset` | `{}` |
| `live.connect` | `{authenticated?:true}` defaults to preferences |
| `live.disconnect` | `{}` |
| `live.save` | `{room_id:123,authenticated:false}` optional manual override |
| `queue.skip`, `queue.clear`, `queue.stop` | `{}` |
| `bili.logout` | `{confirmed:true}` |

Completed QR polling saves protected credentials locally. Bili completion also
resolves the logged-in account's own room; an account without a room reports an
error with manual UID entry still available. Doubao completion creates a default
voice preset when needed. When `connection_id` is omitted (wizard), it explicitly
selects a Doubao default; settings credential refresh keeps an existing default.
QR status is one of `idle`, `waiting`,
`scanned`, `complete`, `expired`; provider is null, `bilibili`, or `doubao`.
Poll QR at 2.5 seconds only while its screen is active; backend rate-limits polls.
Poll snapshots at 800 ms; avoid recreating active forms/focus on each poll.
First run explicitly starts Bili QR, as requested by the user. `--disable-network`
is a test-only process flag: network commands reject with a clear error.

## Settings

| Action | Payload |
| --- | --- |
| `connections.save` | `{connection:ServiceConnection,credential?:"local secret"}` id empty creates; empty credential keeps existing |
| `connections.delete` | `{id,confirmed:true}` |
| `connections.clear_credential` | `{id,confirmed:true}` stops affected playback first |
| `connections.probe` | `{id}` explicit dots health/voices probe; `result` contains response |
| `fish.connect` | `{credential:"API Key",connection_id?:"existing Fish ID"}`; read-only credit verification precedes protected save, result `{id,verified:true}` |
| `fish.voice.lookup` | `{connection_id,id_or_url}` read-only Fish model-title lookup, result `{voice_id,name}` |
| `fish.voice.save` | `{connection_id,id_or_url,name}` saves or updates a voice preset by normalized 32-hex model ID; result `VoicePreset` |
| `fish.voices.restore_builtin` | `{connection_id}` restores missing built-in presets without overwriting custom names; result is the created presets |
| `fish.settings.get` | `{connection_id}` returns `FishPlaybackSettings` |
| `fish.settings.save` | `{connection_id,settings:FishPlaybackSettings}` saves non-secret generation options |
| `presets.save` | `{preset:VoicePreset}` id empty creates |
| `presets.delete` | `{id,confirmed:true}` |
| `presets.default` | `{id:"preset id"}` or `{id:null}`; choosing a preset also clears an earlier deliberate empty choice |
| `local_services.save` | `{provider:"dots"\|"gpt_sovits",directory:"absolute path"}` validates installation; empty directory disables automatic startup |
| `local_services.check` | `{provider:"dots"\|"gpt_sovits"}` probes the local server without starting it |
| `local_services.start` | `{provider:"dots"\|"gpt_sovits"}` starts a configured local service asynchronously |
| `local_services.stop` | `{provider:"dots"\|"gpt_sovits"}` stops only a process this app started; live and playback must first be stopped; automatic restart pauses until explicit start |
| `models.scan` | `{path:"GPT-SoVITS installation"}` returns paired model paths and unmatched issues; read-only |
| `references.save` | `{profile:ReferenceProfile}` remembers an existing original audio path, text and languages; never copies audio |
| `references.list` | `{connection_id:"id"}` returns `{profile}` records |
| `dots.voice.save` | `{preset:VoicePreset,profile:ReferenceProfile,make_preferred?:true}` saves matching dots preset, reference and optional default selection atomically; result `{id}` |
| `bindings.save` | `{id?:"id",binding:VoiceBinding}`; a new binding may use `user_name` without a UID, while imported `legacy_user_name` alone remains pending |
| `bindings.delete` | `{id,confirmed:true}` |
| `rules.save` | `{rules:RuleSet}` |
| `rules.preview` | `{event:LiveEvent}` result `{event,filtered_reason,final_text,parts,voice,pending_legacy_binding}` |
| `audition` | `{preset_id:"stored preset ID",text:"speech text"}` plays that preset; the voice page first calls `presets.default` when a user selects a service or voice, so its audition uses the saved live primary. Legacy `{event:LiveEvent}` is also accepted. This makes a real TTS request and can incur provider charge |
| `assets.import` | `{path:"absolute path",name:"name"}` |
| `assets.replace` | `{id,path:"absolute path",confirmed:true}` |
| `assets.delete` | `{id,confirmed:true}` |
| `preferences.save` | `{preferences:DesktopPreferences,ffmpeg_path?:"path",confirmed?:true}` device/path change needs confirmed, stops all jobs |
| `devices.refresh` | `{}` |
| `audio.test` | `{}` queues a 600 ms local calibration tone through the embedded FFmpeg and selected output, without a TTS account or network. Uses existing master volume and queue cancellation; muted/zero volume is rejected. Completion or sanitized failure appears in queue history. |
| `startup.set` | `{enabled:true}` |
| `configuration.export` | `{path:"new absolute file path"}` never overwrites |
| `migration.preview` | `{path:"old config.json"}` result is engine LegacyPreview |
| `migration.apply` | `{confirmed:true,options:LegacyImportOptions}` applies the last exact preview, creates backup |
| `migration.cancel` | `{}` |

The frontend edits serialized engine models directly. Connection settings use
`{provider:"dots"|"gpt_sovits",endpoint,timeout_secs}` or
`{provider:"doubao"|"fish_audio",timeout_secs}`. Presets include
`{id,name,connection_id,provider,voice_id,speed,volume,sovits:null}`.
`ReferenceProfile` uses `{connection_id,role,audio_path,reference_text,
reference_language,text_language,text_free}`. `audio_path` is the existing,
readable, absolute original file path. Saving never copies it; playback checks it
again and reports a missing/unreadable source. Dots `reference_text` may be empty:
the app-managed dots shim treats that as text-free prompting and does not read a
same-name `.txt`. Its legacy `myvoice` directory is for default voice selection,
not a restriction on absolute custom paths. A separately running dots listener
is Ready only if it reports capability `danmakuvoice-dots-paths-v1` with
`arbitrary_voice_paths:true` and `reference_text_explicit:true`; older dots
listeners cannot be used for these presets. The GPT profile role identifies the
paired model paths and also stores reference/text language codes.

`FishPlaybackSettings` is `{model,latency,volume_db,temperature,top_p,streaming}`;
defaults are `s2.1-pro-free`, `normal`, `0`, `0.7`, `0.7`, and `true`.
`streaming` remains in the stored schema for compatibility, but the UI has no
switch and runtime playback always uses incremental streaming, including when
an older record contains `false`.
The model name does not establish available free credit. `fish.connect` performs
read-only account verification; the API Key is saved only after success under
Windows DPAPI and is absent from snapshots and ordinary configuration exports.
Voice lookup accepts a 32-hex ID or a Fish model page, with no request sent to
the supplied page URL. `configuration.export` uses format version 4 and includes
non-secret `fish_audio_settings` by connection ID and migrated `dots_settings`
by preset ID. Real Fish login, synthesis,
charge behavior, and complete GUI flow have not been validated by offline IPC tests.
Preferences include `{appearance:"system"|"light"|"dark",scale:1,output:"default",
master_volume:1,onboarding_done:false,broadcaster_uid:null,authenticated:false,
tts_enabled:true}`. Only specified preference fields are merged into current values.
Migration options: `import_rules`, `import_live_settings`, `selected_sound_ids`,
`import_connections`, `import_pending_bindings`, `replace_existing_rules`,
`replace_existing_live_settings`; all false/empty unless explicitly selected.
