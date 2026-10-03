import { getLanguage } from './i18n.mjs';

// Structured error templates preserve dynamic identifiers, names, paths and
// numeric system/service codes. Unknown diagnostics remain available verbatim.
const copy = `
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
      return source.startsWith('音频组件') && field === '0' ? localizeDiagnostic(value) : value;
    });
  }
  return source;
}
