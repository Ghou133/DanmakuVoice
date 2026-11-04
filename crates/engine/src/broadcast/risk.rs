//! Bilibili's newer broadcast face check (startLive 60043 with a `v_voucher`).
//!
//! Protocol reference: Radekyspec/StartLive (GPL-3.0) `core/sign/captcha_codec.py`,
//! `core/sign/gen_dm_track.py` and `core/workers/face_auth/`, which reproduce the
//! risk-control page script. This is an independent Rust implementation of the
//! same wire format:
//!
//! 1. `x/gaia-vgate/v2/register` answers with `data.content`, which is
//!    base64(`timestamp|salt|secretIndex|payload`). The XOR key is the first 16
//!    bytes of SHA-256(key + timestamp), where the key is the slice of the
//!    voucher (after its first 8 characters) between the two lowest set bits of
//!    `secretIndex`. The decoded JSON names the check `type` and a `token`.
//! 2. The phone opens `h5/risk-control/realname?t=<obfuscated token>`.
//! 3. `x/gaia-vgate/v2/validatePreCheck` reports the result for an obfuscated
//!    token: status 1 is passed, 2 and above expired or failed.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::bilibili::BiliError;

pub(super) const REALNAME_PAGE: &str = "https://www.bilibili.com/h5/risk-control/realname";

/// Plain WebGL strings the page fingerprint encodes; the script sends their
/// base64 form with the last two characters removed.
const WEBGL_VERSION: &str = "WebGL 1.0 (OpenGL ES 2.0 Chromium)";
const WEBGL_RENDERER: &str =
    "ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)Google Inc. (Intel)";

/// Decode a register reply into the raw check token. Only the real-name face
/// check is supported; any other type is reported without the payload.
pub(super) fn decode_register(
    voucher: &str,
    content: &str,
) -> Result<Zeroizing<String>, BiliError> {
    let invalid = || BiliError::Protocol("人脸验证数据无效");
    let outer = Zeroizing::new(STANDARD.decode(content.trim()).map_err(|_| invalid())?);
    let mut parts = outer.split(|byte| *byte == b'|');
    let (Some(timestamp), Some(_salt), Some(index), Some(payload), None) = (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) else {
        return Err(invalid());
    };
    let index: i64 = std::str::from_utf8(index)
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .ok_or_else(invalid)?;
    let mut bits = (0..32).filter(|bit| (index as u64) & (1 << bit) != 0);
    let (Some(start), Some(end)) = (bits.next(), bits.next()) else {
        return Err(invalid());
    };
    if !voucher.is_ascii() || !timestamp.is_ascii() {
        return Err(invalid());
    }
    let tail = if voucher.len() > 8 {
        &voucher[8..]
    } else {
        voucher
    };
    let key = &tail.as_bytes()[start.min(tail.len())..end.min(tail.len())];
    let digest = Sha256::new()
        .chain_update(key)
        .chain_update(timestamp)
        .finalize();
    let mut plain = Zeroizing::new(STANDARD.decode(payload).map_err(|_| invalid())?);
    for (i, byte) in plain.iter_mut().enumerate() {
        *byte ^= digest[i % 16];
    }
    let data: Value = serde_json::from_slice(&plain).map_err(|_| invalid())?;
    if data["type"].as_str() != Some("realname") {
        return Err(BiliError::Protocol(
            "B站要求的验证方式暂不支持，请使用官方直播姬开播",
        ));
    }
    data["token"]
        .as_str()
        .filter(|token| !token.is_empty() && token.len() <= 4096)
        .map(|token| Zeroizing::new(token.to_owned()))
        .ok_or_else(invalid)
}

/// The page's token form: base64(mask, token ^ mask ^ salt[i % 8], salt) with
/// a fresh random mask byte and 8-byte salt each time.
pub(super) fn obfuscate(token: &str) -> Zeroizing<String> {
    let random = Uuid::new_v4().into_bytes();
    // Bytes 6 and 8 carry the UUID version/variant; skip them.
    let salt = [
        random[0], random[1], random[2], random[3], random[4], random[5], random[7], random[9],
    ];
    obfuscate_with(token, random[10], salt)
}

fn obfuscate_with(token: &str, mask: u8, salt: [u8; 8]) -> Zeroizing<String> {
    let mut raw = Zeroizing::new(Vec::with_capacity(token.len() + 9));
    raw.push(mask);
    raw.extend(
        token
            .bytes()
            .enumerate()
            .map(|(i, byte)| byte ^ mask ^ salt[i % 8]),
    );
    raw.extend_from_slice(&salt);
    Zeroizing::new(STANDARD.encode(&*raw))
}

/// The real-name page link for the phone. The token is percent-encoded twice,
/// as the page script does (slashes stay literal).
pub(super) fn realname_url(token: &str) -> Zeroizing<String> {
    let once = percent_encode(&obfuscate(token));
    Zeroizing::new(format!("{REALNAME_PAGE}?t={}", percent_encode(&once)))
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len() * 3);
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~/".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// A minimal page fingerprint: no input events, the encoded WebGL strings, and
/// window size/scroll values derived from a 500x420 window as the script does.
pub(super) fn dm_track() -> String {
    let random = Uuid::new_v4().into_bytes();
    let (a, b) = (500u32, 420u32);
    let r = u32::from(u16::from_le_bytes([random[0], random[1]])) % 114;
    let s = u32::from(u16::from_le_bytes([random[2], random[3]])) % 514;
    let trimmed = |text: &str| {
        let mut encoded = STANDARD.encode(text);
        encoded.truncate(encoded.len().saturating_sub(2));
        encoded
    };
    let inter =
        json!({"ds": [], "wh": [2 * a + 2 * b + 3 * r, 4 * a - b + r, r], "of": [s, 2 * s, s]});
    json!({
        "dm_img_list": [],
        "dm_img_str": trimmed(WEBGL_VERSION),
        "dm_cover_img_str": trimmed(WEBGL_RENDERER),
        "dm_img_inter": inter.to_string(),
    })
    .to_string()
}

#[cfg(test)]
/// Build a register reply the way the server does, for a given voucher.
pub(super) fn register_content(voucher: &str, kind: &str, token: &str) -> String {
    let timestamp = "1793800000";
    let index = (1 << 3) | (1 << 11) | (1 << 20);
    let key = &voucher[8..][3..11];
    let digest = Sha256::new()
        .chain_update(key)
        .chain_update(timestamp)
        .finalize();
    let mut payload = json!({"type": kind, "token": token})
        .to_string()
        .into_bytes();
    for (i, byte) in payload.iter_mut().enumerate() {
        *byte ^= digest[i % 16];
    }
    STANDARD.encode(format!(
        "{timestamp}|fictional-salt|{index}|{}",
        STANDARD.encode(payload)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_content_decodes_to_the_realname_token() {
        let voucher = "prefix00ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        let token = decode_register(
            voucher,
            &register_content(voucher, "realname", "fictional-token"),
        )
        .unwrap();
        assert_eq!(token.as_str(), "fictional-token");
        // A different voucher derives a different key and cannot decode it.
        assert!(
            decode_register(
                "prefix00ZYXWVUTSRQPONMLKJIHGFEDCBA",
                &register_content(voucher, "realname", "fictional-token")
            )
            .is_err()
        );
        let other = decode_register(
            voucher,
            &register_content(voucher, "sms", "fictional-token"),
        )
        .unwrap_err()
        .to_string();
        assert!(other.contains("官方直播姬") && !other.contains("fictional"));
        for broken in [
            "",
            "not base64!",
            &STANDARD.encode("1|2|3"),
            &STANDARD.encode("1|s|1|eA=="),
        ] {
            assert!(decode_register(voucher, broken).is_err(), "{broken}");
        }
    }

    #[test]
    fn obfuscated_token_carries_mask_and_salt_and_round_trips() {
        let encoded = obfuscate_with("abc", 0x5a, [1, 2, 3, 4, 5, 6, 7, 8]);
        let raw = STANDARD.decode(encoded.as_str()).unwrap();
        assert_eq!(raw.len(), 1 + 3 + 8);
        assert_eq!(raw[0], 0x5a);
        assert_eq!(&raw[4..], &[1, 2, 3, 4, 5, 6, 7, 8]);
        let token: Vec<u8> = raw[1..4]
            .iter()
            .enumerate()
            .map(|(i, byte)| byte ^ raw[0] ^ raw[4 + i % 8])
            .collect();
        assert_eq!(token, b"abc");
        // Fresh randomness each time, so the token never repeats verbatim.
        assert_ne!(obfuscate("abc"), obfuscate("abc"));
    }

    #[test]
    fn realname_link_is_the_bilibili_page_with_a_double_encoded_token() {
        let url = realname_url("fictional-token");
        let parsed = reqwest::Url::parse(&url).unwrap();
        assert_eq!(parsed.host_str(), Some("www.bilibili.com"));
        assert_eq!(parsed.path(), "/h5/risk-control/realname");
        let (key, once) = parsed.query_pairs().next().unwrap();
        assert_eq!(key, "t");
        // One decode still leaves the page's own encoding in place.
        assert!(!once.contains('+') && !once.contains('='));
        assert_eq!(percent_encode("a+b/c="), "a%2Bb/c%3D");
        assert_eq!(percent_encode(&percent_encode("+")), "%252B");
    }

    #[test]
    fn page_fingerprint_matches_the_script_shape() {
        let track: Value = serde_json::from_str(&dm_track()).unwrap();
        assert_eq!(track["dm_img_list"], json!([]));
        assert_eq!(
            track["dm_img_str"],
            "V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ"
        );
        assert!(
            track["dm_cover_img_str"]
                .as_str()
                .unwrap()
                .starts_with("QU5HTEUgKEludGVsLCBJbnRlbChSKSBVSEQg")
        );
        let inter: Value = serde_json::from_str(track["dm_img_inter"].as_str().unwrap()).unwrap();
        let wh = inter["wh"].as_array().unwrap();
        let r = wh[2].as_u64().unwrap();
        assert!(r < 114);
        assert_eq!(wh[0].as_u64().unwrap(), 1840 + 3 * r);
        assert_eq!(wh[1].as_u64().unwrap(), 1580 + r);
        let of = inter["of"].as_array().unwrap();
        assert_eq!(of[1].as_u64().unwrap(), 2 * of[0].as_u64().unwrap());
    }
}
