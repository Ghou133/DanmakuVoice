# 超绝可爱弹幕姬

<img src="crates/desktop/ui/logo.png" width="88" height="88" alt="应用图标">

Windows 弹幕接收与语音播报工具，支持 B 站直播间、观众指定声音、词典替换及关键词音效。

## 下载与启动

安装入口为 [Microsoft Store](https://apps.microsoft.com/detail/9P4DFD8HGN03)，可用版本及上架状态以商店页面为准。当前发行工作流生成审核用的未签名 MSIX 和配套源码，不自动发布、提交审核或提供普通用户安装包。历史 GitHub 便携版仍保留。

商店版支持 Windows 10 2004 / Windows 11 x64，需要 Microsoft Edge WebView2 Runtime。FFmpeg 随安装包提供，由程序直接从安装目录调用，无需用户配置。

首次启动从欢迎页开始，选择扫码登录 B 站或输入主播 UID 匿名连接，再选择豆包朗读或暂时只看弹幕，最后确认开始接收。其他语音服务可在设置中配置。之后会沿用设置，自动尝试连接已保存的直播间。

在 **设置 → 通用 → 界面语言** 切换简体中文 / English，立即生效并自动保存。界面语言不会改变弹幕原文、用户名、声音名称或已保存的播报模板。

## 声音与规则

- **豆包**：在应用内扫码连接并选择音色。
- **Fish Audio**：在设置中填写 API Key，选择内建或自定义音色。自动使用 Windows 中已启用的代理服务器设置，支持统一代理地址和 HTTP/HTTPS 分项地址。
- **dots.tts / GPT-SoVITS**：选择已安装的服务目录及参考音频；模型和服务需自行准备。参考音频保留在原位置。
- **观众声音**：点击弹幕打开观众卡片，设置名字读法或专属声音；声音设置中也可管理用户名／UID 绑定。
- **播报规则**：分别设置用户名和正文词典、事件模板、关键词音效；预览不会发起语音请求，试听会实际合成并播放。

主界面控制坞提供音色选择、音量、静音、待播列表和播报开关；选择待播条目可立即朗读，关闭播报仍接收并显示弹幕。音色面板浏览其他服务不会改变直播声音，确认选择才保存。连接管理在“设置 → 直播间”；其余分类为声音、播报内容、音效、通用、数据与关于。

最小化或切换到后台时暂停界面轮询，弹幕接收与播报继续运行。切换声音会保留已经启动的本地服务，可在服务设置中手动停止；关闭程序会停止由它启动的本地服务，不停止用户自己启动的外部服务。

点击喇叭可静音或恢复，保留原音量。托盘菜单提供“显示窗口”和“退出”；退出前尝试保存自动编辑并关闭接收、播报及本程序启动的 TTS，无需二次确认。编辑期间，无效或保存失败的草稿会保留并显示原因；失败不会阻止退出，尚未确认的账号／导入等表单不会自动提交。

## 更新

商店版由 Microsoft Store 管理更新，可在 **设置 → 数据与关于 → 打开 Microsoft Store 更新** 查看。非商店版本保留 GitHub 检查更新入口；下载后退出旧程序再替换，设置保存在独立的数据目录。

## 数据

数据保存在 `%LOCALAPPDATA%\DanmakuVoice`。登录凭据使用 Windows 当前用户范围的 DPAPI 加密，普通配置导出不包含凭据。不要公开分享整个数据目录。

“设置 → 数据与关于”中可导入旧配置、导出普通配置或清除应用数据。导出不包含音效文件、聊天记录或凭据；旧配置需先预览、选择并确认，不能用来导入新版配置。迁移说明见 [MIGRATION.md](MIGRATION.md)。独立试用可指定另一个数据目录：

```powershell
.\DanmakuVoice.exe --data-dir "D:\DanmakuVoice-Test"
```

## 从源码构建

需要 Windows x64、[指定 Rust 工具链](rust-toolchain.toml)、Visual Studio C++ 构建工具及 Windows SDK。界面随程序嵌入，无需 Node.js 运行时。

```powershell
cargo build --locked --release -p danmakuvoice
cargo test --locked --workspace
```

发行包使用静态 CRT，构建与验证方法见 [FFMPEG.md](docs/FFMPEG.md)。同版 `DanmakuVoice-source.zip` 提供完整锁定依赖及 FFmpeg 源码，解压后可运行 `scripts/build-from-source.ps1 -VerifyOnly` 核验，或运行 `scripts/build-from-source.ps1` 离线构建。工具链和 Windows SDK 仍需预先安装。

GitHub Actions 在提交、PR 和版本标签上执行验证，生成 `DanmakuVoice-store-submission.msix` 与同提交完整源码包。EXE 只作为安装包内部构建中间件，不作为下载产物发布。不会自动提交微软审核或把未签名 MSIX 发布成正式安装包。商店流程见 [STORE-PUBLISHING.md](docs/STORE-PUBLISHING.md)。

## 许可

代码采用 [AGPL-3.0-only](LICENSE)。第三方组件与素材说明集中在 [NOTICE.md](NOTICE.md)。正式分发须提供对应完整源码；商店包包含许可材料，历史便携版使用配套许可 ZIP。

## 限制与开发文档

B 站及豆包采用网页接口，接口变化可能影响登录与连接。Fish Audio 需独立 API Key；本地 TTS 需用户自行准备服务与模型。设备断开后可在“设置 → 通用 → 音频输出”刷新或重新连接；重新连接会停止当前与待播队列。

开发入口：[架构](ARCHITECTURE.md)、[现有 UI 设计与验收边界](docs/UI-DESIGN.md)、[桌面命令](docs/UI-IPC.md)、[构建与音频组件](docs/FFMPEG.md)、[发行材料核验](docs/RELEASE-LICENSE-AUDIT.md)、[商店流程](docs/STORE-PUBLISHING.md)。实际验证、未解决项和后续工作统一记录在 [PROGRESS.md](PROGRESS.md)。

## 问题反馈

报错会显示中文说明及末尾的短代码，例如 `音频组件 FFmpeg 无法启动… [DV-C02]`。反馈时请附上程序版本、操作步骤和完整报错截图（保留错误代码），不需要提供 Cookie 或 API Key。开发定位参见 [错误码对照表](docs/ERROR-CODES.md)。
