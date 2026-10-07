import { getLanguage } from './i18n.mjs';

// Structured error templates preserve dynamic identifiers, names, paths and
// numeric system/service codes. Unknown diagnostics remain available verbatim.
const copy = `
叠加层已由另一个应用窗口接管	Another app window now manages the overlay.
OBS 中同名来源不是弹幕姬管理的浏览器叠加层，请先重命名该来源再添加	The same-name OBS input is not an app-managed browser overlay. Rename that input before adding the overlay.
叠加层地址只在本机有效，请将 OBS 连接地址设为 localhost 或 127.0.0.1	The overlay address works only on this computer. Set the OBS host to localhost or 127.0.0.1.
OBS 或叠加层设置已变更，请重新检测	OBS or overlay settings changed. Check the connection again.
匿名模式已关闭，请先扫码登录 B 站账号	Anonymous mode is disabled. Sign in to Bilibili by QR code.
请先启用实验性 OBS 开播台，再管理直播间用户	Enable the experimental OBS broadcast console before moderating room users.
请先启用实验性 OBS 开播台，再发送弹幕	Enable the experimental OBS broadcast console before sending chat.
请先扫码登录哔哩哔哩，再发送弹幕	Sign in to Bilibili by QR code before sending chat.
请选择要发送的表情	Choose an emoticon to send.
不支持的弹幕发送操作	Unsupported chat action.
弹幕发送正在处理请求，请稍候	Chat is processing a request. Please wait.
账号或开播台设置已变更，弹幕请求已取消；请核对发送结果	The account or broadcast settings changed. Chat request cancelled; verify the send result.
账号或开播台设置已变更；请核对发送结果	The account or broadcast settings changed. Verify the send result.
弹幕请求超时，请核对发送结果	Chat request timed out. Verify the send result.
弹幕被平台拦截，未确认发送成功	The platform filtered this message. Sending was not confirmed.
弹幕被直播间屏蔽，未确认发送成功	This room filtered the message. Sending was not confirmed.
平台未确认弹幕发送成功，请核对接收记录	The platform did not confirm sending. Check the received chat.
弹幕长度限制无效	Invalid chat length limit.
表情包列表无效	Invalid emoticon pack list.
表情列表无效	Invalid emoticon list.
表情列表过大	The emoticon list is too large.
表情标识无效	Invalid emoticon identifier.
表情标识重复	Duplicate emoticon identifier.
表情包名称无效	Invalid emoticon pack name.
当前账号没有这个直播间的用户管理权限，或权限信息不可用	This account lacks room moderation permission, or permission details are unavailable.
当前账号没有这个直播间的禁言权限	This account cannot mute users in this room.
当前账号没有这个直播间的拉黑权限	This account cannot block users in this room.
弹幕超过当前直播间允许的长度，请缩短后再发送	Message exceeds this room's limit. Shorten it before sending.
请输入要发送的弹幕	Enter a chat message.
弹幕不能包含换行或控制字符	Chat messages cannot contain line breaks or control characters.
当前账号没有使用这个表情的权限	This account cannot use this emoticon.
这个表情当前不可用，请刷新表情列表	This emoticon is unavailable. Refresh the list.
直播间与当前登录账号不匹配	The live room does not belong to the signed-in account.
弹幕发送身份与当前账号不匹配	Chat identity does not match the current account.
请选择禁言时长	Choose a mute duration
不支持的直播间用户管理操作	Unsupported room moderation action
直播间用户管理正在处理请求，请稍候	Room moderation is busy. Please wait.
请先扫码登录哔哩哔哩，再管理直播间用户	Sign in to Bilibili by QR code to moderate room users
登录身份与当前账号不匹配，请重新扫码	The session identity differs from the signed-in account. Sign in again.
直播间已变更，请重新打开用户资料	The room changed. Reopen the user's card.
用户或直播间已变更，请重新打开用户资料	The user or room changed. Reopen the user's card.
当前登录账号不是这个直播间的主播或房管	The signed-in account is not this room's owner or moderator
只有这个直播间的主播或高级房管可以拉黑用户	Only the room owner or a senior moderator can block users
只有这个直播间的主播可以设置或撤销房管	Only the room owner can appoint or remove moderators
账号或直播间已变更，用户管理请求已取消；请重新打开用户资料	The account or room changed. The request was cancelled; reopen the user's card.
账号或直播间已变更；请重新打开用户资料并核对操作结果	The account or room changed. Reopen the user's card and verify the result.
用户管理信息已过期，请重新打开用户资料	Moderation details expired. Reopen the user's card.
用户管理响应无效	Invalid moderation response
请先选择要管理的直播间	Select a room to moderate first
这个用户没有可用的真实 UID，无法执行禁言或拉黑	This user has no usable public UID and cannot be muted or blocked
不能禁言或拉黑这个直播间的主播	You cannot mute or block this room's owner
不能对当前登录账号执行禁言或拉黑	You cannot mute or block the signed-in account
禁言时长须为本场、永久或 1 到 720 小时	Mute duration must be this broadcast, permanent, or 1 to 720 hours
OBS 当前使用高级输出模式，请在 OBS 的「设置 → 输出 → 推流」中配置码率	OBS uses Advanced output mode. Set the bitrate in OBS Settings → Output → Streaming.
请先停止 OBS 的推流、录制、回放缓冲和虚拟摄像头，再修改码率	Stop OBS streaming, recording, replay buffer and virtual camera before changing the bitrate.
视频码率须为 100–100000 Kbps 的整数	Video bitrate must be an integer between 100 and 100000 Kbps
OBS 读取的码率与保存值不一致，请刷新后检查	The bitrate read from OBS differs from the saved value. Refresh and check it.
OBS 码率设置：{0}	OBS bitrate settings: {0}
OBS 配置档已切换，请重新读取后检查码率	The OBS profile changed. Read the bitrate again and check it.
OBS 当前有输出运行；码率可以保存，下次开播生效	OBS has active outputs. You can save the bitrate; it applies the next time streaming starts.
请先连接直播间	Connect to a live room first
缺少高能榜人数	Missing contribution rank count
高能榜列表无效	Invalid contribution rank list
缺少主播 UID	Missing streamer UID
缺少直播状态	Missing broadcast status
不支持的开播管理操作	Unsupported broadcast management action
开播管理正在处理请求，请稍候	Broadcast management is processing a request. Please wait.
当前没有推流信息，请点击开播获取	No stream details are available. Open the room to get them.
请先扫码登录哔哩哔哩，再管理自己的直播间	Sign in to Bilibili by QR code to manage your own room
账号已变更，开播管理请求已取消；请刷新房间状态	Account changed. The broadcast request was cancelled; refresh the room status.
账号已变更，请重新加载自己的直播间	Account changed. Load your own room again.
服务地址已更新，尚未检查服务	Service address updated; awaiting a check
服务检查超时，请稍后重试	Service check timed out; try again shortly
本地服务连接不存在或类型不一致	Local service connection is missing or has a different service type
没有可用的音频输出设备	No audio output device available
找不到音频输出设备：{0}	Audio output device not found: {0}
同名音频设备不止一个：{0}	Multiple audio devices have this name: {0}
音频设备操作失败：{0}	Audio device operation failed: {0}
设备不支持的采样格式：{0}	Unsupported device sample format: {0}
音频输出设备已断开	Audio output device disconnected
输出设备连续 5 秒未消耗音频	The output device has not consumed audio for 5 seconds
直播间号必须大于零	Live room ID must be greater than zero
主播 UID 必须大于零	Streamer UID must be greater than zero
网络请求失败	Network request failed
B站接口返回错误码 {0}	Bilibili API returned error code {0}
B站返回了不支持或无效的数据：{0}	Bilibili returned unsupported or invalid data: {0}
当前扫码流程已结束，请生成新的二维码	This login session has ended. Generate a new QR code
直播连接任务已经运行	The live connection task is already running
此账号没有可用的直播间	This account has no available live room
B站登录已失效，请重新扫码	Bilibili login expired. Scan again
文件操作失败：{0}	File operation failed: {0}
数据库操作失败：{0}	Database operation failed: {0}
配置格式错误：{0}	Invalid configuration format: {0}
不支持的数据库版本：{0}	Unsupported database version: {0}
不支持的音频格式：{0}	Unsupported audio format: {0}
音频素材超过 128 MiB 限制	Audio file exceeds the 128 MiB limit
素材仍被规则引用：{0}	Sound is still referenced by rules: {0}
素材不存在：{0}	Sound not found: {0}
备份文件不属于此数据目录	The backup file does not belong to this data folder
服务连接不存在：{0}	Service connection not found: {0}
声音预设不存在：{0}	Voice preset not found: {0}
用户声音绑定不存在：{0}	Viewer voice binding not found: {0}
观众名称不能为空、超过 200 字，或包含前后空格与控制字符	Viewer name must contain 1–200 characters with no leading/trailing whitespace or control characters
此观众名称已有声音绑定，请编辑原有绑定	This viewer name already has a voice binding. Edit the existing binding
此观众 UID 已有声音绑定，请编辑原有绑定	This viewer UID already has a voice binding. Edit the existing binding
声音预设是当前默认声音，请先更换默认声音	This preset is the default voice. Choose a different default first
声音预设仍被 {0} 条用户绑定引用	This voice preset is still referenced by {0} viewer bindings
服务连接仍被 {0} 个声音预设引用	This service connection is still referenced by {0} voice presets
服务连接仍被声音预设引用，不能更换服务类型	This connection is used by voice presets. Its service type cannot be changed
服务连接地址不能包含凭据、查询参数或片段	Service URL must not contain credentials, query parameters, or fragments
服务连接地址无效	Invalid service URL
服务连接超时无效：{0}	Invalid service timeout: {0}
已保存的 B 站会话格式无效，请重新扫码	Saved Bilibili session is invalid. Scan again
直播设置无效	Invalid live room settings
豆包设备标识无效，请检查本机数据目录	Invalid Doubao device ID. Check the local data folder
桌面偏好设置无效	Invalid desktop preferences
参考音频路径无效、不可读或文件已删除	Reference audio path is invalid, unreadable, or deleted
参考配置无效或服务类型不匹配	Invalid reference settings or mismatched service type
Fish Audio 参数无效或连接类型不匹配	Invalid Fish Audio options or mismatched connection type
dots.tts 参数无效或连接类型不匹配	Invalid dots.tts options or mismatched connection type
Fish Audio 音色名称不能为空	Fish Audio voice name cannot be empty
Fish Audio 音色 ID 或页面链接无效	Invalid Fish Audio voice ID or page link
试听文本不能为空、不能超过 2000 字，且不能包含控制字符	Preview text must contain 1–2000 characters with no control characters
数据已重置，但数据库仍被其他实例占用；请关闭其他实例后重新清除	Data reset, but the database is in use by another instance. Close other instances and clear data again
OBS 叠加层设置无效	Invalid OBS overlay settings
OBS 叠加层无法使用本机端口 {0} 起的 {1} 个端口：{2}	The OBS overlay could not use any of {1} local ports starting at {0}: {2}
请先启用 OBS 叠加层	Turn on the OBS overlay first
缺少叠加层设置	Overlay settings are missing
无法连接 OBS（{0}）：请确认 OBS 已打开，并在「工具 → WebSocket 服务器设置」中开启服务器，端口与弹幕姬一致	Could not connect to OBS ({0}). Make sure OBS is open, the server is enabled in Tools → WebSocket Server Settings, and the port matches
OBS WebSocket 服务器启用了密码，请在“设置 → OBS 与开播 → OBS 连接”中填写	The OBS WebSocket server requires a password. Enter it in Settings → OBS & going live → OBS connection
OBS WebSocket 密码不正确	Incorrect OBS WebSocket password
OBS 返回了不支持的数据：{0}（需要 OBS 28 或更高版本）	OBS returned unsupported data: {0} (OBS 28 or later is required)
OBS 未能{0}：{1}（代码 {2}）	OBS could not {0}: {1} (code {2})
OBS 未能{0}：代码 {1}	OBS could not {0}: code {1}
OBS 未能{0}：{1}	OBS could not {0}: {1}
OBS 已停止推流，但{0}	OBS stopped streaming, but {0}
等待 OBS 响应超时	Timed out waiting for OBS
找不到 OBS 程序（obs64.exe），请在“设置 → OBS 与开播 → OBS 连接”中选择	OBS (obs64.exe) was not found. Choose it in Settings → OBS & going live → OBS connection
无法启动 OBS：{0}	Could not start OBS: {0}
OBS 已启动，但 {0} 秒内没有连上 WebSocket：请确认 OBS 已开启 WebSocket 服务器，或先处理 OBS 里的提示窗口	OBS started, but its WebSocket did not answer within {0} seconds. Make sure the WebSocket server is enabled in OBS, or close any prompt OBS is showing
OBS 设在其他电脑上，弹幕姬只能启动本机的 OBS	OBS is set to another computer; this app can only start OBS on this computer
程序文件不存在	the program file does not exist
没有权限运行，请检查安全软件	not allowed to run; check your security software
系统错误 {0}	system error {0}
读取画布大小	read the canvas size
读取当前场景	read the current scene
读取叠加层来源	read the overlay source
更新叠加层来源	update the overlay source
添加叠加层来源	add the overlay source
查找场景中的叠加层	find the overlay in the scene
把叠加层加入当前场景	add the overlay to the current scene
画布大小	canvas size
当前场景	current scene
OBS 地址或端口无效	Invalid OBS address or port
OBS 联动设置无效：地址只能是主机名或 IPv4，端口 1–65535，密码不超过 256 字且不含控制字符	Invalid OBS link settings: use a host name or IPv4 address, a port from 1 to 65535, and a password of up to 256 characters without control characters
OBS 联动设置不完整或格式无效	OBS link settings are incomplete or invalid
请填写 OBS WebSocket 密码	Enter the OBS WebSocket password
连接被拒绝	connection refused
找不到该地址	address not found
网络错误	network error
该端口不是 OBS WebSocket 服务器	this port is not an OBS WebSocket server
握手失败	handshake failed
连接已断开	connection lost
OBS 关闭了连接	OBS closed the connection
RPC 版本	RPC version
鉴权参数	authentication parameters
消息格式	message format
二进制消息	binary message
请求状态	request status
版本信息	version information
推流状态	stream status
读取版本	read its version
读取推流状态	read the stream status
写入推流设置	save the stream settings
开始推流	start streaming
停止推流	stop streaming
OBS 正在推流	OBS is already streaming
OBS 当前没有推流	OBS is not streaming
OBS 尚未准备好，请稍后重试	OBS is not ready yet. Try again shortly
凭据为空	Credentials are empty
凭据超过系统加密接口的长度限制	Credentials exceed the system encryption length limit
Windows 凭据保护失败：{0}	Windows credential protection failed: {0}
Windows 凭据解密失败：{0}	Windows credential decryption failed: {0}
凭据不是 UTF-8 文本	Credentials are not UTF-8 text
此平台不支持 Windows 凭据保护	This platform does not support Windows credential protection
这条消息已被过滤	This message was filtered
未选择声音预设	No voice preset selected
声音预设缺少音色或参考音频 ID	Voice preset has no voice or reference audio ID
声音预设的语速须在 0.5 到 2.0 之间	Voice preset speed must be between 0.5 and 2.0
声音预设的音量须在 0 到 2.0 之间	Voice preset volume must be between 0 and 2.0
声音预设对应的服务连接不存在	The service connection for this voice preset does not exist
声音预设和服务连接的类型不一致	Voice preset and service connection types do not match
此服务连接缺少登录信息或 API Key	This connection has no login information or API key
豆包设备标识尚未初始化	Doubao device ID has not been initialized
GPT-SoVITS 音色语言或分句方式无效	Invalid GPT-SoVITS voice language or sentence splitting method
音效素材文件不可用	Sound effect file unavailable
参考音频原文件已删除或不可读，请重新选择	Original reference audio is deleted or unreadable. Select it again
找不到随应用提供的 ffmpeg.exe	Bundled ffmpeg.exe not found
模板缺少结束括号	Template has an unclosed bracket
模板中存在孤立的结束括号	Template has an unmatched closing bracket
不支持的模板字段：{0}	Unsupported template field: {0}
配置过大：{0}	Configuration is too large: {0}
礼物与醒目留言金额阈值必须是非负有限数	Gift and Super Chat thresholds must be finite, non-negative numbers
词典关键词不能为空	Dictionary keywords cannot be empty
关键词音效需要非空关键词和素材	Keyword sounds require a non-empty trigger and sound
旧配置预览后已变化，请重新预览	The old configuration changed after preview. Preview it again
选择了预览中不存在或重复的音效	Selected sounds are duplicated or absent from the preview
所选音效不是可用的本机绝对文件	Selected sound must be an available local file with an absolute path
所选音效内容在预览后发生变化，请重新预览	Selected sound changed after preview. Preview it again
必须同时选择导入规则才能导入音效	Select rules as well to import sounds
当前规则已有修改，需明确选择覆盖规则	Current rules have changes. Explicitly allow replacement
当前直播设置已有修改，需明确选择覆盖直播设置	Current live settings have changes. Explicitly allow replacement
无法读取旧配置：{0}	Unable to read old configuration: {0}
直播会话已启动	The live session has already started
直播间连接失败：{0}	Live room connection failed: {0}
播放调度器已关闭	Playback scheduler is closed
仅显示弹幕的会话没有播放组件，请启用语音后重新连接	A messages-only session has no playback component. Enable speech and reconnect
音频组件 FFmpeg 无法启动：{0}（系统错误 {1}）	FFmpeg could not start: {0} (system error {1})
音频组件 FFmpeg 无法启动：{0}	FFmpeg could not start: {0}
音频组件 FFmpeg 异常退出（退出码 {0} / {1}）	FFmpeg exited unexpectedly (exit code {0} / {1})
音频组件 FFmpeg 异常终止，无法取得退出码	FFmpeg terminated unexpectedly; exit code unavailable
输出设备已断开或驱动报告错误，请重新连接设备	Output device disconnected or its driver reported an error. Reconnect the device
音频管道中断：{0}（系统错误 {1}）	Audio pipe interrupted: {0} (system error {1})
音频管道中断：{0}	Audio pipe interrupted: {0}
请先取消静音并提高音量，再测试声音	Unmute and increase the volume before testing sound
请先取消静音或提高音量，再测试声音	Unmute or increase the volume before testing sound
尚未检查本地服务	Local service not checked yet
尚未配置本地服务目录	Local service folder not configured
本应用启动的服务已停止	The service started by this app has stopped
本次会话已暂停自动启动；外部服务不会被停止	Automatic startup is paused for this session; external services are kept running
正在检查本地服务	Checking local service
本地服务进程已退出，请检查安装目录	Local service process exited. Check the installation folder
请先设置本地 TTS 目录	Set the local TTS folder first
服务正在加载模型	Service is loading models
请选择存在的本地 TTS 安装目录	Choose an existing local TTS installation folder
本地 TTS 安装目录无法访问	Local TTS installation folder is inaccessible
dots.tts 目录结构不完整	Incomplete dots.tts folder structure
dots.tts 目录缺少 2p 模型、启动入口或 Python 环境	The dots.tts folder is missing 2p models, its startup entry, or Python
GPT-SoVITS 目录缺少 api_v2.py 或 runtime/python.exe	The GPT-SoVITS folder is missing api_v2.py or runtime/python.exe
GPT-SoVITS 目录缺少推理配置文件	The GPT-SoVITS folder is missing inference configuration
本地服务连接正常	Local service connection ready
本地服务已就绪	Local service ready
连接超时	Connection timed out
TLS 安全连接失败，请检查系统时间、证书及网络代理	TLS connection failed. Check system time, certificates, network, and proxy
连接或接收超时	Connection or receive timed out
连接被拒绝，请检查网络或防火墙	Connection refused. Check network or firewall
连接中断，请检查网络或代理	Connection interrupted. Check network or proxy
无法连接或传输数据，请检查网络、DNS 或代理	Unable to connect or transfer data. Check network, DNS, or proxy
WebSocket 传输失败	WebSocket transfer failed
服务未接受连接	The service did not accept the connection
连接被重定向	The connection was redirected
请求频率过高	Too many requests
账号或设备语音请求受限	Speech requests restricted for this account or device
登录状态无效，请重新登录	Invalid login state. Sign in again
找不到音频组件 ffmpeg.exe	Audio component ffmpeg.exe not found
音频解码失败或文件不完整	Audio decoding failed or the file is incomplete
输出设备连续 5 秒未消耗音频，请重新连接或选择其他设备	Output device has not consumed audio for 5 seconds. Reconnect or choose another device
音频输出设备操作失败，请重新连接或选择其他设备	Audio output device operation failed. Reconnect or choose another device
语速或音量配置无效	Invalid speech speed or volume
音频组件管道中断：{0}（系统错误 {1}）	Audio component pipe interrupted: {0} (system error {1})
音频组件管道中断：{0}	Audio component pipe interrupted: {0}
访问被拒绝，请检查文件权限或安全软件拦截记录	Access denied. Check file permissions or security software records
文件或所需组件不存在	File or required component not found
音频组件提前关闭了管道	The audio component closed the pipe early
操作超时	Operation timed out
系统操作失败	System operation failed
服务响应超时	Service response timed out
TLS 安全连接失败，请检查系统证书、系统时间、网络或代理设置	TLS connection failed. Check system certificates, time, network, or proxy settings
连接被拒绝，请检查网络、代理或服务是否可达	Connection refused. Check network, proxy, or service availability
连接中断，请检查网络或代理设置	Connection interrupted. Check network or proxy settings
网络连接失败，请检查网络、DNS 或代理设置	Network connection failed. Check network, DNS, or proxy settings
合成总时间超过上限	Synthesis exceeded its time limit
登录信息格式无效	Invalid login information format
设备标识格式无效	Invalid device ID format
请先完成豆包登录	Sign in to Doubao first
请选择有效的豆包音色	Choose a valid Doubao voice
语速须在 0.5 到 2.0 倍之间	Speech speed must be between 0.5 and 2.0
总超时须在 1 到 120 秒之间	Total timeout must be between 1 and 120 seconds
WebSocket 地址无效	Invalid WebSocket URL
朗读文本须为 1 到 10000 个字符	Speech text must contain 1–10000 characters
豆包请求已暂停，请检查登录或稍后手动恢复	Doubao requests are paused. Check login or resume manually later
连接在完成事件之前关闭	Connection closed before completion
无法识别的事件	Unrecognized event
事件格式无效	Invalid event format
登录状态无效，请重新登录（{0}）	Invalid login state. Sign in again ({0})
登录状态无效（{0}）	Invalid login state ({0})
账号或设备语音请求受限（{0}）	Speech requests restricted for this account or device ({0})
请求频率过高（{0}）	Too many requests ({0})
服务拒绝了语音合成请求	The service rejected the speech synthesis request
AAC 音频为空或帧不完整	AAC audio is empty or has incomplete frames
HTTP 请求失败	HTTP request failed
请求失败	Request failed
连接	connection
发送	send
接收	receive
合成	synthesis
豆包	Doubao
豆包扫码登录	Doubao QR login
指定服务连接不可用	Selected service connection unavailable
指定服务登录信息不可用	Selected service login information unavailable
豆包设备信息不可用	Doubao device information unavailable
指定参考音频不可用	Selected reference audio unavailable
指定声音配置不可用	Selected voice configuration unavailable
尚未播放语音	no speech has played
未配置可用的主选声音	No usable preferred voice configured
默认声音配置不可用	Default voice configuration unavailable
`.trim().split('\n').map(line => line.split('\t'));

const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const templates = copy.map(([source, target]) => {
  const fields = [...source.matchAll(/\{(\d+)\}/g)].map(match => match[1]);
  return { pattern: new RegExp('^' + source.split(/\{\d+\}/).map(escapePattern).join('(.*?)') + '$', 'u'), target, fields };
});

export function localizeDiagnostic(source) {
  if (getLanguage() !== 'en' || typeof source !== 'string') return source;
  const coded = /^(.*?)(\s+\[DV-[A-Z0-9-]{2,21}\](?:\s+\[DV-[A-Z0-9-]{2,21}\])*)$/su.exec(source);
  if (coded) return localizeDiagnostic(coded[1]) + coded[2];
  for (const prefix of ['播报未能播放：', 'Speech playback failed: ']) {
    if (source.startsWith(prefix)) return 'Speech playback failed: ' + localizeDiagnostic(source.slice(prefix.length));
  }
  const service = /^(豆包扫码登录|豆包|Fish Audio|GPT-SoVITS|dots\.tts) (配置无效|返回 HTTP (\d+)|(.+?)请求失败|音频无效|响应无效)：(.+)$/u.exec(source);
  if (service) {
    const name = localizeDiagnostic(service[1]);
    const kind = service[3] ? `returned HTTP ${service[3]}` : service[4] ? `${localizeDiagnostic(service[4])} request failed`
      : ({ 配置无效: 'invalid configuration', 音频无效: 'invalid audio', 响应无效: 'invalid response' })[service[2]];
    return `${name} ${kind}: ${localizeDiagnostic(service[5])}`;
  }
  for (const { pattern, target, fields } of templates) {
    const match = pattern.exec(source);
    if (match) return target.replace(/\{(\d+)\}/g, (_, field) => {
      const value = match[fields.indexOf(field) + 1];
      // FFmpeg's cause is sanitized enum copy; device/path parameters are data.
      // OBS fields are sanitized enum copy too (reason, step); OBS's own comments stay verbatim.
      const copyField = (source.startsWith('音频组件') && field === '0') || /^(?:OBS |无法连接 OBS|无法启动 OBS)/u.test(source);
      return copyField ? localizeDiagnostic(value) : value;
    });
  }
  return source;
}
