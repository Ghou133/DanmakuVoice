//! Non-GUI event, rule, scheduling and service core for DanmakuVoice.

pub mod audience;
pub mod audio;
pub mod bilibili;
pub mod broadcast;
pub mod chat_send;
pub mod diagnostics;
pub mod error_codes;
pub mod event_pipeline;
pub mod ffmpeg;
pub mod legacy;
pub mod live;
pub mod migration;
pub mod model;
pub mod moderation;
pub mod obs;
pub mod obs_process;
pub mod playback;
pub mod received_emotes;
pub mod rules;
pub mod scheduler;
pub mod secrets;
pub mod storage;
pub mod tts;
pub mod voice_library;
pub mod wav;

#[cfg(windows)]
pub mod owned_process;
