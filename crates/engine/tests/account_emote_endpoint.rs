//! Explicit read-only account acceptance; credentials stay inside DPAPI/session memory.

#[cfg(windows)]
#[tokio::test]
#[ignore = "requires explicitly selected application DB and expected account pack count; authenticated GETs only"]
async fn selected_saved_account_returns_personal_packages_and_original_texts() {
    use danmakuvoice_engine::{bilibili::BiliSession, chat_send::ChatSendClient, secrets};
    use rusqlite::{Connection, OpenFlags};
    use serde_json::json;

    let path = std::env::var_os("DANMAKUVOICE_EMOTE_DB")
        .expect("explicitly select the current application's database");
    let expected: usize = std::env::var("DANMAKUVOICE_EMOTE_EXPECTED_ACCOUNT_PACKS")
        .expect("explicitly provide the previously observed personal pack count")
        .parse()
        .expect("expected count is a number");
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("read-only application DB");
    let encrypted: Vec<u8> = connection
        .query_row(
            "SELECT protected_value FROM protected_secrets WHERE key='bilibili'",
            [],
            |row| row.get(0),
        )
        .expect("existing application session");
    let plaintext = secrets::unprotect(&encrypted).expect("current user's existing DPAPI session");
    let session =
        BiliSession::from_secret_payload(plaintext.as_bytes()).expect("valid saved session");
    drop(plaintext);
    drop(connection);
    let view = ChatSendClient::new()
        .expect("HTTP client")
        .refresh(&session)
        .await
        .expect("real account package GETs must succeed");
    assert!(
        view.warnings.is_empty(),
        "all requested sources must be available"
    );
    let personal: Vec<_> = view
        .emoticons
        .iter()
        .filter(|pack| pack.source == "account")
        .collect();
    assert_eq!(personal.len(), expected);
    assert!(personal.iter().all(|pack| !pack.name.is_empty()));
    assert!(personal.iter().all(|pack| pack.icon.is_some()));
    assert!(
        personal
            .iter()
            .flat_map(|pack| &pack.emoticons)
            .all(|item| {
                item.kind == "text"
                    && item.allowed
                    && item.text.as_ref().is_some_and(|text| !text.is_empty())
            })
    );
    let personal_items: usize = personal.iter().map(|pack| pack.emoticons.len()).sum();
    let result = json!({
        "passed":true,
        "evidence":"Explicitly selected application DPAPI session and read-only SQLite; actual production Rust client authenticated GETs. No broadcast/chat POST, credential export, raw HTTP response, or native UI acceptance.",
        "account_package_count":personal.len(),
        "account_item_count":personal_items,
        "live_package_count":view.emoticons.len()-personal.len(),
        "warnings":view.warnings,
        "emoticons":view.emoticons,
        "message_limit":view.message_limit,
    });
    if let Some(output) = std::env::var_os("DANMAKUVOICE_EMOTE_METADATA_OUTPUT") {
        std::fs::write(
            output,
            serde_json::to_vec_pretty(&result).expect("metadata JSON"),
        )
        .expect("write only normalized public package metadata, never credentials");
    }
    println!(
        "Authenticated read-only Rust GET acceptance: {expected} personal packs, {personal_items} items, {} total packs; no writes or credential output",
        result["emoticons"].as_array().unwrap().len()
    );
}
