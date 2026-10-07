// Release WebView2 comparison harness. Test-only fictional snapshots; the
// application itself runs with a new --data-dir and --disable-network.
// Requires a test-only build with --remote-debugging-port=59493 appended to
// WEBVIEW_BROWSER_ARGS; production executables do not expose that port.
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {createHash} = require('node:crypto');
const {chromium} = require('playwright');
const [exe, uiRoot, output] = process.argv.slice(2).map(p=>path.resolve(p));
const pause = ms=>new Promise(r=>setTimeout(r,ms));
const longRun = process.env.DV_PERF_LONG === '1';
const event = n=>({platform_event_id:`perf-${n}`,room_id:999,observed_at_ms:1791288000000+n,kind:'danmaku',user_id:500+n%7,user_name:`测试观众${n%7}`,message:`这是一条用于同负载性能比较的弹幕 ${n}，保留原有水面与逐字动画。`,avatar_url:null});
const state = {config_revision:1,onboarding_done:true,network_disabled:true,preferences:{language:'zh-CN',appearance:'dark',scale:1,master_volume:1,tts_enabled:false,broadcast_console:false},setup:{room_id:999,tts_enabled:false,mode:'account',uid:42},live_settings:{room_id:999,gift_merge:{enabled:false}},live:{running:true,state:'connected',room_id:999,received:100,events:Array.from({length:100},(_,i)=>event(i)),audience:{active:false}},queue:{current:null,pending:[],history:[]},rules:{default_preset_id:null,preferred_presets:{},user_words:[]},connections:[],presets:[],bindings:[],assets:[],devices:[],local_services:{},account:{user_id:42,name:'隔离性能测试'},qr:{status:'idle'},status:{},broadcast:{room:null,areas:[],busy:false},obs:{settings:{enabled:false,host:'127.0.0.1',port:4455},has_password:false,status:{state:'idle'},local:true},overlay:{settings:{enabled:false},running:false,clients:[]},chat_send:{busy:false,error:null,account_id:42,room_id:999,message_limit:20,emoticons:[]},moderation:{busy:false,can_moderate:false}};
(async()=>{
  await fs.mkdir(output); const phaseFile=path.join(output,'phase.txt');
  const server=net.createServer(); await new Promise(r=>server.listen(59493,'127.0.0.1',r)); const port=server.address().port; await new Promise(r=>server.close(r));
  const app=spawn(exe,['--data-dir',path.join(output,'data'),'--disable-network'],{windowsHide:true,env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`},stdio:'ignore'});
  const errors=[], scenarios=[]; let browser,sampler,page;
  const result={passed:false,exe,sha256:createHash('sha256').update(await fs.readFile(exe)).digest('hex'),pid:app.pid,evidence:'Real native release WebView2 window, same fictional 100-message snapshot and in-page test instrumentation; no real live service, audio or accounts. Production snapshot polling remains at its actual cadence; CDP and sampling overhead apply equally; no low-end-device inference.',scenarios,errors};
  try {
    for(let i=0;i<100;i++){try{const r=await fetch(`http://127.0.0.1:${port}/json/version`);if(r.ok)break;}catch{} await pause(100);}
    browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context=browser.contexts()[0]; page=context.pages()[0];
    page.on('pageerror',e=>errors.push(e.message));
    await page.waitForURL('http://tauri.localhost/**');
    await page.waitForFunction(()=>window.__TAURI__?.core && document.readyState==='complete');
    await page.evaluate(async()=>{
      await window.__TAURI__.core.invoke('dispatch',{action:'live.save',payload:{room_id:999}});
      await window.__TAURI__.core.invoke('dispatch',{action:'onboarding.finish',payload:{tts_enabled:false,connect:false}});
    });
    await page.reload(); await page.locator('#live-shell').waitFor();
    const source=await fs.readFile(path.join(uiRoot,'app.js'),'utf8');
    result.appJsSha256=createHash('sha256').update(source).digest('hex');
    // WebView2's app protocol bypasses CDP response routing. Replace only the
    // mutable global API namespace in this isolated page; original production
    // polling/rendering and native visibility events continue unchanged.
    await page.evaluate(async fixture=>{
      fixture.config_revision=(await window.__TAURI__.core.invoke('snapshot')).config_revision+1;
      window.__perfState=fixture;
      window.__perfNativeInvoke=window.__TAURI__.core.invoke;
      window.__TAURI__.core={...window.__TAURI__.core,invoke:async(command,args)=>{
        if(command==='snapshot')return structuredClone(window.__perfState);
        if(command==='dispatch'){
          if(args.action==='preferences.save')Object.assign(window.__perfState.preferences,args.payload.preferences);
          return structuredClone(window.__perfState);
        }
        return window.__perfNativeInvoke(command,args);
      }};
    },state);
    await page.bringToFront();
    await page.locator('#lake-current .lake-message').waitFor({timeout:20000});
    await page.evaluate(()=>{
      window.__perfPush=next=>{window.__perfState=next};
      window.__perfReset=()=>{window.__frames=[];window.__tasks=[];window.__inputs=[];window.__pushCosts=[];window.__mutations=0;};
      window.__perfReset();let previous=0;function frame(t){if(previous)window.__frames.push(t-previous);previous=t;requestAnimationFrame(frame);}requestAnimationFrame(frame);
      new PerformanceObserver(list=>window.__tasks.push(...list.getEntries().map(e=>e.duration))).observe({type:'longtask',buffered:false});
      new PerformanceObserver(list=>window.__inputs.push(...list.getEntries().map(e=>({name:e.name,duration:e.duration,inputDelay:e.processingStart-e.startTime})))).observe({type:'event',durationThreshold:16});
      new MutationObserver(records=>window.__mutations+=records.length).observe(document.querySelector('#chat-feed'),{childList:true,subtree:true,attributes:true,characterData:true});
    });
    await page.bringToFront(); await pause(2200);
    sampler=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'sample-native-performance.ps1'),'-RootProcessId',String(app.pid),'-PhaseFile',phaseFile,'-Output',path.join(output,'resources.json'),'-Seconds','900'],{windowsHide:true,stdio:'ignore'});
    const cdp=await context.newCDPSession(page); const {windowId}=await cdp.send('Browser.getWindowForTarget');
    async function phase(name,ms,action){await fs.writeFile(phaseFile,name);await page.evaluate(()=>window.__perfReset());if(action)await action();await pause(ms*(longRun?2:1));const values=await page.evaluate(()=>({frames:window.__frames,tasks:window.__tasks,inputs:window.__inputs,pushCosts:window.__pushCosts,historyMutations:window.__mutations,nodes:document.getElementsByTagName('*').length,heap:performance.memory?.usedJSHeapSize,inactive:document.documentElement.dataset.inactive}));scenarios.push({name,...values});await fs.writeFile(path.join(output,'results.json'),JSON.stringify(result,null,2));}
    await phase('foreground-idle',20000);
    await phase('same-snapshot',10000,()=>page.evaluate(()=>{window.__sameTimer=setInterval(()=>{const t=performance.now();window.__perfPush(structuredClone(window.__perfState));window.__pushCosts.push(performance.now()-t);},100);}));
    await page.evaluate(()=>clearInterval(window.__sameTimer));
    await phase('danmaku-burst',20000,()=>page.evaluate(()=>{let n=100;window.__burstTimer=setInterval(()=>{const t=performance.now();const s=window.__perfState;const e={...s.live.events.at(-1),platform_event_id:`perf-${n}`,observed_at_ms:1791288000000+n,message:`这是一条用于同负载性能比较的弹幕 ${n}，保留原有水面与逐字动画。`};s.live.events.push(e);s.live.events.shift();s.live.received=++n;window.__perfPush(structuredClone(s));window.__pushCosts.push(performance.now()-t);},100);}));
    await page.evaluate(()=>clearInterval(window.__burstTimer));
    await phase('history-scroll',10000,async()=>{await page.locator('[data-action="history.open"]').click();await page.evaluate(()=>{window.__scrollTimer=setInterval(()=>{const s=document.querySelector('#chat-scroll');s.scrollTop=(s.scrollTop+200)%(s.scrollHeight-s.clientHeight||1);},50);});});
    await page.evaluate(()=>clearInterval(window.__scrollTimer)); await page.keyboard.press('Escape');
    await phase('settings-switch',10000,async()=>{
      result.settingsLatenciesMs=[];
      const start=Date.now(); await page.locator('[data-action="settings.open"]').first().click();
      await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
      result.settingsLatenciesMs.push({action:'open',ms:Date.now()-start});
      if(longRun){
        const ids=await page.locator('[data-action="settings.tab"]').evaluateAll(nodes=>nodes.map(n=>n.dataset.id));
        for(let round=0;round<2;round++)for(const id of ids){const at=Date.now();await page.locator(`[data-action="settings.tab"][data-id="${id}"]`).click();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));result.settingsLatenciesMs.push({action:id,round,ms:Date.now()-at});}
      }
    });
    await page.keyboard.press('Escape');
    await phase('minimized',12000,()=>cdp.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'minimized'}}));
    const restored=Date.now(); await cdp.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'normal'}}); await page.bringToFront(); await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));result.restoreTwoFramesMs=Date.now()-restored;
    await phase('restored-foreground',12000);
    if(longRun){
      await phase('sustained-burst',60000,()=>page.evaluate(()=>{let n=10000;window.__burstTimer=setInterval(()=>{const s=window.__perfState;s.live.events.push({...s.live.events.at(-1),platform_event_id:`soak-${n}`,observed_at_ms:1791288000000+n,message:`持续负载回归 ${n++}`});s.live.events.shift();s.live.received++;},100);}));
      await page.evaluate(()=>clearInterval(window.__burstTimer));
      await phase('post-load-idle',15000);
    }
    await page.screenshot({path:path.join(output,'restored.png')});
    result.passed=errors.length===0;
    if(errors.length)throw new Error(errors.join('\n'));
  }catch(e){result.error=e.stack;if(page){result.body=await page.locator('body').innerText().catch(()=>null);result.url=page.url();await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}throw e;}
  finally{if(app.exitCode===null)app.kill();await pause(1800);if(sampler&&sampler.exitCode===null)await new Promise(r=>{sampler.once('exit',r);setTimeout(r,5000)});if(browser)await browser.close().catch(()=>{});await fs.writeFile(path.join(output,'results.json'),JSON.stringify(result,null,2));}
})().catch(e=>{console.error(e);process.exitCode=1;});
