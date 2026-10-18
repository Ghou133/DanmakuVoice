// Offline browser acceptance for the actual voice and setup UI. IPC fixtures
// live only here; no account, audio service, or production data is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../crates/desktop/ui');
const output = path.resolve(__dirname, '../target/lake-redesign-voices-tests');
const state = {
  config_revision:1,onboarding_done:true,network_disabled:true,app_version:'0.3.2',
  preferences:{appearance:'dark',language:'zh-CN',master_volume:1,muted:false,tts_enabled:true},
  setup:{room_id:123,uid:42,mode:'account',tts_enabled:true},account:{user_id:42,name:'测试主播'},
  live:{running:false,state:'stopped',events:[],received:0},queue:{current:null,pending:[],history:[]},
  live_settings:{room_id:123,gift_merge:{enabled:true,initial_seconds:1.5,increment_seconds:.5,maximum_seconds:5}},
  rules:{default_preset_id:'doubao-1',preferred_presets:{},events:{danmaku_on:true,filter_bilibili_emoticons:true,gift_on:true,free_gift_on:false,super_chat_on:true,guard_on:true,gift_threshold_yuan:5,super_chat_threshold_yuan:30},templates:{danmaku:'{user_name}说：{message}',gift:'{user_name}送出{gift_name}',super_chat:'{message}',guard:'{user_name}开通{guard_name}'},user_words:[],message_words:[],emote_words:[],sounds:[]},
  connections:[{id:'doubao',settings:{provider:'doubao'},has_credential:true},{id:'fish',settings:{provider:'fish_audio'},has_credential:true},{id:'dots',settings:{provider:'dots',endpoint:'http://127.0.0.1:9881'},has_credential:false}],
  presets:[{id:'doubao-1',name:'温柔桃子',connection_id:'doubao',provider:'doubao',voice_id:'catalog-1',speed:1,volume:1,sovits:null},{id:'fish-1',name:'元气少女',connection_id:'fish',provider:'fish_audio',voice_id:'f'.repeat(32),speed:1,volume:.82,sovits:null},{id:'dots-1',name:'本地声音',connection_id:'dots',provider:'dots',voice_id:'local-reference',speed:1,volume:1,sovits:null}],
  doubao_voices:[{id:'catalog-1',name:'温柔桃子'},{id:'catalog-2',name:'明亮晴天'},{id:'catalog-3',name:'沉稳声音'}],
  local_services:{dots:{state:'stopped',directory:'E:/test/dots'},gpt_sovits:{state:'unconfigured'}},
  bindings:[],assets:[],devices:[],qr:{status:'idle'},status:{},startup_enabled:false,
  overlay:{settings:{enabled:false,style:'spine',corner:'top_left',offset_x:0,offset_y:0,scale:1,vignette:.6,title:'Tonight',tagline:'',show_danmaku:true,show_gift:true,show_super_chat:true,show_guard:true,names:'special',merge_duplicates:true,linger_seconds:14},clients:[]},
  obs:{settings:{host:'127.0.0.1',port:4455,enabled:false,auto_launch:false},status:{state:'unknown'}},
};
const calls=[],errors=[],checks=[];
let failPreset=false,holdNextPreset=false,releaseHeldPreset=null,failReferences=false;
const references=[{profile:{connection_id:'dots',role:{kind:'dots',role:'local-reference'},audio_path:'E:/test/old-reference.wav',reference_text:'原参考文本',reference_language:'',text_language:'',text_free:false}}];
const waitForHost=async predicate=>{for(let attempt=0;attempt<100;attempt++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('Timed out waiting for fixture result');};
(async()=>{
  await fs.mkdir(output,{recursive:true});
  const server=http.createServer(async(req,res)=>{
    try {
      const file=path.resolve(root,'.'+(req.url==='/'?'/index.html':new URL(req.url,'http://localhost').pathname));
      if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
      const data=await fs.readFile(file).catch(()=>fs.readFile(path.join(root,'fonts',path.basename(file))));
      res.writeHead(200,{'Content-Type':{'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.html':'text/html'}[path.extname(file)]||'application/octet-stream'}).end(data);
    }catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({headless:true,channel:'msedge',args:['--disable-features=msWindowTabManagerPublic']});
  const context=await browser.newContext({viewport:{width:1040,height:740},reducedMotion:'reduce'});
  await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.exposeFunction('__invoke',async(command,args)=>{
    if(command==='ui_activity')return true;
    if(command==='snapshot')return structuredClone(state);
    if(command!=='dispatch')throw Error('Unexpected command '+command);
    calls.push(structuredClone(args));
    let result;
    const {action,payload}=args;
    if(action==='preferences.save')Object.assign(state.preferences,payload.preferences);
    else if(action==='presets.default')state.rules.default_preset_id=payload.id;
    else if(action==='presets.save') {
      if(failPreset)throw Error('Save rejected [DV-S02]');
      if(holdNextPreset){holdNextPreset=false;await new Promise(resolve=>{releaseHeldPreset=resolve;});}
      const preset=structuredClone(payload.preset);preset.id ||= 'saved-'+state.presets.length;
      const index=state.presets.findIndex(item=>item.id===preset.id);if(index>=0)state.presets[index]=preset;else state.presets.push(preset);result={id:preset.id};
    }else if(action==='presets.remove'){state.presets=state.presets.filter(p=>p.id!==payload.id);if(state.rules.default_preset_id===payload.id)state.rules.default_preset_id=null;}
    else if(action==='rules.save')state.rules=structuredClone(payload.rules);
    else if(action==='references.list'){if(failReferences)throw Error('Moved reference folder [DV-S02]');result=references.filter(row=>row.profile.connection_id===payload.connection_id);}
    else if(action==='dots.voice.save'){
      const index=state.presets.findIndex(preset=>preset.id===payload.preset.id);assert.ok(index>=0,'repair must keep the existing preset ID');
      state.presets[index]=structuredClone(payload.preset);references[0]={profile:structuredClone(payload.profile)};result={id:payload.preset.id};
    }
    else if(action==='local_services.save')Object.assign(state.local_services[payload.provider],{directory:payload.directory,state:'stopped'});
    else if(action==='fish.connect'){assert.equal(payload.connection_id,'fish');result={connected:true};}
    else if(action==='models.scan')result={pairs:[],issues:[]};
    else if(action==='onboarding.finish'){state.onboarding_done=true;state.setup.tts_enabled=payload.tts_enabled;}
    else if(action==='local_services.start')state.local_services[payload.provider].state='starting';
    else if(!['audition','audition.catalog','bili.qr.cancel','doubao.qr.cancel','local_services.check'].includes(action))throw Error('Unexpected action '+action);
    state.config_revision++;return {...structuredClone(state),result};
  });
  await page.addInitScript(()=>{
    window.__listeners={};window.__TAURI__={core:{invoke:(command,args)=>window.__invoke(command,args)},event:{listen:async(name,listener)=>{window.__listeners[name]=listener;return()=>{};}},dialog:{open:async options=>options.directory?'E:/test/repaired-dots':'E:/test/repaired-reference.wav'}};
  });
  const refresh=async()=>{state.config_revision++;await page.evaluate(()=>{window.__listeners['resource-mode']?.({payload:false});window.__listeners['resource-mode']?.({payload:true});});await page.waitForTimeout(300);};
  const navigate=async id=>{if(!await page.locator('#settings').isVisible())await page.locator('[data-action="settings.open"]').click();for(let step=0;step<3&&await page.locator('#settings .lake-settings-heading :is([data-action="editor.cancel"],[data-action="voice.provider"])').count();step++)await page.locator('#settings .lake-settings-heading :is([data-action="editor.cancel"],[data-action="voice.provider"])').click();if(await page.locator('#settings [data-action="settings.tab"][data-id="home"]').count())await page.locator('#settings [data-action="settings.tab"][data-id="home"]').click();await page.locator(`#settings [data-action="settings.tab"][data-id="${id}"]`).click();};
  try {
    await page.goto(origin);await page.locator('#live-shell').waitFor();
    await navigate('voices');
    assert.equal(await page.locator('.lake-voice-row').count(),3);
    assert.equal(await page.locator('.lake-voice-row.sleeping').count(),1);
    assert.equal(await page.locator('#settings [name="tts_enabled"]').count(),0);
    assert.equal(await page.locator('#settings [data-action="theme.toggle"]').count(),0);
    assert.equal(Math.round((await page.locator('#settings').boundingBox()).width),380);
    await page.screenshot({path:path.join(output,'voices-night.png')});
    await page.locator('#voice-audition-text').fill('我写的试听句子');
    await page.locator('[data-action="voice.preview"][data-id="fish-1"]').click({force:true});
    assert.equal(state.rules.default_preset_id,'doubao-1');
    assert.ok(calls.some(c=>c.action==='audition'&&c.payload.preset_id==='fish-1'&&c.payload.text==='我写的试听句子'));
    checks.push('all providers share a list; preview leaves default unchanged');
    await page.locator('[data-action="voice.edit"][data-id="fish-1"]').click({force:true});
    const edit=page.locator('[data-form="lake-voice-edit"]');
    await edit.locator('[name="name"]').fill('专门改的名字');
    await edit.locator('[name="speed"]').fill('1.25');await edit.locator('[name="speed"]').dispatchEvent('input');
    await page.waitForFunction(()=>document.querySelector('[data-form="lake-voice-edit"]')?.dataset.dirty===undefined);
    await page.waitForTimeout(800);
    assert.equal(state.presets.find(p=>p.id==='fish-1').name,'专门改的名字');
    assert.equal(state.presets.find(p=>p.id==='fish-1').speed,1.25);
    const unchanged=await edit.locator('[name="name"]').evaluate(node=>{window.__nameNode=node;return true;});
    assert.ok(unchanged);await refresh();assert.equal(await page.evaluate(()=>window.__nameNode===document.querySelector('[data-form="lake-voice-edit"] [name="name"]')),true);
    await page.screenshot({path:path.join(output,'voice-inline-edit.png')});
    checks.push('inline name and waterline edits persist; background snapshots retain controls');
    for(const [speed,preview] of [['1.4','[data-action="voice.preview"][data-id="fish-1"]'],['1.5','[data-form="voice-audition"] button[type="submit"]']]){
      holdNextPreset=true;releaseHeldPreset=null;await edit.locator('[name="speed"]').fill(speed);
      await waitForHost(()=>typeof releaseHeldPreset==='function');
      const before=calls.filter(call=>call.action==='audition').length;
      await page.locator(preview).click({force:true});await page.waitForTimeout(100);
      assert.equal(calls.filter(call=>call.action==='audition').length,before,'preview must wait for the outstanding inline save');
      releaseHeldPreset();await waitForHost(()=>calls.filter(call=>call.action==='audition').length===before+1);
      assert.equal(state.presets.find(p=>p.id==='fish-1').speed,Number(speed));
    }
    checks.push('row and default previews wait for pending inline changes before audition');
    failPreset=true;await edit.locator('[name="name"]').fill('失败草稿');await page.waitForTimeout(900);
    assert.equal(await edit.locator('[name="name"]').inputValue(),'失败草稿');
    assert.equal(state.presets.find(p=>p.id==='fish-1').name,'专门改的名字');
    const previewsBeforeFailure=calls.filter(call=>call.action==='audition').length;
    await page.locator('[data-action="voice.preview"][data-id="fish-1"]').click({force:true});await page.waitForTimeout(100);
    await page.locator('[data-form="voice-audition"] button[type="submit"]').click({force:true});await page.waitForTimeout(100);
    assert.equal(calls.filter(call=>call.action==='audition').length,previewsBeforeFailure,'a failed inline draft must not audition stale settings');
    failPreset=false;await edit.locator('[data-action="autosave.retry"]').click();await page.waitForTimeout(700);
    assert.equal(state.presets.find(p=>p.id==='fish-1').name,'失败草稿');checks.push('failed autosave retains a retryable draft');
    await page.locator('[data-action="voice.add"]').click();
    // One add page: the four services are tabs, and the list follows the chosen one.
    assert.equal(await page.locator('.voice-provider-tabs [role="tab"]').count(),4);
    await page.screenshot({path:path.join(output,'add-voice-services.png')});
    await page.locator('[data-action="voice.provider"][data-id="doubao"]').click();
    assert.equal(await page.locator('[data-voice-search]').count(),0,'a short catalogue has no search');
    await page.locator('[data-action="voice.catalog.preview"][data-id="catalog-2"]').click();
    assert.equal(state.presets.length,3);assert.equal(state.rules.default_preset_id,'doubao-1');
    assert.ok(calls.some(c=>c.action==='audition.catalog'&&c.payload.voice_id==='catalog-2'));
    await page.locator('[data-action="voice.catalog.add"][data-id="catalog-2"]').click();
    await waitForHost(()=>state.presets.length===4);assert.equal(state.rules.default_preset_id,'doubao-1');
    assert.equal(await page.locator('.voice-catalog-row.added [data-id="catalog-2"]').count(),1);
    checks.push('listening before adding, one-click add, and the current default stays');
    await navigate('voices');await page.locator('[data-action="voice.add"]').click();
    failReferences=true;await page.locator('[data-action="voice.provider"][data-id="dots"]').click();
    await page.locator('#settings-error').waitFor({state:'visible'});
    await page.locator('[data-action="service.configure"][data-id="dots"]').click();
    assert.equal(await page.locator('[data-form="service-local"] [name="directory"]').inputValue(),'E:/test/dots');
    await page.locator('[data-action="service.pick_directory"]').click();
    await waitForHost(()=>state.local_services.dots.directory==='E:/test/repaired-dots');
    assert.equal(state.connections.find(connection=>connection.id==='dots').settings.endpoint,'http://127.0.0.1:9881');
    assert.equal(calls.filter(call=>call.action==='connections.save').length,0);
    failReferences=false;await navigate('voices');await page.locator('[data-action="voice.add"]').click();
    await page.locator('[data-action="voice.provider"][data-id="fish_audio"]').click();await page.locator('[data-action="service.configure"][data-id="fish_audio"]').click();
    await page.locator('[data-form="service-fish"] [name="credential"]').fill('fictional-replacement-key');
    await page.locator('[data-form="service-fish"] button[type="submit"]').click();
    await page.locator('.voice-add').waitFor();assert.equal(calls.findLast(call=>call.action==='fish.connect').payload.connection_id,'fish');
    assert.equal(state.connections.length,3);
    checks.push('existing service repair remains reachable after metadata failure and preserves connection IDs');
    await navigate('voices');await page.locator('[data-action="voice.edit"][data-id="dots-1"]').click({force:true});
    // The recording is the first thing in the open row; choosing a file saves it.
    const reference=page.locator('[data-reference-preset="dots-1"] [data-action="voice.reference.pick"]');await reference.waitFor();
    assert.match(await reference.textContent(),/old-reference\.wav/);
    await reference.click();
    await waitForHost(()=>references[0].profile.audio_path==='E:/test/repaired-reference.wav');
    assert.equal(state.presets.length,4);assert.equal(calls.findLast(call=>call.action==='dots.voice.save').payload.preset.id,'dots-1');
    assert.equal(calls.findLast(call=>call.action==='dots.voice.save').payload.profile.role.role,'local-reference');
    checks.push('existing local reference audio can be repaired without replacing the preset or role');
    await navigate('voices');
    state.preferences.appearance='light';await refresh();await page.screenshot({path:path.join(output,'voices-day.png')});
    for(const size of [{width:900,height:620},{width:1440,height:900}]){
      await page.setViewportSize(size);assert.equal(await page.locator('#settings-content').evaluate(node=>node.scrollWidth>node.clientWidth+2),false);
    }
    checks.push('day theme and supported desktop sizes have no horizontal overflow');
    state.presets=[];state.rules.default_preset_id=null;
    await page.locator('[data-action="settings.close"]').click();await refresh();await navigate('voices');
    assert.equal(await page.locator('.voice-empty').count(),1);await page.screenshot({path:path.join(output,'voices-empty.png')});
    checks.push('empty voices retains receive-only guidance and add entry');
    // Fresh onboarding runs through real application branches with no QR network requests.
    state.onboarding_done=false;state.setup={tts_enabled:false};state.account=null;state.preferences.appearance='dark';
    await page.setViewportSize({width:1040,height:740});await page.reload();await page.locator('[data-action="setup.start"]').waitFor();
    assert.equal(await page.locator('#titlebar [data-action="theme.toggle"]').count(),0);
    assert.equal(await page.locator('#lake-orb').count(),1);await page.screenshot({path:path.join(output,'setup-welcome.png')});
    await page.locator('[data-action="setup.start"]').click();await page.locator('.setup-lake-drawer').waitFor();
    assert.equal(await page.locator('[data-qr-provider="bilibili"]').count(),1);
    assert.equal(calls.filter(c=>c.action==='bili.qr.begin').length,0);
    await page.waitForTimeout(400);
    await fs.writeFile(path.join(output,'setup-layout.json'),JSON.stringify(await page.evaluate(()=>Object.fromEntries(['#titlebar','#app','#setup-shell','.setup-lake-drawer','.setup-card','.setup-qr-foot'].map(selector=>{const el=document.querySelector(selector),r=el.getBoundingClientRect(),s=getComputedStyle(el);return [selector,{x:r.x,y:r.y,w:r.width,h:r.height,position:s.position,transform:s.transform,margin:s.margin,padding:s.padding}];}))),null,2));
    await page.screenshot({path:path.join(output,'setup-login.png')});
    // An existing authenticated own-room snapshot enters the voice step on restart.
    state.setup={room_id:123,uid:42,tts_enabled:false};state.account={user_id:42,name:'测试主播'};await page.reload();
    await page.locator('[data-action="setup.silent"]').waitFor();await page.screenshot({path:path.join(output,'setup-voices.png')});
    await page.locator('[data-action="setup.silent"]').click();await page.locator('[data-action="setup.finish"]').waitFor();await page.screenshot({path:path.join(output,'setup-ready.png')});
    await page.locator('[data-action="setup.finish"]').click();await page.locator('#live-shell').waitFor();
    assert.equal(state.onboarding_done,true);assert.equal(state.setup.tts_enabled,false);
    checks.push('welcome / merged login / voice choice / ready use lake drawers and finish receive-only');
    assert.deepEqual(errors,[]);
    await fs.writeFile(path.join(output,'results.json'),JSON.stringify({checks,errors,offline:true},null,2));console.log('PASS '+checks.length+' grouped voice/setup checks');
  } catch(error) {
    await page.screenshot({path:path.join(output,'failure.png')});await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({error:error.stack,errors,checks,lastCalls:calls.slice(-12)},null,2));throw error;
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
