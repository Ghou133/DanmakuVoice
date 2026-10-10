// Windows integration regression. Supply a test-only build with
// --remote-debugging-port=59493 in WEBVIEW_BROWSER_ARGS and an unused output
// directory. Production builds must not expose the debugging port.
// Only this owned --disable-network process and fresh data directory are used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const [exe, output] = process.argv.slice(2).map(p => path.resolve(p));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function windowState(pid, change) {
  // Read the OS foreground owner directly; ui_activity is the state under test.
  const script = `Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class VisibilityProbe {
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a,uint b,bool attach);

 public delegate bool EnumProc(IntPtr h,IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f,IntPtr l);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,System.Text.StringBuilder b,int n);
 public static IntPtr FindOwnedWindow(uint pid){IntPtr result=IntPtr.Zero;EnumWindows((h,l)=>{uint p;GetWindowThreadProcessId(h,out p);var c=new System.Text.StringBuilder(256);GetClassName(h,c,256);if(p==pid&&c.ToString()=="Tauri Window"){if(result!=IntPtr.Zero)throw new Exception("Multiple Tauri windows");result=h;}return true;},IntPtr.Zero);return result;}

 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd,uint flag);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd,int command);
}
'@
$owned=Get-Process -Id ${pid}
$hwnd=[VisibilityProbe]::FindOwnedWindow($owned.Id)
if(!$hwnd){throw 'Owned test window disappeared'}
${change ? `[VisibilityProbe]::ShowWindow($hwnd,${change === 'minimized' ? 6 : 9})|Out-Null;Start-Sleep -Milliseconds 900` : ''}
${change === 'foreground' ? `
[uint32]$unusedPid=0
$calling=[VisibilityProbe]::GetCurrentThreadId()
$foregroundThread=[VisibilityProbe]::GetWindowThreadProcessId([VisibilityProbe]::GetForegroundWindow(),[ref]$unusedPid)
$attached=[VisibilityProbe]::AttachThreadInput($calling,$foregroundThread,$true)
try{[VisibilityProbe]::SetForegroundWindow($hwnd)|Out-Null}finally{if($attached){[VisibilityProbe]::AttachThreadInput($calling,$foregroundThread,$false)|Out-Null}}
$targetThread=[VisibilityProbe]::GetWindowThreadProcessId($hwnd,[ref]$unusedPid)
$attached=[VisibilityProbe]::AttachThreadInput($calling,$targetThread,$true)
try{[VisibilityProbe]::SetFocus($hwnd)|Out-Null}finally{if($attached){[VisibilityProbe]::AttachThreadInput($calling,$targetThread,$false)|Out-Null}}
Start-Sleep -Milliseconds 900
if([VisibilityProbe]::GetAncestor([VisibilityProbe]::GetForegroundWindow(),3) -ne $hwnd){throw 'Owned Tauri window did not become foreground'}
` : ''}
@{pid=$owned.Id;createdUtc=$owned.StartTime.ToUniversalTime().ToString('o');hwnd=[long]$hwnd; foregroundHwnd=[long][VisibilityProbe]::GetForegroundWindow(); foregroundRoot=[long][VisibilityProbe]::GetAncestor([VisibilityProbe]::GetForegroundWindow(),3); visible=[VisibilityProbe]::IsWindowVisible($hwnd);minimized=[VisibilityProbe]::IsIconic($hwnd);foreground=([VisibilityProbe]::GetAncestor([VisibilityProbe]::GetForegroundWindow(),3) -eq $hwnd)} | ConvertTo-Json -Compress`;
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, encoding: 'utf8' }).trim());
}

(async () => {
  await fs.mkdir(output);
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(59493, '127.0.0.1', resolve); });
  await new Promise(resolve => reservation.close(resolve));
  const app = spawn(exe, ['--data-dir', path.join(output, 'data'), '--disable-network'], { windowsHide: true, stdio: 'ignore' });
  let browser;
  const result = { passed: false, exe, pid: app.pid, checks: [], visibleBackgroundExercised: false };
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch('http://127.0.0.1:59493/json/version')).ok) break; } catch {}
      await pause(100);
    }
    browser = await chromium.connectOverCDP('http://127.0.0.1:59493');
    const page = browser.contexts()[0].pages()[0];
    await page.waitForURL('http://tauri.localhost/**');
    await page.waitForFunction(() => window.__TAURI__?.core && document.readyState === 'complete');
    await page.evaluate(() => window.__TAURI__.core.invoke('dispatch', { action: 'live.save', payload: { room_id: 999 } }));
    await page.evaluate(() => window.__TAURI__.core.invoke('dispatch', { action: 'onboarding.finish', payload: { tts_enabled: false, connect: false } }));
    await page.reload(); await page.locator('#live-shell').waitFor();
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    let creation, nativeHwnd;
    for (const state of ['native-minimized', 'native-restored', 'native-foreground', 'webview-minimized', 'webview-restored']) {
      const minimized = state.endsWith('minimized');
      if (state.startsWith('webview')) {
        // CDP changes the embedded browser; this is deliberately separate
        // from a real native minimize, verified using IsIconic below.
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: minimized ? 'minimized' : 'normal' } });
        await pause(900);
      }
      const os = windowState(app.pid, state === 'native-foreground' ? 'foreground' : state.startsWith('native') ? (minimized ? 'minimized' : 'normal') : null);
      if (state.startsWith('native')) assert.equal(os.minimized, minimized, 'native window operation did not take effect');
      creation ??= os.createdUtc; assert.equal(os.createdUtc, creation, 'process identity changed');
      nativeHwnd ??= os.hwnd; assert.equal(os.hwnd,nativeHwnd,'must keep the same Tauri HWND, never the hidden Tao event target');
      const ui = await page.evaluate(async () => ({ active: await window.__TAURI__.core.invoke('ui_activity'), inactive: document.documentElement.dataset.inactive, reflection: getComputedStyle(document.querySelector('.lake-reflection'), '::before').animationPlayState }));
      const expected = os.visible && !os.minimized && os.foreground;
      if (os.visible && !os.minimized && !os.foreground) result.visibleBackgroundExercised = true;
      result.checks.push({ state, os, ui, expected });
      console.log(JSON.stringify(result.checks.at(-1)));
      assert.equal(ui.active, expected, 'native activity must match the actual foreground HWND after restore');
      assert.equal(ui.inactive, String(!expected), 'CSS animation policy must match the actual foreground HWND');
      assert.equal(ui.reflection,expected?'running':'paused','reflection plane follows native activity');
    }
    result.passed = true;
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { result.error = error.stack; throw error; }
  finally {
    if (app.exitCode === null) app.kill();
    await browser?.close().catch(() => {});
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
