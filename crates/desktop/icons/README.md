# 超绝可爱弹幕姬 Logo

直接使用用户提供的浅绿发、眨眼比 V 手势头像，保留方形构图与薄荷色背景。来源与原图校验见 [ARTWORK.md](ARTWORK.md)。浅色和深色界面共用同一位图；界面动效遵循现有 [UI 设计](../../../docs/UI-DESIGN.md)。登录账号头像与昵称在直播间设置展示，和应用图标分别管理。

- 用户原图：`logo-original.png`，原样保留 1254 × 1254 PNG。
- 图标源文件：`logo-source.png`，与用户原图逐字节相同；界面仅嵌入 `../ui/logo.png` 的 256 像素版本。
- `icon.ico`：16、20、24、32、40、48、64、128、256 像素，供 Windows 标题栏、任务栏和资源管理器使用。
- `tray.rgba`：32 × 32 RGBA 像素，供原生托盘直接读取，无需运行时解码或绘制。
- `logo-512.png`：512 × 512 PNG，保留原有背景，供展示和复用。

普通 Cargo 构建直接使用已生成文件。只有修改图标源图后才需要运行 `node crates/desktop/icons/generate-icon.mjs`；使用 Lanczos 缩小，不裁切或重绘。当前 ICO／UI PNG 输出保留既有 `palette:true, quality:90, dither:0` 生成参数；该调色板转换不能称为相对原图的无损处理，审查优化不得重生成并降低质量。此可选开发脚本依赖 Node.js 和 `sharp`，支持通过 `NODE_PATH` 指向开发环境的模块目录。生成工具不打入 EXE，不增加运行时依赖。

第三方角色及参考作品的权利仍归原权利人，本项目代码许可证不授予第三方角色权利。保留内部 `danmakuvoice` 包名、Tauri identifier、Windows 启动项键名和既有用户数据目录，确保改名不创建另一份配置。
