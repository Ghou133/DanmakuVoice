//! Ordinary room entry, independent of paid/level-based ENTRY_EFFECT packets.
//!
//! Wire fields were checked against the embedded entry_effect.proto and
//! user_basic.proto descriptors in official Livehime 7.30.0.9821 bililive.dll
//! (SHA256 c2dc9d34fe888dd2526d2b5734eb5692a5aa0d170fc75bcc2a6ca21fb7a7faf9).
//! This bounded reader intentionally decodes only fields needed for a greeting.

use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;

use super::bili_image_url;
use crate::model::{EventKind, LiveEvent};

const MAX_PROTOBUF_BYTES: usize = 64 * 1024;
const MAX_BASE64_BYTES: usize = MAX_PROTOBUF_BYTES.div_ceil(3) * 4;
const MAX_NAME_BYTES: usize = 1024;

#[derive(Default)]
struct DisplayUser<'a> {
    name: Option<&'a str>,
    face: Option<&'a str>,
}

#[derive(Default)]
struct UserInfo<'a> {
    uid: Option<u64>,
    display: DisplayUser<'a>,
    risk: DisplayUser<'a>,
    is_mystery: bool,
}

#[derive(Default)]
struct Entry<'a> {
    uid: Option<u64>,
    display: DisplayUser<'a>,
    user: UserInfo<'a>,
    msg_type: u64,
    timestamp: Option<u64>,
    trigger_time: Option<u64>,
    is_mystery: bool,
}

fn positive(value: u64) -> Option<u64> {
    (value > 0 && value <= i64::MAX as u64).then_some(value)
}

fn json_positive(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64).and_then(positive)
}

fn json_flag(value: Option<&Value>) -> bool {
    value.is_some_and(|value| value.as_bool() == Some(true) || value.as_u64() == Some(1))
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.trim().is_empty())
}

fn json_display<'a>(value: Option<&'a Value>, name_key: &str) -> DisplayUser<'a> {
    DisplayUser {
        name: nonempty(
            value
                .and_then(|value| value.get(name_key))
                .and_then(Value::as_str),
        ),
        face: nonempty(
            value
                .and_then(|value| value.get("face"))
                .and_then(Value::as_str),
        ),
    }
}

pub(super) fn parse_json(room_id: u64, data: &Value) -> Option<LiveEvent> {
    let user = data.get("uinfo");
    let base = user.and_then(|user| user.get("base"));
    Entry {
        uid: json_positive(data.get("uid")),
        display: json_display(Some(data), "uname"),
        user: UserInfo {
            uid: json_positive(user.and_then(|user| user.get("uid"))),
            display: json_display(base, "name"),
            risk: json_display(base.and_then(|base| base.get("risk_ctrl_info")), "name"),
            is_mystery: json_flag(base.and_then(|base| base.get("is_mystery"))),
        },
        msg_type: data.get("msg_type")?.as_u64()?,
        timestamp: json_positive(data.get("timestamp")),
        trigger_time: json_positive(data.get("trigger_time")),
        is_mystery: json_flag(data.get("is_mystery")),
    }
    .into_event(room_id)
}

impl Entry<'_> {
    fn into_event(self, room_id: u64) -> Option<LiveEvent> {
        if self.msg_type != 1 {
            return None;
        }
        let risk_controlled = self.user.risk.name.is_some() || self.user.risk.face.is_some();
        let mysterious = self.is_mystery || self.user.is_mystery;
        let restricted = mysterious || risk_controlled;
        let (name, face) = if risk_controlled {
            (
                self.user.risk.name.unwrap_or("神秘观众"),
                self.user.risk.face,
            )
        } else if mysterious {
            (
                self.user.display.name.unwrap_or("神秘观众"),
                self.user.display.face,
            )
        } else {
            (
                self.user.display.name.or(self.display.name)?,
                self.user.display.face.or(self.display.face),
            )
        };
        if name.len() > MAX_NAME_BYTES || name.chars().any(char::is_control) {
            return None;
        }
        let uid = (!restricted)
            .then_some(self.user.uid.or(self.uid))
            .flatten();
        let mut event = LiveEvent::danmaku(room_id, uid, name, "进入直播间");
        event.kind = EventKind::Entry;
        // A controlled face must never fall through to an unmasked original.
        // No origin_info field is read, including for mysterious/hidden users.
        event.avatar_url = face.and_then(|face| bili_image_url(Some(&Value::String(face.into()))));
        event.platform_event_id = uid.and_then(|uid| {
            self.trigger_time
                .map(|time| format!("enter:{uid}:trigger:{time}"))
                .or_else(|| {
                    self.timestamp
                        .map(|time| format!("enter:{uid}:timestamp:{time}"))
                })
        });
        Some(event)
    }
}

pub(super) fn parse_protobuf(room_id: u64, data: &Value) -> Option<LiveEvent> {
    let encoded = data.get("pb")?.as_str()?;
    if encoded.is_empty() || encoded.len() > MAX_BASE64_BYTES {
        return None;
    }
    let bytes = STANDARD.decode(encoded).ok()?;
    if bytes.len() > MAX_PROTOBUF_BYTES {
        return None;
    }
    let mut entry = Entry::default();
    let mut reader = Reader::new(&bytes);
    while let Some((number, field)) = reader.next()? {
        match number {
            1 => entry.uid = positive(field.varint()?),
            2 => entry.display.name = nonempty(Some(field.text()?)),
            5 => entry.msg_type = field.varint()?,
            7 => entry.timestamp = positive(field.varint()?),
            15 => entry.trigger_time = positive(field.varint()?),
            21 => entry.is_mystery |= field.varint()? != 0,
            22 => read_user(field.bytes()?, &mut entry.user)?,
            _ => {}
        }
    }
    entry.into_event(room_id)
}

fn read_user<'a>(bytes: &'a [u8], user: &mut UserInfo<'a>) -> Option<()> {
    let mut reader = Reader::new(bytes);
    while let Some((number, field)) = reader.next()? {
        match number {
            1 => user.uid = positive(field.varint()?),
            2 => read_base(field.bytes()?, user)?,
            _ => {}
        }
    }
    Some(())
}

fn read_base<'a>(bytes: &'a [u8], user: &mut UserInfo<'a>) -> Option<()> {
    let mut reader = Reader::new(bytes);
    while let Some((number, field)) = reader.next()? {
        match number {
            1 => user.display.name = nonempty(Some(field.text()?)),
            2 => user.display.face = nonempty(Some(field.text()?)),
            4 => user.is_mystery |= field.varint()? != 0,
            5 => read_display(field.bytes()?, &mut user.risk)?,
            // In particular, field 6 is origin_info: leave it unread.
            _ => {}
        }
    }
    Some(())
}

fn read_display<'a>(bytes: &'a [u8], user: &mut DisplayUser<'a>) -> Option<()> {
    let mut reader = Reader::new(bytes);
    while let Some((number, field)) = reader.next()? {
        match number {
            1 => user.name = nonempty(Some(field.text()?)),
            2 => user.face = nonempty(Some(field.text()?)),
            _ => {}
        }
    }
    Some(())
}

enum Field<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
    Fixed,
}

impl<'a> Field<'a> {
    fn varint(self) -> Option<u64> {
        match self {
            Self::Varint(value) => Some(value),
            _ => None,
        }
    }

    fn bytes(self) -> Option<&'a [u8]> {
        match self {
            Self::Bytes(value) => Some(value),
            _ => None,
        }
    }

    fn text(self) -> Option<&'a str> {
        std::str::from_utf8(self.bytes()?).ok()
    }
}

struct Reader<'a> {
    remaining: &'a [u8],
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { remaining: bytes }
    }

    fn varint(&mut self) -> Option<u64> {
        let mut value = 0u64;
        for shift in (0..70).step_by(7) {
            let (&byte, tail) = self.remaining.split_first()?;
            self.remaining = tail;
            if shift == 63 && byte > 1 {
                return None;
            }
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Some(value);
            }
        }
        None
    }

    fn take(&mut self, length: usize) -> Option<&'a [u8]> {
        let (value, tail) = self.remaining.split_at_checked(length)?;
        self.remaining = tail;
        Some(value)
    }

    fn next(&mut self) -> Option<Option<(u32, Field<'a>)>> {
        if self.remaining.is_empty() {
            return Some(None);
        }
        let tag = self.varint()?;
        let number = u32::try_from(tag >> 3).ok()?;
        if number == 0 || number > 0x1fff_ffff {
            return None;
        }
        let field = match tag & 7 {
            0 => Field::Varint(self.varint()?),
            1 => {
                self.take(8)?;
                Field::Fixed
            }
            2 => {
                let length = usize::try_from(self.varint()?).ok()?;
                Field::Bytes(self.take(length)?)
            }
            5 => {
                self.take(4)?;
                Field::Fixed
            }
            // Deprecated groups and invalid wire types are not accepted.
            _ => return None,
        };
        Some(Some((number, field)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bilibili::{decode_live_events, encode_packet, parse_live_event};
    use flate2::{Compression, write::ZlibEncoder};
    use serde_json::json;
    use std::io::Write;

    fn varint(mut value: u64) -> Vec<u8> {
        let mut result = Vec::new();
        while value >= 0x80 {
            result.push((value as u8 & 0x7f) | 0x80);
            value >>= 7;
        }
        result.push(value as u8);
        result
    }

    fn number(field: u32, value: u64) -> Vec<u8> {
        [varint(u64::from(field) << 3), varint(value)].concat()
    }

    fn bytes(field: u32, value: &[u8]) -> Vec<u8> {
        [
            varint((u64::from(field) << 3) | 2),
            varint(value.len() as u64),
            value.to_vec(),
        ]
        .concat()
    }

    fn packet(raw: &[u8]) -> Value {
        json!({"cmd":"INTERACT_WORD_V2","data":{"pb":STANDARD.encode(raw)}})
    }

    fn ordinary(msg_type: u64) -> Vec<u8> {
        [
            number(1, 7),
            bytes(2, "普通观众".as_bytes()),
            number(5, msg_type),
            number(7, 1_761_000_000),
            number(15, 1_761_000_000_123_456_789),
        ]
        .concat()
    }

    #[test]
    fn ordinary_v1_and_v2_entries_match_without_medal_or_entry_effect() {
        let old = json!({"cmd":"INTERACT_WORD","data":{"uid":7,"uname":"普通观众","msg_type":1,"timestamp":1761000000,"trigger_time":1761000000123456789u64}});
        let expected = parse_live_event(42, 99, &old).unwrap();
        assert_eq!(expected.kind, EventKind::Entry);
        assert_eq!(expected.user_id, Some(7));
        assert_eq!(expected.user_name, "普通观众");
        assert_eq!(expected.message, "进入直播间");
        assert_eq!(expected.observed_at_ms, 99);
        assert_eq!(
            expected.platform_event_id.as_deref(),
            Some("enter:7:trigger:1761000000123456789")
        );
        assert_eq!(
            parse_live_event(42, 99, &packet(&ordinary(1))),
            Some(expected)
        );
        for kind in [0, 2, 3, 4, u64::MAX] {
            let mut old = old.clone();
            old["data"]["msg_type"] = json!(kind);
            assert!(parse_live_event(42, 99, &old).is_none());
            assert!(parse_live_event(42, 99, &packet(&ordinary(kind))).is_none());
        }
        for cmd in ["ENTRY_EFFECT", "ENTRY_EFFECT_MUST_RECEIVE", "WELCOME_GUARD"] {
            let mut old = old.clone();
            old["cmd"] = json!(cmd);
            assert!(parse_live_event(42, 99, &old).is_none());
        }
    }

    #[test]
    fn entries_share_the_existing_compressed_packet_decoder() {
        let inner = [
            encode_packet(5, 1, &serde_json::to_vec(&packet(&ordinary(1))).unwrap()),
            encode_packet(5, 1, &serde_json::to_vec(&packet(&ordinary(2))).unwrap()),
            encode_packet(
                5,
                1,
                br#"{"cmd":"DANMU_MSG","info":[[],"hello",[8,"Alice"]]}"#,
            ),
        ]
        .concat();
        let expected = decode_live_events(42, 99, &inner).unwrap();
        assert_eq!(expected.len(), 2);
        assert_eq!(expected[0].kind, EventKind::Entry);
        assert_eq!(expected[1].kind, EventKind::Danmaku);
        let mut zlib = ZlibEncoder::new(Vec::new(), Compression::default());
        zlib.write_all(&inner).unwrap();
        assert_eq!(
            decode_live_events(42, 99, &encode_packet(5, 2, &zlib.finish().unwrap())).unwrap(),
            expected
        );
        let mut compressed = Vec::new();
        {
            let mut writer = brotli::CompressorWriter::new(&mut compressed, 4096, 5, 22);
            writer.write_all(&inner).unwrap();
        }
        assert_eq!(
            decode_live_events(42, 99, &encode_packet(5, 3, &compressed)).unwrap(),
            expected
        );
    }

    #[test]
    fn public_user_details_override_top_level_and_origin_info_is_never_used() {
        let base = [
            bytes(1, "公开姓名".as_bytes()),
            bytes(2, b"http://i1.hdslb.com/bfs/face/public.jpg"),
            bytes(6, &bytes(1, "不应使用的原始姓名".as_bytes())),
        ]
        .concat();
        let raw = [
            ordinary(1),
            bytes(22, &[number(1, 9), bytes(2, &base)].concat()),
        ]
        .concat();
        let event = parse_live_event(42, 99, &packet(&raw)).unwrap();
        assert_eq!(event.user_name, "公开姓名");
        assert_eq!(event.user_id, Some(9));
        assert_eq!(
            event.avatar_url.as_deref(),
            Some("https://i1.hdslb.com/bfs/face/public.jpg")
        );
        let origin_only = [
            number(1, 7),
            number(5, 1),
            bytes(22, &bytes(2, &bytes(6, &bytes(1, "不可回填".as_bytes())))),
        ]
        .concat();
        assert!(parse_live_event(42, 99, &packet(&origin_only)).is_none());
    }

    #[test]
    fn hidden_and_risk_controlled_users_never_keep_uid_or_event_identity() {
        for (top_mystery, base_mystery, risk) in [
            (true, false, false),
            (false, true, false),
            (false, false, true),
        ] {
            let mut base = [
                bytes(1, "公开匿名".as_bytes()),
                number(4, u64::from(base_mystery)),
            ]
            .concat();
            if risk {
                base.extend(bytes(
                    5,
                    &[
                        bytes(1, "受控姓名".as_bytes()),
                        bytes(2, b"https://i2.hdslb.com/bfs/face/hidden.jpg"),
                    ]
                    .concat(),
                ));
            }
            base.extend(bytes(6, &bytes(1, "真实姓名不能播报".as_bytes())));
            let raw = [
                ordinary(1),
                number(21, u64::from(top_mystery)),
                bytes(22, &[number(1, 7), bytes(2, &base)].concat()),
            ]
            .concat();
            let event = parse_live_event(42, 99, &packet(&raw)).unwrap();
            assert_eq!(event.user_id, None);
            assert_eq!(event.platform_event_id, None);
            assert_eq!(event.user_name, if risk { "受控姓名" } else { "公开匿名" });
            let mut old = json!({"cmd":"INTERACT_WORD","data":{"uid":7,"uname":"顶层姓名","msg_type":1,"timestamp":1761000000,"is_mystery":top_mystery,"uinfo":{"uid":7,"base":{"name":"公开匿名","is_mystery":base_mystery,"origin_info":{"name":"真实姓名不能播报"}}}}});
            if risk {
                old["data"]["uinfo"]["base"]["risk_ctrl_info"] = json!({
                    "name":"受控姓名","face":"https://i2.hdslb.com/bfs/face/hidden.jpg"
                });
            }
            assert_eq!(parse_live_event(42, 99, &old), Some(event));
        }
    }

    #[test]
    fn incomplete_controlled_identity_never_falls_back_to_original_fields() {
        let top = json!({"cmd":"INTERACT_WORD","data":{"uid":7,"uname":"不回填顶层姓名","face":"https://i1.hdslb.com/bfs/face/original.jpg","msg_type":1,"timestamp":123}});
        let mut mysterious = top.clone();
        mysterious["data"]["is_mystery"] = json!(true);
        let event = parse_live_event(42, 99, &mysterious).unwrap();
        assert_eq!(event.user_name, "神秘观众");
        assert_eq!(event.user_id, None);
        assert_eq!(event.avatar_url, None);
        assert_eq!(
            parse_live_event(42, 99, &packet(&[ordinary(1), number(21, 1)].concat())),
            Some(event)
        );
        for risk in [
            json!({"name":"受控姓名"}),
            json!({"face":"https://i2.hdslb.com/bfs/face/hidden.jpg"}),
        ] {
            let mut old = top.clone();
            old["data"]["uinfo"] = json!({
                "uid":7,
                "base":{"name":"不回填普通姓名","face":"https://i1.hdslb.com/bfs/face/original.jpg","risk_ctrl_info":risk}
            });
            let event = parse_live_event(42, 99, &old).unwrap();
            assert_eq!(event.user_id, None);
            assert_eq!(event.platform_event_id, None);
            assert_eq!(event.user_name, risk["name"].as_str().unwrap_or("神秘观众"));
            assert_eq!(event.avatar_url.as_deref(), risk["face"].as_str());
            let mut risk_bytes = Vec::new();
            if let Some(name) = risk["name"].as_str() {
                risk_bytes.extend(bytes(1, name.as_bytes()));
            }
            if let Some(face) = risk["face"].as_str() {
                risk_bytes.extend(bytes(2, face.as_bytes()));
            }
            let base = [
                bytes(1, "不回填普通姓名".as_bytes()),
                bytes(2, b"https://i1.hdslb.com/bfs/face/original.jpg"),
                bytes(5, &risk_bytes),
            ]
            .concat();
            let raw = [ordinary(1), bytes(22, &bytes(2, &base))].concat();
            assert_eq!(parse_live_event(42, 99, &packet(&raw)), Some(event));
        }
    }

    #[test]
    fn missing_identity_or_time_never_creates_a_name_based_event_id() {
        for uid in [0, u64::MAX] {
            let old = json!({"cmd":"INTERACT_WORD","data":{"uid":uid,"uname":"访客","msg_type":1,"timestamp":1761000000}});
            let event = parse_live_event(42, 99, &old).unwrap();
            assert_eq!(event.user_id, None);
            assert_eq!(event.platform_event_id, None);
        }
        let old = json!({"cmd":"INTERACT_WORD","data":{"uid":7,"uname":"观众","msg_type":1}});
        assert_eq!(
            parse_live_event(42, 99, &old).unwrap().platform_event_id,
            None
        );
        let mut timestamp = old;
        timestamp["data"]["timestamp"] = json!(123);
        assert_eq!(
            parse_live_event(42, 99, &timestamp)
                .unwrap()
                .platform_event_id
                .as_deref(),
            Some("enter:7:timestamp:123")
        );
    }

    #[test]
    fn unknown_fields_are_skipped_but_bad_wire_data_is_rejected() {
        let future = [
            ordinary(1),
            number(100, 12),
            bytes(101, b"future"),
            [varint((102 << 3) | 1), vec![0; 8]].concat(),
            [varint((103 << 3) | 5), vec![0; 4]].concat(),
        ]
        .concat();
        assert!(parse_live_event(42, 99, &packet(&future)).is_some());
        for bad in [
            vec![0],
            vec![0x80],
            vec![0xff; 10],
            [vec![0x80; 9], vec![2]].concat(),
            [varint((100 << 3) | 2), varint(u64::MAX)].concat(),
            bytes(5, b"wrong wire type"),
            bytes(2, &[0xff]),
            vec![0x0b],
            vec![0x0f],
            [varint((100 << 3) | 1), vec![0; 7]].concat(),
            bytes(22, &bytes(2, &[0x12, 0x7f])),
        ] {
            let raw = [ordinary(1), bad].concat();
            assert!(parse_live_event(42, 99, &packet(&raw)).is_none());
        }
        for encoded in ["%%%".to_owned(), "A".repeat(MAX_BASE64_BYTES + 1)] {
            assert!(
                parse_live_event(
                    42,
                    99,
                    &json!({"cmd":"INTERACT_WORD_V2","data":{"pb":encoded}})
                )
                .is_none()
            );
        }
        let over_limit = [ordinary(1), bytes(100, &vec![0; MAX_PROTOBUF_BYTES])].concat();
        assert!(parse_live_event(42, 99, &packet(&over_limit)).is_none());
        let long_name = [ordinary(1), bytes(2, &vec![b'a'; MAX_NAME_BYTES + 1])].concat();
        assert!(parse_live_event(42, 99, &packet(&long_name)).is_none());
    }
}
