# 发行材料核验

当前 `.github/workflows/windows-portable.yml` 验证 Windows 构建并生成未签名 Microsoft Store 提交包，不自动发布 GitHub Release、提交审核或签名。商店操作和签名验收见 [STORE-PUBLISHING.md](STORE-PUBLISHING.md)。历史便携版和本地开发包仍使用下面的配对工具，不能混同为已发布版本。

## 来源与材料

正式版本须从同一干净提交构建；`package-portable.ps1 -RequireCleanCheckout` 记录构建提交、Cargo.lock、FFmpeg 哈希并检查 PE 依赖。`package-source.ps1 -RequireCleanCheckout` 从对应提交归档，保留完整 Cargo.lock 解析所需的 `.crate`、FFmpeg 对应源码、许可及构建脚本。构建工具链与 Windows SDK 需另行安装。

本地未提交工作使用两脚本的 `-DevelopmentSnapshot`，并在 `verify-bundle-pair.ps1` 加同名开关。`WORKTREE-SOURCE.json` 记录白名单文件及 SHA-256；审计包和源码必须有相同清单，源码每份实际内容须匹配。基础 Git 提交仅标识起点，不能表示当前未提交源码。凭据／数据库路径和重解析文件拒绝打包，生成目录及非项目资料排除。开发标记不能通过正式发布或商店提交门槛。

```powershell
./scripts/verify-bundle-pair.ps1 -PortableZip <审计ZIP> -ApplicationExe <EXE> -SourceZip <源码ZIP> -ExpectedCommit <完整提交>
python scripts/verify-rust-license-copies.py --portable <审计ZIP> --source <源码ZIP>
```

第一个命令核对实际 EXE、来源、锁文件、完整依赖源码、FFmpeg 和许可补充材料；开发快照还逐文件核对工作树源码。第二个命令逐字节对照原始 `.crate` 内的许可证文件并核验补充文本。解压源码后运行 `scripts/build-from-source.ps1 -VerifyOnly` 独立重验；省略开关则离线构建，不保证跨工具链逐字节复现。

## 本地交付布局

已核验的审计包／源码可交给 `scripts/package-release.py`（Python 3.11+）；开发快照必须加 `--development`。脚本只生成本地文件，不推送或发布，拒绝覆盖已有目录：

- `DanmakuVoice-windows-x64.zip`：根目录单个 `DanmakuVoice.exe`，无损压缩并逐字节核对。
- `DanmakuVoice.exe`：同一程序；单 EXE 不等于全部源码／许可材料。
- `DanmakuVoice-source.zip`：对应完整源码和离线构建材料。
- `DanmakuVoice-licenses.zip`：项目许可、第三方原始许可、归属及素材说明。
- `SHA256SUMS.txt`、`BUILD-SOURCE.txt`：交付文件哈希及实际来源。

开发包的说明明确标记未提交修改，并指向同目录源码，不声称存在公开下载。历史便携正式版本的 `package-release.py` 使用 `v<版本>` 下载位置；只有获用户发布指令并核对实际公开附件后，才能宣称已发行。

商店包包含同一程序、独立 FFmpeg、图标、隐私说明与许可材料；须统计完整包，不能把组件移出 EXE 后称为总量节省。按同 target／profile／feature 分别记录程序字节数、完整必需交付目录和压缩包；源码 ZIP 使用 Deflate，不丢弃锁定依赖或上游源码。

## 归属与验证边界

保留 [NOTICE.md](../NOTICE.md) 和 AGPL-3.0-only。FFmpeg 使用未启用 GPL/nonfree 的 LGPL 2.1+ 构建，以独立子进程运行；对应源码、许可与构建参数随配套源码提供。

Rust 原始 LICENSE、COPYING、NOTICE、ATTRIBUTION 等按实际 Windows 正常／构建依赖图收集；缺少根目录文本时，仅使用 `third-party/license-supplements/manifest.json` 按版本、来源提交及 SHA-256 核验的补充材料。保留复合许可、额外归属和上游源文件头。图标说明见 [ARTWORK.md](../crates/desktop/icons/ARTWORK.md)。自动核验保证材料内容与来源一致，不能代替人工审阅全部义务。

`smoke-portable.ps1` 在临时数据目录、禁网及受限 PATH 下检查短时单 EXE 初始化、WebView2 和内置 FFmpeg 解包。它不证明真实扫码、在线 TTS、扬声器听感、托盘交互或另一台机器的安装。MakeAppx 成功也不证明商店签名或 SAC 下播放。实际通过项、外部阻塞与来源／哈希统一记录在 [PROGRESS.md](../PROGRESS.md)，不复用历史版本结果证明新包。
