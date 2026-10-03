# 音频组件与构建

程序使用精简的 FFmpeg 9.0.2（Windows x64），通过独立子进程解码及变速。非商店构建内嵌组件，首次运行自动解出到当前应用数据目录并核验 SHA-256；商店安装版直接调用包根目录的 `ffmpeg.exe`，缺失或损坏时报 `DV-C09`，不回退到缓存版本。保存过的旧 FFmpeg 路径不能覆盖当前组件。

- 二进制：`8fb7ecc11f4f7a441ae7075a81c984289250b166e78dedf51900bbeb1a96ef4d`
- 官方源码归档：`8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`
- 上游源码：[ffmpeg-9.0.2.tar.xz](https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz)
- 许可：LGPL 2.1 或更高版本，未启用 GPL/nonfree。

## 重建

在 Ubuntu 22.04 / WSL 中执行 `scripts/build-minimal-ffmpeg-wsl.sh <输出目录>`。脚本固定官方源码哈希及裁剪参数，验证签名，不修改上游源码。使用 MinGW 交叉编译。`scripts/verify-minimal-ffmpeg.py` 检查支持的音频格式及变速音高；完整格式检查需提供参考编码器。

主程序发布配置启用体积优化（`opt-level="s"`）、Fat LTO、单代码生成单元和符号剥离，并保留 panic 展开行为。正式打包使用静态 CRT：

```powershell
$env:RUSTFLAGS = '-C target-feature=+crt-static'
cargo build --locked --release -p danmakuvoice
```

`package-portable.ps1` 与源码离线构建脚本会临时设置该标志并恢复原环境。普通 `cargo build --release` 不等于此打包条件；对照体积或性能时需记录 `RUSTFLAGS`、target、profile 和 feature，不跨条件计算收益。

## 打包

`scripts/package-portable.ps1` 接收以下参数：

- `-FfmpegBinary`：经校验的精简 ffmpeg.exe。
- `-FfmpegSourceArchive`：上述官方源码归档。
- `-FfmpegCopying`、`-FfmpegLicenseDescription`：源码内的 COPYING.LGPLv2.1 与 LICENSE.md。
- `-OutputExe`、`-OutputZip`：程序和审计包输出路径。
- `-RequireCleanCheckout`：正式发布时验证检出干净。
- `-DevelopmentSnapshot`：记录当前工作树的白名单源码及逐文件 SHA-256，仅用于本地开发包；与上一个开关互斥。

脚本核验所有输入哈希、Windows 系统 DLL 依赖、源码来源和打包文件；不会覆盖已有产物。审计包用于配对核验，不是普通用户下载项。开发快照还核对构建期间源码未变化，基础提交不能被当作未提交源码的精确身份。

`scripts/package-source.ps1` 从同一提交生成完整源码 ZIP；指定 `-DevelopmentSnapshot` 时从当前工作树的白名单文件复制并核验。包含 Cargo.lock 中的全部 crates.io 归档及所提供的 FFmpeg 源码和许可，使用无损 Deflate 压缩。解压后执行 `scripts/build-from-source.ps1 -VerifyOnly` 核验，或省略该开关进行离线构建。需 PowerShell 7.3+、指定 Rust、MSVC 和 SDK；开发快照核验还需 Python 3.11+。不同工具链环境不保证产物逐字节一致。

对实际产物运行 `scripts/smoke-portable.ps1`、`scripts/verify-bundle-pair.ps1`、`scripts/verify-rust-license-copies.py`；开发配对需显式加 `-DevelopmentSnapshot`。当前商店工作流及对应源码要求见 [STORE-PUBLISHING.md](STORE-PUBLISHING.md)，本地／正式材料核验见 [RELEASE-LICENSE-AUDIT.md](RELEASE-LICENSE-AUDIT.md)。EXE 不包含 TTS 模型、外部服务或 WebView2 Runtime，短时禁网启动检查不代表可听播放或在线服务验收。
