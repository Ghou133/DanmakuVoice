# 音频组件与构建

程序内嵌精简的 FFmpeg 9.0.2（Windows x64），通过独立子进程解码及变速，首次运行自动解出到应用数据目录并核验 SHA-256。

- 二进制：`8fb7ecc11f4f7a441ae7075a81c984289250b166e78dedf51900bbeb1a96ef4d`
- 官方源码归档：`8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`
- 上游源码：[ffmpeg-9.0.2.tar.xz](https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz)
- 许可：LGPL 2.1 或更高版本，未启用 GPL/nonfree。

## 重建

在 Ubuntu 22.04 / WSL 中执行 `scripts/build-minimal-ffmpeg-wsl.sh <输出目录>`。脚本固定官方源码哈希及裁剪参数，验证签名，不修改上游源码。使用 MinGW 交叉编译。`scripts/verify-minimal-ffmpeg.py` 检查支持的音频格式及变速音高；完整格式检查需提供参考编码器。

主程序发布配置启用体积优化、Thin LTO、单代码生成单元和符号剥离，并保留 panic 展开行为。正式打包使用静态 CRT：

```powershell
$env:RUSTFLAGS = '-C target-feature=+crt-static'
cargo build --locked --release -p danmakuvoice
```

## 打包

`scripts/package-portable.ps1` 接收以下参数：

- `-FfmpegBinary`：经校验的精简 ffmpeg.exe。
- `-FfmpegSourceArchive`：上述官方源码归档。
- `-FfmpegCopying`、`-FfmpegLicenseDescription`：源码内的 COPYING.LGPLv2.1 与 LICENSE.md。
- `-OutputExe`、`-OutputZip`：程序和审计包输出路径。
- `-RequireCleanCheckout`：正式发布时验证检出干净。

脚本核验所有输入哈希、Windows 系统 DLL 依赖、源码提交和打包文件；不会覆盖已有产物。审计包用于配对核验，不是普通用户下载项。

`scripts/package-source.ps1` 从同一提交生成完整源码 ZIP，包含 Cargo.lock 中的 crates.io 归档及 FFmpeg 源码和许可。解压后执行 `scripts/build-from-source.ps1 -VerifyOnly` 核验，或省略该开关进行离线构建。仍需安装指定 Rust、MSVC 和 SDK；不同工具链环境不保证产物逐字节一致。

发布前对实际产物运行 `scripts/smoke-portable.ps1`、`scripts/verify-bundle-pair.ps1`、`scripts/verify-rust-license-copies.py`。公开发布 EXE、同提交完整源码包及许可包；EXE 不包含 TTS 模型、外部服务或 WebView2 Runtime。
