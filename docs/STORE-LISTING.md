# Microsoft Store 商店资料

产品：超绝可爱弹幕姬（DanmakuVoice）；Store ID：9P4DFD8HGN03；商店发布者显示名称：CurePrism。

2026-10-20 状态：应用 0.3.4 / MSIX 1.3.4.0（构建提交 `2f908fe9`）已以 Submission 5（`1152921505702175885`）正式送审。后台显示 Update in certification，提交完成、预处理进行中，认证和发布尚未开始；通过认证后自动发布。中英文 0.3.4 更新说明、18 张新截图及审核说明已保存核对。[独立 Windows CI](https://github.com/Ghou133/DanmakuVoice/actions/runs/39353795931) 全部成功，[对应完整源码 store-v1.3.4.0](https://github.com/Ghou133/DanmakuVoice/releases/tag/store-v1.3.4.0) 已公开；尚未确认新版认证通过或上架。构建校验和及验收边界见 PROGRESS.md。

此前版本：应用 0.3.3 / MSIX 1.3.3.0（构建提交 `ba89d579`）于 2026-10-18 以 Submission 4 送审；2026-10-20 本轮在 Partner Center 实际核对，该提交已处于当前商店在售状态。对应完整源码见 [store-v1.3.3.0](https://github.com/Ghou133/DanmakuVoice/releases/tag/store-v1.3.3.0)，应用发行说明见 [v0.3.3](https://github.com/Ghou133/DanmakuVoice/releases/tag/v0.3.3)。

以下文案按 Partner Center“商店一览”的字段整理，可直接复制。上传前请在 Partner Center 中核对各字段的当前字数限制。截图素材见文末“截图”一节。

- 对应构建：水月重设计（本地分支 `lake-redesign`，提交 `453985e` 起）。主界面、设置抽屉和初次设置都已换新；旧的待读列表、控制坞、音频输出设备选择和平铺设置页不再存在，文案不再提及。
- 商店一览的公开内容（名称、介绍、描述、功能、截图及说明、搜索词、版本新增内容、版权）**不出现“豆包”“哔哩哔哩”**，也不写 B站、Bilibili、Doubao（2026-10-18 用户要求）。直播平台写作“受支持的直播平台／直播间”，语音服务写作“支持的云端语音服务”“自行部署的本地语音服务”。GitHub README 不受此限制。
- 本次准备应用版本 0.3.5，包版本 1.3.5.0；Partner Center 的“版本新增内容”在下述变化正文前加 `0.3.5` 版本行。

## 简体中文（zh-CN）

### 产品名称

超绝可爱弹幕姬

### 简短介绍

把直播间弹幕读成你喜欢的声音。正在读的那一句倒映在湖面上；为熟悉的观众设置专属读法和声音，还能把弹幕叠加层放进 OBS。免费、开源、无广告。

### 描述

把直播间弹幕，读成你喜欢的声音。

超绝可爱弹幕姬是一款免费开源的 Windows 弹幕语音播报工具。它接收受支持直播间的弹幕、礼物、醒目留言和上舰消息，按你定的规则用你选的声音读出来，让主播不用一直盯着屏幕也能接住每一条互动。

【倒影朗读】
正在读的那一句浮在湖面上，水里是它的倒影；倒影随播放进度逐字亮起。鼠标移到水面，刚读过的几句会浮上来；往下滚潜进水下，就能翻看本场的全部弹幕，礼物和醒目留言一眼就能找到。

【声音随手换】
点右下角的声音名字，切换音色、开关播报，鼠标移上去可以先试听。名字下面那条水线就是音量，滚轮调节，点一下静音。

【云端或本地】
可连接支持的云端语音服务，也可以接入自行部署的本地语音服务；本地服务没开时，点一下就会帮你启动。所有声音放在同一张列表里，原地试听、改名字、调语速和音量。

【观众专属】
点一下弹幕，就能设置这位观众的名字怎么读、用哪个声音，还能看到 TA 今晚说过的话。熟悉的观众一开口就认得出。

【记住的读法】
观众名字、正文用词和表情的读法收在一页，搜索、添加都在原地完成。读哪些消息、礼物和醒目留言的金额门槛、播报模板、关键词音效，都在“高级”里，平时不用管。

【开播与 OBS】
登录后可以在主界面开播、下播，原地修改标题和分区，发送弹幕和表情；按账号权限禁言、拉黑或任免房管。连接 OBS 后，一键把弹幕叠加层放进直播场景，直接拖动摆放和缩放，改动自动同步；开播时也可以同步控制 OBS 推流。

【简单上手】
扫码登录受支持的直播平台账号，自动连接自己的直播间，选好声音就能开始。关掉播报时弹幕照常显示。点太阳或月亮切换晨雾与夜幕，简体中文／English 界面，设置改动自动保存，可选开机启动。

【放心使用】
免费、开源、无广告，不含应用内购买。登录凭据和 API Key 只在本机按当前 Windows 用户加密保存；应用不内置开发者的数据收集或使用统计。待播报的文字只会发送给你选择的语音服务。

请注意：第三方语音服务可能需要独立账号、API Key 或自行部署，服务商可能另行收费。本应用不包含本地语音模型，也不提供第三方账号或额度。OBS 需另行安装。请仅使用你有权使用的账号、音色和音频素材。

本应用由独立第三方开发。兼容范围、使用前提与配置步骤详见项目 GitHub 文档。源代码以 AGPL-3.0-only 许可公开：https://github.com/Ghou133/DanmakuVoice

### 产品功能（每行一项）

- 接收受支持直播间的弹幕、礼物、醒目留言和上舰消息
- 正在读的弹幕倒映在湖面上，随播放进度逐字点亮
- 往下滚翻看本场全部弹幕
- 点声音名字切换音色、开关播报，水线调音量
- 接入支持的云端语音服务或自行部署的本地语音服务
- 为观众设置名字读法和专属声音
- 观众名字、正文用词和表情读法集中管理
- 消息类型、金额门槛、播报模板与关键词音效
- 主界面开播、下播、修改标题，发送弹幕和表情
- 一键把弹幕叠加层放进 OBS，拖动摆放
- 晨雾／夜幕主题，简体中文／English 界面
- 免费、开源、无广告，凭据仅在本机加密保存

### 搜索词

DanmakuVoice；超绝可爱弹幕姬；弹幕；弹幕姬；语音播报；直播助手；文字转语音

### 版本新增内容

- 改进开播与身份验证流程
- 支持播报普通观众进入直播间，可在设置中开启，默认关闭
- 改进入场事件处理与播报队列的稳定性

### 截图说明（与截图依次对应）

1. 把弹幕，读成声音。正在读的那一句浮在湖面上，倒影随播放进度逐字亮起。
2. 换个声音，点一下就好。名字下面那条水线就是音量，滚轮一拨就好。
3. 熟悉的观众，熟悉的声音。点一下弹幕，设置这位观众的名字怎么读、用哪个声音。
4. 往下滚，翻看今晚。本场的弹幕都沉在湖里，礼物和醒目留言一眼就能找到。
5. 云端或本地，都能接。所有声音一张列表，原地试听和编辑。
6. 名字和词，都读得对。观众名字、正文用词和表情的读法收在一页。
7. 弹幕，也放进直播画面。连接 OBS 后点一下添加，再直接拖动摆放。
8. 开播之前，先写好标题。点太阳或月亮切换晨雾和夜幕。
9. 一分钟，开始播报。扫码登录自己的直播间，选好声音就能开始。

### 版权与商标信息

© 2026 CurePrism。应用代码以 AGPL-3.0-only 许可发布。应用图标插画的作品与角色权利归原权利人。第三方服务名称及商标属于其各自权利人。

### 其他许可条款

本应用以 GNU Affero General Public License v3.0 only 许可发布，完整源代码与第三方许可见 https://github.com/Ghou133/DanmakuVoice

## English (en-US)

### Product name

超绝可爱弹幕姬

### Short description

Hear live chat in the voice you love, mirrored in a moonlit lake. Give regulars their own pronunciation and voice, and put chat in OBS. Free, open source and ad-free.

### Description

Hear your live chat in the voice you love.

DanmakuVoice (超绝可爱弹幕姬) is an independent, free, open-source text-to-speech companion for supported live rooms on Windows. It receives chat messages, gifts, Super Chats and memberships from a live room and reads them aloud using your rules and your chosen voice, so streamers can keep up with every viewer without watching the screen.

REFLECTIONS
The line being read floats above a lake, and its reflection lights up progressively with playback. Hover over the water to bring up the last few lines; scroll down to dive in and browse every message from this session, with gifts and Super Chats easy to spot.

A NEW VOICE IN ONE CLICK
Click the voice name in the corner to switch voices or turn speech on and off, and audition a voice before you pick it. The waterline under the name is the volume: scroll to adjust, click to mute.

CLOUD OR LOCAL
Connect supported cloud speech services with your own account or API key, or use your self-hosted speech services; a stopped local service starts with one click. All voices sit in one list where you audition, rename and set speed and volume in place.

A VOICE FOR EVERY REGULAR
Click a message to set how a viewer's name is pronounced and which voice reads them, and see what they said tonight.

SAVED READINGS
Viewer names, words and emoticons share one page, with search and editing right there. Which messages are read, gift and Super Chat thresholds, speech templates and keyword sounds wait under Advanced.

GO LIVE WITH OBS
Once signed in, go live, end the stream, edit the title and area, and send chat messages and emotes from the main screen. Mute, block or appoint moderators when your account has permission. Connect OBS to add the chat overlay to your scene with one click, then drag and resize it in place; changes sync automatically, and going live can also start streaming in OBS.

EASY TO USE
Scan to sign in with your supported live-platform account, connect to your own room, pick a voice and start. Turning speech off keeps chat on screen. Click the sun or moon to switch between Mist and Night, use the Simplified Chinese or English interface, and let settings save automatically, with optional start with Windows.

PRIVATE BY DESIGN
Free, open source, no ads and no in-app purchases. Sign-in data and API keys are encrypted on this PC for the current Windows user. There is no developer-run telemetry. Text to be spoken is sent only to the voice service you choose.

Please note: third-party voice services may require their own account, API key or self-hosting, and providers may charge for them. DanmakuVoice does not include local voice models or third-party accounts or credits. OBS is installed separately. Only use accounts, voices and audio you have the right to use.

DanmakuVoice is an independent third-party project. See the GitHub documentation for compatibility, prerequisites and setup. Source code (AGPL-3.0-only): https://github.com/Ghou133/DanmakuVoice

### Product features

- Receives live chat, gifts, Super Chats and memberships from supported rooms
- The line being read is mirrored in the lake and lights up progressively with playback
- Scroll down to browse every message from this session
- Click the voice name to switch voices or turn speech off; scroll the waterline for volume
- Supported cloud speech services or self-hosted speech services
- Per-viewer name pronunciation and voice
- Viewer names, words and emoticon readings on one page
- Message types, amount thresholds, speech templates and keyword sounds
- Go live, end the stream, edit the title and chat from the main screen
- Add the chat overlay to OBS with one click and drag it into place
- Mist and Night themes, Chinese and English interface
- Free, open source, ad-free; credentials stay encrypted on your PC

### Search terms

danmaku; live chat; text to speech; TTS; streaming; stream tool; DanmakuVoice

### What's new in this version

- Improve the broadcast and identity-verification flow
- Optionally announce ordinary viewers entering the live room; this is off by default
- Improve entry-event processing and speech queue reliability

### Screenshot captions

1. Hear your chat, read aloud. The line being read floats above the lake, and its reflection lights up progressively with playback.
2. A new voice in one click. The waterline beneath the voice name is the volume: just scroll.
3. Every regular, their own voice. Click a message to set how a viewer's name is read and which voice reads them.
4. Scroll down through tonight. Every message from this session rests in the lake; gifts and Super Chats stand out.
5. Cloud or local, your choice. All voices sit in one list, auditioned and edited in place.
6. Every name, read right. Viewer names, words and emoticons share one page.
7. Put your chat on stream. Connect OBS, add the overlay with one click and drag it into place.
8. Set the title, then go live. Click the sun or moon to switch themes.
9. Ready in a minute. Scan to sign in to your own live room, pick a voice and start.

### Copyright and trademark info

© 2026 CurePrism. Code: AGPL-3.0-only. Icon art and characters belong to their owners. Third-party service names and trademarks belong to their respective owners.

### Additional license terms

Licensed under the GNU Affero General Public License v3.0 only. Complete source code and third-party licenses: https://github.com/Ghou133/DanmakuVoice

## 截图

本次 0.3.4 商店截图位于 `Claude outputs/store-screenshots-0.3.4-20261020/`（该目录不进入公开提交），每种语言 9 张，1920×1080 PNG，文件名顺序即上传顺序，与上面的“截图说明”一一对应：`store-zh-CN-01…09`、`store-en-01…09`。默认生成目录仍为 `Claude outputs/store-screenshots/`，可用 `DV_STORE_OUTPUT` 指定独立目录。README 用的首图和功能图在 `docs/images/`。

重新生成：

```powershell
$env:NODE_PATH = (npm root -g); node scripts/render-store-screenshots.cjs
```

脚本用全局 Playwright 和本机 Edge，在离线浏览器里加载实际的 `crates/desktop/ui` 生产页面，由脚本内的虚构 IPC 提供用户名、直播间、弹幕和声音（不登录、不联网、不合成语音），按固定时间截取界面，再排版成商店图。每张原始截图和排版后的说明文字都会检查，出现豆包、哔哩哔哩、B站、Bilibili、Doubao 即失败；英文图还检查界面里没有残留中文。截图中出现的语音服务标签只有 Fish Audio、GPT-SoVITS、dots.tts。

这些图不是原生 WebView2 窗口截图，也不代表真实账号、语音服务或 OBS 上的在线验收。提交前应在待提交构建上核对界面与截图一致。

## 审核说明（英文）

审核说明只交给微软认证人员，不出现在商店页面。按用户 2026-10-18 的决定，这里保留 Bilibili，以便审核人员知道用哪个账号登录；商店公开内容仍不写平台名。版本号和源码链接在打包时填写。

This is a free, open-source Windows desktop utility for receiving Bilibili live-room messages and playing text-to-speech or user-selected audio. It does not host a social network. After sign-in, the main screen can start or end the signed-in account's own live room, edit its title and area, send text/emote messages to that room, and perform mute, live-room block or moderator actions when the platform grants the account permission. Incoming live chat is third-party user-generated content; the existing age questionnaire declares user content conservatively. Local keyword playback rules are separate from these platform moderation actions. The app does not provide its own reporting service.

No developer account, payment, or administrator privileges are needed to open the app. Completing first-run setup and receiving chat require the reviewer's own Bilibili account with a live room: choose Start, scan the QR code with the Bilibili app, and confirm sign-in. At the voice step, choose "View messages for now" to skip speech setup; chat is still received and shown. To check audio output without any speech account, open Settings (gear icon) > Voices: with no voice added, the page shows "No voices yet", and "Play test tone" at the bottom plays a short local tone through the real decoder and the Windows default output device. Hearing speech requires the reviewer's own supported cloud provider account or API key (Settings > Voices > +), or a separately installed local TTS service and model; no developer credentials are included. The UI supports Simplified Chinese and English (Settings > General > Language). Microsoft Edge WebView2 Runtime is required.

The runFullTrust capability is required by the Rust/Tauri desktop application for its WebView2 window, system audio output, user-selected files, and spawning its bundled FFmpeg decoder. Optional local TTS services are started only when the user configures or wakes them. FFmpeg is launched directly from the installed MSIX directory; no executable is downloaded or extracted to AppData for the Store build. StartupTask is disabled by default and is enabled only through the user's setting. Updates are managed by Microsoft Store.

OBS features are optional. Settings > OBS connects to the user's own OBS WebSocket; "Add to OBS" places a token-protected overlay, served only on 127.0.0.1, into the current scene. Syncing OBS streaming with going live is off by default (Settings > OBS > Advanced). Capture, encoding and RTMP publishing remain in OBS.

Only runFullTrust is requested, matching the approved capability set. Windows manages Store app data virtualization. Store and portable builds do not promise a shared physical database or retention after uninstall. Package identity is unchanged. No old database is overwritten and no credentials are automatically imported.

The submission includes FFmpeg (LGPL-2.1-or-later), original third-party license notices, bundled serif fonts with their copyright and SIL OFL 1.1 notices, and a link to the exact complete source archive. The application's own source is AGPL-3.0-only. Source and support: https://github.com/Ghou133/DanmakuVoice
Corresponding complete source for package 1.3.5.0 (app 0.3.5): https://github.com/Ghou133/DanmakuVoice/releases/tag/store-v1.3.5.0
The exact source commit is recorded in the submission package's SUBMISSION-README.txt and in the source release. Publish and verify the matching source archive before submitting the package.

This update improves broadcast identity handling and adds optional viewer-entry announcements, disabled by default. Supported platforms, speech providers and the approved capability set are unchanged. Generic search terms are retained. Certification and publication require a separate Microsoft decision.

### runFullTrust 说明（500 字以内）

Rust/Tauri desktop app: WebView2 window, audio output, user-selected files and bundled FFmpeg decoder. Optional local TTS processes and the token-protected 127.0.0.1 OBS overlay start only when enabled. Bilibili broadcast actions require the user's own account and explicit input. Standard user permissions; no admin rights. Store build uses FFmpeg from its installed package. No executable downloads. StartupTask is off by default. Updates use Microsoft Store.

### 认证历史

- 1.3.0.0 元数据重新提交处理了报告 7210d7cf-406f-4430-90d6-d0a0b61a27f4（10.1.3 搜索词），此后搜索词保持通用。
- 1.3.2.0（应用 0.3.2）移除 unvirtualizedResources 及全部文件/注册表虚拟化例外，处理报告 7b667596-99b5-4b4e-ad00-61168ed4db28（10.6.3），只保留 runFullTrust；不申请重新考虑 unvirtualizedResources。

## 提交状态

商店文案不构成安装验收。上架及签名以 Partner Center 状态为准；SAC 开启环境仍需实际验证。水月重设计尚未完成真实账号、语音服务和 OBS 的在线验收（见 PROGRESS.md）。
