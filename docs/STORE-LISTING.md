# Microsoft Store 商店资料

产品：超绝可爱弹幕姬；Store ID：9P4DFD8HGN03；发布者：CurePirsm。

## 中文介绍

把直播间弹幕变成声音，让直播互动更轻松。

超绝可爱弹幕姬是一款免费开源的 Windows 弹幕接收与语音播报工具，可接收哔哩哔哩直播间消息，并按你的规则播放语音或音效。

- 接收直播弹幕和直播事件，支持按主播 UID 连接。
- 选择豆包、Fish Audio，或连接自行部署的 dots.tts、GPT-SoVITS 语音服务。
- 管理音色、试听语音，为指定用户设置不同的声音。
- 设置播报规则、文字替换、用户过滤与音效。
- 查看待播队列、选择立即朗读、开关弹幕播报、静音并选择音频输出设备。
- 提供浅色／深色主题、本地配置管理与可选开机启动。

本应用免费、开源、无广告，不含应用内购买。第三方语音服务可能需要独立账号、API Key 或自行部署，服务商可能单独收取费用。本应用不包含本地语音模型，也不提供第三方账号或额度。

登录凭据在当前 Windows 用户范围内加密保存。弹幕文本会按你选择的语音服务发送用于合成。请参阅隐私说明，并仅使用你有权使用的账号、音色和音频素材。

本项目为独立开发，与哔哩哔哩、豆包、Fish Audio 无官方隶属关系。需要 Windows 10 2004 或更新版本（x64）及 Microsoft Edge WebView2 Runtime。

## 简短介绍

免费开源的哔哩哔哩弹幕语音播报工具，支持多种语音服务、个性音色与播报规则。

## 审核说明（英文）

This is a free, open-source Windows desktop utility for receiving Bilibili live-room messages and playing text-to-speech or user-selected audio. It does not send chat messages or host a social network. Incoming live chat is third-party user-generated content; the age questionnaire declares user content conservatively. User/keyword playback filtering is available, but the app does not implement reporting or server-side chat moderation.

No developer account, payment, or administrator privileges are needed to open the app. The welcome page leads to a choice of QR login or an anonymous broadcaster UID. Bilibili login can be skipped; a broadcaster UID is needed to connect anonymously. On the voice setup step, speech can be disabled. In Settings > General (通用) > Audio output (音频输出), “测试声音” generates a short local tone through the real decoder and selected device, without a cloud account. To test cloud speech, add your own supported provider account/API key; no developer credentials are included. Local TTS requires a separately installed service/model.

The runFullTrust capability is required by the Rust/Tauri desktop application for its WebView2 window, system audio output, user-selected files, and spawning its bundled FFmpeg decoder. Optional local TTS services are started only when configured by the user. FFmpeg is launched directly from the installed MSIX directory; no executable is downloaded or extracted to AppData for the Store build. StartupTask is disabled by default and is enabled only through the user's setting. Updates are managed by Microsoft Store.

The submission includes FFmpeg (LGPL-2.1-or-later), original third-party license notices, and a link to the exact complete source archive. The application's own source is AGPL-3.0-only. Source and support: https://github.com/Ghou133/DanmakuVoice

## 提交状态

商店文案不构成安装验收。上架及签名以 Partner Center 状态为准；SAC 开启环境仍需实际验证。
