# 发布材料核验

每个正式版本同时提供：

- `DanmakuVoice-windows-x64.zip`：压缩后的 Windows x64 程序，包内仅有 `DanmakuVoice.exe`。
- `DanmakuVoice.exe`：同一程序的独立附件，兼容 0.2.0 的更新下载入口。
- `DanmakuVoice-source.zip`：同一提交的应用、完整锁定 Rust 依赖、FFmpeg 对应源码与构建材料。
- `DanmakuVoice-licenses.zip`：项目许可与第三方原始许可、NOTICE 及归属文本。
- `SHA256SUMS.txt`：上述发布文件的校验值。

## 同版本配对

GitHub Actions 对普通提交及 PR 执行构建验证；推送版本标签（如 `v0.2.1`）时，要求标签、Cargo 和 Tauri 版本一致。测试、源码配对、离线重建全部通过后，`scripts/package-release.py` 以 ZIP Deflate 最高压缩级别生成发行包，并逐字节核对解压内容。再次解压 ZIP 执行单 EXE 启动检查后才上传。

自动发布先创建草稿，核对 GitHub 返回的全部附件大小及 SHA-256，成功后转为正式最新版。构建失败不会发布，已有 Release 不会在重跑时被覆盖。`DanmakuVoice-licenses.zip` 与对应源码必须和程序同时保留在 Release 中。

发布步骤使用独立工作流 `publish-release.yml`。如果构建已成功而发布前失败，可在 Actions 手动运行“发布已验证的构建产物”，填写原版本标签和构建运行 ID。它会核对同仓库构建来源、标签提交、Windows 作业成功状态及附件校验值，复用已验证的产物；不会绕过编译与测试门槛。校验清单接受 CRLF/LF，公开附件统一使用 LF。

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
