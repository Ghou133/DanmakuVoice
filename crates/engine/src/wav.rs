//! Incremental PCM16 RIFF/WAVE parser for dots.tts and GPT-SoVITS streams.

use thiserror::Error;

const MAX_HEADER_CHUNK: usize = 1024 * 1024;

#[derive(Debug, Error, Eq, PartialEq)]
pub enum WavError {
    #[error("音频不是 RIFF/WAVE 格式")]
    NotWave,
    #[error("WAV 头缺少 fmt 数据")]
    MissingFormat,
    #[error("WAV 头过大或无效")]
    HeaderTooLarge,
    #[error("仅支持单声道或双声道 PCM16 WAV 流")]
    UnsupportedFormat,
    #[error("WAV 未返回可播放音频")]
    NoAudio,
    #[error("WAV 音频流截断")]
    Truncated,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PcmFormat {
    pub sample_rate: u32,
    pub channels: u16,
}

#[derive(Default)]
pub struct WavPcmParser {
    buffer: Vec<u8>,
    riff_seen: bool,
    format: Option<PcmFormat>,
    in_data: bool,
    remaining: Option<usize>,
    frames: usize,
}

impl WavPcmParser {
    pub fn format(&self) -> Option<PcmFormat> {
        if self.in_data { self.format } else { None }
    }

    /// Returns aligned PCM bytes. WAV headers may be split at any byte.
    pub fn feed(&mut self, data: &[u8]) -> Result<Vec<u8>, WavError> {
        if self.in_data && self.remaining == Some(0) {
            return Ok(Vec::new());
        }
        self.buffer.extend_from_slice(data);
        if !self.riff_seen {
            if self.buffer.len() < 12 {
                return Ok(Vec::new());
            }
            if &self.buffer[..4] != b"RIFF" || &self.buffer[8..12] != b"WAVE" {
                return Err(WavError::NotWave);
            }
            self.buffer.drain(..12);
            self.riff_seen = true;
        }
        while !self.in_data {
            if self.buffer.len() < 8 {
                return Ok(Vec::new());
            }
            let tag = &self.buffer[..4];
            let size =
                u32::from_le_bytes(self.buffer[4..8].try_into().expect("four bytes")) as usize;
            if tag == b"data" {
                if self.format.is_none() {
                    return Err(WavError::MissingFormat);
                }
                self.buffer.drain(..8);
                self.in_data = true;
                // Both dots (0xffffffff) and GPT-SoVITS (zero) use a WAV
                // header before a stream with no known size.
                self.remaining = if size == u32::MAX as usize || size == 0 {
                    None
                } else {
                    Some(size)
                };
                break;
            }
            if size > MAX_HEADER_CHUNK {
                return Err(WavError::HeaderTooLarge);
            }
            let total = 8 + size + size % 2;
            if self.buffer.len() < total {
                return Ok(Vec::new());
            }
            if tag == b"fmt " {
                if size < 16 {
                    return Err(WavError::MissingFormat);
                }
                let fmt = &self.buffer[8..24];
                let encoding = u16::from_le_bytes([fmt[0], fmt[1]]);
                let channels = u16::from_le_bytes([fmt[2], fmt[3]]);
                let sample_rate = u32::from_le_bytes(fmt[4..8].try_into().expect("four bytes"));
                let align = u16::from_le_bytes([fmt[12], fmt[13]]);
                let bits = u16::from_le_bytes([fmt[14], fmt[15]]);
                if encoding != 1
                    || bits != 16
                    || !matches!(channels, 1 | 2)
                    || !(8_000..=192_000).contains(&sample_rate)
                    || align != channels * 2
                {
                    return Err(WavError::UnsupportedFormat);
                }
                self.format = Some(PcmFormat {
                    sample_rate,
                    channels,
                });
            }
            self.buffer.drain(..total);
        }
        let format = self.format.expect("checked above");
        let align = usize::from(format.channels) * 2;
        let available = self.remaining.map_or(self.buffer.len(), |remaining| {
            self.buffer.len().min(remaining)
        });
        let count = available - available % align;
        if count == 0 {
            return Ok(Vec::new());
        }
        let pcm = self.buffer.drain(..count).collect();
        if let Some(remaining) = self.remaining.as_mut() {
            *remaining -= count;
        }
        self.frames += count / align;
        Ok(pcm)
    }

    pub fn finish(&self) -> Result<(), WavError> {
        if !self.in_data {
            return Err(WavError::NoAudio);
        }
        if self.remaining.is_some_and(|remaining| remaining != 0)
            || (self.remaining.is_none() && !self.buffer.is_empty())
        {
            return Err(WavError::Truncated);
        }
        if self.frames == 0 {
            return Err(WavError::NoAudio);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav() -> Vec<u8> {
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&u32::MAX.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&24_000u32.to_le_bytes());
        wav.extend_from_slice(&48_000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&u32::MAX.to_le_bytes());
        wav.extend_from_slice(&[1, 0, 2, 0, 3, 0, 4, 0]);
        wav
    }

    #[test]
    fn arbitrary_packet_boundaries_and_unknown_size() {
        let input = wav();
        for packet in [1, 3, 17, 44, 1024] {
            let mut parser = WavPcmParser::default();
            let mut output = Vec::new();
            for bytes in input.chunks(packet) {
                output.extend(parser.feed(bytes).unwrap());
            }
            parser.finish().unwrap();
            assert_eq!(
                parser.format(),
                Some(PcmFormat {
                    sample_rate: 24_000,
                    channels: 1
                })
            );
            assert_eq!(output, input[44..]);
        }
    }

    #[test]
    fn rejects_truncated_and_invalid_data() {
        let mut parser = WavPcmParser::default();
        assert_eq!(
            parser.feed(b"{\"error\":true}").unwrap_err(),
            WavError::NotWave
        );
        let mut parser = WavPcmParser::default();
        parser.feed(&wav()[..45]).unwrap();
        assert_eq!(parser.finish(), Err(WavError::Truncated));
    }
}
