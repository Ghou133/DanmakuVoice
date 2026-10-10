# Microsoft Store 发布

## 已保留的产品标识

- Store ID：`9P4DFD8HGN03`
- Package Name：`CurePirsm.334999D231AD4`
- Publisher：`CN=1049AC53-C23A-44DB-89F9-D37EC0C2B00A`
- PublisherDisplayName：`CurePrism`
- PFN：`CurePirsm.334999D231AD4_srm51y1gxbpqm`

以上值于 2026-10-07 重新核对 Partner Center Product Identity。显示名称 `CurePrism` 与固定包名中的 `CurePirsm` 拼写不同，不能据此修改包名、PFN 或 Publisher CN。

这些是公开包标识，不包含证件、私钥或登录凭据。源配置为 `packaging/store-identity.json`。应用版本 `M.m.p` 映射为 MSIX `(M+1).m.p.0`，例如 `0.2.2 → 1.2.2.0`；第四段留给商店，主版本始终非零且跨 `1.0.0` 仍保持递增。

## 构建与分发

`.github/workflows/windows-portable.yml` 保留原文件名以延续构建历史，现生成 `DanmakuVoice-store-submission` artifact，不再调用自动 GitHub Release 发布器。

1. Windows 工作流完成 fmt、clippy、Rust／UI／Python 测试、真实 FFmpeg 解码以及锁定源码核验。
2. 原 `package-portable.ps1` 仅用于内部编译、PE 依赖检查和许可证收集；中间 EXE／审计 ZIP 不作为新的公开下载。
3. `package-msix.ps1` 生成清单，包含主程序、FFmpeg、图标和第三方许可；使用 Windows SDK MakeAppx 完整语义验证并逐文件核验包内容。
4. 正式分发前将同提交 `DanmakuVoice-source.zip` 提供在 `store-v<MSIX 版本>` 对应的公开源码位置，例如应用 `0.2.2` 对应 `store-v1.2.2.0`；先核对链接与实际完整源码，再进行提交，不覆盖旧便携版的标签／源码。源码公开同样需要用户发布指令。不要发布未签名 MSIX 给普通用户。
5. 上传 `DanmakuVoice-store-submission.msix` 到 Partner Center 的 Packages。只有通过微软审核并签名的商店分发包才供用户安装。无需自签证书或关闭 SAC。

本地可在已核验的 EXE／审计 ZIP／完整源码基础上执行：

```powershell
./scripts/package-msix.ps1 -AuditZip <audit.zip> -ApplicationExe <DanmakuVoice.exe> -FfmpegBinary <ffmpeg.exe> -SourceZip <source.zip> -Commit <完整提交> -Version 0.2.2
```

`-DevelopmentSnapshot` 只用于本地未提交工作验证，输出显式标记为 development，不能上传为正式版本。输入审计包／源码需先用同名开发快照开关生成并配对，不能把基础提交当作工作树的精确源码。完整材料及命令边界见 [RELEASE-LICENSE-AUDIT.md](RELEASE-LICENSE-AUDIT.md)。

## 安装后的行为

通过 Windows API 获取真实包身份，直接调用包根目录的 `ffmpeg.exe`。缺失／损坏报 `DV-C09`，不回退到 AppData 解包版本。MSIX 的包信任不应扩展解释为任意缓存中的独立 EXE 也已签名。

“关于”页改由 Store 管理更新；开机启动使用清单声明的 Windows StartupTask，默认关闭，必须由用户明确启用。不向包目录写配置，不自动搬运或导入旧版凭据。WebView2 及用户自己配置的外部 TTS 环境仍需实际验证；本应用的签名不会替外部服务签名。

默认逻辑数据目录由系统 Known Folder API 定位至当前用户的 `AppData\Local\DanmakuVoice`；商店版沿用已通过 1.3.0.0 的 Windows 默认文件和注册表虚拟化，不声明 `unvirtualizedResources` 或任何虚拟化排除。商店版与便携版不承诺共用物理数据库，卸载后配置可能被系统删除；普通配置导出不是完整备份。升级保持产品身份不变，不自动覆盖旧副本或导入凭据。发布前核对实际 MSIX 清单，并区分隔离数据回归与真实签名商店升级验收。依据 [Microsoft 的文件虚拟化说明](https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization)，Known Folder 返回逻辑路径不等于关闭 I/O 虚拟化。

## 商店资料与提交前验收

- 免费应用，类别建议“实用工具与工具”；无应用内购买、无广告。
- 隐私说明使用本仓库 `docs/PRIVACY.md`，在 Partner Center 可直接填写完整文本；若使用公开链接，发布前确认链接确实可访问。
- 年龄评级按实际功能填写：显示第三方直播用户内容，不能仅因工具本身无预置成人内容就忽略用户内容。
- `runFullTrust` 用于桌面窗口、系统音频播放、本地文件选择及用户指定的本地 TTS 子进程；不要求管理员权限。
- 商店截图必须来自真实应用，不包含账号、Cookie、私人目录等资料。
- 上架前检查公开发布者、支持联系方式及法律信息字段，遵守“不公开真实姓名”的用户要求；需要公开私人身份时停止确认。
- 必须验证实际商店签名包在 SAC 开启的 Windows 上安装、启动、FFmpeg 播放、更新和开机启动。MakeAppx 成功、自签测试或离线单元测试不代表这些验收已完成。

参考：Microsoft 的 MSIX 手动打包、MakeAppx、StartupTask 和商店发布文档。

## 截图维护

截图应反映待提交构建的当前六分类设置、刊头／聚光主界面及深浅主题；旧引导或旧主页图片不能代表新版本。来源、构建及脱敏范围记在唯一的 [PROGRESS.md](../PROGRESS.md)，不把生成目录下的旧素材当成持续有效的证据。

`node scripts/test-ui-emotes-alias.cjs --capture-store --output <临时目录>` 可在装有 Playwright 与 Microsoft Edge 的开发环境生成离线页面对照；需要时设置 `NODE_PATH` 指向开发模块目录。该模式使用虚构用户名、房间及聊天，不登录、不合成、不上传，连接状态为未连接；它不能证明原生 WebView2、真实直播或商店签名包。实际商店截图与动画验收仍需对应构建运行时留存，不能由静态页面图替代。
