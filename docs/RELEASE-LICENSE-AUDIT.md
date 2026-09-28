# 发布材料核验

每个正式版本同时提供：

- `DanmakuVoice.exe`：Windows x64 单文件程序。
- `DanmakuVoice-source.zip`：同一提交的应用、完整锁定 Rust 依赖、FFmpeg 对应源码与构建材料。
- `DanmakuVoice-licenses.zip`：项目许可与第三方原始许可、NOTICE 及归属文本。
- `SHA256SUMS.txt`：上述发布文件的校验值。

## 同版本配对

正式打包要求干净检出。`scripts/package-portable.ps1` 记录构建提交、Cargo.lock、FFmpeg 哈希，并校验 PE 依赖。
`scripts/package-source.ps1` 从同一提交归档，核验锁文件中的每份 `.crate` 及补充许可材料。

```powershell
./scripts/verify-bundle-pair.ps1 -PortableZip <审计包> -ApplicationExe <EXE> -SourceZip <源码包> -ExpectedCommit <提交SHA>
python scripts/verify-rust-license-copies.py --portable <审计包> --source <源码包>
```

第二个脚本逐字节对照原始 `.crate` 内的许可证文件，并验证补充文本。完整源码 ZIP 中的 `scripts/build-from-source.ps1 -VerifyOnly` 可独立重验归档；不加该开关则进行离线构建。

## 归属材料

项目许可为 AGPL-3.0-only，保留 NOTICE 中的来源归属。FFmpeg 使用未启用 GPL/nonfree 的 LGPL 2.1+ 构建，通过子进程运行。所有对应源码与许可在同一个 Release 可下载。

Rust 依赖按实际 Windows 正常/构建依赖图收集原始 LICENSE、COPYING、NOTICE、ATTRIBUTION 等文本；缺少根目录文本时，仅使用 `third-party/license-supplements/manifest.json` 中按版本、来源提交及 SHA-256 核验的补充材料。保留复合许可及额外归属文本，源码包保留上游文件头。图标说明见 `crates/desktop/icons/ARTWORK.md`。

发布时重新核对实际产物，确认公开资产的哈希与本地产物相同。检查结果记录在 PROGRESS.md；历史版本的结果不作为新版本证明。
