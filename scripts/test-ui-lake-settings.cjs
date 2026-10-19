// Actual UI in an isolated browser with explicit offline fixtures. These checks
// do not claim Bilibili, OBS, cloud TTS, file-picker or physical-audio acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../crates/desktop/ui');
const output = path.resolve(__dirname, '../dist/lake-settings-tests');
const state = {
  config_revision:1,onboarding_done:true,network_disabled:true,app_version:'0.3.2',data_dir:'isolated fixture',
  preferences:{language:'zh-CN',appearance:'dark',scale:1,master_volume:1,muted:false,tts_enabled:true,output:'default'},
  setup:{room_id:123,tts_enabled:true,mode:'account'},live_settings:{room_id:123,gift_merge:{enabled:false,initial_seconds:1.5,increment_seconds:.5,maximum_seconds:5}},
  live:{room_id:123,running:false,state:'stopped',events:[]},queue:{current:null,pending:[],history:[]},
  rules:{default_preset_id:'voice',events:{danmaku_on:true,filter_bilibili_emoticons:true,gift_on:true,free_gift_on:false,super_chat_on:true,guard_on:true,gift_threshold_yuan:5,super_chat_threshold_yuan:30},templates:{danmaku:'{user_name}说：{message}',gift:'{user_name}赠送了{gift_num}个{gift_name}',super_chat:'{user_name}留言：{message}',guard:'感谢{user_name}赠送的{guard_name}'},user_words:[{from:'Kinoko7',to:'蘑菇七'}],message_words:[{from:'yyds',to:'永远的神'}],emote_words:[{from:'[doge]',to:'狗头'}],sounds:[{trigger:'晚安',asset_id:'bell'}]},
  connections:[{id:'local',name:'Local',settings:{provider:'dots',endpoint:'http://127.0.0.1:9881',timeout_secs:30}}],
  presets:[{id:'voice',connection_id:'local',name:'元气少女',provider:'dots',voice_id:'reference.wav',speed:1,volume:1}],
  bindings:[{id:'binding',binding:{platform:'bilibili',user_id:null,user_name:'Kinoko7',legacy_user_name:null,preset_id:'voice',enabled:true}}],assets:[{id:'bell',name:'风铃',bytes:1234}],devices:[],account:{user_id:42,name:'柚子不加糖'},qr:{status:'idle'},local_services:{dots:{state:'ready'},gpt_sovits:{state:'unconfigured'}},doubao_voices:[],startup_enabled:false,status:{},
  overlay:{settings:{enabled:false,style:'spine',corner:'top_left',scale:1,offset_x:0,offset_y:0,title:'直播弹幕',tagline:'say a word',show_danmaku:true,show_gift:true,show_super_chat:true,show_guard:true,names:'all',merge_repeats:true,vignette:.6,linger_seconds:14}},obs:{settings:{host:'127.0.0.1',port:4455},status:'idle'}
};
const calls=[];let rejectRules=false;
(async()=>{
 await fs.mkdir(output,{recursive:true});
 const server=http.createServer(async(req,res)=>{try{
  const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const file=path.resolve(root,'.'+(name==='/'?'/index.html':name));
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  let bytes=await fs.readFile(file).catch(()=>fs.readFile(path.join(root,'fonts',path.basename(file))));
  if(name==='/app.js')bytes=Buffer.concat([bytes,Buffer.from('\nglobalThis.__settingsSnapshot=acceptSnapshot;\n')]);
  res.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.png':'image/png','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream'}).end(bytes);
 }catch{res.writeHead(404).end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;let browser;
 try{
  browser=await chromium.launch({headless:true,channel:'msedge',args:['--disable-features=msWindowTabManagerPublic']});
  const context=await browser.newContext({viewport:{width:1040,height:740},reducedMotion:'reduce'});
  await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
  const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.exposeFunction('__offlineInvoke',async(command,args)=>{
   if(command==='snapshot')return structuredClone(state);if(command==='ui_activity')return true;
   assert.equal(command,'dispatch');calls.push(structuredClone(args));const p=args.payload;
   if(args.action==='rules.save'){if(rejectRules){rejectRules=false;throw new Error('fixture rule write rejected');}state.rules=structuredClone(p.rules);}
   else if(args.action==='bindings.save'){const row={id:p.id||'new-binding',binding:structuredClone(p.binding)};state.bindings=state.bindings.filter(item=>item.id!==row.id);state.bindings.push(row);}
   else if(args.action==='bindings.delete')state.bindings=state.bindings.filter(item=>item.id!==p.id);
   else if(args.action==='preferences.save')Object.assign(state.preferences,p.preferences);
   else if(args.action==='startup.set')state.startup_enabled=p.enabled;
   else if(args.action==='live.save'){if(p.room_id&&state.live.running)throw new Error('fixture: disconnect before changing rooms');Object.assign(state.live_settings,p);if(p.room_id)state.setup.room_id=p.room_id;}
   else if(args.action==='live.disconnect')state.live.running=false;
   else if(args.action==='live.connect')state.live.running=true;
   else if(args.action==='assets.import')state.assets.push({id:'picked-audio',name:p.name,bytes:2000});
   else if(!['assets.audition','configuration.export','configuration.import','bili.qr.cancel','doubao.qr.cancel'].includes(args.action))throw new Error('Unexpected action '+args.action);
   state.config_revision++;return structuredClone(state);
  });
  await page.addInitScript(()=>{
   window.__TAURI__={core:{invoke:async(command,args)=>{const result=await window.__offlineInvoke(command,args);if(command==='dispatch'){window.__fixtureLastAction=args.action;window.__fixtureSavedRules=result.rules;}return result;}},event:{listen:async()=>()=>{}},dialog:{open:async options=>options.filters[0].extensions.includes('json')?'C:\\fixture\\backup.json':'C:\\fixture\\piano.wav',save:async()=> 'C:\\fixture\\backup.json'}};
  });
  await page.goto(origin);await page.locator('[data-action="settings.open"]').click();
  const dialog=page.locator('#settings');await dialog.locator('.lake-home-row').first().waitFor();
  const geometry=await page.evaluate(()=>{const s=document.querySelector('#settings').getBoundingClientRect(),b=document.querySelector('#titlebar').getBoundingClientRect();return {top:s.top,right:innerWidth-s.right,bottom:innerHeight-s.bottom,width:s.width,titlebarWidth:b.width,titlebarHeight:b.height,modal:document.querySelector('#settings').matches(':modal')};});
  assert.deepEqual(geometry,{top:48,right:12,bottom:12,width:380,titlebarWidth:1040,titlebarHeight:40,modal:false});
  assert.equal(await page.locator('#titlebar [data-window="close"]').isVisible(),true);
  await page.screenshot({path:path.join(output,'home-night.png')});
  const open=async id=>{await dialog.locator('[data-action="settings.tab"][data-id="home"]').click();await dialog.locator(`[data-action="settings.tab"][data-id="${id}"]`).click();};
  await dialog.locator('[data-action="settings.tab"][data-id="readings"]').click();
  assert.equal(await dialog.locator('.lake-reading-row').count(),3);
  assert.equal(await dialog.locator('.lake-reading-to small').innerText(),'元气少女');
  await dialog.locator('#lake-readings-search').fill('yyds');assert.equal(await dialog.locator('.lake-reading-row:visible').count(),1);
  await dialog.locator('#lake-readings-search').fill('');await page.screenshot({path:path.join(output,'readings-night.png')});
  // 2026-10-19: one page. Rows are edited where they are and save themselves;
  // there is no editor page, no kind tabs, no save/cancel and no discard prompt.
  const back=dialog.locator('.lake-settings-heading [data-action="settings.tab"][data-id="home"]');
  const noPrompt=async()=>assert.equal(await page.locator('#confirmation').isVisible(),false,'a discard prompt appeared');
  await dialog.locator('[data-action="lake.reading.add"][data-id="user_words"]').click();
  assert.equal(await dialog.locator('.lake-reading-kinds, [data-action="lake.reading.save"], [data-action="lake.editor.cancel"], [data-form="lake-reading"]').count(),0);
  assert.equal(await back.getAttribute('aria-label'),'返回设置','adding a reading opened another page');
  const fresh=dialog.locator('.lake-reading-row[data-new]');
  await fresh.locator('[name="from"]').fill('小鱼干');await fresh.locator('[name="to"]').fill('小鱼');await fresh.locator('[name="to"]').press('Enter');
  await page.waitForFunction(()=>!document.querySelector('.lake-reading-row.editing')&&document.querySelectorAll('.lake-reading-row').length===4);
  assert.equal(state.rules.user_words.find(row=>row.from==='小鱼干').to,'小鱼');
  assert.equal(await dialog.locator('[data-reading-group="user_words"] [data-reading-count]').innerText(),'2');
  const word=dialog.locator('.lake-reading-row[data-kind="message_words"]');
  await word.locator('[data-action="lake.reading.edit"]').click();
  assert.equal(await back.getAttribute('aria-label'),'返回设置','editing a reading opened another page');
  await word.locator('[name="to"]').fill('不要的修改');await page.keyboard.press('Escape');
  await noPrompt();assert.equal(await dialog.isVisible(),true,'Escape in a row closed the drawer');
  assert.equal(await word.locator('.lake-reading-to').innerText(),'永远的神');
  await word.locator('[data-action="lake.reading.edit"]').click();await word.locator('[name="to"]').fill('永远滴神');
  await dialog.locator('#lake-readings-search').click();
  await page.waitForFunction(()=>document.querySelector('.lake-reading-row[data-kind="message_words"] .lake-reading-to')?.innerText==='永远滴神');
  assert.deepEqual(state.rules.message_words,[{from:'yyds',to:'永远滴神'}]);
  await dialog.locator('[data-action="lake.reading.add"][data-id="message_words"]').click();
  await dialog.locator('.lake-reading-row[data-new] [name="from"]').fill('半截');
  await back.click();await dialog.locator('[data-action="settings.tab"][data-id="readings"]').waitFor();
  await noPrompt();assert.deepEqual(state.rules.message_words,[{from:'yyds',to:'永远滴神'}]);
  await dialog.locator('[data-action="settings.tab"][data-id="readings"]').click();
  assert.equal(await dialog.locator('.lake-reading-row[data-new]').count(),0,'an unfinished line came back');
  await open('advanced');assert.equal(await dialog.locator('.lake-accordion-toggle[aria-expanded="true"]').count(),0);
  await dialog.locator('[data-action="lake.advanced.section"][data-id="messages"]').click();
  await dialog.locator('[name="gift_threshold_yuan"]').fill('12');await dialog.locator('[name="gift_threshold_yuan"]').press('Tab');
  await page.waitForFunction(()=>document.querySelector('[data-form="lake-thresholds"] .autosave-status').hidden);
  await dialog.locator('[data-action="lake.advanced.section"][data-id="templates"]').click();
  assert.equal(state.rules.events.gift_threshold_yuan,12);assert.equal(state.rules.user_words.length,2);assert.equal(state.rules.emote_words.length,1);
  assert.equal(await dialog.locator('.lake-accordion-toggle[aria-expanded="true"]').count(),1);
  const sentence=dialog.locator('[data-lake-template="danmaku"]');await sentence.fill('今晚：');
  await dialog.locator('.lake-template-row').first().locator('[data-action="lake.template.insert"][data-id="message"]').click();
  const beforeIme=calls.filter(call=>call.action==='rules.save').length;
  await sentence.evaluate(node=>{
   node.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
   node.textContent='输入法草稿';node.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));
  });
  await page.waitForTimeout(700);assert.equal(calls.filter(call=>call.action==='rules.save').length,beforeIme);
  await dialog.locator('[data-action="lake.advanced.section"][data-id="sounds"]').click();
  assert.equal(await sentence.isVisible(),true,'switching sections must not save an uncommitted IME composition');
  await sentence.evaluate(node=>{node.textContent='输入法完成';node.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));});
  await page.waitForFunction(()=>window.__fixtureSavedRules?.templates.danmaku==='输入法完成');
  assert.equal(state.rules.templates.danmaku,'输入法完成');
  await sentence.fill('今晚：');await sentence.press('End');await sentence.press('Enter');await sentence.press('Enter');await sentence.press('A');
  await dialog.locator('.lake-template-row').first().locator('[data-action="lake.template.insert"][data-id="message"]').click();
  await dialog.locator('[data-action="lake.advanced.section"][data-id="sounds"]').click();
  assert.equal(state.rules.templates.danmaku,'今晚：\n\nA{message}');assert.equal(state.rules.templates.gift,'{user_name}赠送了{gift_num}个{gift_name}');
  await page.waitForFunction(()=>document.querySelector('[data-action="lake.advanced.section"][data-id="sounds"]').getAttribute('aria-expanded')==='true');
  await dialog.locator('.lake-sound-row [data-action="lake.sound.audition"]').click();assert.equal(calls.at(-1).action,'assets.audition');
  await dialog.locator('[data-action="lake.sound.pick"]').click();assert.equal(state.assets.at(-1).name,'piano');
  await dialog.locator('[data-action="lake.sound.add"]').click();await dialog.locator('.lake-sound-row').last().locator('input').fill('生日快乐');
  await dialog.locator('[data-action="lake.advanced.section"][data-id="templates"]').click();assert.equal(state.rules.sounds.length,2);
  assert.equal(await sentence.innerText(),'今晚：\n\nA内容');
  rejectRules=true;await sentence.fill('保存失败的草稿');
  await dialog.locator('[data-form="lake-templates"] [data-action="autosave.retry"]').waitFor();
  assert.equal(await sentence.innerText(),'保存失败的草稿');assert.equal(state.rules.templates.danmaku,'今晚：\n\nA{message}');
  await dialog.locator('[data-form="lake-templates"] [data-action="autosave.retry"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-form="lake-templates"] .autosave-status').hidden);
  assert.equal(state.rules.templates.danmaku,'保存失败的草稿');
  await sentence.focus();await page.screenshot({path:path.join(output,'templates-night.png')});
  // An unfinished field never holds the drawer: an empty keyword line is not a draft
  // yet, and a keyword cleared and left is put down without a prompt.
  await dialog.locator('[data-action="lake.advanced.section"][data-id="sounds"]').click();
  await dialog.locator('[data-action="lake.sound.add"]').click();
  assert.equal(await dialog.locator('[data-form="sound-words"] .autosave-status').isVisible(),false,'an empty keyword line was reported as unfinished');
  await dialog.locator('.lake-sound-row').first().locator('input').fill('');
  await dialog.locator('[data-form="sound-words"] .autosave-status').waitFor();
  await open('advanced');await noPrompt();
  assert.equal(await dialog.locator('[data-action="lake.advanced.section"][data-id="sounds"]').getAttribute('aria-expanded'),'true');
  assert.deepEqual(state.rules.sounds.map(row=>row.trigger),['晚安','生日快乐']);
  assert.deepEqual(await dialog.locator('.lake-sound-row input').evaluateAll(nodes=>nodes.map(node=>node.value)),['晚安','生日快乐'],'an unfinished keyword came back');
  assert.equal(await dialog.locator('[data-form="sound-words"] .autosave-status').isVisible(),false);
  await open('general');assert.equal(await dialog.locator('[data-action="lake.backup.export"]').count(),1);
  assert.equal(await dialog.locator('[name="appearance"], [name="output"], [name="scale"], [data-action="onboarding.reset"], [name="tts_enabled"]').count(),0);
  await dialog.locator('[data-action="lake.backup.export"]').click();assert.equal(calls.at(-1).action,'configuration.export');
  await dialog.locator('[data-action="lake.backup.import"]').click();await page.locator('#confirmation [value="confirm"]').click();await page.waitForFunction(()=>window.__fixtureLastAction==='configuration.import');
  assert.equal(calls.at(-1).action,'configuration.import');assert.equal(calls.at(-1).payload.confirmed,true);
  await page.screenshot({path:path.join(output,'general-night.png')});
  await open('room');await page.screenshot({path:path.join(output,'room-night.png')});
  // 2026-10-19: the room number changes where it stands, like the room title on the lake:
  // no editor page, no save or cancel, the page is not redrawn and nothing asks.
  const roomInput=dialog.locator('.lake-room-number.editing input');
  const roomEdit=dialog.locator('[data-action="lake.room.edit"]');
  const shownNumber=await dialog.locator('.lake-room-number strong').boundingBox();
  await dialog.locator('.lake-room-account').evaluate(node=>{node.dataset.fixtureKept='true';});
  await roomEdit.click();
  assert.equal(await roomInput.evaluate(node=>node===document.activeElement&&node.value==='123'),true);
  assert.equal(await back.getAttribute('aria-label'),'返回设置','changing the room opened another page');
  assert.equal(await dialog.locator('.lake-room-number button, [data-form="lake-room"]').count(),0,'the room field has buttons');
  const field=await roomInput.boundingBox();
  assert.ok(Math.abs(field.x-shownNumber.x)<=1&&Math.abs(field.y+field.height/2-(shownNumber.y+shownNumber.height/2))<=2,'the room field moved away from the number');
  await page.waitForFunction(()=>Number(getComputedStyle(document.querySelector('.lake-room-account')).opacity)<.2);
  await page.screenshot({path:path.join(output,'room-edit-night.png')});
  await roomInput.fill('456');await page.keyboard.press('Escape');
  await noPrompt();assert.equal(await dialog.isVisible(),true,'Escape in the room field closed the drawer');
  assert.equal(await dialog.locator('.lake-room-number strong').innerText(),'123');assert.equal(state.live_settings.room_id,123);
  assert.equal(await roomEdit.evaluate(node=>node===document.activeElement),true);
  state.live.running=true;await page.evaluate(next=>window.__settingsSnapshot(next),structuredClone(state));
  const roomCalls=calls.length;
  await roomEdit.click();await roomInput.fill('456');await roomInput.press('Enter');
  await page.waitForFunction(()=>document.querySelector('.lake-room-number strong')?.textContent==='456');
  assert.deepEqual(calls.slice(roomCalls).map(call=>call.action).filter(action=>['live.disconnect','live.save','live.connect'].includes(action)),['live.disconnect','live.save','live.connect']);
  assert.equal(state.live_settings.room_id,456);assert.equal(state.live.running,true);
  assert.equal(await dialog.locator('.lake-room-account').getAttribute('data-fixture-kept'),'true','saving the room redrew the page');
  const roomSaves=()=>calls.filter(call=>call.action==='live.save').length,savesBefore=roomSaves();
  await roomEdit.click();await roomInput.fill('');await dialog.locator('.lake-room-number>span').click();
  await page.waitForFunction(()=>!document.querySelector('.lake-room-number.editing'));
  assert.equal(await dialog.locator('.lake-room-number strong').innerText(),'456');assert.equal(roomSaves(),savesBefore,'an empty room number was saved');
  await roomEdit.click();await roomInput.fill('789');await back.click();
  await dialog.locator('[data-action="settings.tab"][data-id="room"]').waitFor();
  await noPrompt();assert.equal(state.live_settings.room_id,789);
  await dialog.locator('[data-action="settings.tab"][data-id="room"]').click();
  assert.equal(await dialog.locator('.lake-room-number strong').innerText(),'789');
  await dialog.locator('[data-action="bili.begin"]').click();assert.equal(await dialog.locator('[data-qr-provider="bilibili"]').count(),1);
  await dialog.locator('.lake-settings-heading [data-action="editor.cancel"]').click();assert.equal(await dialog.locator('[data-qr-provider]').count(),0);
  await dialog.locator('.lake-settings-heading [data-action="settings.tab"]').click();
  state.preferences.appearance='light';await page.evaluate(next=>window.__settingsSnapshot(next),structuredClone(state));await page.screenshot({path:path.join(output,'home-day.png')});
  await dialog.locator('[data-action="settings.tab"][data-id="advanced"]').focus();await page.keyboard.press('Tab');assert.equal(await page.locator('#titlebar button').first().evaluate(node=>node===document.activeElement),true);
  await page.keyboard.press('Escape');assert.equal(await dialog.isVisible(),false);assert.equal(await page.locator('.lake-settings-scrim').isVisible(),false);
  assert.deepEqual(errors,[]);await fs.writeFile(path.join(output,'result.json'),JSON.stringify({offline:true,geometry,calls:calls.map(call=>call.action),errors},null,2));
  console.log('PASS lake settings: drawer geometry, native titlebar, one-page readings saved in place without discard prompts, partial rule saves, template tokens, multiline roundtrip, IME commit gate, failed autosave retry, unfinished fields put down on leaving, retained sound assets, backups, room number changed in place with reconnect, QR cleanup, day colors and keyboard close.');
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
