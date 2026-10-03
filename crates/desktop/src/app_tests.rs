use super::*;

#[tokio::test]
async fn language_change_persists_and_preserves_playback_and_existing_configuration() {
    let (directory, app) = isolated(true);
    app.dispatch(
        "preferences.save",
        json!({"preferences":{"master_volume":0.65,"muted":true,"appearance":"dark"}}),
    )
    .await
    .unwrap();
    let scheduler = scheduler::spawn(Arc::new(WaitingExecutor));
    scheduler.start().await.unwrap();
    app.lock().unwrap().scheduler = Some(scheduler.clone());
    let before = app.snapshot().unwrap();
    assert_eq!(before["preferences"]["language"], "zh-CN");
    let changed = app
        .dispatch("preferences.save", json!({"preferences":{"language":"en"}}))
        .await
        .unwrap();
    assert_eq!(changed["preferences"]["language"], "en");
    for key in ["rules", "presets", "bindings", "queue", "live"] {
        assert_eq!(before[key], changed[key], "{key}");
    }
    assert_eq!(
        changed["preferences"]["master_volume"],
        before["preferences"]["master_volume"]
    );
    assert_eq!(changed["preferences"]["muted"], true);
    assert_eq!(changed["preferences"]["appearance"], "dark");
    assert!(scheduler.state().borrow().accepting);
    assert!(
        app.dispatch("preferences.save", json!({"preferences":{"language":"fr"}}))
            .await
            .is_err()
    );
    assert_eq!(app.snapshot().unwrap()["preferences"]["language"], "en");
    assert!(scheduler.state().borrow().accepting);
    app.stop(true).await.unwrap();
    drop(app);
    let reopened = Application::new(directory.path().to_path_buf(), true).unwrap();
    assert_eq!(
        reopened.snapshot().unwrap()["preferences"]["language"],
        "en"
    );
    let chinese = reopened
        .dispatch(
            "preferences.save",
            json!({"preferences":{"language":"zh-CN"}}),
        )
        .await
        .unwrap();
    assert_eq!(chinese["preferences"]["language"], "zh-CN");
}

#[tokio::test]
async fn command_failure_codes_survive_snapshot_without_overriding_typed_causes() {
    let (_directory, app) = isolated(true);
    let error = app.dispatch("connections.save", json!({"connection":{
        "id":"bad-endpoint","name":"local","settings":{"provider":"dots","endpoint":"not a URL","timeout_secs":30},"has_credential":false
    }})).await.unwrap_err();
    assert!(error.ends_with("[DV-S22]"), "{error}");
    assert!(!error.contains("DV-X08"));
    assert_eq!(app.snapshot().unwrap()["status"]["message"], error);
    let unknown = app
        .dispatch("unknown.operation", json!({}))
        .await
        .unwrap_err();
    assert!(unknown.ends_with("[DV-X00]"));
}

#[tokio::test]
async fn offline_output_test_checks_mute_without_requiring_a_cloud_account() {
    let (_directory, app) = isolated(true);
    app.dispatch("preferences.save", json!({"preferences":{"muted":true}}))
        .await
        .unwrap();
    let error = app.dispatch("audio.test", json!({})).await.unwrap_err();
    assert!(error.contains("取消静音"), "{error}");
    assert!(app.lock().unwrap().store.connections().unwrap().is_empty());
}

#[tokio::test]
#[ignore = "plays a 600 ms local tone on the physical default output; no network or accounts"]
async fn local_output_test_reaches_physical_device_without_cloud_login() {
    let (_directory, app) = isolated(true);
    assert!(danmakuvoice_engine::audio::default_output_available());
    app.dispatch("audio.test", json!({})).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let snapshot = app.snapshot().unwrap();
            if let Some(record) = snapshot["queue"]["history"]
                .as_array()
                .and_then(|rows| rows.last())
            {
                assert_eq!(record["state"], "played", "{record}");
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    app.dispatch("queue.stop", json!({})).await.unwrap();
    assert!(app.lock().unwrap().store.connections().unwrap().is_empty());
}

#[tokio::test]
async fn muting_preserves_volume_and_survives_restart() {
    let (directory, app) = isolated(true);
    app.dispatch(
        "preferences.save",
        json!({"preferences":{"master_volume":0.65}}),
    )
    .await
    .unwrap();
    let snapshot = app
        .dispatch("preferences.save", json!({"preferences":{"muted":true}}))
        .await
        .unwrap();
    assert_eq!(snapshot["preferences"]["muted"], true);
    assert_eq!(app.lock().unwrap().prefs.playback_volume(), 0.0);
    drop(app);
    let reopened = Application::new(directory.path().to_owned(), true).unwrap();
    assert!(reopened.lock().unwrap().prefs.muted);
    assert!((reopened.lock().unwrap().prefs.master_volume - 0.65).abs() < 0.00001);
    reopened
        .dispatch("preferences.save", json!({"preferences":{"muted":false}}))
        .await
        .unwrap();
    assert!((reopened.lock().unwrap().prefs.playback_volume() - 0.65).abs() < 0.00001);
}

#[tokio::test]
async fn polling_omits_unchanged_configuration_and_refreshes_after_edits() {
    let (_directory, app) = isolated(true);
    let full = app.snapshot().unwrap();
    let revision = full["config_revision"].as_u64().unwrap();
    let delta = app.snapshot_since(Some(revision)).unwrap();
    assert_eq!(delta["config_unchanged"], true);
    assert!(delta.get("presets").is_none());
    assert!(delta.get("doubao_voices").is_none());
    let mut merged = full.clone();
    merged
        .as_object_mut()
        .unwrap()
        .extend(delta.as_object().unwrap().clone());
    merged["config_unchanged"] = json!(false);
    assert_eq!(merged, full);
    let full_size = serde_json::to_vec(&full).unwrap().len();
    let delta_size = serde_json::to_vec(&delta).unwrap().len();
    assert!(delta_size < full_size);
    println!("snapshot IPC bytes: full={full_size}, delta={delta_size}");
    app.dispatch(
        "preferences.save",
        json!({"preferences":{"master_volume":0.5}}),
    )
    .await
    .unwrap();
    let changed = app.snapshot_since(Some(revision)).unwrap();
    assert_eq!(changed["config_unchanged"], false);
    assert!(changed.get("presets").is_some());
    assert_eq!(changed["preferences"]["master_volume"], 0.5);
    assert_ne!(changed["config_revision"], revision);
    assert_eq!(
        app.snapshot_since(Some(u64::MAX)).unwrap()["config_unchanged"],
        false
    );
}

#[tokio::test]
async fn runtime_commands_keep_the_configuration_revision_and_error_status_fresh() {
    let (_directory, app) = isolated(true);
    let revision = app.snapshot().unwrap()["config_revision"].as_u64().unwrap();
    for action in [
        "queue.skip",
        "queue.clear",
        "queue.stop",
        "live.disconnect",
        "bili.qr.cancel",
        "doubao.qr.cancel",
        "migration.cancel",
    ] {
        let result = app.dispatch(action, json!({})).await.unwrap();
        assert_eq!(result["config_revision"], revision, "{action}");
        assert_eq!(
            app.snapshot_since(Some(revision)).unwrap()["config_unchanged"],
            true,
            "{action}"
        );
    }
    assert!(app.dispatch("queue.jump", json!({"id":999})).await.is_err());
    let error = app.snapshot_since(Some(revision)).unwrap();
    assert_eq!(error["config_unchanged"], true);
    assert_eq!(error["status"]["error"], true);
    let saved = app
        .dispatch(
            "preferences.save",
            json!({"preferences":{"master_volume":0.45}}),
        )
        .await
        .unwrap();
    assert_ne!(saved["config_revision"], revision);
    assert_eq!(saved["status"]["error"], false);
}

#[tokio::test]
async fn runtime_dispatch_cache_comparison_uses_identical_configuration_and_load() {
    let (_directory, app) = isolated(true);
    app.snapshot().unwrap();
    let repeats = 200;
    // This reproduces the previous unconditional invalidation path while using
    // exactly the same command, configuration, process and build as the cache.
    let previous_start = Instant::now();
    for _ in 0..repeats {
        app.lock().unwrap().config_snapshot = None;
        app.dispatch("queue.skip", json!({})).await.unwrap();
    }
    let previous = previous_start.elapsed();
    let revision = app.snapshot().unwrap()["config_revision"].as_u64().unwrap();
    let cached_start = Instant::now();
    for _ in 0..repeats {
        app.dispatch("queue.skip", json!({})).await.unwrap();
    }
    let cached = cached_start.elapsed();
    assert_eq!(app.snapshot().unwrap()["config_revision"], revision);
    println!(
        "runtime dispatch {repeats} calls: previous invalidation={}us, cache={}us",
        previous.as_micros(),
        cached.as_micros()
    );
}

#[tokio::test]
async fn pending_fish_verification_cannot_restore_credentials_after_a_clear_or_stop() {
    for action in ["connections.clear_credential", "data.clear", "queue.stop"] {
        let (_directory, app) = isolated(false);
        let connection = ServiceConnection {
            id: "review-fish".into(),
            name: "Fish Audio".into(),
            settings: ConnectionSettings::FishAudio { timeout_secs: 30 },
            has_credential: false,
        };
        app.lock()
            .unwrap()
            .store
            .save_connection(&connection)
            .unwrap();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let pending = app.clone();
        let login = tokio::spawn(async move {
            pending
                .connect_fish_with_verify(
                    &mut json!({"connection_id":"review-fish","credential":"sk-test-only-placeholder"}),
                    |_| async move {
                        entered_tx.send(()).unwrap();
                        release_rx.await.unwrap();
                        Ok(())
                    },
                )
                .await
        });
        entered_rx.await.unwrap();
        app.dispatch(action, json!({"id":"review-fish","confirmed":true}))
            .await
            .unwrap();
        release_tx.send(()).unwrap();
        let error = tokio::time::timeout(Duration::from_secs(2), login)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(error.contains("登录已取消"), "{action}: {error}");
        let state = app.lock().unwrap();
        if action == "data.clear" {
            assert!(state.store.connections().unwrap().is_empty());
        } else {
            assert!(
                state
                    .store
                    .connection_credential("review-fish")
                    .unwrap()
                    .is_none(),
                "{action}"
            );
        }
    }
}

#[tokio::test]
async fn rejected_preferences_release_the_reconfiguration_guard() {
    let (_directory, app) = isolated(true);
    assert!(
        app.dispatch("preferences.save", json!({"preferences":{"scale":9}}))
            .await
            .is_err()
    );
    assert!(!app.lock().unwrap().reconfiguring);
    let saved = app
        .dispatch(
            "preferences.save",
            json!({"preferences":{"master_volume":0.35}}),
        )
        .await
        .unwrap();
    assert_eq!(saved["preferences"]["master_volume"], 0.35_f32 as f64);
}

#[tokio::test]
async fn startup_listener_skips_incomplete_and_offline_profiles() {
    for disabled in [false, true] {
        let (_directory, app) = isolated(disabled);
        app.auto_connect_saved_room().await;
        assert!(app.lock().unwrap().startup_connection_attempted);
        assert!(
            !app.snapshot().unwrap()["status"]["error"]
                .as_bool()
                .unwrap()
        );
        assert!(!app.lock().unwrap().connecting);
        assert!(app.lock().unwrap().live.is_none());
    }
    let (_directory, app) = isolated(true);
    {
        let mut state = app.lock().unwrap();
        state.prefs.onboarding_done = true;
        let mut live = state.store.load_live_settings().unwrap();
        live.room_id = Some(123);
        state.store.save_live_settings(&live).unwrap();
    }
    app.auto_connect_saved_room().await;
    assert!(app.lock().unwrap().live.is_none());
    assert!(!app.lock().unwrap().status_error);
}

#[tokio::test]
async fn startup_listener_attempts_once_and_exposes_validation_failure_without_network() {
    let (_directory, app) = isolated(false);
    {
        let mut state = app.lock().unwrap();
        state.prefs.onboarding_done = true;
        state.prefs.authenticated = true;
        let mut live = state.store.load_live_settings().unwrap();
        live.room_id = Some(123);
        state.store.save_live_settings(&live).unwrap();
    }
    // Missing credentials fail before any request, audio device or service startup.
    app.auto_connect_saved_room().await;
    assert!(
        app.snapshot().unwrap()["status"]["message"]
            .as_str()
            .unwrap()
            .contains("自动连接")
    );
    app.lock().unwrap().status.clear();
    app.auto_connect_saved_room().await;
    assert!(app.lock().unwrap().status.is_empty());
    assert!(app.lock().unwrap().live.is_none());
}

#[tokio::test]
async fn startup_listener_yields_to_an_explicit_stop_while_waiting_for_the_activity_gate() {
    let (_directory, app) = isolated(false);
    let gate = {
        let mut state = app.lock().unwrap();
        state.prefs.onboarding_done = true;
        state.prefs.authenticated = true;
        let mut live = state.store.load_live_settings().unwrap();
        live.room_id = Some(123);
        state.store.save_live_settings(&live).unwrap();
        state.activity_gate.clone()
    };
    let guard = gate.lock().await;
    let starting = app.clone();
    let task = tokio::spawn(async move { starting.auto_connect_saved_room().await });
    tokio::time::timeout(Duration::from_secs(2), async {
        while !app.lock().unwrap().startup_connection_attempted {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    app.lock().unwrap().explicit_stop_epoch += 1;
    drop(guard);
    task.await.unwrap();
    assert!(app.lock().unwrap().live.is_none());
    assert!(!app.lock().unwrap().status_error);
}
use danmakuvoice_engine::scheduler::{JobExecutor, JobState};
use tempfile::TempDir;

#[test]
fn default_data_directory_is_windows_appdata() {
    assert!(LaunchOptions::parse([OsString::from("--disable-network")]).is_err());
    match std::env::var_os("LOCALAPPDATA") {
        Some(path) => {
            let options = LaunchOptions::parse([]).unwrap();
            assert_eq!(options.data_dir, PathBuf::from(path).join("DanmakuVoice"));
            assert!(!options.disable_network);
        }
        None => assert!(LaunchOptions::parse([]).is_err()),
    }
}

fn install_profile_session(app: &Application) {
    let session = BiliSession::from_secret_payload(
        br#"{"user_id":42,"sessdata":"profile-fixture-secret","bili_jct":"csrf"}"#,
    )
    .unwrap();
    let mut state = app.lock().unwrap();
    state.store.save_bili_session(&session).unwrap();
    state.bili_user_id = Some(42);
}

fn profile_fixture() -> BiliAccountProfile {
    BiliAccountProfile {
        user_id: 42,
        name: "测试昵称".into(),
        avatar_url: Some("https://i0.hdslb.com/bfs/face/profile.jpg".into()),
    }
}

#[tokio::test]
async fn display_identity_is_cached_with_session_and_cleared_on_logout() {
    let (directory, app) = isolated(false);
    install_profile_session(&app);
    app.refresh_bili_profile_with(|_| async { Ok(profile_fixture()) })
        .await
        .unwrap();
    let reopened = Application::new(directory.path().to_owned(), false).unwrap();
    let snapshot = reopened.snapshot().unwrap();
    assert_eq!(snapshot["account"]["name"], "测试昵称");
    assert_eq!(
        snapshot["account"]["avatar_url"],
        "https://i0.hdslb.com/bfs/face/profile.jpg"
    );
    assert!(!snapshot.to_string().contains("profile-fixture-secret"));
    reopened
        .refresh_bili_profile_with(|_| async { Err("temporary network failure".into()) })
        .await
        .unwrap_err();
    assert_eq!(reopened.snapshot().unwrap()["account"]["name"], "测试昵称");
    reopened
        .dispatch("bili.logout", json!({"confirmed":true}))
        .await
        .unwrap();
    assert!(reopened.snapshot().unwrap()["account"]["name"].is_null());
    assert!(
        Application::new(directory.path().to_owned(), false)
            .unwrap()
            .snapshot()
            .unwrap()["account"]["user_id"]
            .is_null()
    );
}

#[tokio::test]
async fn late_identity_reply_cannot_restore_a_logged_out_account() {
    let (_directory, app) = isolated(false);
    install_profile_session(&app);
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = tokio::sync::oneshot::channel();
    let cloned = app.clone();
    let task = tokio::spawn(async move {
        cloned
            .refresh_bili_profile_with(|_| async move {
                let _ = started.send(());
                let _ = wait.await;
                Ok(profile_fixture())
            })
            .await
    });
    ready.await.unwrap();
    app.dispatch("bili.logout", json!({"confirmed":true}))
        .await
        .unwrap();
    let _ = release.send(());
    task.await.unwrap().unwrap();
    assert!(app.snapshot().unwrap()["account"]["name"].is_null());
    assert!(
        app.lock()
            .unwrap()
            .store
            .load_bili_session()
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn offline_profile_does_not_fetch_identity_or_register_startup() {
    let (_directory, app) = isolated(true);
    install_profile_session(&app);
    app.refresh_bili_profile_with(|_| async { panic!("offline identity request") })
        .await
        .unwrap();
    assert!(
        app.dispatch("startup.set", json!({"enabled":true}))
            .await
            .unwrap_err()
            .contains("离线测试")
    );
}

#[tokio::test]
async fn clear_data_requires_confirmation_and_preserves_unrelated_files() {
    let (directory, app) = isolated(false);
    save_test_voice(&app).await;
    app.dispatch("live.save", json!({"room_id":123,"authenticated":false}))
        .await
        .unwrap();
    app.dispatch(
        "onboarding.finish",
        json!({"tts_enabled":false,"connect":false}),
    )
    .await
    .unwrap();
    let source_directory = tempfile::tempdir().unwrap();
    let source = source_directory.path().join("original.wav");
    std::fs::write(&source, b"RIFF test-only fixture").unwrap();
    let (asset_path, orphan_path, backup) = {
        let mut state = app.lock().unwrap();
        let asset = state.store.import_asset(&source, "sound").unwrap();
        let orphan = state.store.asset_path(&asset.id).unwrap();
        state.store.replace_asset(&asset.id, &source).unwrap();
        let asset = state.store.asset_path(&asset.id).unwrap();
        let backup = state.store.backup_before_legacy_import().unwrap();
        (asset, orphan, backup)
    };
    std::fs::create_dir_all(directory.path().join("logs")).unwrap();
    std::fs::create_dir_all(directory.path().join("webview")).unwrap();
    let sentinels = [
        "keep.txt",
        "assets/my-sound.wav",
        "backups/personal.sqlite3",
        "cache/ffmpeg/keep.txt",
        "logs/keep.txt",
        "webview/profile-cache",
    ];
    for name in sentinels {
        std::fs::write(directory.path().join(name), b"unrelated user data").unwrap();
    }
    std::fs::write(
        directory.path().join("logs/previous-1.jsonl"),
        b"test old log",
    )
    .unwrap();
    std::fs::write(directory.path().join("desktop-paths.json"), b"{}").unwrap();
    let scheduler = scheduler::spawn(Arc::new(WaitingExecutor));
    app.lock().unwrap().scheduler = Some(scheduler.clone());
    app.dispatch(
        "audition",
        json!({"event":LiveEvent::danmaku(123, Some(77), "Tester", "reset fixture")}),
    )
    .await
    .unwrap();
    let cancel = app.lock().unwrap().begin_qr("bilibili").1;
    assert!(app.dispatch("data.clear", json!({})).await.is_err());
    assert!(scheduler.state().borrow().current.is_some());
    assert!(backup.exists());
    assert!(!cancel.is_cancelled());
    let result = app
        .dispatch("data.clear", json!({"confirmed":true}))
        .await
        .unwrap();
    assert!(cancel.is_cancelled());
    assert!(!scheduler.state().borrow().accepting);
    assert!(scheduler.state().borrow().current.is_none());
    assert_eq!(result["onboarding_done"], false);
    assert!(result["setup"]["room_id"].is_null());
    assert!(result["connections"].as_array().unwrap().is_empty());
    assert!(result["presets"].as_array().unwrap().is_empty());
    assert!(result["assets"].as_array().unwrap().is_empty());
    assert!(app.lock().unwrap().scheduler.is_none());
    for path in [
        asset_path,
        orphan_path,
        backup,
        embedded_ffmpeg::path(directory.path()),
        directory.path().join("desktop-paths.json"),
        directory.path().join("logs/previous-1.jsonl"),
    ] {
        assert!(!path.exists(), "managed path remained: {}", path.display());
    }
    for name in sentinels {
        assert_eq!(
            std::fs::read(directory.path().join(name)).unwrap(),
            b"unrelated user data"
        );
    }
    assert_eq!(std::fs::read(source).unwrap(), b"RIFF test-only fixture");
    drop(app);
    let reopened = Application::new(directory.path().to_owned(), true)
        .unwrap()
        .snapshot()
        .unwrap();
    assert_eq!(reopened["onboarding_done"], false);
    assert!(reopened["connections"].as_array().unwrap().is_empty());
    assert!(reopened["rules"]["default_preset_id"].is_null());
}

#[tokio::test]
async fn reset_rejects_unsafe_managed_entries_before_wiping_settings() {
    let (directory, app) = isolated(true);
    save_test_voice(&app).await;
    // A directory under an application-owned filename must never be recursed.
    let path = directory.path().join("backups").join(format!(
        "before-legacy-import-123-{}.sqlite3",
        Uuid::new_v4()
    ));
    std::fs::create_dir(&path).unwrap();
    std::fs::write(path.join("keep.txt"), b"must survive").unwrap();
    assert!(
        app.dispatch("data.clear", json!({"confirmed":true}))
            .await
            .is_err()
    );
    assert_eq!(
        app.snapshot().unwrap()["connections"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        std::fs::read(path.join("keep.txt")).unwrap(),
        b"must survive"
    );
    let outside = tempfile::tempdir().unwrap();
    let outside_file = outside.path().join("keep.txt");
    std::fs::write(&outside_file, b"outside").unwrap();
    assert!(
        checked_data_entry(
            &outside_file,
            &directory.path().canonicalize().unwrap(),
            false
        )
        .is_err()
    );
}

fn isolated(disable_network: bool) -> (TempDir, Application) {
    let directory = tempfile::tempdir().expect("temporary data directory");
    let app = Application::new(directory.path().to_owned(), disable_network).unwrap();
    (directory, app)
}

const GPT_STANDARD_SCHEMA: &str = r#"{"paths":{"/tts":{"post":{}},"/set_gpt_weights":{"get":{}},"/set_sovits_weights":{"get":{}}}}"#;
const GPT_ATOMIC_STATUS: &str =
    r#"{"protocol":1,"atomic_model_selection":true,"resident_model_reuse":true}"#;

// Test-only HTTP listeners: random ports, GET metadata only, no model process.
async fn gpt_status_server(
    atomic: bool,
    gate: Option<tokio::sync::oneshot::Receiver<()>>,
    seen: Option<tokio::sync::oneshot::Sender<()>>,
) -> (String, tokio::task::JoinHandle<()>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let mut gate = gate;
        let mut seen = seen;
        let mut responses = 0;
        while responses < if atomic { 1 } else { 2 } {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            let size = socket.read(&mut request).await.unwrap();
            if size == 0 {
                continue; // TCP occupation check.
            }
            let request = String::from_utf8_lossy(&request[..size]);
            assert!(
                request.starts_with("GET "),
                "metadata probe mutated the service"
            );
            if let Some(seen) = seen.take() {
                seen.send(()).unwrap();
            }
            if let Some(gate) = gate.take() {
                gate.await.unwrap();
            }
            let (status, body) = if request.starts_with("GET /kinoko/status ") {
                if atomic {
                    ("200 OK", GPT_ATOMIC_STATUS)
                } else {
                    ("404 Not Found", "{}")
                }
            } else {
                assert!(!atomic, "atomic identity must not require OpenAPI");
                assert!(request.starts_with("GET /openapi.json "));
                ("200 OK", GPT_STANDARD_SCHEMA)
            };
            let response = format!(
                "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
            responses += 1;
        }
    });
    (endpoint, task)
}

async fn save_gpt_connection(app: &Application, endpoint: &str) {
    app.dispatch(
        "connections.save",
        json!({"connection": {
            "id":"gpt-status", "name":"GPT test", "settings": {
                "provider":"gpt_sovits", "endpoint":endpoint, "timeout_secs":30
            }, "has_credential":false
        }}),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn local_service_stop_checks_queue_and_ownership_while_room_connects() {
    let (_directory, app) = isolated(true);
    app.lock().unwrap().connecting = true;
    for provider in ["dots", "gpt_sovits"] {
        let error = app
            .dispatch("local_services.stop", json!({"provider":provider}))
            .await
            .unwrap_err();
        assert!(error.contains("此服务不是本应用启动"), "{error}");
        assert!(app.lock().unwrap().connecting);
    }

    let scheduler = scheduler::spawn(Arc::new(WaitingExecutor));
    scheduler.start().await.unwrap();
    let preview = danmakuvoice_engine::rules::RulePreview::voice_audition(
        VoicePreset {
            id: "stop-service-test".into(),
            name: "Test".into(),
            connection_id: "dots".into(),
            provider: Provider::Dots,
            voice_id: "test".into(),
            speed: 1.0,
            volume: 1.0,
            sovits: None,
        },
        "test",
    )
    .unwrap();
    scheduler
        .submit(preview, scheduler::JobOrigin::Audition)
        .await
        .unwrap();
    app.lock().unwrap().scheduler = Some(scheduler.clone());
    let error = app
        .dispatch("local_services.stop", json!({"provider":"dots"}))
        .await
        .unwrap_err();
    assert!(
        error.contains("请先等待播报队列结束或停止全部播报"),
        "{error}"
    );
    scheduler.stop_all().await.unwrap();
}

#[tokio::test]
async fn gpt_external_start_refresh_and_stop_are_observed_without_ownership() {
    let (_directory, app) = isolated(false);
    for atomic in [false, true] {
        let (endpoint, server) = gpt_status_server(atomic, None, None).await;
        save_gpt_connection(&app, &endpoint).await;
        let before = app.snapshot().unwrap();
        assert_eq!(before["local_services"]["gpt_sovits"]["state"], "unknown");
        let ready = app
            .dispatch("local_services.check", json!({"provider":"gpt_sovits"}))
            .await
            .unwrap();
        assert_eq!(ready["local_services"]["gpt_sovits"]["state"], "ready");
        assert_eq!(ready["local_services"]["gpt_sovits"]["endpoint"], endpoint);
        assert_eq!(ready["local_services"]["gpt_sovits"]["owned"], false);
        server.await.unwrap();
        let stopped = app
            .dispatch("local_services.check", json!({"provider":"gpt_sovits"}))
            .await
            .unwrap();
        assert_eq!(stopped["local_services"]["gpt_sovits"]["state"], "stopped");
        assert!(
            app.dispatch("local_services.stop", json!({"provider":"gpt_sovits"}))
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn gpt_late_probe_cannot_overwrite_changed_endpoint_or_manual_stop() {
    for change_address in [true, false] {
        let (_directory, app) = isolated(false);
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let (seen_tx, seen_rx) = tokio::sync::oneshot::channel();
        let (endpoint, server) = gpt_status_server(true, Some(release_rx), Some(seen_tx)).await;
        save_gpt_connection(&app, &endpoint).await;
        let checking_app = app.clone();
        let check = tokio::spawn(async move {
            checking_app
                .dispatch("local_services.check", json!({"provider":"gpt_sovits"}))
                .await
                .unwrap()
        });
        seen_rx.await.unwrap();
        if change_address {
            save_gpt_connection(&app, "http://127.0.0.1:9").await;
        } else {
            // Emulate a lifecycle transition without starting/stopping a process.
            app.lock().unwrap().local_services.gpt_sovits.stop_manual();
        }
        release_tx.send(()).unwrap();
        let result = check.await.unwrap();
        assert_eq!(
            result["local_services"]["gpt_sovits"]["state"],
            if change_address { "unknown" } else { "stopped" }
        );
        server.await.unwrap();
    }
}

#[tokio::test]
async fn gpt_explicit_start_rechecks_external_service_and_stale_start_never_runs() {
    let (_directory, app) = isolated(false);
    let (endpoint, server) = gpt_status_server(true, None, None).await;
    save_gpt_connection(&app, &endpoint).await;
    app.dispatch("local_services.start", json!({"provider":"gpt_sovits"}))
        .await
        .unwrap();
    server.await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while app.snapshot().unwrap()["local_services"]["gpt_sovits"]["state"] != "ready" {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        app.snapshot().unwrap()["local_services"]["gpt_sovits"]["owned"],
        false
    );
    let old_generation = app.lock().unwrap().local_services.gpt_sovits.generation;
    app.lock().unwrap().local_services.gpt_sovits.stop_manual();
    app.ensure_local_service(Kind::GptSovits, &endpoint, false, Some(old_generation))
        .await;
    assert_eq!(
        app.snapshot().unwrap()["local_services"]["gpt_sovits"]["state"],
        "stopped"
    );
}

#[tokio::test]
async fn gpt_probe_timeout_is_unknown_and_never_launches_or_adopts_listener() {
    let (_directory, app) = isolated(false);
    let (_release_tx, release_rx) = tokio::sync::oneshot::channel();
    let (endpoint, server) = gpt_status_server(true, Some(release_rx), None).await;
    save_gpt_connection(&app, &endpoint).await;
    let result = app
        .dispatch("local_services.check", json!({"provider":"gpt_sovits"}))
        .await
        .unwrap();
    assert_eq!(result["local_services"]["gpt_sovits"]["state"], "unknown");
    assert!(
        result["local_services"]["gpt_sovits"]["message"]
            .as_str()
            .unwrap()
            .contains("超时")
    );
    assert_eq!(result["local_services"]["gpt_sovits"]["owned"], false);
    server.abort();
}

#[tokio::test]
async fn gpt_older_observation_cannot_replace_newer_ready_result() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (_directory, app) = isolated(false);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (seen_tx, seen_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let mut requests = 0;
        let mut first = None;
        let mut seen_tx = Some(seen_tx);
        let mut release_rx = Some(release_rx);
        while requests < 2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let size = socket.read(&mut request).await.unwrap();
            if size == 0 {
                continue;
            }
            assert!(request[..size].starts_with(b"GET /kinoko/status "));
            if requests == 0 {
                let release = release_rx.take().unwrap();
                first = Some(tokio::spawn(async move {
                    release.await.unwrap();
                    socket
                        .write_all(
                            b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 2\r\n\r\n{}",
                        )
                        .await
                        .unwrap();
                }));
                seen_tx.take().unwrap().send(()).unwrap();
            } else {
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{GPT_ATOMIC_STATUS}",
                    GPT_ATOMIC_STATUS.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
            requests += 1;
        }
        first.unwrap().await.unwrap();
    });
    save_gpt_connection(&app, &endpoint).await;
    let old_app = app.clone();
    let old_check = tokio::spawn(async move {
        old_app
            .dispatch("local_services.check", json!({"provider":"gpt_sovits"}))
            .await
            .unwrap()
    });
    seen_rx.await.unwrap();
    let newest = app
        .dispatch("local_services.check", json!({"provider":"gpt_sovits"}))
        .await
        .unwrap();
    assert_eq!(newest["local_services"]["gpt_sovits"]["state"], "ready");
    release_tx.send(()).unwrap();
    let old_result = old_check.await.unwrap();
    assert_eq!(old_result["local_services"]["gpt_sovits"]["state"], "ready");
    server.await.unwrap();
}

#[tokio::test]
async fn automatic_local_observations_preserve_unrelated_diagnostics() {
    let (_directory, app) = isolated(false);
    let (endpoint, server) = gpt_status_server(true, None, None).await;
    save_gpt_connection(&app, &endpoint).await;
    app.dispatch("unknown.operation", json!({}))
        .await
        .unwrap_err();
    let previous = app.snapshot().unwrap()["status"].clone();
    app.dispatch(
        "local_services.check",
        json!({"provider":"gpt_sovits", "connection_id":"missing", "automatic":true}),
    )
    .await
    .unwrap_err();
    assert_eq!(app.snapshot().unwrap()["status"], previous);
    let ready = app
        .dispatch(
            "local_services.check",
            json!({"provider":"gpt_sovits", "automatic":true}),
        )
        .await
        .unwrap();
    assert_eq!(ready["local_services"]["gpt_sovits"]["state"], "ready");
    assert_eq!(ready["status"], previous);
    server.await.unwrap();
}

async fn save_test_voice(app: &Application) {
    app.dispatch("connections.save", json!({"connection":{"id":"local","name":"Local","settings":{"provider":"dots","endpoint":"http://127.0.0.1:9881","timeout_secs":180},"has_credential":false}})).await.unwrap();
    app.dispatch("presets.save", json!({"preset":{"id":"voice","name":"Voice","connection_id":"local","provider":"dots","voice_id":"reference.wav","speed":1.0,"volume":1.0,"sovits":null}})).await.unwrap();
    app.dispatch("presets.default", json!({"id":"voice"}))
        .await
        .unwrap();
}

#[tokio::test]
async fn desktop_commands_scan_and_remember_reference_original_path() {
    let (directory, app) = isolated(true);
    save_test_voice(&app).await;
    let installation = directory.path().join("GPT-SoVITS");
    std::fs::create_dir_all(installation.join("GPT_weights_v4")).unwrap();
    std::fs::create_dir_all(installation.join("SoVITS_weights_v4")).unwrap();
    std::fs::write(installation.join("api_v2.py"), b"").unwrap();
    std::fs::write(installation.join("GPT_weights_v4/Alice-e4.ckpt"), b"").unwrap();
    std::fs::write(installation.join("SoVITS_weights_v4/Alice-e4_s9.pth"), b"").unwrap();
    let scan = app
        .dispatch("models.scan", json!({"path":installation}))
        .await
        .unwrap();
    assert_eq!(scan["result"]["pairs"].as_array().unwrap().len(), 1);

    let source = directory.path().join("reference.wav");
    std::fs::write(&source, b"RIFF local reference fixture").unwrap();
    app.dispatch(
        "references.save",
        json!({"profile":{
            "connection_id":"local", "role":{"kind":"dots","role":"reference.wav"},
            "audio_path":source, "reference_text":"示例原文",
            "reference_language":"", "text_language":"", "text_free":false
        }}),
    )
    .await
    .unwrap();
    let listed = app
        .dispatch("references.list", json!({"connection_id":"local"}))
        .await
        .unwrap();
    assert_eq!(listed["result"][0]["profile"]["reference_text"], "示例原文");
    assert_eq!(
        listed["result"][0]["profile"]["audio_path"],
        source.to_string_lossy().as_ref()
    );
    assert!(source.is_file());
    assert!(!directory.path().join("references").exists());
    std::fs::remove_file(&source).unwrap();
    assert!(
        app.dispatch(
            "references.save",
            json!({"profile":{
                "connection_id":"local", "role":{"kind":"dots","role":"reference.wav"},
                "audio_path":source, "reference_text":"示例原文",
                "reference_language":"", "text_language":"", "text_free":false
            }})
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn sound_only_setup_does_not_require_a_default_tts_preset() {
    let (directory, app) = isolated(true);
    let source = directory.path().join("effect.wav");
    std::fs::write(&source, b"RIFF test-only sound fixture").unwrap();
    {
        let mut state = app.lock().unwrap();
        assert!(state.validate_default_voice().is_err());
        let asset = state.store.import_asset(&source, "effect").unwrap();
        let mut rules = state.store.load_rules().unwrap();
        rules.sounds.push(danmakuvoice_engine::rules::SoundRule {
            trigger: "ding".into(),
            asset_id: asset.id,
        });
        state.store.save_rules(&rules).unwrap();
        assert!(state.validate_default_voice().is_ok());
    }
    app.dispatch("live.save", json!({"room_id":123,"authenticated":false}))
        .await
        .unwrap();
    let snapshot = app
        .dispatch(
            "onboarding.finish",
            json!({"tts_enabled":true,"connect":false}),
        )
        .await
        .unwrap();
    assert_eq!(snapshot["onboarding_done"], true);
    assert_eq!(snapshot["preferences"]["tts_enabled"], true);
    assert!(snapshot["rules"]["default_preset_id"].is_null());
}

#[tokio::test]
async fn failed_first_connection_keeps_onboarding_pending_until_finish_succeeds() {
    let (directory, app) = isolated(true);
    app.dispatch("live.save", json!({"room_id":123,"authenticated":false}))
        .await
        .unwrap();

    let error = app
        .dispatch(
            "onboarding.finish",
            json!({"tts_enabled":false,"connect":true}),
        )
        .await
        .unwrap_err();
    assert!(error.contains("离线测试窗口"), "{error}");
    let pending = app.snapshot().unwrap();
    assert_eq!(pending["onboarding_done"], false);
    assert_eq!(pending["preferences"]["tts_enabled"], false);
    assert_eq!(pending["setup"]["room_id"], 123);

    drop(app);
    let reopened = Application::new(directory.path().to_owned(), true).unwrap();
    assert_eq!(reopened.snapshot().unwrap()["onboarding_done"], false);
    let completed = reopened
        .dispatch(
            "onboarding.finish",
            json!({"tts_enabled":false,"connect":false}),
        )
        .await
        .unwrap();
    assert_eq!(completed["onboarding_done"], true);
    assert_eq!(completed["preferences"]["tts_enabled"], false);
    drop(reopened);
    let reopened = Application::new(directory.path().to_owned(), true).unwrap();
    assert_eq!(reopened.snapshot().unwrap()["onboarding_done"], true);
}

#[tokio::test]
async fn confirmed_uid_binding_can_supply_voice_without_a_default() {
    let (_directory, app) = isolated(true);
    save_test_voice(&app).await;
    app.dispatch("presets.default", json!({"id":null}))
        .await
        .unwrap();
    assert!(app.lock().unwrap().validate_default_voice().is_err());
    app.dispatch("bindings.save", json!({"id":"bound","binding":{"platform":"bilibili","user_id":77,"legacy_user_name":null,"preset_id":"voice","enabled":true}}))
        .await
        .unwrap();
    assert!(app.lock().unwrap().validate_default_voice().is_ok());
}

#[tokio::test]
async fn invalid_rule_or_duplicate_uid_command_keeps_saved_configuration() {
    let (directory, app) = isolated(true);
    save_test_voice(&app).await;
    let before = app.snapshot().unwrap()["rules"].clone();
    let mut invalid = before.clone();
    invalid["templates"]["gift"] = json!("谢谢 {not_a_field}");
    let error = app
        .dispatch("rules.save", json!({"rules": invalid}))
        .await
        .unwrap_err();
    assert!(error.contains("礼物模板无效"), "{error}");
    assert_eq!(app.snapshot().unwrap()["rules"], before);

    let binding = json!({
        "platform":"bilibili", "user_id":77, "user_name":null,
        "legacy_user_name":null, "preset_id":"voice", "enabled":true
    });
    app.dispatch("bindings.save", json!({"id":"first", "binding":binding}))
        .await
        .unwrap();
    let error = app
        .dispatch("bindings.save", json!({"id":"second", "binding":binding}))
        .await
        .unwrap_err();
    assert!(error.contains("UID 已有声音绑定"), "{error}");
    assert_eq!(
        app.snapshot().unwrap()["bindings"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    drop(app);
    let reopened = Application::new(directory.path().to_owned(), true).unwrap();
    assert_eq!(reopened.snapshot().unwrap()["rules"], before);
    assert_eq!(
        reopened.snapshot().unwrap()["bindings"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn manually_named_viewer_binding_is_live_and_legacy_name_stays_pending() {
    let (_directory, app) = isolated(true);
    save_test_voice(&app).await;
    app.dispatch("presets.default", json!({"id":null}))
        .await
        .unwrap();
    app.dispatch(
        "bindings.save",
        json!({"id":"named","binding":{"platform":"bilibili","user_id":null,
            "user_name":"观众","legacy_user_name":null,"preset_id":"voice","enabled":true}}),
    )
    .await
    .unwrap();
    assert!(app.lock().unwrap().validate_default_voice().is_ok());
    let preview = app
        .dispatch(
            "rules.preview",
            json!({"event":LiveEvent::danmaku(123, Some(88), "观众", "你好")}),
        )
        .await
        .unwrap();
    assert_eq!(preview["result"]["voice"]["id"], "voice");
    assert_eq!(
        app.snapshot().unwrap()["bindings"][0]["binding"]["user_name"],
        "观众"
    );
    assert!(
        app.dispatch(
            "bindings.save",
            json!({"id":"duplicate","binding":{"platform":"bilibili","user_id":null,
                "user_name":"观众","legacy_user_name":null,"preset_id":"voice","enabled":true}}),
        )
        .await
        .unwrap_err()
        .contains("已有声音绑定")
    );
    assert!(
        app.dispatch(
            "bindings.save",
            json!({"id":"old","binding":{"platform":"bilibili","user_id":null,
                "legacy_user_name":"旧名","preset_id":"voice","enabled":true}}),
        )
        .await
        .unwrap_err()
        .contains("UID 或名称")
    );
}

#[tokio::test]
async fn successful_local_action_clears_a_previous_error_status() {
    let (_directory, app) = isolated(true);
    assert!(app.dispatch("unknown.action", json!({})).await.is_err());
    assert_eq!(app.snapshot().unwrap()["status"]["error"], true);

    let snapshot = app
        .dispatch("connections.save", json!({"connection":{"id":"local","name":"Local","settings":{"provider":"dots","endpoint":"http://127.0.0.1:9881","timeout_secs":180},"has_credential":false}}))
        .await
        .unwrap();
    assert_eq!(snapshot["result"]["id"], "local");
    assert_eq!(snapshot["status"]["error"], false);
    assert_eq!(snapshot["status"]["message"], "");
}

#[test]
fn launch_options_keep_isolated_paths_and_reject_legacy_capture_flags() {
    let options = LaunchOptions::parse([
        OsString::from("--data-dir"),
        OsString::from("relative-fixture"),
        OsString::from("--disable-network"),
    ])
    .unwrap();
    assert!(options.data_dir.is_absolute());
    assert!(options.disable_network);
    assert!(LaunchOptions::parse([OsString::from("--data-dir")]).is_err());
    assert!(
        LaunchOptions::parse([
            OsString::from("--capture-screen"),
            OsString::from("old.png")
        ])
        .is_err()
    );
}

#[tokio::test]
async fn snapshot_reuses_configuration_but_reads_fresh_runtime_state() {
    let (_directory, app) = isolated(true);
    let initial = app.snapshot().unwrap();
    let scheduler = scheduler::spawn(Arc::new(WaitingExecutor));
    {
        let mut state = app.lock().unwrap();
        // Model a persisted change before its dispatch completes. Polling
        // retains one consistent configuration until that boundary.
        let mut settings = state.store.load_live_settings().unwrap();
        settings.room_id = Some(991);
        state.store.save_live_settings(&settings).unwrap();
        state.prefs.onboarding_done = true;
        state.prefs.broadcaster_uid = Some(42);
        state.prefs.tts_enabled = false;
        state.qr.status = "waiting";
        state.qr.message = "正在等待扫码".into();
        state.last_live.received = 1;
        state.last_live.recent_events = vec![LiveEvent::danmaku(991, Some(77), "Tester", "新弹幕")];
        state.status = "测试状态".into();
        state.scheduler = Some(scheduler.clone());
    }
    scheduler.start().await.unwrap();
    let polled = app.snapshot().unwrap();
    assert_eq!(polled["live_settings"], initial["live_settings"]);
    assert_eq!(polled["setup"]["room_id"], initial["setup"]["room_id"]);
    assert_eq!(polled["onboarding_done"], true);
    assert_eq!(polled["setup"]["uid"], 42);
    assert_eq!(polled["preferences"]["tts_enabled"], false);
    assert_eq!(polled["qr"]["status"], "waiting");
    assert_eq!(polled["live"]["received"], 1);
    assert_eq!(polled["live"]["events"].as_array().unwrap().len(), 1);
    assert_eq!(polled["queue"]["accepting"], true);
    assert_eq!(polled["status"]["message"], "测试状态");

    let cancelled = app.dispatch("bili.qr.cancel", json!({})).await.unwrap();
    assert_eq!(cancelled["qr"]["status"], "idle");
    assert_eq!(cancelled["live_settings"], initial["live_settings"]);
    // A runtime-only QR cancellation does not invalidate persisted settings.
    // The settings command is the configuration boundary being simulated.
    let updated = app
        .dispatch("live.save", json!({"room_id":991}))
        .await
        .unwrap();
    assert_eq!(updated["live_settings"]["room_id"], 991);
    assert_eq!(updated["setup"]["room_id"], 991);
    assert_eq!(updated["qr"]["status"], "idle");
    app.stop(true).await.unwrap();
}

#[tokio::test]
async fn failed_dispatch_invalidates_configuration_after_a_partial_write() {
    let (_directory, app) = isolated(true);
    app.snapshot().unwrap();
    {
        let mut state = app.lock().unwrap();
        let mut settings = state.store.load_live_settings().unwrap();
        settings.room_id = Some(992);
        state.store.save_live_settings(&settings).unwrap();
    }
    let error = app.dispatch("unknown.action", json!({})).await.unwrap_err();
    let refreshed = app.snapshot().unwrap();
    assert_eq!(refreshed["live_settings"]["room_id"], 992);
    assert_eq!(refreshed["setup"]["room_id"], 992);
    assert_eq!(refreshed["status"]["error"], true);
    assert_eq!(refreshed["status"]["message"], error);
}

#[tokio::test]
async fn offline_gate_blocks_every_provider_entry_without_mutating_setup() {
    let (_directory, app) = isolated(true);
    let before = app.snapshot().unwrap();
    for action in [
        "bili.qr.begin",
        "bili.qr.poll",
        "doubao.qr.begin",
        "doubao.qr.poll",
        "onboarding.anonymous",
        "live.connect",
        "connections.probe",
        "audition",
    ] {
        let result = app.dispatch(action, json!({"uid":"42","id":"local"})).await;
        assert!(result.unwrap_err().contains("离线测试窗口"), "{action}");
    }
    let after = app.snapshot().unwrap();
    assert_eq!(before["setup"], after["setup"]);
    assert_eq!(after["qr"]["status"], "idle");
    assert!(!app.data_dir().unwrap().join("desktop-paths.json").exists());
    assert!(
        app.dispatch("onboarding.anonymous", json!({"uid":"0"}))
            .await
            .unwrap_err()
            .contains("正整数")
    );
}

#[tokio::test]
async fn settings_crud_and_onboarding_persist_across_reopen() {
    let (directory, app) = isolated(true);
    save_test_voice(&app).await;
    app.dispatch("live.save",json!({"room_id":123,"authenticated":false,"gift_merge":{"enabled":true,"initial_seconds":1.2,"increment_seconds":0.3,"maximum_seconds":4.0}})).await.unwrap();
    app.dispatch("bindings.save",json!({"id":"binding","binding":{"platform":"bilibili","user_id":77,"legacy_user_name":null,"preset_id":"voice","enabled":true}})).await.unwrap();
    app.dispatch(
        "preferences.save",
        json!({"preferences":{"appearance":"light","scale":1.2,"broadcaster_uid":42}}),
    )
    .await
    .unwrap();
    app.dispatch(
        "onboarding.finish",
        json!({"tts_enabled":false,"connect":false}),
    )
    .await
    .unwrap();
    drop(app);
    let reopened = Application::new(directory.path().to_owned(), true).unwrap();
    let value = reopened.snapshot().unwrap();
    assert_eq!(value["setup"]["uid"], 42);
    assert_eq!(value["setup"]["room_id"], 123);
    assert_eq!(value["setup"]["mode"], "anonymous");
    assert_eq!(value["preferences"]["appearance"], "light");
    assert_eq!(value["rules"]["default_preset_id"], "voice");
    assert_eq!(value["live_settings"]["gift_merge"]["enabled"], true);
    assert_eq!(value["onboarding_done"], true);
    reopened
        .dispatch("bindings.delete", json!({"id":"binding","confirmed":true}))
        .await
        .unwrap();
    reopened
        .dispatch("presets.default", json!({"id":null}))
        .await
        .unwrap();
    reopened
        .dispatch("presets.delete", json!({"id":"voice","confirmed":true}))
        .await
        .unwrap();
    let result = reopened
        .dispatch("connections.delete", json!({"id":"local","confirmed":true}))
        .await
        .unwrap();
    assert!(result["presets"].as_array().unwrap().is_empty());
    assert!(result["connections"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn stale_saved_ffmpeg_path_does_not_override_embedded_audio() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(
        directory.path().join("desktop-paths.json"),
        br#"{"ffmpeg_path":"C:\\old\\missing\\ffmpeg.exe"}"#,
    )
    .unwrap();
    let app = Application::new(directory.path().to_path_buf(), true).unwrap();
    let binary = embedded_ffmpeg::ensure(directory.path()).unwrap();
    assert!(binary.is_file());
    assert!(app.snapshot().unwrap().get("ffmpeg_path").is_none());
    app.dispatch(
        "preferences.save",
        json!({"preferences":{"master_volume":0.4}}),
    )
    .await
    .unwrap();
    let saved: Value = serde_json::from_slice(
        &std::fs::read(directory.path().join("desktop-paths.json")).unwrap(),
    )
    .unwrap();
    assert!(saved.get("ffmpeg_path").is_none());
    let volume = app.snapshot().unwrap()["preferences"]["master_volume"]
        .as_f64()
        .unwrap();
    assert!((volume - 0.4).abs() < 0.000001);
}

#[tokio::test]
async fn reconnecting_unchanged_missing_output_reports_failure_and_can_be_retried() {
    let (_directory, app) = isolated(true);
    let missing = format!("missing-output-{}", Uuid::new_v4());
    let scheduler = scheduler::spawn(Arc::new(WaitingExecutor));
    {
        let mut state = app.lock().unwrap();
        state.prefs.output = audio::OutputSelection::Named(missing.clone());
        state.scheduler = Some(scheduler.clone());
    }
    scheduler.start().await.unwrap();

    // A normal save of identical values does not stop or reopen playback.
    app.dispatch("preferences.save", json!({"preferences":{}}))
        .await
        .unwrap();
    assert!(scheduler.state().borrow().accepting);
    assert!(app.lock().unwrap().scheduler.is_some());

    // The explicit reconnect still requires acknowledgement of queue stoppage.
    assert!(
        app.dispatch(
            "preferences.save",
            json!({"preferences":{},"reopen_output":true}),
        )
        .await
        .unwrap_err()
        .contains("确认")
    );
    assert!(scheduler.state().borrow().accepting);

    let retry = json!({"preferences":{},"reopen_output":true,"confirmed":true});
    let error = app
        .dispatch("preferences.save", retry.clone())
        .await
        .unwrap_err();
    assert!(error.contains("重新连接输出设备失败："), "{error}");
    assert!(!scheduler.state().borrow().accepting);
    assert!(app.lock().unwrap().scheduler.is_none());
    let snapshot = app.snapshot().unwrap();
    assert_eq!(snapshot["status"]["error"], true);
    assert_eq!(snapshot["status"]["message"], error);
    assert_eq!(snapshot["preferences"]["output"]["named"], missing);

    // A failed open leaves the action available for a later device recovery.
    let again = app.dispatch("preferences.save", retry).await.unwrap_err();
    assert!(again.contains("重新连接输出设备失败："), "{again}");
}

#[tokio::test]
async fn exports_and_snapshots_never_contain_protected_credentials() {
    let (directory, app) = isolated(true);
    let secret = "test-only-secret-must-not-leak";
    let connection = ServiceConnection {
        id: "fish".into(),
        name: "Fish Audio".into(),
        settings: ConnectionSettings::FishAudio { timeout_secs: 30 },
        has_credential: false,
    };
    app.lock()
        .unwrap()
        .store
        .save_connection_with_credential(&connection, Some(secret.as_bytes()))
        .unwrap();
    let snapshot = app.snapshot().unwrap();
    assert_eq!(snapshot["connections"][0]["has_credential"], true);
    assert!(!snapshot.to_string().contains(secret));
    let export = directory.path().join("configuration.json");
    app.dispatch("configuration.export", json!({"path":export}))
        .await
        .unwrap();
    let content = std::fs::read_to_string(&export).unwrap();
    assert!(!content.contains(secret));
    assert!(!content.contains("protected_credential"));
    assert!(
        app.dispatch("configuration.export", json!({"path":export}))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn fish_setup_uses_verified_login_and_remembers_nonsecret_options() {
    let (_directory, app) = isolated(true);
    assert!(
        app.dispatch("fish.connect", json!({"credential":"test-only-key"}))
            .await
            .unwrap_err()
            .contains("离线")
    );
    assert!(
        app.snapshot().unwrap()["connections"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(app
        .dispatch(
            "connections.save",
            json!({"connection":{"id":"fish","name":"Fish Audio","settings":{"provider":"fish_audio","timeout_secs":30},"has_credential":false},"credential":"test-only-key"}),
        )
        .await
        .unwrap_err()
        .contains("登录入口"));
    assert!(
        app.snapshot().unwrap()["connections"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    app.dispatch(
        "connections.save",
        json!({"connection":{"id":"fish","name":"Fish Audio","settings":{"provider":"fish_audio","timeout_secs":30},"has_credential":false}}),
    )
    .await
    .unwrap();
    let initial = app
        .dispatch("fish.settings.get", json!({"connection_id":"fish"}))
        .await
        .unwrap();
    assert_eq!(initial["result"]["model"], "s2.1-pro-free");
    let mut settings = initial["result"].clone();
    settings["streaming"] = json!(false);
    settings["latency"] = json!("balanced");
    let saved = app
        .dispatch(
            "fish.settings.save",
            json!({"connection_id":"fish","settings":settings}),
        )
        .await
        .unwrap();
    assert_eq!(saved["fish_audio_settings"]["fish"]["streaming"], false);
    assert_eq!(saved["fish_audio_settings"]["fish"]["latency"], "balanced");
    let voice = app
        .dispatch(
            "fish.voice.save",
            json!({"connection_id":"fish","id_or_url":fish::DEFAULT_VOICE_ID,"name":"喜欢的声音"}),
        )
        .await
        .unwrap();
    assert_eq!(voice["result"]["name"], "喜欢的声音");
    assert_eq!(voice["presets"].as_array().unwrap().len(), 1);
    let restored = app
        .dispatch(
            "fish.voices.restore_builtin",
            json!({"connection_id":"fish"}),
        )
        .await
        .unwrap();
    assert_eq!(restored["result"].as_array().unwrap().len(), 4);
    assert_eq!(restored["presets"].as_array().unwrap().len(), 5);
    assert_eq!(
        restored["presets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|preset| preset["voice_id"] == fish::DEFAULT_VOICE_ID)
            .unwrap()["name"],
        "喜欢的声音"
    );
}

#[tokio::test]
async fn fish_voice_audition_uses_selected_preset_without_changing_default() {
    let (_directory, app) = isolated(false);
    let connection = ServiceConnection {
        id: "fish".into(),
        name: "Fish Audio".into(),
        settings: ConnectionSettings::FishAudio { timeout_secs: 30 },
        has_credential: false,
    };
    app.lock()
        .unwrap()
        .store
        .save_connection_with_credential(&connection, Some(b"sk-test-only-placeholder"))
        .unwrap();
    let preset = app
        .dispatch(
            "fish.voice.save",
            json!({"connection_id":"fish","id_or_url":fish::DEFAULT_VOICE_ID,"name":"试听音色"}),
        )
        .await
        .unwrap()["result"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let before = app.snapshot().unwrap()["rules"]["default_preset_id"].clone();
    let scheduler = scheduler::spawn(Arc::new(WaitingExecutor));
    app.lock().unwrap().scheduler = Some(scheduler.clone());
    app.dispatch("audition", json!({"preset_id":preset,"text":"你好"}))
        .await
        .unwrap();
    assert!(scheduler.state().borrow().current.is_some());
    assert_eq!(
        app.snapshot().unwrap()["rules"]["default_preset_id"],
        before
    );
    app.stop(true).await.unwrap();
}

// This executor exists only in tests. Production always uses PlaybackExecutor.
struct WaitingExecutor;
#[async_trait::async_trait]
impl JobExecutor for WaitingExecutor {
    async fn execute(
        &self,
        _job: SpeechJob,
        _cancel: CancellationToken,
    ) -> Result<danmakuvoice_engine::scheduler::JobOutcome, String> {
        std::future::pending().await
    }
}

#[tokio::test]
async fn stop_live_preserves_audition_and_explicit_audition_restarts_after_stop_all() {
    let (_directory, app) = isolated(false);
    save_test_voice(&app).await;
    let scheduler = scheduler::spawn(Arc::new(WaitingExecutor));
    app.lock().unwrap().scheduler = Some(scheduler.clone());
    let event = LiveEvent::danmaku(123, Some(77), "Tester", "试听");
    app.dispatch("audition", json!({"event":event}))
        .await
        .unwrap();
    let first = scheduler.state().borrow().current.as_ref().unwrap().id;
    app.dispatch("live.disconnect", json!({})).await.unwrap();
    assert_eq!(
        scheduler.state().borrow().current.as_ref().unwrap().id,
        first
    );
    app.dispatch("queue.stop", json!({})).await.unwrap();
    assert!(!scheduler.state().borrow().accepting);
    assert!(
        scheduler
            .state()
            .borrow()
            .history
            .iter()
            .any(|h| h.id == first && h.state == JobState::Stopped)
    );
    app.dispatch("audition", json!({"event":event}))
        .await
        .unwrap();
    assert!(scheduler.state().borrow().accepting);
    assert!(scheduler.state().borrow().current.as_ref().unwrap().id > first);
    app.stop(true).await.unwrap();
}

#[tokio::test]
async fn explicit_stop_cancels_pending_default_device_reconnect() {
    let (_directory, app) = isolated(true);
    app.lock().unwrap().resume_live_after_default_device_change = true;
    app.dispatch("live.disconnect", json!({})).await.unwrap();
    let state = app.lock().unwrap();
    assert!(!state.resume_live_after_default_device_change);
    assert_eq!(state.explicit_stop_epoch, 1);
}

#[tokio::test]
async fn settings_reconnect_yields_to_a_newer_explicit_stop_before_opening_the_queue() {
    let (_directory, app) = isolated(false);
    app.dispatch("live.save", json!({"room_id":123,"authenticated":true}))
        .await
        .unwrap();
    let gate = app.lock().unwrap().activity_gate.clone();
    let held = gate.lock().await;
    let previous_epoch = app.lock().unwrap().explicit_stop_epoch;
    let restarting = app.clone();
    let reconnect = tokio::spawn(async move {
        restarting
            .connect_with_intent(None, None, Some(previous_epoch))
            .await
    });
    tokio::task::yield_now().await;
    let stopping = app.clone();
    let stop = tokio::spawn(async move { stopping.dispatch("queue.stop", json!({})).await });
    while !app.lock().unwrap().stopping {
        tokio::task::yield_now().await;
    }
    drop(held);
    tokio::time::timeout(Duration::from_secs(2), async {
        reconnect.await.unwrap().unwrap();
        stop.await.unwrap().unwrap();
    })
    .await
    .unwrap();
    let state = app.lock().unwrap();
    assert_eq!(state.explicit_stop_epoch, previous_epoch + 1);
    assert!(!state.connecting);
    assert!(state.live.is_none());
    assert!(state.scheduler.is_none());
}

#[tokio::test]
async fn stop_all_stays_closed_after_an_inflight_starter_reopens_queue() {
    let (_directory, app) = isolated(false);
    let scheduler = scheduler::spawn(Arc::new(WaitingExecutor));
    let gate = app.lock().unwrap().activity_gate.clone();
    app.lock().unwrap().scheduler = Some(scheduler.clone());
    scheduler.start().await.unwrap();
    let held = gate.lock().await;
    let stopping = app.clone();
    let stop = tokio::spawn(async move { stopping.stop(true).await });
    while !app.lock().unwrap().stopping {
        tokio::task::yield_now().await;
    }
    while scheduler.state().borrow().accepting {
        tokio::task::yield_now().await;
    }
    // Reproduce a starter that was in flight before the stop request.
    scheduler.start().await.unwrap();
    assert!(scheduler.state().borrow().accepting);
    drop(held);
    tokio::time::timeout(Duration::from_secs(2), stop)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(!scheduler.state().borrow().accepting);
    assert!(!app.lock().unwrap().stopping);
}

#[tokio::test]
async fn invalid_preferences_do_not_stop_the_running_queue() {
    let (_directory, app) = isolated(false);
    let scheduler = scheduler::spawn(Arc::new(WaitingExecutor));
    app.lock().unwrap().scheduler = Some(scheduler.clone());
    scheduler.start().await.unwrap();
    let result = app
        .dispatch(
            "preferences.save",
            json!({"preferences":{"scale":9,"tts_enabled":false},"confirmed":true}),
        )
        .await;
    assert!(result.is_err());
    assert!(scheduler.state().borrow().accepting);
    assert!(
        app.snapshot().unwrap()["setup"]["tts_enabled"]
            .as_bool()
            .unwrap()
    );
    app.stop(true).await.unwrap();
}

#[tokio::test]
async fn stop_all_escalates_an_inflight_disconnect_and_silences_audition() {
    let (_directory, app) = isolated(false);
    save_test_voice(&app).await;
    let scheduler = scheduler::spawn(Arc::new(WaitingExecutor));
    app.lock().unwrap().scheduler = Some(scheduler.clone());
    let event = LiveEvent::danmaku(123, Some(77), "Tester", "试听");
    app.dispatch("audition", json!({"event":event}))
        .await
        .unwrap();
    let gate = app.lock().unwrap().activity_gate.clone();
    let held = gate.lock().await;
    let first = app.clone();
    let disconnect = tokio::spawn(async move { first.stop(false).await });
    while !app.lock().unwrap().stopping {
        tokio::task::yield_now().await;
    }
    let second = app.clone();
    let stop_all = tokio::spawn(async move { second.stop(true).await });
    while scheduler.state().borrow().accepting {
        tokio::task::yield_now().await;
    }
    assert!(scheduler.state().borrow().current.is_none());
    drop(held);
    tokio::time::timeout(Duration::from_secs(2), async {
        disconnect.await.unwrap().unwrap();
        stop_all.await.unwrap().unwrap();
    })
    .await
    .unwrap();
    assert!(!scheduler.state().borrow().accepting);
    assert!(!app.lock().unwrap().stopping);
}

#[test]
fn qr_cancel_invalidates_pending_results_and_clears_display() {
    let (_directory, app) = isolated(true);
    let mut state = app.lock().unwrap();
    let (generation, cancel) = state.begin_qr("bilibili");
    state.qr.image_data_url = Some("data:image/png;base64,fixture".into());
    state.cancel_qr();
    assert!(cancel.is_cancelled());
    assert_ne!(state.qr_generation, generation);
    assert!(state.qr.image_data_url.is_none());
    assert!(state.qr.provider.is_none());
}

#[tokio::test]
async fn committed_room_change_preserves_audition_and_cancelled_resolution_cannot_overwrite() {
    let (_directory, app) = isolated(false);
    save_test_voice(&app).await;
    let scheduler = scheduler::spawn(Arc::new(WaitingExecutor));
    app.lock().unwrap().scheduler = Some(scheduler.clone());
    let event = LiveEvent::danmaku(123, Some(77), "Tester", "试听");
    app.dispatch("audition", json!({"event":event}))
        .await
        .unwrap();
    let (generation, cancel) = {
        let state = app.lock().unwrap();
        (state.qr_generation, state.qr_cancel.clone())
    };
    assert!(
        app.commit_room_resolution(generation, &cancel, 42, 900, false)
            .await
            .unwrap()
    );
    assert_eq!(app.snapshot().unwrap()["setup"]["room_id"], 900);
    assert!(scheduler.state().borrow().current.is_some());
    app.lock().unwrap().cancel_qr();
    assert!(
        !app.commit_room_resolution(generation, &cancel, 99, 901, true)
            .await
            .unwrap()
    );
    assert_eq!(app.snapshot().unwrap()["setup"]["room_id"], 900);
    assert_eq!(app.snapshot().unwrap()["setup"]["mode"], "anonymous");
    app.stop(true).await.unwrap();
}

#[tokio::test]
async fn doubao_login_preserves_an_existing_primary_even_from_setup() {
    let (_directory, app) = isolated(true);
    save_test_voice(&app).await;
    app.dispatch("connections.save",json!({"connection":{"id":"doubao","name":"豆包","settings":{"provider":"doubao","timeout_secs":120},"has_credential":false}})).await.unwrap();
    app.lock().unwrap().ensure_doubao_default("doubao").unwrap();
    assert_eq!(
        app.snapshot().unwrap()["rules"]["default_preset_id"],
        "voice"
    );
    app.lock().unwrap().ensure_doubao_default("doubao").unwrap();
    let state = app.snapshot().unwrap();
    let id = state["presets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|preset| preset["provider"] == "doubao")
        .unwrap()["id"]
        .clone();
    assert_eq!(state["rules"]["default_preset_id"], "voice");
    assert!(
        state["presets"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == id && p["provider"] == "doubao")
    );
    app.lock().unwrap().ensure_doubao_default("doubao").unwrap();
    let repeated = app.snapshot().unwrap();
    assert_eq!(repeated["presets"].as_array().unwrap().len(), 2);
    assert_eq!(repeated["rules"]["default_preset_id"], "voice");
}

#[tokio::test]
async fn switching_to_an_unconnected_cloud_voice_keeps_the_current_primary() {
    let (_directory, app) = isolated(true);
    save_test_voice(&app).await;
    app.dispatch("connections.save", json!({"connection":{"id":"doubao","name":"豆包","settings":{"provider":"doubao","timeout_secs":30},"has_credential":false}})).await.unwrap();
    app.lock().unwrap().ensure_doubao_default("doubao").unwrap();
    let doubao_id = app.snapshot().unwrap()["presets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|preset| preset["provider"] == "doubao")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    app.dispatch("connections.save", json!({"connection":{"id":"fish","name":"Fish Audio","settings":{"provider":"fish_audio","timeout_secs":30},"has_credential":false}})).await.unwrap();
    let fish_id = app
        .dispatch(
            "fish.voice.save",
            json!({"connection_id":"fish","id_or_url":fish::DEFAULT_VOICE_ID,"name":"Fish 音色"}),
        )
        .await
        .unwrap()["result"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    for (id, provider) in [(&doubao_id, "豆包"), (&fish_id, "Fish Audio")] {
        let error = app
            .dispatch("presets.default", json!({"id":id}))
            .await
            .unwrap_err();
        assert!(error.contains(provider), "{error}");
        assert_eq!(
            app.snapshot().unwrap()["rules"]["default_preset_id"],
            "voice"
        );
    }

    {
        let mut state = app.lock().unwrap();
        state
            .store
            .set_connection_credential("doubao", b"test-only-encrypted-secret")
            .unwrap();
    }
    app.dispatch("presets.default", json!({"id":doubao_id}))
        .await
        .unwrap();
    {
        let mut state = app.lock().unwrap();
        state.store.clear_connection_credential("doubao").unwrap();
    }
    // A historical primary can remain selected after logout. Only a new
    // selection of the now-unavailable voice is rejected.
    app.dispatch("presets.default", json!({"id":doubao_id}))
        .await
        .unwrap();
    app.dispatch("presets.default", json!({"id":"voice"}))
        .await
        .unwrap();
    assert!(
        app.dispatch("presets.default", json!({"id":doubao_id}))
            .await
            .is_err()
    );
    assert_eq!(
        app.snapshot().unwrap()["rules"]["default_preset_id"],
        "voice"
    );
}

#[tokio::test]
async fn first_playable_voice_becomes_primary_without_an_extra_click() {
    let (directory, app) = isolated(true);
    app.dispatch("connections.save", json!({"connection":{"id":"local","name":"dots.tts","settings":{"provider":"dots","endpoint":"http://127.0.0.1:9881","timeout_secs":30},"has_credential":false}})).await.unwrap();
    assert!(app.snapshot().unwrap()["rules"]["default_preset_id"].is_null());
    app.dispatch("presets.save", json!({"preset":{"id":"first","name":"第一个音色","connection_id":"local","provider":"dots","voice_id":"reference.wav","speed":1.0,"volume":1.0,"sovits":null}})).await.unwrap();
    assert_eq!(
        app.snapshot().unwrap()["rules"]["default_preset_id"],
        "first"
    );
    app.dispatch("presets.save", json!({"preset":{"id":"second","name":"第二个音色","connection_id":"local","provider":"dots","voice_id":"another.wav","speed":1.0,"volume":1.0,"sovits":null}})).await.unwrap();
    assert_eq!(
        app.snapshot().unwrap()["rules"]["default_preset_id"],
        "first"
    );
    drop(app);
    let reopened = Application::new(directory.path().to_owned(), true).unwrap();
    assert_eq!(
        reopened.snapshot().unwrap()["rules"]["default_preset_id"],
        "first"
    );
}

#[tokio::test]
async fn switching_tts_remembers_each_services_last_voice_after_restart() {
    let (directory, app) = isolated(true);
    save_test_voice(&app).await;
    app.dispatch(
        "presets.save",
        json!({"preset":{
            "id":"dots-other","name":"另一个 dots 音色","connection_id":"local",
            "provider":"dots","voice_id":"other.wav","speed":1.0,"volume":1.0,"sovits":null
        }}),
    )
    .await
    .unwrap();
    app.dispatch(
        "connections.save",
        json!({"connection":{
            "id":"gpt","name":"GPT-SoVITS","settings":{"provider":"gpt_sovits",
            "endpoint":"http://127.0.0.1:19880","timeout_secs":30},"has_credential":false
        }}),
    )
    .await
    .unwrap();
    app.dispatch(
        "presets.save",
        json!({"preset":{
            "id":"gpt-voice","name":"GPT 音色","connection_id":"gpt",
            "provider":"gpt_sovits","voice_id":"role","speed":1.0,"volume":1.0,"sovits":null
        }}),
    )
    .await
    .unwrap();

    app.dispatch("presets.default", json!({"id":"dots-other"}))
        .await
        .unwrap();
    let switched = app
        .dispatch("presets.default", json!({"id":"gpt-voice"}))
        .await
        .unwrap();
    assert_eq!(switched["rules"]["default_preset_id"], "gpt-voice");
    assert_eq!(switched["rules"]["preferred_presets"]["dots"], "dots-other");
    assert_eq!(
        switched["rules"]["preferred_presets"]["gpt_sovits"],
        "gpt-voice"
    );

    drop(app);
    let reopened = Application::new(directory.path().to_owned(), true).unwrap();
    let remembered = reopened.snapshot().unwrap();
    assert_eq!(
        remembered["rules"]["preferred_presets"]["dots"],
        "dots-other"
    );
    assert_eq!(
        remembered["rules"]["preferred_presets"]["gpt_sovits"],
        "gpt-voice"
    );
    let mut old_client_rules = remembered["rules"].clone();
    old_client_rules
        .as_object_mut()
        .unwrap()
        .remove("preferred_presets");
    let saved = reopened
        .dispatch("rules.save", json!({"rules":old_client_rules}))
        .await
        .unwrap();
    assert_eq!(saved["rules"]["preferred_presets"]["dots"], "dots-other");
    reopened
        .dispatch("presets.default", json!({"id":null}))
        .await
        .unwrap();
    let cleared = reopened.snapshot().unwrap();
    assert!(cleared["rules"]["default_preset_id"].is_null());
    assert_eq!(
        cleared["rules"]["preferred_presets"]["gpt_sovits"],
        "gpt-voice"
    );
    let deleted = reopened
        .dispatch(
            "presets.delete",
            json!({"id":"dots-other","confirmed":true}),
        )
        .await
        .unwrap();
    assert!(deleted["rules"]["preferred_presets"]["dots"].is_null());
    assert_eq!(
        deleted["rules"]["preferred_presets"]["gpt_sovits"],
        "gpt-voice"
    );
}

#[tokio::test]
async fn local_service_actions_target_the_selected_voice_connection() {
    let (_directory, app) = isolated(true);
    for (id, port) in [("first", 9881), ("selected", 19881)] {
        app.dispatch("connections.save", json!({"connection":{
            "id":id,"name":id,"settings":{"provider":"dots","endpoint":format!("http://127.0.0.1:{port}"),"timeout_secs":30},"has_credential":false
        }})).await.unwrap();
    }
    app.dispatch("presets.save", json!({"preset":{
        "id":"selected-voice","name":"目标音色","connection_id":"selected","provider":"dots","voice_id":"reference.wav","speed":1.0,"volume":1.0,"sovits":null
    }})).await.unwrap();
    assert_eq!(
        app.local_service_endpoint(Kind::Dots, None).unwrap(),
        "http://127.0.0.1:19881"
    );
}

#[test]
fn expired_bilibili_session_has_an_actionable_desktop_state() {
    assert_eq!(
        room_state(&RoomState::SessionExpired { room_id: 42 }),
        (
            "session_expired",
            "哔哩哔哩登录已失效，请重新扫码 [DV-B09]".into()
        )
    );
}

#[tokio::test]
async fn stale_auto_start_does_not_restart_an_unselected_local_service() {
    let (_directory, app) = isolated(false);
    let before = app.lock().unwrap().local_services.dots.generation;
    app.ensure_local_service(Kind::Dots, "http://127.0.0.1:9881", true, None)
        .await;
    let state = app.lock().unwrap();
    assert_eq!(state.local_services.dots.generation, before);
    assert_eq!(state.local_services.dots.state, "unconfigured");
}

#[tokio::test]
async fn invalid_stale_service_task_does_not_overwrite_manual_stop_or_new_selection() {
    let (_directory, app) = isolated(false);
    let generation = app.lock().unwrap().local_services.dots.generation;
    app.lock().unwrap().local_services.dots.stop_manual();
    app.ensure_local_service(Kind::Dots, "invalid old endpoint", false, Some(generation))
        .await;
    assert_eq!(app.lock().unwrap().local_services.dots.state, "stopped");

    let (_directory, app) = isolated(false);
    app.ensure_local_service(Kind::Dots, "invalid old endpoint", true, None)
        .await;
    assert_eq!(
        app.lock().unwrap().local_services.dots.state,
        "unconfigured"
    );
}

#[tokio::test]
async fn switching_or_clearing_the_primary_keeps_started_local_services() {
    let (_directory, app) = isolated(true);
    save_test_voice(&app).await;
    app.dispatch(
        "connections.save",
        json!({"connection":{
            "id":"gpt","name":"GPT-SoVITS","settings":{"provider":"gpt_sovits",
            "endpoint":"http://127.0.0.1:19880","timeout_secs":30},"has_credential":false
        }}),
    )
    .await
    .unwrap();
    app.dispatch(
        "presets.save",
        json!({"preset":{
            "id":"gpt-voice","name":"GPT voice","connection_id":"gpt",
            "provider":"gpt_sovits","voice_id":"role","speed":1.0,"volume":1.0,"sovits":null
        }}),
    )
    .await
    .unwrap();
    for phase in ["checking", "starting", "ready"] {
        {
            let mut state = app.lock().unwrap();
            state
                .local_services
                .dots
                .set(phase, "Existing dots service");
            state
                .local_services
                .gpt_sovits
                .set(phase, "Existing GPT service");
        }
        let before = app.snapshot().unwrap()["local_services"].clone();
        for primary in [Some("gpt-voice"), Some("voice"), None] {
            app.dispatch("presets.default", json!({"id":primary}))
                .await
                .unwrap();
            // Exercise the same automatic-start path as dispatch/startup,
            // even after queues and bindings no longer reference either service.
            app.auto_start_preferred_service().await;
            assert_eq!(app.snapshot().unwrap()["local_services"], before);
        }
    }
    // Exit still performs the owned-service shutdown path.
    app.stop_owned_local_services();
    let snapshot = app.snapshot().unwrap();
    assert_eq!(snapshot["local_services"]["dots"]["state"], "stopped");
    assert_eq!(snapshot["local_services"]["gpt_sovits"]["state"], "stopped");
}

#[cfg(windows)]
#[tokio::test]
async fn primary_switch_keeps_owned_processes_until_explicit_stop_or_exit() {
    let (_directory, app) = isolated(true);
    save_test_voice(&app).await;
    app.dispatch(
        "connections.save",
        json!({"connection":{
            "id":"gpt","name":"GPT-SoVITS","settings":{"provider":"gpt_sovits",
            "endpoint":"http://127.0.0.1:19880","timeout_secs":30},"has_credential":false
        }}),
    )
    .await
    .unwrap();
    app.dispatch(
        "presets.save",
        json!({"preset":{
            "id":"gpt-voice","name":"GPT voice","connection_id":"gpt",
            "provider":"gpt_sovits","voice_id":"role","speed":1.0,"volume":1.0,"sovits":null
        }}),
    )
    .await
    .unwrap();
    let dots_directory = tempfile::tempdir().unwrap();
    let gpt_directory = tempfile::tempdir().unwrap();
    {
        let mut state = app.lock().unwrap();
        state.local_services.dots = local_service::tests::running_owned_service_fixture(
            dots_directory.path(),
            Kind::Dots,
            "http://127.0.0.1:9881",
        );
        state.local_services.gpt_sovits = local_service::tests::running_owned_service_fixture(
            gpt_directory.path(),
            Kind::GptSovits,
            "http://127.0.0.1:19880",
        );
    }
    for primary in [Some("gpt-voice"), Some("voice"), None] {
        app.dispatch("presets.default", json!({"id":primary}))
            .await
            .unwrap();
        app.auto_start_preferred_service().await;
        let snapshot = app.snapshot().unwrap();
        for provider in ["dots", "gpt_sovits"] {
            assert_eq!(snapshot["local_services"][provider]["owned"], true);
            assert_eq!(snapshot["local_services"][provider]["state"], "ready");
        }
    }
    app.dispatch("local_services.stop", json!({"provider":"gpt_sovits"}))
        .await
        .unwrap();
    let snapshot = app.snapshot().unwrap();
    assert_eq!(snapshot["local_services"]["gpt_sovits"]["owned"], false);
    assert_eq!(
        snapshot["local_services"]["gpt_sovits"]["manual_stopped"],
        true
    );
    assert_eq!(snapshot["local_services"]["dots"]["owned"], true);
    app.auto_start_preferred_service().await;
    assert_eq!(
        app.snapshot().unwrap()["local_services"]["gpt_sovits"]["owned"],
        false
    );
    app.stop_owned_local_services();
    assert_eq!(
        app.snapshot().unwrap()["local_services"]["dots"]["owned"],
        false
    );
}

#[tokio::test]
async fn reopening_an_older_profile_repairs_an_unset_primary_voice() {
    let (directory, app) = isolated(true);
    save_test_voice(&app).await;
    {
        let mut state = app.lock().unwrap();
        let mut rules = state.store.load_rules().unwrap();
        rules.default_preset_id = None;
        rules.default_preset_explicitly_cleared = false;
        state.store.save_rules(&rules).unwrap();
    }
    drop(app);
    let reopened = Application::new(directory.path().to_owned(), true).unwrap();
    assert_eq!(
        reopened.snapshot().unwrap()["rules"]["default_preset_id"],
        "voice"
    );
}

#[tokio::test]
async fn manually_cleared_primary_stays_empty_when_more_voices_are_added() {
    let (directory, app) = isolated(true);
    save_test_voice(&app).await;
    app.dispatch("presets.default", json!({"id":null}))
        .await
        .unwrap();
    let cleared = app.snapshot().unwrap();
    assert!(cleared["rules"]["default_preset_id"].is_null());
    assert_eq!(cleared["rules"]["default_preset_explicitly_cleared"], true);
    app.dispatch("presets.save", json!({"preset":{"id":"later","name":"另一个音色","connection_id":"local","provider":"dots","voice_id":"another.wav","speed":1.0,"volume":1.0,"sovits":null}})).await.unwrap();
    assert!(app.snapshot().unwrap()["rules"]["default_preset_id"].is_null());
    drop(app);
    let reopened = Application::new(directory.path().to_owned(), true).unwrap();
    reopened.dispatch("presets.save", json!({"preset":{"id":"third","name":"又一个音色","connection_id":"local","provider":"dots","voice_id":"third.wav","speed":1.0,"volume":1.0,"sovits":null}})).await.unwrap();
    assert!(reopened.snapshot().unwrap()["rules"]["default_preset_id"].is_null());
}

#[tokio::test]
async fn first_fish_voice_waits_for_login_before_becoming_primary() {
    let (_directory, app) = isolated(true);
    app.dispatch("connections.save", json!({"connection":{"id":"fish","name":"Fish Audio","settings":{"provider":"fish_audio","timeout_secs":30},"has_credential":false}})).await.unwrap();
    let saved = app.dispatch("fish.voice.save", json!({"connection_id":"fish","id_or_url":fish::DEFAULT_VOICE_ID,"name":"首个 Fish 音色"})).await.unwrap();
    let id = saved["result"]["id"].as_str().unwrap().to_owned();
    assert!(saved["rules"]["default_preset_id"].is_null());
    {
        let mut state = app.lock().unwrap();
        state
            .store
            .set_connection_credential("fish", b"sk-test-only-placeholder")
            .unwrap();
        state.ensure_first_default(Some(&id)).unwrap();
        state.config_snapshot = None;
    }
    assert_eq!(app.snapshot().unwrap()["rules"]["default_preset_id"], id);
}

#[tokio::test]
async fn entered_doubao_login_creates_its_first_primary_voice() {
    let (_directory, app) = isolated(true);
    let saved = app.dispatch("connections.save", json!({
        "connection":{"id":"doubao","name":"豆包","settings":{"provider":"doubao","timeout_secs":30},"has_credential":false},
        "credential":"sessionid=offline-test-only; csrf_token=test"
    })).await.unwrap();
    let id = saved["rules"]["default_preset_id"].as_str().unwrap();
    assert!(
        saved["presets"]
            .as_array()
            .unwrap()
            .iter()
            .any(|preset| preset["id"] == id && preset["provider"] == "doubao")
    );
}

#[tokio::test]
async fn first_doubao_login_creates_a_connection_the_playback_client_accepts() {
    let (_directory, app) = isolated(true);
    let mut state = app.lock().unwrap();
    let connection = doubao_connection_for_login(&state.store, "new-doubao").unwrap();
    assert!(matches!(
        connection.settings,
        ConnectionSettings::Doubao { timeout_secs: 30 }
    ));
    state
        .store
        .save_connection_with_credential(&connection, Some(b"sessionid=offline-test-only"))
        .unwrap();
    let device = state.store.load_or_create_dobao_device().unwrap();
    state.ensure_doubao_default(&connection.id).unwrap();
    let preview = state
        .store
        .load_rules()
        .unwrap()
        .preview(
            &LiveEvent::danmaku(42, Some(7), "Tester", "offline"),
            &state.store.presets().unwrap(),
            &[],
        )
        .unwrap();
    assert!(preview.needs_tts());
    assert_eq!(preview.voice.as_ref().unwrap().provider, Provider::Doubao);
    assert!(PreparedPlayback::from_store(&state.store, &preview, Some(&device)).is_ok());
}

#[test]
fn confirmed_doubao_login_resumes_only_after_successful_save() {
    let (_directory, app) = isolated(true);
    let mut state = app.lock().unwrap();
    let connection = doubao_connection_for_login(&state.store, "new-doubao").unwrap();
    let mut resumes = 0;

    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(
        !save_confirmed_doubao_credential(
            &mut state.store,
            &connection,
            b"sessionid=offline-test-only",
            &cancelled,
            || resumes += 1,
        )
        .unwrap()
    );
    assert_eq!(resumes, 0);
    assert!(state.store.connections().unwrap().is_empty());

    let mut invalid = connection.clone();
    invalid.settings = ConnectionSettings::Doubao { timeout_secs: 0 };
    assert!(
        save_confirmed_doubao_credential(
            &mut state.store,
            &invalid,
            b"sessionid=offline-test-only",
            &CancellationToken::new(),
            || resumes += 1,
        )
        .is_err()
    );
    assert_eq!(resumes, 0);
    assert!(state.store.connections().unwrap().is_empty());

    assert!(
        save_confirmed_doubao_credential(
            &mut state.store,
            &connection,
            b"sessionid=offline-test-only",
            &CancellationToken::new(),
            || resumes += 1,
        )
        .unwrap()
    );
    assert_eq!(resumes, 1);
    assert!(
        state
            .store
            .connection_credential(&connection.id)
            .unwrap()
            .is_some()
    );
}

#[cfg(windows)]
#[tokio::test]
async fn saved_bili_account_can_resume_its_room_without_scanning_again() {
    let (directory, app) = isolated(false);
    app.dispatch("live.save", json!({"room_id":123,"authenticated":false}))
        .await
        .unwrap();
    let missing = app
        .dispatch("bili.use_account", json!({}))
        .await
        .unwrap_err();
    assert!(missing.contains("请先扫码登录"));
    assert_eq!(app.snapshot().unwrap()["setup"]["room_id"], 123);

    let session = BiliSession::from_secret_payload(
        br#"{"user_id":42,"sessdata":"offline-session","bili_jct":"offline-csrf","buvid3":null,"refresh_token":null}"#,
    )
    .unwrap();
    app.lock()
        .unwrap()
        .store
        .save_bili_session(&session)
        .unwrap();
    let lookup_error = app
        .use_account_with_lookup(|session| async move {
            assert_eq!(session.user_id(), 42);
            Err("离线查询失败".into())
        })
        .await
        .unwrap_err();
    assert_eq!(lookup_error, "离线查询失败");
    let before = app.snapshot().unwrap();
    assert_eq!(before["setup"]["mode"], "anonymous");
    assert_eq!(before["setup"]["room_id"], 123);

    app.use_account_with_lookup(|session| async move {
        assert_eq!(session.user_id(), 42);
        Ok(789)
    })
    .await
    .unwrap();
    let switched = app.snapshot().unwrap();
    assert_eq!(switched["setup"]["mode"], "account");
    assert_eq!(switched["setup"]["uid"], 42);
    assert_eq!(switched["setup"]["room_id"], 789);
    assert_eq!(switched["account"]["user_id"], 42);
    drop(app);
    let reopened = Application::new(directory.path().to_owned(), true)
        .unwrap()
        .snapshot()
        .unwrap();
    assert_eq!(reopened["setup"]["mode"], "account");
    assert_eq!(reopened["setup"]["room_id"], 789);
}

#[tokio::test]
async fn local_tts_directory_persists_and_reset_keeps_original_references() {
    let directory = tempfile::tempdir().unwrap();
    let data = directory.path().join("app-data");
    let dots = directory.path().join("dots.tts");
    let myvoice = directory.path().join("myvoice");
    std::fs::create_dir_all(&myvoice).unwrap();
    std::fs::create_dir_all(dots.join(".venv/Scripts")).unwrap();
    std::fs::create_dir_all(dots.join("pretrained_models/dots.tts-2p")).unwrap();
    for path in [
        directory.path().join("serve_api.py"),
        dots.join("start_api_2p.bat"),
        dots.join(".venv/Scripts/python.exe"),
    ] {
        std::fs::write(path, b"offline fixture").unwrap();
    }
    let app = Application::new(data.clone(), true).unwrap();
    let saved = app
        .dispatch(
            "local_services.save",
            json!({"provider":"dots","directory":dots}),
        )
        .await
        .unwrap();
    assert_eq!(saved["local_services"]["dots"]["owned"], false);
    assert_eq!(saved["local_services"]["dots"]["state"], "unknown");
    let original = myvoice.join("original.wav");
    let legacy_reference_dir = data.join("references");
    std::fs::create_dir_all(&legacy_reference_dir).unwrap();
    let legacy_reference = legacy_reference_dir.join(format!("{}.wav", Uuid::new_v4()));
    let owned_cache = data.join("cache/dots/inductor/kernel.bin");
    let unrelated_cache = data.join("cache/keep.txt");
    std::fs::create_dir_all(owned_cache.parent().unwrap()).unwrap();
    std::fs::write(&owned_cache, b"owned cache").unwrap();
    std::fs::write(&unrelated_cache, b"unrelated cache").unwrap();
    std::fs::write(&original, b"source fixture").unwrap();
    std::fs::write(&legacy_reference, b"older app reference fixture").unwrap();
    drop(app);
    let reopened = Application::new(data.clone(), true).unwrap();
    assert_eq!(
        PathBuf::from(
            reopened.snapshot().unwrap()["local_services"]["dots"]["directory"]
                .as_str()
                .unwrap()
        )
        .canonicalize()
        .unwrap(),
        dots.canonicalize().unwrap()
    );
    reopened
        .dispatch("data.clear", json!({"confirmed":true}))
        .await
        .unwrap();
    assert_eq!(std::fs::read(original).unwrap(), b"source fixture");
    assert_eq!(
        std::fs::read(legacy_reference).unwrap(),
        b"older app reference fixture"
    );
    assert!(!owned_cache.exists());
    assert_eq!(std::fs::read(unrelated_cache).unwrap(), b"unrelated cache");
}

#[tokio::test]
async fn standalone_emote_filter_roundtrips_rules_ipc_and_preserves_old_client_updates() {
    let (directory, app) = isolated(true);
    let before = app.snapshot().unwrap();
    assert_eq!(before["rules"]["events"]["filter_bilibili_emoticons"], true);
    let mut rules = before["rules"].clone();
    rules["events"]["filter_bilibili_emoticons"] = json!(true);
    let changed = app
        .dispatch("rules.save", json!({"rules":rules}))
        .await
        .unwrap();
    assert_eq!(
        changed["rules"]["events"]["filter_bilibili_emoticons"],
        true
    );
    for key in ["queue", "live", "preferences", "presets", "bindings"] {
        assert_eq!(changed[key], before[key], "{key}");
    }
    drop(app);
    let reopened = Application::new(directory.path().to_owned(), true).unwrap();
    let mut old = reopened.snapshot().unwrap()["rules"].clone();
    assert_eq!(old["events"]["filter_bilibili_emoticons"], true);
    old["events"]
        .as_object_mut()
        .unwrap()
        .remove("filter_bilibili_emoticons");
    let retained = reopened
        .dispatch("rules.save", json!({"rules":old}))
        .await
        .unwrap();
    assert_eq!(
        retained["rules"]["events"]["filter_bilibili_emoticons"],
        true
    );
    let mut rules = retained["rules"].clone();
    rules["events"]["filter_bilibili_emoticons"] = json!(false);
    let disabled = reopened
        .dispatch("rules.save", json!({"rules":rules}))
        .await
        .unwrap();
    assert_eq!(
        disabled["rules"]["events"]["filter_bilibili_emoticons"],
        false
    );
    drop(reopened);
    let reopened = Application::new(directory.path().to_owned(), true).unwrap();
    let mut old = reopened.snapshot().unwrap()["rules"].clone();
    assert_eq!(old["events"]["filter_bilibili_emoticons"], false);
    old["events"]
        .as_object_mut()
        .unwrap()
        .remove("filter_bilibili_emoticons");
    let retained = reopened
        .dispatch("rules.save", json!({"rules":old}))
        .await
        .unwrap();
    assert_eq!(
        retained["rules"]["events"]["filter_bilibili_emoticons"],
        false
    );
}

#[test]
fn speech_restart_keeps_chat_in_order_and_bounded() {
    let event = |n: usize| LiveEvent::danmaku(1, Some(n as u64), "观众", &n.to_string());
    let carried: Vec<_> = (0..3).map(event).collect();
    let current: Vec<_> = (3..5).map(event).collect();
    let messages =
        |events: &[LiveEvent]| events.iter().map(|e| e.message.clone()).collect::<Vec<_>>();
    assert_eq!(
        messages(&carried_chat(&carried, &current)),
        ["0", "1", "2", "3", "4"]
    );
    let many: Vec<_> = (0..LIVE_RECENT_EVENT_LIMIT + 5).map(event).collect();
    let bounded = carried_chat(&many, &current);
    assert_eq!(bounded.len(), LIVE_RECENT_EVENT_LIMIT);
    assert_eq!(bounded.last().unwrap().message, "4");
    assert!(carried_chat(&[], &[]).is_empty());
}
