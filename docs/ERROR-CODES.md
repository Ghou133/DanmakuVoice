# 错误码

用户看到的格式为 `中文说明 [DV-代码]`。代码固定对应失败环节；它不是版本号、随机日志 ID 或对用户电脑根因的判定。原有系统错误数字、进程退出码及服务返回码保留在中文说明中。

新增分支分配新代码，已有代码不可重排、重用；修改中文文案不改变代码。优先保留底层代码，只有旧字符串错误缺少代码时才加操作边界代码。正常状态/主动停止不作为运行故障打码。不记录凭据、远端原始响应或新增明文导出。

## 引擎固定代码

| 代码 | 定位 | 含义 |
|---|---|---|
| `DV-A01` | `audio.rs / AudioError::NoDevice` | 没有可用的音频输出设备 |
| `DV-A02` | `audio.rs / AudioError::DeviceNotFound` | 找不到音频输出设备：{0} |
| `DV-A03` | `audio.rs / AudioError::AmbiguousDevice` | 同名音频设备不止一个：{0} |
| `DV-A04` | `audio.rs / AudioError::Backend` | 音频设备操作失败：{0} |
| `DV-A05` | `audio.rs / AudioError::UnsupportedSampleFormat` | 设备不支持的采样格式：{0:?} |
| `DV-A07` | `audio.rs / AudioError::Disconnected` | 音频输出设备已断开 |
| `DV-A08` | `audio.rs / AudioError::Stalled` | 输出设备连续 5 秒未消耗音频 |
| `DV-B01` | `bilibili.rs / BiliError::InvalidRoom` | 直播间号必须大于零 |
| `DV-B02` | `bilibili.rs / BiliError::InvalidUid` | 主播 UID 必须大于零 |
| `DV-B03` | `bilibili.rs / BiliError::Network` | 网络请求失败 |
| `DV-B04` | `bilibili.rs / BiliError::Api` | B站接口返回错误码 {0} |
| `DV-B05` | `bilibili.rs / BiliError::Protocol` | B站返回了不支持或无效的数据：{0} |
| `DV-B06` | `bilibili.rs / BiliError::QrFinished` | 当前扫码流程已结束，请生成新的二维码 |
| `DV-B07` | `bilibili.rs / BiliError::AlreadyRunning` | 直播连接任务已经运行 |
| `DV-B08` | `bilibili.rs / BiliError::NoOwnRoom` | 此账号没有可用的直播间 |
| `DV-B09` | `bilibili.rs / BiliError::SessionExpired` | B站登录已失效，请重新扫码 |
| `DV-S01` | `storage.rs / StorageError::Io` | 文件操作失败：{0} |
| `DV-S02` | `storage.rs / StorageError::Sql` | 数据库操作失败：{0} |
| `DV-S03` | `storage.rs / StorageError::Json` | 配置格式错误：{0} |
| `DV-S04` | `storage.rs / StorageError::UnsupportedSchema` | 不支持的数据库版本：{0} |
| `DV-S05` | `storage.rs / StorageError::UnsupportedAudio` | 不支持的音频格式：{0} |
| `DV-S06` | `storage.rs / StorageError::AssetTooLarge` | 音频素材超过 128 MiB 限制 |
| `DV-S07` | `storage.rs / StorageError::AssetReferenced` | 素材仍被规则引用：{0} |
| `DV-S08` | `storage.rs / StorageError::AssetMissing` | 素材不存在：{0} |
| `DV-S09` | `storage.rs / StorageError::InvalidBackupPath` | 备份文件不属于此数据目录 |
| `DV-S10` | `storage.rs / StorageError::ConnectionMissing` | 服务连接不存在：{0} |
| `DV-S11` | `storage.rs / StorageError::PresetMissing` | 声音预设不存在：{0} |
| `DV-S12` | `storage.rs / StorageError::BindingMissing` | 用户声音绑定不存在：{0} |
| `DV-S13` | `storage.rs / StorageError::InvalidBindingName` | 观众名称不能为空、超过 200 字，或包含控制字符 |
| `DV-S14` | `storage.rs / StorageError::DuplicateBindingName` | 此观众名称已有声音绑定，请编辑原有绑定 |
| `DV-S15` | `storage.rs / StorageError::DuplicateBindingUid` | 此观众 UID 已有声音绑定，请编辑原有绑定 |
| `DV-S17` | `storage.rs / StorageError::PresetIsDefault` | 声音预设是当前默认声音，请先更换默认声音 |
| `DV-S18` | `storage.rs / StorageError::PresetReferenced` | 声音预设仍被 {0} 条用户绑定引用 |
| `DV-S19` | `storage.rs / StorageError::ConnectionReferenced` | 服务连接仍被 {0} 个声音预设引用 |
| `DV-S20` | `storage.rs / StorageError::ConnectionProviderInUse` | 服务连接仍被声音预设引用，不能更换服务类型 |
| `DV-S21` | `storage.rs / StorageError::CredentialsInUrl` | 服务连接地址不能包含凭据、查询参数或片段 |
| `DV-S22` | `storage.rs / StorageError::InvalidEndpoint` | 服务连接地址无效 |
| `DV-S23` | `storage.rs / StorageError::InvalidConnectionTimeout` | 服务连接超时无效：{0} |
| `DV-S25` | `storage.rs / StorageError::InvalidBiliSession` | 已保存的 B 站会话格式无效，请重新扫码 |
| `DV-S26` | `storage.rs / StorageError::InvalidLiveSettings` | 直播设置无效 |
| `DV-S27` | `storage.rs / StorageError::InvalidDoubaoDevice` | 豆包设备标识无效，请检查本机数据目录 |
| `DV-S28` | `storage.rs / StorageError::InvalidDesktopPreferences` | 桌面偏好设置无效 |
| `DV-S29` | `storage.rs / StorageError::ReferenceAudioUnavailable` | 参考音频路径无效、不可读或文件已删除 |
| `DV-S30` | `storage.rs / StorageError::InvalidReferenceProfile` | 参考配置无效或服务类型不匹配 |
| `DV-S31` | `storage.rs / StorageError::InvalidFishAudioSettings` | Fish Audio 参数无效或连接类型不匹配 |
| `DV-S32` | `storage.rs / StorageError::InvalidDotsSettings` | dots.tts 参数无效或连接类型不匹配 |
| `DV-S33` | `storage.rs / StorageError::InvalidFishVoiceName` | Fish Audio 音色名称不能为空 |
| `DV-S34` | `storage.rs / StorageError::InvalidFishVoiceId` | Fish Audio 音色 ID 或页面链接无效 |
| `DV-S35` | `storage.rs / StorageError::InvalidAuditionText` | 试听文本不能为空、不能超过 2000 字，且不能包含控制字符 |
| `DV-S36` | `storage.rs / StorageError::DataResetBusy` | 数据已重置，但数据库仍被其他实例占用；请关闭其他实例后重新清除 |
| `DV-K01` | `secrets.rs / SecretError::Empty` | 凭据为空 |
| `DV-K02` | `secrets.rs / SecretError::TooLarge` | 凭据超过系统加密接口的长度限制 |
| `DV-K03` | `secrets.rs / SecretError::Protect` | Windows 凭据保护失败：{0} |
| `DV-K04` | `secrets.rs / SecretError::Unprotect` | Windows 凭据解密失败：{0} |
| `DV-K05` | `secrets.rs / SecretError::Utf8` | 凭据不是 UTF-8 文本 |
| `DV-K06` | `secrets.rs / SecretError::UnsupportedPlatform` | 此平台不支持 Windows 凭据保护 |
| `DV-P01` | `playback.rs / PrepareError::Filtered` | 这条消息已被过滤 |
| `DV-P02` | `playback.rs / PrepareError::NoVoice` | 未选择声音预设 |
| `DV-P03` | `playback.rs / PrepareError::EmptyVoiceId` | 声音预设缺少音色或参考音频 ID |
| `DV-P04` | `playback.rs / PrepareError::InvalidSpeed` | 声音预设的语速须在 0.5 到 2.0 之间 |
| `DV-P05` | `playback.rs / PrepareError::InvalidVolume` | 声音预设的音量须在 0 到 2.0 之间 |
| `DV-P06` | `playback.rs / PrepareError::MissingConnection` | 声音预设对应的服务连接不存在 |
| `DV-P07` | `playback.rs / PrepareError::ProviderMismatch` | 声音预设和服务连接的类型不一致 |
| `DV-P08` | `playback.rs / PrepareError::MissingCredential` | 此服务连接缺少登录信息或 API Key |
| `DV-P09` | `playback.rs / PrepareError::MissingDoubaoDevice` | 豆包设备标识尚未初始化 |
| `DV-P10` | `playback.rs / PrepareError::InvalidSovitsSettings` | GPT-SoVITS 音色语言或分句方式无效 |
| `DV-P11` | `playback.rs / PrepareError::MissingSound` | 音效素材文件不可用 |
| `DV-P12` | `playback.rs / PrepareError::MissingReferenceAudio` | 参考音频原文件已删除或不可读，请重新选择 |
| `DV-P13` | `playback.rs / PrepareError::MissingFfmpeg` | 找不到随应用提供的 ffmpeg.exe |
| `DV-R01` | `rules.rs / RuleError::UnclosedField` | 模板缺少结束括号 |
| `DV-R02` | `rules.rs / RuleError::UnexpectedClose` | 模板中存在孤立的结束括号 |
| `DV-R03` | `rules.rs / RuleError::UnknownField` | 不支持的模板字段：{0} |
| `DV-R04` | `rules.rs / RuleError::TooLarge` | 配置过大：{0} |
| `DV-R05` | `rules.rs / RuleError::InvalidAuditionText` | 试听文本不能为空、不能超过 2000 字，且不能包含控制字符 |
| `DV-R06` | `rules.rs / RuleError::InvalidTemplate` | {event}模板无效：{reason} |
| `DV-R07` | `rules.rs / RuleError::InvalidThreshold` | 礼物与醒目留言金额阈值必须是非负有限数 |
| `DV-R08` | `rules.rs / RuleError::EmptyKeyword` | 词典关键词不能为空 |
| `DV-R09` | `rules.rs / RuleError::InvalidSoundRule` | 关键词音效需要非空关键词和素材 |
| `DV-M01` | `migration.rs / LegacyImportError::StalePreview` | 旧配置预览后已变化，请重新预览 |
| `DV-M02` | `migration.rs / LegacyImportError::InvalidSoundSelection` | 选择了预览中不存在或重复的音效 |
| `DV-M03` | `migration.rs / LegacyImportError::InvalidSoundPath` | 所选音效不是可用的本机绝对文件 |
| `DV-M04` | `migration.rs / LegacyImportError::SoundChanged` | 所选音效内容在预览后发生变化，请重新预览 |
| `DV-M05` | `migration.rs / LegacyImportError::SoundsNeedRules` | 必须同时选择导入规则才能导入音效 |
| `DV-M06` | `migration.rs / LegacyImportError::RulesConflict` | 当前规则已有修改，需明确选择覆盖规则 |
| `DV-M07` | `migration.rs / LegacyImportError::LiveSettingsConflict` | 当前直播设置已有修改，需明确选择覆盖直播设置 |
| `DV-M08` | `migration.rs / LegacyImportError::Legacy` | 无法读取旧配置：{0} |
| `DV-M10` | `migration.rs / LegacyImportError::Rollback` | 导入失败且数据库回滚失败；原错误：{apply}；回滚错误：{rollback} |
| `DV-M11` | `migration.rs / LegacyImportError::Cleanup` | 数据库已回滚，但新复制的音效文件清理失败；原错误：{apply}；清理错误：{cleanup} |
| `DV-V01` | `live.rs / LiveError::AlreadyRunning` | 直播会话已启动 |
| `DV-V02` | `live.rs / LiveError::Room` | 直播间连接失败：{0} |
| `DV-V03` | `live.rs / LiveError::Scheduler` | 播放调度器已关闭 |
| `DV-V04` | `live.rs / LiveError::PlaybackUnavailable` | 仅显示弹幕的会话没有播放组件，请启用语音后重新连接 |

## 播放与组件

| 代码 | 定位 | 含义 |
|---|---|---|
| `DV-C01` | playback::safe_decode_error | 找不到内置 FFmpeg |
| `DV-C02` | playback::safe_decode_error / DecodeError::Start | FFmpeg 无法启动；附系统错误数字 |
| `DV-C03` | playback::safe_decode_error / DecodeError::Pipe | 音频管道中断 |
| `DV-C04` | playback::safe_decode_error / ProcessExit 或 InvalidAudio(code) | FFmpeg 异常退出；附十进制/十六进制退出码 |
| `DV-C05` | playback::safe_decode_error | 音频格式、帧或解码结果无效 |
| `DV-C06` | playback::safe_decode_error | 音效素材不可用 |
| `DV-C07` | playback::safe_decode_error | 播放音量/速度无效 |
| `DV-C08` | desktop::embedded_ffmpeg::ensure | 内嵌组件校验/缓存释放失败 |
| `DV-Q01` | scheduler / UI playbackIssue | 异步播报失败，源错误没有更具体的代码 |
| `DV-Q02` | scheduler JoinError | 播报任务异常结束，不显示原始 panic 文本 |
| `DV-V05` | UI runtimeIssue | 会话错误计数摘要；需结合具体播放/连接错误 |
| `DV-L01` | local_service::ServiceState::view | 本地 TTS 服务启动或运行失败，源错误没有更具体的代码 |

## 语音服务

`TtsError` 使用 `DV-T<服务><类型>`；例如 `DV-TD06` 是豆包语音网络请求失败，`DV-TQ06` 是豆包扫码网络失败，`DV-TF02` 是 Fish Audio HTTP 401。
代码来自服务标识、错误变体和 HTTP 数字状态，不根据中文说明匹配，因此修改提示文案不改变代码。连接/接收阶段、系统错误、服务响应码继续看代码前的说明。

| 服务位 | 服务 | 源码 |
|---|---|---|
| D | 豆包语音 | tts/dobao.rs |
| Q | 豆包扫码 | tts/dobao_auth.rs |
| F | Fish Audio | tts/fish.rs |
| S | GPT-SoVITS | tts/sovits.rs |
| L | dots.tts | tts/dots.rs |
| 0 | 其他/未知服务 | tts/mod.rs |

| 类型 | 含义 |
|---|---|
| 01 | 配置无效 |
| 02 | HTTP 401，登录/授权未被接受 |
| 03 | HTTP 403，访问被拒绝 |
| 04 | HTTP 429，限流 |
| 05 | 其他 HTTP 失败，说明中保留状态码 |
| 06 | 网络请求失败，说明中保留阶段与脱敏原因 |
| 07 | 服务音频数据无效 |
| 08 | 服务协议/响应无效或拒绝请求，说明中保留已知上游错误码 |

`DV-T000` 只用于旧的无类型 TTS 失败兜底；`DV-T009` / `DV-A06` 为主动取消保留，正常取消路径不额外显示错误码。


### 语音代码速查

| 类型 | 豆包语音 | 豆包扫码 | Fish Audio | GPT-SoVITS | dots.tts | 未知服务 |
|---|---|---|---|---|---|---|
| 配置 | `DV-TD01` | `DV-TQ01` | `DV-TF01` | `DV-TS01` | `DV-TL01` | `DV-T001` |
| HTTP 401 | `DV-TD02` | `DV-TQ02` | `DV-TF02` | `DV-TS02` | `DV-TL02` | `DV-T002` |
| HTTP 403 | `DV-TD03` | `DV-TQ03` | `DV-TF03` | `DV-TS03` | `DV-TL03` | `DV-T003` |
| HTTP 429 | `DV-TD04` | `DV-TQ04` | `DV-TF04` | `DV-TS04` | `DV-TL04` | `DV-T004` |
| 其他 HTTP | `DV-TD05` | `DV-TQ05` | `DV-TF05` | `DV-TS05` | `DV-TL05` | `DV-T005` |
| 网络 | `DV-TD06` | `DV-TQ06` | `DV-TF06` | `DV-TS06` | `DV-TL06` | `DV-T006` |
| 音频数据 | `DV-TD07` | `DV-TQ07` | `DV-TF07` | `DV-TS07` | `DV-TL07` | `DV-T007` |
| 协议响应 | `DV-TD08` | `DV-TQ08` | `DV-TF08` | `DV-TS08` | `DV-TL08` | `DV-T008` |

## 桌面命令与界面兜底

已有源代码时不追加这些兜底代码；源代码在包装文案后仍位于末尾。多层独立故障（例如导入失败且回滚失败）可保留多个不同代码，不重复同一代码。

| 代码 | 定位/操作 |
|---|---|
| `DV-X00` | 未分类桌面操作或运行状态失败 |
| `DV-X01` | B 站账号/扫码操作 |
| `DV-X02` | 豆包扫码操作 |
| `DV-X03` | Fish 账号/音色操作 |
| `DV-X04` | 直播连接/引导 |
| `DV-X05` | 试听/队列操作 |
| `DV-X06` | 音频设备操作/本地测试音 |
| `DV-X07` | 本地服务管理命令 |
| `DV-X08` | 服务连接、音色、绑定配置 |
| `DV-X09` | 偏好、规则、开机启动设置 |
| `DV-X10` | 数据管理/旧版导入/素材操作 |
| `DV-X11` | 打开外部页面 |
| `DV-X12` | 读取桌面状态/快照 |
| `DV-X13` | 程序启动失败 |
| `DV-X14` | 缺少 WebView2 Runtime |
| `DV-U01` | GitHub 更新检查 |
| `DV-UI01` | 前端校验/操作失败，没有更具体的后端代码 |
| `DV-UI02` | 桌面 IPC / 界面启动失败，没有更具体的后端代码 |

## 维护与反馈

用户只需提供完整中文报错和末尾代码（截图也可），无需提供 Cookie 或密钥。先按本表和代码全文搜索定位分支，再结合版本及前面的系统/服务数字错误信息分析。正常状态不加代码；不得把未知异常统一改写为某个已确认根因。新增服务应在 `TtsError::code` 注册服务位。

### 商店安装

| 代码 | 含义 |
| --- | --- |
| DV-C09 | 安装包中的 FFmpeg 缺失或哈希损坏；不解包回退，需修复安装 |
| DV-X15 | Windows 包身份／安装目录查询失败 |
| DV-X16 | Windows 用户或策略禁止启动任务，需要系统设置允许 |
