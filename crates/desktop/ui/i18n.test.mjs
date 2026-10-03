import test from 'node:test';
import assert from 'node:assert/strict';
import { t, ui, getLanguage, setLanguage } from './i18n.mjs';
import { english } from './i18n-en.mjs';
import { localizeDiagnostic } from './i18n-diagnostics.mjs';
import { errorMessage, eventKey, eventText, headerIdentity, liveConnectionView, messageParts, playbackCaption, playbackIssue, qrLabel } from './helpers.mjs';

test.afterEach(() => setLanguage('zh-CN'));

test('language defaults safely to Chinese and supports repeated switches', () => {
  setLanguage('unsupported');
  assert.equal(getLanguage(), 'zh-CN');
  assert.equal(t('设置'), '设置');
  assert.equal(setLanguage('en'), true);
  assert.equal(t('设置'), 'Settings');
  assert.equal(setLanguage('en'), false);
  assert.equal(setLanguage('zh-CN'), true);
  assert.equal(t('设置'), '设置');
});

test('English catalog has no empty or untranslated entries', () => {
  setLanguage('en');
  for (const [source, translated] of Object.entries(english)) {
    assert.ok(translated.length, source);
    assert.doesNotMatch(translated, /\p{Script=Han}/u, source);
    assert.equal(t(source), translated, source);
  }
});

test('template interpolation preserves Chinese names, speech templates and HTML escaping', () => {
  setLanguage('en');
  const name = '设置豆包声音 <img src=x>';
  assert.equal(ui`声音：${name}`, `Voice: ${name}`);
  assert.equal(ui`<textarea>${'{user_name} 送出 {gift_name}'}</textarea>`, '<textarea>{user_name} 送出 {gift_name}</textarea>');
  assert.equal(ui`已切换到 ${'声音${newName}'}`, 'Switched to 声音${newName}');
});

test('live status and QR text translate while message content and event identity stay intact', () => {
  const message = { room_id:1, kind:'danmaku', user_name:'超绝可爱弹幕姬', message:'设置声音，欢迎来到直播间。', observed_at_ms:1 };
  const key = eventKey(message);
  setLanguage('en');
  assert.equal(eventKey(message), key);
  assert.equal(eventText(message), message.message);
  assert.equal(messageParts(message)[0].text, message.message);
  assert.equal(eventText({kind:'gift',gift_name:'中文礼物',quantity:2}), 'Sent 中文礼物 × 2');
  assert.equal(headerIdentity({account:{user_id:1,name:message.user_name}}).name, message.user_name);
  assert.equal(headerIdentity({}).name, 'DanmakuVoice');
  assert.equal(liveConnectionView({running:true,state:'reconnecting'}).caption, 'Connection lost, reconnecting');
  assert.equal(qrLabel({status:'scanned'}), 'Scanned. Confirm on your phone');
  assert.equal(playbackCaption({pending:[1,2]}), 'Queued · 2 messages');
  assert.equal(playbackCaption({current:{text:message.message}}), message.message);
});

test('English diagnostics retain support, service, system and process codes', () => {
  setLanguage('en');
  assert.equal(errorMessage('豆包 接收请求失败：服务响应超时 [DV-TD06]'), 'Doubao receive request failed: Service response timed out [DV-TD06]');
  assert.equal(errorMessage('豆包 响应无效：登录状态无效，请重新登录（710012001） [DV-TD08]'), 'Doubao invalid response: Invalid login state. Sign in again (710012001) [DV-TD08]');
  assert.equal(errorMessage('音频组件 FFmpeg 异常退出（退出码 -1073741790 / 0xC0000022） [DV-C04]'), 'FFmpeg exited unexpectedly (exit code -1073741790 / 0xC0000022) [DV-C04]');
  assert.equal(errorMessage('音频组件 FFmpeg 无法启动：访问被拒绝，请检查文件权限或安全软件拦截记录（系统错误 5） [DV-C02]'), 'FFmpeg could not start: Access denied. Check file permissions or security software records (system error 5) [DV-C02]');
  assert.match(playbackIssue({history:[{state:'failed',detail:'豆包 连接请求失败：连接超时 [DV-TD06]'}]}), /^Speech playback failed: Doubao connection request failed: Connection timed out \[DV-TD06\]$/);
});

test('diagnostic parameters and unknown messages are never rewritten or hidden', () => {
  setLanguage('en');
  assert.equal(errorMessage('找不到音频输出设备：声音与设置 [DV-A02]'), 'Audio output device not found: 声音与设置 [DV-A02]');
  assert.equal(localizeDiagnostic('文件操作失败：E:\\中文设置\\声音.wav [DV-S01]'), 'File operation failed: E:\\中文设置\\声音.wav [DV-S01]');
  assert.equal(errorMessage('新服务未知错误 123 [DV-T008]'), '新服务未知错误 123 [DV-T008]');
});
