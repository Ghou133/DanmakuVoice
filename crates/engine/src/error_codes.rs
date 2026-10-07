//! User-facing error labels. These are stable support identifiers, not log IDs.
//! Callers still own redaction; this module never logs or inspects credentials.

/// Keep specific source codes through wrapping and put them after the prose.
/// A boundary code is used only when the source did not supply one.
pub fn tag(message: impl AsRef<str>, fallback: &str) -> String {
    let mut rest = message.as_ref();
    let mut prose = String::new();
    let mut codes = Vec::new();
    while let Some(start) = rest.find("[DV-") {
        prose.push_str(&rest[..start]);
        rest = &rest[start..];
        if let Some(end) = rest.find(']') {
            let code = &rest[1..end];
            if (5..=24).contains(&code.len())
                && code
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'-')
            {
                while prose.ends_with(char::is_whitespace) {
                    prose.pop();
                }
                if !codes.contains(&code) {
                    codes.push(code);
                }
                rest = &rest[end + 1..];
                continue;
            }
        }
        prose.push('[');
        rest = &rest[1..];
    }
    prose.push_str(rest);
    if codes.is_empty() {
        codes.push(fallback);
    }
    let suffix = codes
        .into_iter()
        .map(|code| format!("[{code}]"))
        .collect::<Vec<_>>()
        .join(" ");
    format!("{} {suffix}", prose.trim())
}

/// Fallback for older string-based command handlers. Never encode payloads.
pub fn command_code(action: &str) -> &'static str {
    match action.split('.').next().unwrap_or_default() {
        "bili" => "DV-X01",
        "doubao" => "DV-X02",
        "fish" => "DV-X03",
        "live" | "onboarding" => "DV-X04",
        "audition" | "queue" => "DV-X05",
        "audio" | "devices" => "DV-X06",
        "local_services" => "DV-X07",
        "connections" | "presets" | "bindings" => "DV-X08",
        "preferences" | "rules" | "startup" => "DV-X09",
        "migration" | "data" | "assets" | "aliases" => "DV-X10",
        "external" => "DV-X11",
        "overlay" => "DV-X17",
        "obs" => "DV-X18",
        _ => "DV-X00",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn boundaries_keep_specific_causes_and_move_codes_to_the_end() {
        assert_eq!(
            tag("启动失败 [DV-C02]；本条停止", "DV-X05"),
            "启动失败；本条停止 [DV-C02]"
        );
        let message = tag("登录失败 [DV-TD02] [DV-TD02]", "DV-X02");
        assert_eq!(message, "登录失败 [DV-TD02]");
        assert_eq!(tag(&message, "DV-X00"), message);
        assert_eq!(tag("字段未填写", "DV-X08"), "字段未填写 [DV-X08]");
        assert_eq!(command_code("fish.connect"), "DV-X03");
    }

    #[test]
    fn provider_and_failure_kind_are_stable_independent_of_user_facing_prose() {
        use crate::tts::TtsError;
        let make = |service, reason| TtsError::Network {
            service,
            stage: "连接",
            reason,
        };
        let first = make("豆包", "连接超时");
        let reworded = make("豆包", "暂时无法连接");
        assert_eq!(first.code(), "DV-TD06");
        assert_eq!(first.code(), reworded.code());
        assert_eq!(make("豆包扫码登录", "连接超时").code(), "DV-TQ06");
        assert_eq!(make("Fish Audio", "连接超时").code(), "DV-TF06");
        let auth = TtsError::HttpStatus {
            service: "Fish Audio",
            status: 401,
            reason: "请检查登录",
        };
        assert!(tag(auth.to_string(), "DV-X03").ends_with("[DV-TF02]"));
        assert!(!tag(auth.to_string(), "DV-X03").contains("DV-X03"));
    }
}
