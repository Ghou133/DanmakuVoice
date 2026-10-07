# 许可与归属

超绝可爱弹幕姬（DanmakuVoice）采用 [AGPL-3.0-only](LICENSE)。

功能与旧配置格式参考 [kinoko7danmaku](https://github.com/MerlinCN/kinoko7danmaku)（GNU AGPL v3 © MerlinCN）及其 [Ghou133 分支](https://github.com/Ghou133/kinoko7danmaku)。本项目独立维护。

B站开播管理的功能和 HTTP 协议参照 [Zarosmm/obs-bilibili-stream](https://github.com/Zarosmm/obs-bilibili-stream)，由 Rust 独立实现，未复制或链接其 C++/Qt/OBS 代码。参照版本和实现说明见 [BROADCAST.md](docs/BROADCAST.md)。

FFmpeg 以独立子进程运行，使用 LGPL 2.1 或更高版本。对应源码、许可和构建参数见对应源码包及 [FFMPEG.md](docs/FFMPEG.md)。Rust 依赖的原始许可及归属文件位于商店安装包的 `third-party/`，便携分发则见配套 `DanmakuVoice-licenses.zip`；依赖源码见同版 `DanmakuVoice-source.zip`。材料完整性核验不能代替每项上游义务的人工审阅。

应用图标使用用户提供的插画；作品与角色权利归原权利人，代码许可证不授予这些权利。原图及处理记录保留在源码 `crates/desktop/icons/`，见 [ARTWORK.md](crates/desktop/icons/ARTWORK.md)。

界面内置字体 DanmakuVoice Serif SC 是 [Google Fonts Noto Serif SC](https://github.com/google/fonts/tree/main/ofl/notoserifsc) 2.003-H1 可变 TrueType 的子集并改名（Copyright 2012 Google Inc.；© 2017-2024 Adobe），保留原可变轮廓与字重插值，按 SIL Open Font License 1.1 分发，许可全文见 `crates/desktop/ui/fonts/OFL.txt`，生成方式见 `scripts/build-serif-subset.py`。Noto 是 Google Inc. 的商标。

OBS 叠加层与其设置预览的英文刊头使用 [Instrument Serif](https://github.com/Instrument/instrument-serif)（Copyright 2022 The Instrument Serif Project Authors）Google Fonts 发布的拉丁子集，未修改，按 SIL Open Font License 1.1 分发，许可全文见 `crates/desktop/ui/fonts/OFL-InstrumentSerif.txt`。
