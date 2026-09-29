# 超绝可爱弹幕姬

<img src="crates/desktop/ui/logo.png" width="88" height="88" alt="应用图标">

Windows 弹幕接收与语音播报工具，支持 B 站直播间、观众指定声音、词典替换及关键词音效。

## 下载与启动

发行流程已迁移至 Microsoft Store MSIX。首次商店提交尚待审核，上线后可通过 [Microsoft Store](https://apps.microsoft.com/detail/9P4DFD8HGN03) 安装。GitHub Actions 生成的是提交审核用的未签名包，不能作为普通用户安装包。历史 GitHub 便携版继续保留，但不再自动发布新的 EXE。

商店版支持 Windows 10 2004 / Windows 11 x64，需要 Microsoft Edge WebView2 Runtime。FFmpeg 随安装包提供，由程序直接从安装目录调用，无需用户配置。

首次启动扫码登录 B 站，或输入主播 UID 匿名连接。选择语音服务和音色后即可开始接收。之后会沿用设置，自动尝试连接已保存的直播间。

## 声音与规则

- **豆包**：在应用内扫码连接并选择音色。
- **Fish Audio**：在设置中填写 API Key，选择内建或自定义音色。自动使用 Windows 中已启用的代理服务器设置，支持统一代理地址和 HTTP/HTTPS 分项地址。
- **dots.tts / GPT-SoVITS**：选择已安装的服务目录及参考音频；模型和服务需自行准备。参考音频保留在原位置。
- **观众声音**：点击弹幕头像指定声音或添加别名，也可在声音设置中按用户名配置。
- **播报规则**：分别设置用户名和正文词典、事件模板、关键词音效；预览不会发起语音请求，试听会实际合成并播放。

主界面支持切换语音服务、调整音量、跳过当前播报、清空队列和停止接收。最小化或切换到后台时暂停界面轮询，弹幕接收与播报继续运行。关闭程序会停止由它启动的本地服务。

点击右下角喇叭可静音或恢复，静音时显示带叉图标，保留原音量。托盘菜单只保留“显示窗口”和“退出”；退出会关闭接收、播报及本程序启动的 TTS，无需二次确认。

## 更新

商店版由 Microsoft Store 管理更新，可在 **设置 → 关于 → 打开 Microsoft Store 更新** 查看。历史便携版保留原 GitHub 更新入口。

## 数据

数据保存在 `%LOCALAPPDATA%\DanmakuVoice`。登录凭据使用 Windows 当前用户范围的 DPAPI 加密，普通配置导出不包含凭据。不要公开分享整个数据目录。

设置中可导入旧配置、导出普通配置或清除应用数据。迁移说明见 [MIGRATION.md](MIGRATION.md)。独立试用可指定另一个数据目录：

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

代码采用 [AGPL-3.0-only](LICENSE)。第三方组件与素材说明集中在 [NOTICE.md](NOTICE.md)，完整源码和许可材料随 GitHub Release 提供。

## 问题反馈

报错会显示中文说明及末尾的短代码，例如 `音频组件 FFmpeg 无法启动… [DV-C02]`。反馈时请附上程序版本、操作步骤和完整报错截图（保留错误代码），不需要提供 Cookie 或 API Key。开发定位参见 [错误码对照表](docs/ERROR-CODES.md)。
