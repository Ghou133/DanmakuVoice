//! Non-GUI event, rule, scheduling and service core for DanmakuVoice.

pub mod audio;
pub mod bilibili;
pub mod diagnostics;
pub mod event_pipeline;
pub mod ffmpeg;
pub mod legacy;
pub mod live;
pub mod migration;
pub mod model;
pub mod playback;
pub mod rules;
pub mod scheduler;
pub mod secrets;
pub mod storage;
pub mod tts;
pub mod voice_library;
pub mod wav;
