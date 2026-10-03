// Offline, headless UI regression. Requires Playwright and an installed Edge.
// Run with NODE_PATH pointing to your Playwright installation. No native app,
// audio device, real configuration, login, or external network is used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../crates/desktop/ui');
const output = path.resolve(__dirname, '../dist/language-tests');
const state = {
  config_revision: 1, onboarding_done: true, network_disabled: true, app_version: '0.2.2', data_dir: 'E:/测试数据',
  preferences: { language:'zh-CN', appearance:'dark', scale:1, output:'default', master_volume:1, muted:false, tts_enabled:true },
  setup: {room_id:123,tts_enabled:true,mode:'anonymous',uid:42},
  live_settings: {room_id:123,gift_merge:{enabled:false,initial_seconds:1.5,increment_seconds:.5,maximum_seconds:5}},
  live: {running:false,state:'stopped',events:[{room_id:123,kind:'danmaku',user_name:'设置声音',message:'中文弹幕 <img src=x onerror=alert(1)>',observed_at_ms:1}],errors:0,no_voice:0},
  queue: {current:null,pending:[],history:[]},
  rules: {default_preset_id:'voice',preferred_presets:{dots:'voice'},events:{danmaku_on:true,gift_on:true,free_gift_on:false,super_chat_on:true,guard_on:true,gift_threshold_yuan:0,super_chat_threshold_yuan:0},templates:{danmaku:'{user_name}说：{message}',gift:'{user_name}送出{gift_name}',super_chat:'{message}',guard:'{user_name}开通{guard_name}'},user_words:[],message_words:[],sounds:[]},
  connections:[{id:'local',name:'本地服务',settings:{provider:'dots',endpoint:'http://127.0.0.1:9881',timeout_secs:30}}],
  presets:[{id:'voice',connection_id:'local',name:'中文音色设置',provider:'dots',voice_id:'reference.wav',speed:1,volume:1}],
  bindings:[],assets:[],devices:[{name:'中文设备声音',is_default:true}],account:null,qr:{status:'idle'},
  local_services:{dots:{state:'ready',message:'本地服务已就绪'},gpt_sovits:{state:'unconfigured',message:'尚未配置本地服务目录'}},
  doubao_voices:[],fish_audio_settings:{},startup_enabled:false,status:{},
  overlay:{settings:{enabled:false,style:'spine',corner:'top_left',scale:1,vignette:.6,title:'Tonight',tagline:'',show_danmaku:true,show_gift:true,show_super_chat:true,show_guard:true,names:'special',merge_duplicates:true,linger_seconds:14,port:47823,token:'0123456789abcdef0123456789abcdef'},running:false,port:47823,url:'http://127.0.0.1:47823/overlay?token=0123456789abcdef0123456789abcdef',error:null,clients:[]}
};
const calls = [];
let failLanguage = false;

(async () => {
  await fs.mkdir(output,{recursive:true});
  const server = http.createServer(async (request,response) => {
    try {
      const pathname = new URL(request.url,'http://localhost').pathname;
      const target = path.resolve(root,'.'+(pathname==='/'?'/index.html':decodeURIComponent(pathname)));
      if (!target.startsWith(root+path.sep)) {response.writeHead(403).end();return;}
      const type = {'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.png':'image/png'}[path.extname(target)];
      // Tauri serves embedded files by file name, so ./Font.woff2 comes from ui/fonts.
      const bytes = await fs.readFile(target).catch(() => fs.readFile(path.join(root,'fonts',path.basename(target))));
      response.writeHead(200,{'Content-Type':type||'application/octet-stream'}).end(bytes);
    } catch {response.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin = 'http://127.0.0.1:'+server.address().port;
  let browser;
  try {
    browser = await chromium.launch({headless:true,channel:'msedge'});
    const context = await browser.newContext({viewport:{width:1040,height:740}});
    await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror',error=>errors.push(error.message));
    await page.exposeFunction('__offlineInvoke',async (command,args) => {
      if(command==='ui_activity')return false;
      if(command==='snapshot')return structuredClone(state);
      if(command!=='dispatch')throw new Error('Unexpected IPC '+command);
      calls.push(structuredClone(args));
      if(args.action==='preferences.save') {
        if(failLanguage && args.payload.preferences.language)throw new Error('数据库操作失败：offline save rejected [DV-S02]');
        Object.assign(state.preferences,args.payload.preferences);
      } else if(args.action==='rules.save') state.rules=structuredClone(args.payload.rules);
      else if(args.action==='references.list')return {...structuredClone(state),result:[]};
      else if(!['bili.qr.cancel','doubao.qr.cancel'].includes(args.action))throw new Error('Unexpected action '+args.action);
      state.config_revision++;
      return structuredClone(state);
    });
    await page.addInitScript(() => {
      window.__offlineListeners={};
      window.__TAURI__={core:{invoke:(command,args)=>window.__offlineInvoke(command,args)},event:{listen:async(name,listener)=>{window.__offlineListeners[name]=listener;return()=>{};}}};
    });
    await page.goto(origin);
    await page.locator('#chat-feed article').waitFor();
    await page.locator('[data-action="settings.open"]').click();
    const tab = id => page.locator(`.settings-nav [data-id="${id}"]`).click();
    const switchLanguage = async language => {
      await tab('general');
      await page.locator(`input[name="language"][value="${language}"]`).check({force:true});
      await page.waitForFunction(expected=>document.documentElement.lang===expected,language);
      await page.waitForFunction(() => document.querySelector('input[name="language"]')?.disabled===false);
    };
    await switchLanguage('en');
    assert.equal(await page.title(),'DanmakuVoice');
    assert.match(await page.locator('#settings-content').innerText(),/Interface language/);
    assert.equal(state.rules.templates.danmaku,'{user_name}说：{message}');
    assert.equal(state.presets[0].name,'中文音色设置');
    await page.screenshot({path:path.join(output,'appearance-en-dark.png')});
    for(const id of ['room','voices','rules','assets','overlay','general','data']) {
      await tab(id);
      assert.ok(await page.locator('#settings-content').innerText(),id);
      const overflow = await page.locator('#settings-content').evaluate(node=>node.scrollWidth>node.clientWidth+2);
      assert.equal(overflow,false,id+' horizontal overflow');
    }
    await tab('rules');
    const before = await page.locator('textarea[name="template_danmaku"]').inputValue();
    assert.equal(before,'{user_name}说：{message}');
    const draft = '用户填写的未完成草稿 {user_name}';
    await page.locator('textarea[name="template_danmaku"]').fill(draft);
    // A pending autosave must settle before changing language.
    await switchLanguage('zh-CN');
    await switchLanguage('en');
    await tab('rules');
    assert.equal(await page.locator('textarea[name="template_danmaku"]').inputValue(),draft);
    // A locale snapshot must retain incomplete reference voice input too.
    await tab('voices');
    await page.locator('[data-action="voice-audition.add"]').click();
    await page.locator('input[name="name"]').fill('未完成中文音色');
    for(const language of ['zh-CN','en']) {
      state.preferences.language=language; state.config_revision++;
      await page.evaluate(()=>{window.__offlineListeners['resource-mode']({payload:false});window.__offlineListeners['resource-mode']({payload:true});});
      await page.waitForFunction(expected=>document.documentElement.lang===expected,language);
      assert.equal(await page.locator('input[name="name"]').inputValue(),'未完成中文音色');
    }
    assert.equal(await page.locator('input[name="name"]').inputValue(),'未完成中文音色');
    assert.match(await page.locator('#settings-content').innerText(),/Add dots voice/);
    await page.reload();
    await page.locator('#chat-feed article').waitFor();
    await page.locator('[data-action="settings.open"]').click();
    // Failed language persistence retains English and restores the selected value.
    await tab('general');
    failLanguage=true;
    await page.locator('input[name="language"][value="zh-CN"]').click({force:true});
    await page.waitForFunction(()=>document.querySelector('#settings-error')?.textContent.includes('DV-S02'));
    assert.equal(await page.locator('input[name="language"]:checked').inputValue(),'en');
    assert.equal(await page.locator('html').getAttribute('lang'),'en');
    failLanguage=false;
    await page.reload();
    await page.locator('#chat-feed article').waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'),'en');
    assert.match(await page.locator('#chat-feed').innerText(),/中文弹幕 <img src=x onerror=alert\(1\)>/);
    assert.equal(await page.locator('#chat-feed .message-bubble img').count(),0);
    await page.locator('[data-action="settings.open"]').click();
    await tab('general');
    await page.setViewportSize({width:780,height:580});
    assert.equal(await page.locator('#settings-content').evaluate(node=>node.scrollWidth>node.clientWidth+2),false);
    await page.screenshot({path:path.join(output,'appearance-en-small.png')});
    assert.deepEqual(errors,[]);
    assert.equal(calls.some(call=>call.action.endsWith('qr.begin')),false);
    await fs.writeFile(path.join(output,'result.json'),JSON.stringify({headless:true,externalNetwork:false,realDesktop:false,passed:true,checks:['switch both directions','saved reload','English layout at 1040 and 780','pending autosave','unfinished voice draft','failed save rollback','Chinese data and XSS preservation'],dispatches:calls.map(call=>call.action)},null,2));
    console.log('Headless localization UI: PASS (8 scenarios, no foreground window)');
  } finally {
    if(browser)await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
