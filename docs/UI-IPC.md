# Desktop IPC contract

The bundled frontend calls `window.__TAURI__.core.invoke('snapshot')` and
`invoke('dispatch', { action, payload })`. Polling passes `{ configRevision }`
to `snapshot`: when `config_unchanged` is true, merge the returned dynamic fields
into the prior snapshot with the same `config_revision`. Otherwise replace the
entire snapshot. Late full/delta replies with a lower `config_revision` are ignored;
a newer delta without a matching base triggers full-state recovery. Initial loads,
commands and recovery always request full state.
Snapshots are assembled on a blocking worker instead of the window event thread. Normal actions return the current safe
snapshot; operation-specific data is added as `result`. Rejected commands reject
the promise with a user-facing error. Secrets never occur in a normal snapshot
or export. Credentials are entered or pasted explicitly into the account form.

Window close and tray Exit emit `exit-requested` with `{request_id}` to the local frontend. The frontend
settles pending automatic edits with `flushExitEdits`/`Promise.allSettled`, then calls
`invoke('finish_exit', { saved: true, requestId })` to stop playback and this app's
owned local TTS processes before direct exit. Invalid/failed autosaves do not block
exit, and explicit account/import/manual forms are not automatically submitted.
The native API still accepts `saved: false` to reveal the window, but the current
product frontend does not use it as an exit confirmation or draft-preservation gate.
Only the current request ID is accepted; a stale response cannot acknowledge a later exit.
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
`external.open` accepts `fish_keys`, `fish_discovery`, `project`, `releases`,
`store_updates`, or `update_download` as `page`. Download URLs must match this repository, the checked
semantic version and an uploaded `DanmakuVoice-windows-x64.zip` or legacy `DanmakuVoice.exe` asset; ZIP is preferred. Store installations display the Microsoft Store entry instead of invoking GitHub checks. The system browser
handles downloads; the application never overwrites its running executable.

Snapshot keys: `app_version`, `update_channel:"store"|"github"`, `config_revision`, `config_unchanged`,
`onboarding_done`, `setup:{mode,uid,room_id,tts_enabled}`,
`account:{user_id,name,avatar_url}`, `qr:{provider,status,image_data_url,message}`,
`live:{running,connecting,room_id,state,message,received,events,errors,no_voice}`, `live_settings`,
`queue:{accepting,current,pending,history}`, `connections`, `presets`, `bindings`,
`assets`, `rules`, `preferences`, `devices`, `doubao_voices`,
`fish_audio_settings:{[connection_id]:FishPlaybackSettings}`,
`local_services:{dots,gpt_sovits}` with each service view
`{directory,state,message,owned,manual_stopped}`,
`status:{error,message}`, `data_dir`, `startup_enabled`,
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
| `queue.jump` | `{id:123}` pending job ID from `queue.pending`; skips the current job and earlier pending jobs, keeps later FIFO order; rejects when the job is no longer pending |
| `bili.logout` | `{confirmed:true}` |

Completed QR polling saves protected credentials locally. Bili completion also
resolves the logged-in account's own room; an account without a room reports an
error with manual UID entry still available. Doubao completion creates a default
voice preset when needed. When `connection_id` is omitted (wizard), it explicitly
selects a Doubao default; settings credential refresh keeps an existing default.
QR status is one of `idle`, `waiting`,
`scanned`, `complete`, `expired`; provider is null, `bilibili`, or `doubao`.
Poll QR at 2.5 seconds only while its screen is active; backend rate-limits polls.
Poll active snapshots at 800 ms, use the existing 5 second quiet-state policy and stop polling while hidden/unfocused; avoid recreating active forms/focus on each poll.
First run starts with a welcome page and asks the user to choose QR or anonymous UID; merely opening the app does not request a QR. `--disable-network`
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
| `local_services.check` | `{provider:"dots"\|"gpt_sovits",connection_id?:"id",automatic?:true}` reads service metadata without starting it; targets the displayed connection when supplied; automatic observations preserve unrelated diagnostics |
| `local_services.start` | `{provider:"dots"\|"gpt_sovits",connection_id?:"id"}` starts a configured local service asynchronously; stale requests cannot override a later stop or address change |
| `local_services.stop` | `{provider:"dots"\|"gpt_sovits"}` stops only a process this app started; playback queue must first be idle; live reception may stay connected; automatic restart pauses until explicit start |
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
| `preferences.save` | `{preferences:DesktopPreferences,confirmed?:true,reopen_output?:true}` device change or explicit reopen needs confirmed and stops all jobs; reopening the same device repairs a disconnected stream |
| `devices.refresh` | `{}` |
| `audio.test` | `{}` queues a 600 ms local calibration tone through the bundled FFmpeg and selected output, without a TTS account or network. Uses existing master volume and queue cancellation; muted/zero volume is rejected. Completion or sanitized failure appears in queue history. |
| `startup.set` | `{enabled:true}` |
| `overlay.save` | `{settings:OverlaySettings}` validates and saves the experimental OBS overlay, then starts or stops its loopback server to match `enabled`; the app keeps its own `port` and `token`, whatever the payload carries |
| `overlay.token.reset` | `{}` replaces the overlay token; connected overlay pages receive `reset` and the old address stops working immediately |
| `overlay.test` | `{kind:"danmaku"\|"super_chat"}` sends one clearly marked demo item to connected overlay pages only; it never enters the speech queue. Rejected while the overlay is off |
| `configuration.export` | `{path:"new absolute file path"}` never overwrites |
| `migration.preview` | `{path:"old config.json"}` result is engine LegacyPreview |
| `migration.apply` | `{confirmed:true,options:LegacyImportOptions}` applies the last exact preview, creates backup |
| `migration.cancel` | `{}` |
| `data.clear` | `{confirmed:true}` clears WebView2 profile and managed app data, preserves unknown/external files and returns fresh onboarding |

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
Preferences include `{appearance:"system"|"light"|"dark",language:"zh-CN"|"en",scale:1,output:"default",
master_volume:1,muted:false,onboarding_done:false,broadcaster_uid:null,authenticated:false,
tts_enabled:true,broadcast_console:false}`. `broadcast_console` is the experimental 开播 switch: it only shows the
broadcast console on the main screen and allows the UI's read-only `bili.broadcast.refresh` calls; it changes no reception,
speech or room state. Only specified preference fields are merged into current values.
Missing language defaults to `zh-CN`; unsupported language values are rejected before changing settings.
Changing only language preserves playback, speech templates, names and existing credentials.
The frontend applies the saved language immediately; the host also updates the window title and tray menu.
Changing `tts_enabled` keeps live reception/display; a speech-capable live session switches its speech gate without reconnecting. A receive-only session needs playback initialization when speech is first enabled. The visible chat is carried through required session replacement. Legacy FFmpeg path values are ignored and are absent from snapshots/exports.
`snapshot.overlay` is dynamic: `{settings:OverlaySettings,running,port,url,error,clients:[{width,height}]}`.
`OverlaySettings` is `{enabled:false,style:"card"|"spine",corner:"top_left"|"top_right"|"bottom_left"|"bottom_right",
scale:0.5..2,vignette:0..1,title,tagline,show_danmaku,show_gift,show_super_chat,show_guard,
names:"none"|"special"|"all",merge_duplicates,linger_seconds:3..120,port,token}`. Defaults: spine, top left,
scale 1, vignette 0.6, title `今晚的弹幕`, empty tagline (the page then uses its English default), names `special`,
14 seconds, port 47823. The token is a 32-hex local address secret: it is in the snapshot so the settings page can
copy the address (the page shows it masked) and is excluded from configuration export. `clients` are the browser
sources currently reading the event stream and the canvas size each reported. The overlay page itself is served at
`http://127.0.0.1:{port}/overlay?token=…`; its event stream `/overlay/events` sends `hello`, `config`, `status`,
`item`, `reading`, `clear` and `reset`.
Migration options: `import_rules`, `import_live_settings`, `selected_sound_ids`,
`import_connections`, `import_pending_bindings`, `replace_existing_rules`,
`replace_existing_live_settings`; all false/empty unless explicitly selected.

Broadcast commands (independent of chat reception and OBS media output):

| Action | Payload | Result |
| --- | --- | --- |
| `bili.broadcast.refresh` | `{}` | Resolve the authenticated account's own room and current areas. |
| `bili.broadcast.update` | `{confirmed:true,title,area_id}` | Update the title and valid subcategory on Bilibili. |
| `bili.broadcast.start` | `{confirmed:true,area_id}` | Fetch current desktop version and sign the start request; retain push credentials or show a face-verification QR. |
| `bili.broadcast.stop` | `{confirmed:true}` | Close the own room; preserve chat/TTS reception. |
| `bili.broadcast.credentials` | `{confirmed:true}` | Transient `result:{address,stream_key}` for explicit reveal/copy only. |
| `bili.broadcast.forget` | `{}` | Cancel pending management and clear retained push credentials and face QR; do not close the room. |

The public `broadcast` snapshot has `{room,areas,busy,has_stream_key,face_image}`. `room` contains
`{room_id,title,parent_area_id,area_id,live_status,live_since}`; `live_since` is Unix seconds from Bilibili's
`live_time` (UTC+8) while `live_status` is 1, otherwise `null`, and only drives the elapsed-time display; `areas` contains `{id,name,children:[{id,name}]}`.
Ordinary polling, configuration export and migration never include push credentials. The UI must remove the
credentials command's `result` before accepting the returned snapshot, keep cleartext out of form drafts,
and clear revealed inputs when settings or the main-screen push panel close, or the account changes. With
`broadcast_console` on and a signed-in account, the UI refreshes the own room when the main screen or the 开播
settings page is visible and active: once per account and then at most every 60 s; it never refreshes automatically
while a request is busy or the window is in the background. Do not replay start/update/stop after
network failure; refresh public room state before another explicit action. Offline mode rejects network operations.
