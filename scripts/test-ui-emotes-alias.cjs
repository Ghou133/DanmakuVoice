// Headless regression and screenshots of the actual HTML/CSS UI with fictional
// offline fixtures. No native app, foreground window, real account, or TTS call.
// NODE_PATH must resolve Playwright; requires an installed Microsoft Edge.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const args = process.argv.slice(2);
const arg = (name, fallback) => args.includes(name) ? args[args.indexOf(name)+1] : fallback;
const root = path.resolve(arg('--ui-root', path.join(__dirname,'../crates/desktop/ui')));
const output = path.resolve(arg('--output', path.join(__dirname,'../dist/emotes-alias-tests')));
const overrideApp = arg('--app-js', '');
const captureStore = args.includes('--capture-store');
const measureRuntime = args.includes('--runtime-stability');
const events = [
  ['观众小雨','欢迎来到直播间～'], ['一颗星星','这个声音好可爱！'],
  ['橘子汽水','今天的配色好舒服 🌸'], ['路过的小猫','你好！第一次来直播间'],
  ['棉花糖','大家晚上好呀'], ['观众小雨','普通文字里的 emoji 😀 也可以播报'],
  ['海盐','支持一下，祝直播顺利！'], ['一颗星星','给新来的朋友比个心 ♡'],
  ['一颗星星','连续发言仍然保留每一条'],
].map(([user_name,message],i)=>({room_id:123,user_id:null,user_name,message,
  kind:i===6?'super_chat':'danmaku',price_yuan:i===6?30:0,observed_at_ms:i+1,emotes:[]}));
const state = {
  config_revision:1,onboarding_done:true,network_disabled:true,app_version:'0.2.2',data_dir:'示例数据',
  preferences:{language:'zh-CN',appearance:'dark',scale:1,master_volume:1,muted:false,tts_enabled:true,output:'default'},
  setup:{room_id:123,tts_enabled:true,mode:'account'},live_settings:{room_id:123,gift_merge:{enabled:false,initial_seconds:1.5,increment_seconds:.5,maximum_seconds:5}},
  live:{room_id:123,running:false,state:'stopped',events,errors:0,no_voice:0},
  queue:{current:null,pending:[],history:[]},
  rules:{default_preset_id:'voice',events:{danmaku_on:true,gift_on:true,free_gift_on:false,super_chat_on:true,guard_on:true,gift_threshold_yuan:5,super_chat_threshold_yuan:30},
    templates:{danmaku:'{user_name}说：{message}',gift:'{user_name}送出{gift_name}',super_chat:'{message}',guard:'{user_name}开通{guard_name}'},user_words:[],message_words:[],sounds:[]},
  connections:[{id:'local',name:'本地服务',settings:{provider:'dots',endpoint:'http://127.0.0.1:9881',timeout_secs:30}}],
  presets:[{id:'voice',connection_id:'local',name:'示例音色',provider:'dots',voice_id:'reference.wav',speed:1,volume:1}],
  bindings:[],assets:[],devices:[{name:'示例输出设备',is_default:true}],account:null,qr:{status:'idle'},
  local_services:{dots:{state:'unconfigured',message:'尚未配置本地服务目录'},gpt_sovits:{state:'unconfigured',message:'尚未配置本地服务目录'}},
  doubao_voices:[],startup_enabled:false,status:{}
};
const calls = [];
let rejectNextRules = false;
let holdNextRules = false;
let releaseRules;
let activeRules = 0, maximumRules = 0;
let exitSaved = false;
const checks = [];
const check = name => {checks.push(name);console.log('PASS '+name);};

(async()=>{
  await fs.mkdir(output,{recursive:true});
  const server = http.createServer(async(request,response)=>{
    try {
      const pathname = new URL(request.url,'http://localhost').pathname;
      const file = path.resolve(root,'.'+(pathname==='/'?'/index.html':decodeURIComponent(pathname)));
      if(!file.startsWith(root+path.sep)){response.writeHead(403).end();return;}
      const type = {'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.png':'image/png','.woff2':'font/woff2'}[path.extname(file)];
      let bytes = await fs.readFile(overrideApp && pathname==='/app.js'?overrideApp:file).catch(()=>fs.readFile(path.join(root,'fonts',path.basename(file))));
      if(pathname==='/app.js')bytes=Buffer.concat([bytes,Buffer.from('\nglobalThis.__acceptTestSnapshot = acceptSnapshot;\n')]);
      response.writeHead(200,{'Content-Type':type||'application/octet-stream'}).end(bytes);
    }catch{response.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin = 'http://127.0.0.1:'+server.address().port;
  let browser;
  try {
    browser = await chromium.launch({headless:true,channel:'msedge',args:['--disable-features=msWindowTabManagerPublic']});
    const context = await browser.newContext({viewport:{width:1040,height:740}});
    const blocked = [];
    await context.route('**/*',route=>{
      if(route.request().url().startsWith(origin+'/'))return route.continue();
      blocked.push(route.request().url());return route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror',error=>errors.push(error.message));
    await page.exposeFunction('__offlineInvoke',async(command,args)=>{
      if(command==='ui_activity')return false;
      if(command==='snapshot')return structuredClone(state);
      if(command==='finish_exit'){exitSaved=state.rules.user_words.some(row=>row.to==='退出前读音');return true;}
      assert.equal(command,'dispatch');
      calls.push(structuredClone(args));
      if(args.action==='rules.save') {
        activeRules++; maximumRules=Math.max(maximumRules,activeRules);
        try {
          if(rejectNextRules){rejectNextRules=false;throw new Error('数据库操作失败：测试保存失败 [DV-S02]');}
          if(holdNextRules){holdNextRules=false;await new Promise(resolve=>{releaseRules=resolve;});}
          state.rules=structuredClone(args.payload.rules);
        } finally { activeRules--; }
      }else if(args.action==='bindings.save') {
        const id=args.payload.id||'fixture-name-binding';
        const record={id,binding:structuredClone(args.payload.binding)};
        const index=state.bindings.findIndex(item=>item.id===id);
        if(index<0)state.bindings.push(record);else state.bindings[index]=record;
      }else if(args.action==='bindings.delete')state.bindings=state.bindings.filter(item=>item.id!==args.payload.id);
      else if(args.action==='preferences.save')Object.assign(state.preferences,args.payload.preferences);
      else if(args.action==='references.list')return {...structuredClone(state),result:[]};
      else if(!['bili.qr.cancel','doubao.qr.cancel'].includes(args.action))throw new Error('Unexpected action '+args.action);
      state.config_revision++;
      return structuredClone(state);
    });
    await page.addInitScript(()=>{
      window.__offlineListeners={};
      window.__TAURI__={core:{invoke:(command,args)=>window.__offlineInvoke(command,args)},event:{listen:async(name,listener)=>{window.__offlineListeners[name]=listener;return()=>{};}}};
    });
    const settings = page.locator('#settings');
    const waitClosed = () => page.waitForFunction(()=>!document.querySelector('#settings').open);
    if(measureRuntime){
      // Measure the same actual rendering workload with current or baseline UI.
      // No fixture adapter enters production. Absolute timings are descriptive.
      state.live.running=true;state.live.state='connected';
      state.queue.pending=Array.from({length:100},(_,i)=>({id:'pending-'+i,origin:'live',user_name:'观众'+i,text:'待读消息'+i}));
      state.presets.push(...Array.from({length:20},(_,i)=>({...state.presets[0],id:'voice-'+i,name:'音色'+i})));
      await page.goto(origin);await page.locator('#tts-switch').click();
      const results=[];
      for(const [name,selector,control] of [
        ['voice-panel','#tts-menu','#tts-menu .lake-voice-row'],
        ['viewer','#viewer-voices','#viewer-voices .voice-chip'],
      ]){
        if(name==='viewer')await page.locator('#lake-current .lake-message-name').click();
        const result=await page.evaluate(({name,selector,control,next})=>{
          const node=document.querySelector(selector),retained=document.querySelector(control);
          const count=document.querySelector('#queue-pill .queue-count');
          let records=0;
          const observer=new MutationObserver(list=>{records+=list.length;});observer.observe(node,{childList:true,subtree:true});
          const started=performance.now();
          for(let i=0;i<100;i++){
            next.live.received=i+1;next.queue.history=[{id:'done-'+i,state:'completed',origin:'live',detail:''}];
            window.__acceptTestSnapshot(structuredClone(next));
          }
          records+=observer.takeRecords().length;observer.disconnect();
          return {name,snapshots:100,milliseconds:performance.now()-started,childMutations:records,controlRetained:document.querySelector(control)===retained && retained.isConnected,countRetained:document.querySelector('#queue-pill .queue-count')===count};
        },{name,selector,control,next:structuredClone(state)});
        results.push(result);
        await page.screenshot({path:path.join(output,name+'.png'),animations:'disabled',caret:'hide'});
        if(!args.includes('--measure-baseline')){
          assert.equal(result.childMutations,0,name+' must not replace unchanged controls');
          assert.equal(result.controlRetained,true,name+' keyboard focus target must survive unrelated runtime updates');
          assert.equal(result.countRetained,true,'unchanged queue count must retain its animation identity');
        }
      }
      assert.deepEqual(errors,[]);
      await fs.writeFile(path.join(output,'runtime-stability.json'),JSON.stringify({headless:true,externalNetwork:false,results},null,2));
      console.log(JSON.stringify(results));return;
    }
    const viewer = page.locator('#viewer-drawer');
    const openViewer = async()=>{
      await page.locator('[data-action="history.open"]').click();
      await page.locator('#chat-feed [data-action="viewer.open"]').first().click();
      await page.locator('#viewer-alias').waitFor();
    };
    const closeViewer = async()=>{
      await page.keyboard.press('Escape');
      await page.waitForFunction(()=>document.querySelector('#viewer-drawer').hidden);
    };
    const fillAlias = text => page.locator('#viewer-alias').fill(text);
    const countRules = () => calls.filter(call=>call.action==='rules.save').length;
    await page.goto(origin);
    await page.locator('#lake-current .chat-hit').waitFor();
    await openViewer();await fillAlias('小雨');
    assert.equal(await page.locator('#viewer-alias').inputValue(),'小雨');
    await closeViewer();
    assert.equal(state.rules.user_words[0].to,'小雨');
    assert.equal(await settings.evaluate(node=>node.open),false);
    check('inline alias saves and closes to the main chat');
    await openViewer();assert.equal(await page.locator('#viewer-alias').inputValue(),'小雨');
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>document.querySelector('#viewer-drawer').hidden);
    check('repeat open and Escape retain the saved alias');

    await openViewer();
    const boundViewerName=await viewer.locator('.viewer-name').textContent();
    await viewer.locator('[data-action="viewer.bind"][data-id="voice"]').click();
    await page.waitForFunction(()=>document.querySelector('#viewer-voices [data-id="voice"]').getAttribute('aria-pressed')==='true');
    assert.equal(state.bindings.length,1);
    assert.equal(state.bindings[0].binding.user_name,boundViewerName);
    assert.equal(state.bindings[0].binding.preset_id,'voice');
    await closeViewer();
    await page.reload();
    await page.locator('#lake-current .chat-hit').waitFor();
    await openViewer();
    assert.equal(await viewer.locator('[data-action="viewer.bind"][data-id="voice"]').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('#viewer-alias').inputValue(),'小雨');
    await viewer.locator('[data-action="viewer.bind"][data-id=""]').click();
    await page.waitForFunction(()=>document.querySelector('#viewer-voices [data-id=""]').getAttribute('aria-pressed')==='true');
    assert.equal(state.bindings.length,0);
    await closeViewer();
    check('viewer voice saves its exact-name binding, survives reload with the alias, and deletes only on follow-default');

    await openViewer();await fillAlias('');await closeViewer();
    assert.equal(state.rules.user_words.length,0);
    check('clearing the inline alias restores the original name');

    await openViewer();rejectNextRules=true;await fillAlias('重试别名');
    await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('DV-S02'));
    assert.equal(await page.locator('#viewer-alias').inputValue(),'重试别名');
    assert.equal(await viewer.evaluate(node=>node.hidden),false);
    rejectNextRules=true;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    assert.equal(await viewer.evaluate(node=>node.hidden),false,'failed close must preserve the unsaved input');
    await closeViewer();assert.equal(state.rules.user_words[0].to,'重试别名');
    check('failed automatic save keeps the draft, reports the error and retries on close');

    await openViewer();holdNextRules=true;await fillAlias('第一稿');
    assert.equal(await page.locator('#viewer-alias').inputValue(),'第一稿');
    await page.waitForTimeout(700);
    assert.equal(activeRules,1);
    await fillAlias('最终稿');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    assert.equal(activeRules,1);assert.equal(await viewer.evaluate(node=>node.hidden),false);
    releaseRules();await page.waitForFunction(()=>document.querySelector('#viewer-drawer').hidden);
    assert.equal(state.rules.user_words[0].to,'最终稿');assert.equal(maximumRules,1);
    check('in-flight and newer aliases commit serially without dropping the final edit');

    await openViewer();const beforeIme=countRules();
    await page.locator('#viewer-alias').evaluate(input=>{
      input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
      input.value='拼音草稿';input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));
    });
    await page.waitForTimeout(700);assert.equal(countRules(),beforeIme);
    await page.locator('#viewer-alias').evaluate(input=>{
      input.value='输入法完成';input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));
    });
    await closeViewer();assert.equal(state.rules.user_words[0].to,'输入法完成');
    check('IME composition is saved only after the committed text');

    await openViewer();await closeViewer();await page.locator('[data-action="settings.open"]').click();
    await settings.waitFor({state:'visible'});
    assert.equal(await viewer.evaluate(node=>node.hidden),true);
    await page.locator('.settings-nav [data-id="rules"]').click();
    const filter = page.locator('input[name="filter_bilibili_emoticons"]');
    assert.equal(await filter.isChecked(),true);
    await filter.uncheck();await page.waitForFunction(()=>!document.querySelector('input[name="filter_bilibili_emoticons"]')?.checked && !document.querySelector('[data-form="rules"] .autosave-status:not([hidden])'));
    assert.equal(state.rules.events.filter_bilibili_emoticons,false);
    check('old rule snapshot defaults filter on and autosaves off');
    await page.screenshot({path:path.join(output,'rules-filter-zh.png')});
    await page.locator('[data-action="settings.close"]').click();await waitClosed();
    await page.reload();await page.locator('#lake-current .chat-hit').waitFor();
    await page.locator('[data-action="settings.open"]').click();
    await page.locator('.settings-nav [data-id="rules"]').click();
    assert.equal(await filter.isChecked(),false);
    await filter.check();await page.waitForFunction(()=>!document.querySelector('[data-form="rules"] .autosave-status:not([hidden])'));
    assert.equal(state.rules.events.filter_bilibili_emoticons,true);
    check('saved filter survives reload and toggles on');
    await page.locator('.settings-nav [data-id="general"]').click();
    await page.locator('input[name="language"][value="en"]').locator('..').click();
    await page.waitForFunction(()=>document.documentElement.lang==='en');
    await page.locator('.settings-nav [data-id="rules"]').click();
    assert.match(await page.locator('#settings-content').innerText(),/Filter Bilibili standalone emotes/);
    for(const width of [1040,780]){
      await page.setViewportSize({width,height:740});
      assert.equal(await page.locator('#settings-content').evaluate(node=>node.scrollWidth>node.clientWidth+2),false);
    }
    await page.screenshot({path:path.join(output,'rules-filter-en-small.png')});
    check('filter copy and layout work in Chinese and English');
    await page.locator('[data-action="settings.close"]').click();await waitClosed();
    await page.locator('[data-action="history.open"]').click();
    assert.equal(await page.locator('#chat-feed .lake-history-entry').count(),events.length);
    for(const line of events) assert.ok((await page.locator('#chat-feed').innerText()).includes(line.message));
    await page.keyboard.press('Escape');
    check('all individual chat entries remain displayed in the source full-history rows');

    await openViewer();await fillAlias('退出前读音');
    await page.evaluate(()=>window.__offlineListeners['exit-requested']({payload:{request_id:1}}));
    assert.equal(exitSaved,true,'exit must flush the inline viewer alias before finishing');
    check('exit flushes pending viewer edits');
      if(captureStore){
        // Capture the real product DOM with fictional messages. Remove only
        // the test-mode flag in the fixture; do not modify product markup/CSS.
        state.preferences.language='zh-CN';state.network_disabled=false;state.config_revision++;
        const capture = await browser.newContext({viewport:{width:1280,height:720},deviceScaleFactor:1.5});
        await capture.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
        await capture.exposeFunction('__offlineInvoke',async command=>{
          if(command==='ui_activity')return false;
          if(command==='snapshot')return structuredClone(state);
      if(command==='finish_exit'){exitSaved=state.rules.user_words.some(row=>row.to==='退出前读音');return true;}
          throw new Error('Screenshot mode does not allow mutations');
        });
        await capture.addInitScript(()=>{
          window.__TAURI__={core:{invoke:(command,args)=>window.__offlineInvoke(command,args)},event:{listen:async()=>()=>{}}};
        });
        const shot = await capture.newPage();
        for(const theme of ['dark','light']){
          state.preferences.appearance=theme;
          await shot.goto(origin);await shot.locator('#lake-current .lake-message').waitFor();
          await shot.evaluate(()=>document.fonts.ready);
          await shot.waitForTimeout(250);
          assert.equal(await shot.locator('#settings').evaluate(node=>node.open),false);
          assert.equal(await shot.locator('#chat-feed .lake-history-entry').count(),events.length);
          assert.equal(await shot.locator('body').evaluate(node=>node.scrollWidth>innerWidth),false);
          await shot.screenshot({path:path.join(output,theme==='dark'?'01-main-chat-dark.png':'02-main-chat-light.png')});
        }
        await capture.close();check('1920x1080 main-chat light and dark screenshots captured');
      }
    assert.deepEqual(errors,[]);
    assert.equal(blocked.length,0);
    assert.equal(calls.some(call=>/audition|qr.begin|live.connect/.test(call.action)),false);
    await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,headless:true,realNativeDesktop:false,externalNetwork:false,fictionalData:true,checks,dispatches:calls.map(call=>call.action)},null,2));
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
