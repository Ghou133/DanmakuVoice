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
`live:{running,connecting,room_id,state,message,received,events,errors,no_voice,audience}`, `live_settings`,
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
| `onboarding.anonymous` | Disabled; all calls fail before network or saved room changes. |
| `doubao.qr.begin` | `{connection_id?:"id"}` omit for setup default |
| `doubao.qr.poll`, `doubao.qr.cancel` | `{}` |
| `onboarding.finish` | `{tts_enabled:true,connect:true}` final user action |
| `onboarding.reset` | `{}` |
| `live.connect` | `{authenticated?:true}` always requires a stored Bilibili session; explicit `false` is rejected. |
| `live.disconnect` | `{}` |
| `live.audience.refresh` | `{}` refresh public contribution rank from page 1; requires an active room session and network access. The main UI no longer offers a refresh control (page 1 polls automatically); the command is retained |
| `live.audience.more` | `{}` request the next public contribution-rank page; same session and network gates. The UI sends it once per page when the list scrolls near its end, never while searching |
| `live.save` | `{room_id:123,authenticated?:true}` local room settings; explicit `false` is rejected. |
| `queue.skip`, `queue.clear`, `queue.stop` | `{}` |
| `queue.jump` | `{id:123}` pending job ID from `queue.pending`; skips the current job and earlier pending jobs, keeps later FIFO order; rejects when the job is no longer pending |
| `bili.logout` | `{confirmed:true}` |

`live.audience` contains `{active,live_status,loading,error,rank_count,rank_count_text,
watched_count,updated_at_ms,users,page,has_more,limit_reached}`. Count fields are
null until received, so unavailable data never becomes a fabricated zero.
`rank_count_text` preserves server caps such as `9999+`; this is the contribution
rank population, not a concurrent viewer count. `watched_count` comes only from
`WATCHED_CHANGE.data.num` and means cumulative reach for this stream; the main UI
does not display it. Heartbeat
popularity and the size of a user list never supply either count.

`active` means a room-reception session is running, not that the room is broadcasting.
`live_status` is read from `room_init`: `0` offline, `1` broadcasting, `2` replaying,
or null before a successful lookup. Offline/replaying rooms produce zero live
viewers and an empty list without requesting the rank endpoint. Unknown status
or a failed lookup stays unavailable; it is never silently converted to zero.
The UI removes the signed-in account from the list and avatars only by an exact,
non-mystery UID match. It subtracts that account once from the displayed count only
when the fetched list confirms its inclusion. A capped count remains a bound
after adjustment (for example, `9999+` becomes `9998+`). Raw platform counts remain
in the snapshot. Anonymous entries, matching names and empty/partial lists do
not authorize an arbitrary subtraction.

Rank users expose `{user_id,user_name,avatar_url,rank,score,guard_level,
medal_name,medal_level,mystery}`. Mystery users never expose a UID or offer voice
binding. Image URLs use the existing Bilibili CDN restriction. Polling begins
with room reception and refreshes page 1 about every 30 seconds; manual requests
are bounded and rate limited, and each page contains at most 50 entries, up to
1,000 displayed users. Failed requests retain the last successful list with an
explicit error and stale-data label. Disconnect cancels in-flight requests and
marks the audience inactive. A new session starts with empty audience data.
These requests use public endpoints without account credentials, and audience
lists are retained in memory only. The UI presents this rank as the viewers
Bilibili confirms are online ("在看"); it does not list chat senders as viewers.

Completed QR polling saves protected credentials locally. Bili completion also
resolves the logged-in account's own room; an account without a room reports an
error with manual UID entry still available. Doubao completion creates a default
voice preset when needed. When `connection_id` is omitted (wizard), it explicitly
selects a Doubao default; settings credential refresh keeps an existing default.
QR status is one of `idle`, `waiting`,
`scanned`, `complete`, `expired`; provider is null, `bilibili`, or `doubao`.
Poll QR at 2.5 seconds only while its screen is active; backend rate-limits polls.
Poll active snapshots at 800 ms, use the existing 5 second quiet-state policy and stop polling while hidden/unfocused; avoid recreating active forms/focus on each poll.
First run starts with a welcome page and then Bilibili QR login; merely opening the welcome page does not request a QR. Anonymous navigation and legacy UID forms are disabled, including after own-room discovery fails. Existing real profiles with no signed-in account return to login rather than starting reception. `--disable-network`
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
master_volume:1,muted:false,onboarding_done:false,broadcaster_uid:null,authenticated:true,
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
| `bili.broadcast.start` | `{confirmed:true,area_id}` | Fetch current desktop version and sign the start request; retain push credentials or show a face-verification QR. With the OBS link on, first start a local OBS when `auto_launch` is on and none runs; after credentials arrive, wait for it, write them to OBS as a custom RTMP service and start streaming: `result:{obs:{outcome:"started"\|"starting"\|"already_streaming",launched}}` or `result:{obs:{error,launched}}` (the room stays open). |
| `bili.broadcast.stop` | `{confirmed:true}` | Close the own room; preserve chat/TTS reception. With the OBS link on, first stop the OBS stream (best effort): `result:{obs:{outcome:"stopped"\|"stopping"\|"not_streaming"}}` or `result:{obs:{error}}`. The UI no longer asks for confirmation; `confirmed:true` stays the IPC contract. |
| `bili.broadcast.credentials` | `{confirmed:true}` | Transient `result:{address,stream_key}` for explicit reveal/copy only. |
| `bili.broadcast.forget` | `{}` | Cancel pending management and clear retained push credentials and face QR; do not close the room. |

OBS link commands (experimental, part of the broadcast console):

| Action | Payload | Result |
| --- | --- | --- |
| `obs.save` | `{settings:{enabled?,host?,port?,auto_launch?,executable?}}` | Merge the given fields into the saved OBS settings and save (host name or IPv4, port 1–65535; `executable` is `null` for the detected installation or an absolute path named `obs64.exe`). Each settings form sends only its own fields. |
| `obs.password` | `{password}` | DPAPI-protect and replace the WebSocket password; `""` removes it. |
| `obs.refresh` | `{}` | Read `{obs_version,websocket_version,streaming}` with the saved connection. Never writes to OBS or changes `config_revision`/global status. Used only by the visible active OBS settings page, at most once per 15 seconds. |
| `obs.test` | `{}` | Read the connection and return the probe result, then schedule existing managed overlay recovery if its local server is enabled. Offline mode rejects it. |
| `obs.bitrate.get` | `{}` | Read the Simple output profile's configured video bitrate; return `{bitrate_kbps,output_mode,editable,outputs_active,reason,min_kbps,max_kbps,applies_next_stream}`. Advanced mode explicitly reports unavailable. |
| `obs.bitrate.set` | `{bitrate_kbps}` | Save an integer 100–100000 Kbps to the current Simple output profile, then verify readback. Allowed during streaming; applies when the encoder starts next time, does not reconfigure the active encoder or stop any output. |
| `overlay.title.save` | `{title}` | Enabled overlay only: save its 1–12 character heading and update connected overlay pages, preserving all other overlay settings and its token. |
| `obs.launch` | `{}` | Local OBS only: start `obs64.exe` if no OBS process runs, wait up to 45 s for its WebSocket, then return the test result plus `launched`. |
| `obs.overlay.add` | `{update_only?:bool}` | Requires the overlay server running. Create or safely update “弹幕姬叠加层” at the OBS base canvas size in the current program scene: `{created,added_to_scene,found,updated,scene,width,height}`. Explicit Add also enables its existing current-scene item. Identical URL/size settings are not written again. `update_only` never creates, adds or enables. |
| `obs.overlay.sync` | `{automatic?:bool}` | Repair only an existing managed browser source's URL/size, with the same result shape. Automatic calls verify persisted local ownership before writing; a superseded instance pauses. Missing source returns `found:false`. Never creates, changes scenes, enables hidden items, launches OBS, or starts/stops output. Observation-only app dispatch keeps failures out of global status. |

The snapshot's `obs` is `{settings:{enabled,host,port,auto_launch,executable},has_password,status,detected,local}` (`detected` is the found obs64.exe path or `null`; `local` is whether the host is this computer); `status` is `{state:"idle"}`,
`{state:"ok",streaming,obs_version?,websocket_version?}` or `{state:"error",message}` from the latest accepted probe or
go-live/end. `idle` means untested, not a failed connection. Its optional `overlay_sync` independently has
`{state:"syncing"|"ready"|"updated"|"missing"|"error"|"paused",message?,page_connected?,refreshed?,reason?}`. Only an existing `browser_source` with a loopback `/overlay` URL and valid local token can be recovered; a conflicting source is never overwritten. Remote OBS cannot use this app's local loopback overlay. Settings/password/endpoint changes cancel old work, and monotonic probe IDs reject late state updates. Source recovery is serialized and bounded at 30 seconds; it is scheduled after server startup/enable/endpoint changes and successful test/launch. The settings page may separately request it after a successful read. Browser `shutdown`/`restart_when_active` options are preserved. The password and stream key never enter snapshots, exports, logs or drafts.

While the overlay is enabled, a process-lifetime recovery task checks missing OBS page connections independently of the foreground settings page. It backs off connection failures, synchronizes only the existing managed source, and can request `refreshnocache` once per missing-connection episode after at least 15 seconds. Refresh requires the existing source to be actively visible; healthy OBS streams are never refreshed. A preview browser does not count as OBS: `overlay.obs_clients` reports actual OBS page streams, while `obs.status.overlay_sync.page_connected` reports their current health. `overlay_sync.refreshed` records a requested browser refresh, not confirmed rendering. Named SSE heartbeats run every 15 seconds; the page rebuilds CLOSED or stalled streams, preserves sequence deduplication, and never reconnects with a revoked token after reset. Automatic source changes stop if persisted overlay ownership has moved to another local app instance.

`received_emotes_error` is `null` or the sanitized current receive-session personal metadata read error. Current-account, current-room platform metadata enriches `live.events[].emotes` before speech rules run, including personal comment markers delivered without native images. The raw message remains unchanged; only exact known markers count toward the standalone Bilibili emote filter. Refresh can add images to retained events without altering past outcomes or requeuing speech. Queue items carry their original `event` for live jobs, and `null` for auditions, so renderers never infer image associations from names or speech text.

The public `broadcast` snapshot has `{room,areas,busy,has_stream_key,face_image,last_session,session_active}`. `room` contains
`{room_id,title,parent_area_id,area_id,live_status,live_since}`; `live_since` is Unix seconds from Bilibili's
`live_time` (UTC+8) while `live_status` is 1, otherwise `null`, and only drives the elapsed-time display; `areas` contains `{id,name,children:[{id,name}]}`.
`last_session` is `null` or `{started_at,observed_started_at,ended_observed_at,messages,seconds}`. Times are Unix seconds;
`started_at` and `seconds` may be `null` when their values cannot be confirmed. Rust stores active observations and the
last completed summary in SQLite, scoped to the authenticated UID and verified own room. Only received packets
attributable to that room contribute to `messages`; this is a local observation, not Bilibili's full historical report.
Reopening the app restores saved observations without inventing a session ending. A newly confirmed offline room can
complete a previously observed active session, but its duration remains unknown if the app did not observe the ending.
The UI renders no previous-session statistics when `last_session` is absent, and omits unknown durations. These records
contain no message text or credentials and are excluded from configuration exports; clearing application data removes them.
Ordinary polling, configuration export and migration never include push credentials. The UI must remove the
credentials command's `result` before accepting the returned snapshot, keep cleartext out of form drafts,
and clear revealed inputs when settings close or the account changes. With
`broadcast_console` on and a signed-in account, the UI refreshes the own room when the main screen or the 开播
settings page is visible and active: once per account and then at most every 60 s; it never refreshes automatically
while a request is busy or the window is in the background. Do not replay start/update/stop after
network failure; refresh public room state before another explicit action. Offline mode rejects network operations.

## Live-room user management

The avatar card reads `bili.moderation.refresh` with `{user_id}` only while `preferences.broadcast_console` is enabled. Both reads and writes require this experimental gate in Rust; enabling just the overlay is insufficient. It resolves the currently selected/reception room, verifies the signed-in account on Bilibili, and checks owner/moderator permissions. The target room is distinct from the own-room broadcast target and account relationship blacklists.

The transient `moderation` snapshot contains `{busy,user_id,room_id,can_moderate,can_blacklist,can_manage_admins,muted,blacklisted,is_admin,message}`. `user_id` is a digit string; missing statuses are `null` and must never be treated as false. Only the owner can appoint/dismiss; ordinary room moderators can mute, and live blacklisting requires the owner or a verified senior moderator. Unknown permissions remain disabled.

| Command | Payload | Result |
|---|---|---|
| `bili.moderation.refresh` | `{user_id}` | Read room permissions and the target's current known statuses; no writes. |
| `bili.moderation.mute` | `{user_id,room_id,hours,confirmed:true}` | Room mute; `0` for this broadcast, `-1` permanent, or `1..720` hours. |
| `bili.moderation.unmute` | `{user_id,room_id,confirmed:true}` | Remove room mute. |
| `bili.moderation.blacklist` / `unblacklist` | `{user_id,room_id,confirmed:true}` | Add/remove the target from the anchor's live blacklist. |
| `bili.moderation.appoint` / `dismiss` | `{user_id,room_id,confirmed:true}` | Appoint an ordinary moderator (`admin_level=1`) or dismiss a moderator, owner only. |

Writes require a matching successful target/room read and recheck server identity and role. No automatic write retries. Disabling the console, logout, account/room changes, data clearing and exit invalidate pending context; invalid/self/anchor UIDs are rejected. Requests and state never export credentials or change local TTS bindings.

## Own-room chat sending

The main-screen composer and every `bili.chat.*` command require a valid QR account and network access, independently of `preferences.broadcast_console` and the OBS overlay. Rust resolves the signed-in account's own room and verifies its owner on every operation; it never trusts the watched room as the send target.

| Command | Payload | Result |
|---|---|---|
| `bili.chat.emoticons.refresh` | `{}` | Read own-room message limit, authenticated personal comment packs, and live packs with current per-item permissions. |
| `bili.chat.send` | `{message,confirmed:true}` | Send one text message, within the platform's current UTF-16 length limit. |
| `bili.chat.emoticon.send` | `{emoticon_unique,confirmed:true}` | Re-read the current account's item and permissions, then send one separate message. Live standalone items use their exact platform token; text items use the original item text. Does not modify the composer draft. |

The transient `chat_send` snapshot is `{busy,account_id,room_id,message_limit,emoticons,warnings,error}`. `account_id` identifies the authenticated account that fetched these packs; a missing or mismatching owner cannot expose cached metadata. Packs contain `{source,name,pkg_type,icon,emoticons:[{emoticon_unique,emoji,url,allowed,kind,text}]}`. `source:"account"` comes first, preserving `/x/emote/user/panel/web?business=reply` package and item order: `name=packages[].text`, `icon=packages[].url`, `pkg_type=packages[].type`, and item `text/url` preserve the original `emote[]` fields. `source:"live"` follows in platform order, using `pkg_name`, `current_cover` and `pkg_type` from `GetEmoticons`. All images pass the existing Bilibili raster-image allowlist.

All cards use `bili.chat.emoticon.send` immediately on selection and leave the composer draft and selection intact. Sending and metadata reads require login and network availability, independently of `broadcast_console`. `kind:"text"` sends the exact original `text` as a separate ordinary message; account image entries still display their pictures. Their `account:{package_id}:{emote_id}` identifier selects the current account item and is never a standalone live send token. The backend freshly reads the personal panel and verifies that item before sending. The official comment component renders returned entries without checking `flags.unlocked`; the app likewise does not disable ordinary text sending based on that unrelated flag. `kind:"emoticon"` uses the live standalone command with a refreshed exact token and permission check. Locked live entries remain disabled. Each pack retains its real name and icon in data and nonvisual accessibility labels. The picker displays only cover/item images, without visible labels, counts, tooltips, or pagination; every item in the selected pack is rendered in one continuous scroll area. Missing covers use the first valid item image or a text-free missing-image graphic. A failed source produces a visible `warnings` entry in the composer status and a text-free picker indicator while retaining the successful source; both sources failing returns an error. Any expired session fails the whole read and invalidates the cached account. Warnings share the account context and cannot survive an account switch.

The composer reads its limit and packs once per logged-in account/room context if no metadata is available. Background/focus updates preserve its nodes and draft; failed metadata reads require an explicit picker refresh. The send POST signs its WBI query with keys from the authenticated nav response and includes CSRF in the form. No unsigned fallback or automatic write retries. Failed sends retain the draft; accepted sends do not create local feed events. Input composition confirmation does not submit. Account/room changes cancel pending work and invalidate cached permissions; toggling broadcast mode preserves the chat context. Stale UI replies cannot replace current identity or clear another draft. State and credentials never enter configuration exports.
