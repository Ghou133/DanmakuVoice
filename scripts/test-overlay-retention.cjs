// Real production HTML/native EventSource against a private fictional loopback feed.
// No account, OBS, TTS, provider or outside network operation is performed.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { chromium } = require('playwright');

const repo = path.resolve(__dirname, '..');
const out = path.resolve(process.env.DV_TEST_OUTPUT || path.join(repo, 'target/spine-retention-20261006/browser'));
const htmlArg = process.argv.indexOf('--overlay-html');
const file = htmlArg >= 0 ? path.resolve(process.argv[htmlArg + 1]) : path.join(repo, 'crates/desktop/overlay/overlay.html');
const fontRoot = path.join(repo, 'crates/desktop/ui/fonts');
const checks = [], errors = [], requests = [];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const check = async (name, run) => { await run(); checks.push({ name, passed: true }); console.log(`ok ${name}`); };
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
const old = Date.now() - 600_000;
const item = (seq, job = null, at = old) => ({seq,at,job_id:job,kind:'danmaku',viewer:`fictional-${seq}`,name:`观众${seq}`,message:`第${seq}条弹幕`});

async function run() {
  await fs.mkdir(out, { recursive: true });
  const html = await fs.readFile(file, 'utf8');
  const section = (value, start, end) => value.slice(value.indexOf(start), value.indexOf(end, value.indexOf(start)));
  // Fixed digests of the reviewed 2026-10-14 spine redesign (three entries,
  // thread light, resting state), with the 2026-10-17 legibility fix (halo
  // behind the lit text, brighter history rows) and thread-led arrival (light
  // pours down to the socket, which blooms into the avatar, and a branch of
  // light writes the line out; the idle light only runs at rest) and the title
  // rule as a branch of the thread that the idle light runs into, and the
  // 2026-10-18 lone-emote line (the emote alone, sized by its place) and the
  // shade's stronger range past its default. Any further artwork change must
  // be reviewed and re-pinned deliberately.
  assert.equal(hash(section(html, '<style>', '</style>')), '9911f4137ff780c24fdb150dd003b929bb7cde5b1742e7973294d9cf527ed0f4', 'overlay CSS differs from the reviewed spine redesign');
  assert.equal(hash(section(html, '<body>', '<script>')), 'a21359d8e025b3dfc27c347c5b41eaf9691c37ab88b2ba5653990a0e7d5ffd50', 'overlay DOM differs from the reviewed spine redesign');
  checks.push({name:'overlay artwork matches the reviewed 2026-10-14 spine redesign',passed:true});
  let opening = {instance:'fictional-app',session:0,heartbeat_ms:15000,config:{style:'spine',linger_seconds:14},status:{connection:'connected',tts:true,words:4},items:[1,2,3,4].map(seq=>item(seq,seq)),reading:null};
  const clients = new Set();
  const server = http.createServer(async (req,res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/overlay/events') {
      res.writeHead(200, {'content-type':'text/event-stream','cache-control':'no-store',connection:'keep-alive'});
      clients.add(res);res.on('close',()=>clients.delete(res));
      res.write(`retry: 2000\n\nevent: hello\ndata: ${JSON.stringify(opening)}\n\n`);return;
    }
    if (url.pathname.startsWith('/overlay/fonts/')) {
      try {res.writeHead(200,{'content-type':'font/woff2'});res.end(await fs.readFile(path.join(fontRoot,path.basename(url.pathname))));}
      catch {res.writeHead(404);res.end();}return;
    }
    if(url.pathname==='/overlay'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html);return;}
    res.writeHead(404);res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  let browser, page;
  try {
    browser=await chromium.launch({channel:process.env.DV_BROWSER_CHANNEL||'msedge',headless:true,args:['--disable-features=msWindowTabManagerPublic']});
    const context=await browser.newContext({viewport:{width:1920,height:1080},reducedMotion:'reduce'});
    await context.route('**/*',route=>{
      const url=route.request().url();requests.push(url);
      return url.startsWith(origin+'/') ? route.continue() : route.abort();
    });
    page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{
      window.__sources=[];window.__rafRequests=0;
      const Native=EventSource;
      window.EventSource=class extends Native {constructor(url){super(url);window.__sources.push(this);}};
      // Count production callbacks after the page clock has installed its
      // scheduler. Wrapping requestAnimationFrame before clock.install can be
      // overwritten by Playwright and make idle-loop assertions vacuous.
      addEventListener('DOMContentLoaded',()=>{
        const frame=window.frame;
        window.frame=(...args)=>{window.__rafRequests++;return frame(...args);};
      });
    });
    await page.clock.install({time:new Date()});
    await page.clock.pauseAt(new Date(Date.now()+1000));
    const loaded = async () => {
      for(let n=0;n<60;n++){
        if(await page.evaluate(()=>document.querySelector('#ov')?.classList.contains('ready')))return;
        await tick(50);
      }
      throw new Error('fictional native SSE hello did not load');
    };
    const emit = (event,data={}) => page.evaluate(({event,data})=>window.__sources.at(-1).dispatchEvent(new MessageEvent(event,{data:JSON.stringify(data)})),{event,data});
    const advance = async ms => {
      for(let left=ms;left>0;left-=Math.min(left,20000)) {
        await emit('heartbeat');await page.clock.runFor(Math.min(left,20000));
      }
    };
    const rows = () => page.locator('#list .item:not(.out)');
    await page.goto(`${origin}/overlay?token=fictional-retention-token`);await loaded();
    await page.evaluate(()=>document.fonts.ready);
    await advance(800);
    await check('cold page restores the newest three old spine readings as small rows without replay',async()=>{
      assert.equal(await rows().count(),3);assert.equal(await page.locator('.spot').count(),0);
      assert.equal(await page.locator('.reading').count(),0);
      assert.deepEqual(await rows().locator('.name').allTextContents(),['观众2','观众3','观众4'],'the spine reads top-down in time order');
      assert.deepEqual(await rows().locator('.age').allTextContents(),['10 min ago','10 min ago','10 min ago']);
      // Size follows position only: newest large, previous medium, oldest small.
      assert.deepEqual(await rows().locator('.text').evaluateAll(nodes=>nodes.map(el=>getComputedStyle(el).fontSize)),['18px','20px','28px']);
      assert.deepEqual(await rows().evaluateAll(nodes=>nodes.map(el=>el.classList.contains('tip'))),[false,false,true]);
      assert.deepEqual(await rows().locator('.lit').evaluateAll(nodes=>nodes.map(el=>el.style.getPropertyValue('--lit')||'100%')),['100%','100%','100%']);
      // With chat on screen every light on the thread means something; the
      // decorative idle light waits for the overlay to rest.
      assert.equal(await page.locator('#ov.resting').count(),0);
      assert.equal(await page.locator('.flow').evaluate(el=>getComputedStyle(el,'::before').animationName),'none');
      // The rule under the title is a branch of the thread, unlit while chat is on screen.
      const fork=await page.evaluate(()=>{
        const rule=document.querySelector('.rule'),curve=getComputedStyle(rule,'::before');
        const start=rule.getBoundingClientRect().left-parseFloat(curve.width)-document.querySelector('.spine').getBoundingClientRect().left;
        return {start:Math.round(start*100)/100,radius:curve.borderBottomLeftRadius,glint:curve.animationName,light:getComputedStyle(rule,'::after').animationName};
      });
      assert.deepEqual(fork,{start:0,radius:'14px',glint:'none',light:'none'},'the title rule leaves the thread in a curve');
      // A text-shadow paints over background-clipped text and greys it out;
      // the halo must sit behind the glyphs.
      assert.deepEqual(await rows().locator('.lit').evaluateAll(nodes=>nodes.map(el=>getComputedStyle(el).textShadow)),['none','none','none']);
      assert.ok((await rows().locator('.text').evaluateAll(nodes=>nodes.map(el=>getComputedStyle(el).filter))).every(f=>f.startsWith('drop-shadow(')),'spine text keeps its halo behind the glyphs');
    });
    await check('the shade and older-line clarity chosen by the streamer reach the page; defaults keep the reviewed look',async()=>{
      const look=()=>page.evaluate(()=>[getComputedStyle(document.documentElement).getPropertyValue('--vig').trim(),getComputedStyle(document.documentElement).getPropertyValue('--vig-boost').trim(),...[...document.querySelectorAll('#list .item:not(.out)')].map(el=>getComputedStyle(el).opacity)]);
      await emit('config',{vignette:1,history_opacity:1});
      assert.deepEqual(await look(),['1','1','1','1','1']);
      await emit('config',{vignette:.3,history_opacity:.3});
      assert.deepEqual(await look(),['0.3','0','0.3','0.7','1']);
      await emit('config',{vignette:.6,history_opacity:.72});
      assert.deepEqual(await look(),['0.6','0','0.72','0.88','1']);
    });
    await check('pixel offsets move the title, chat and Super Chat equally across corners, scales and canvas sizes',async()=>{
      // A separate context keeps resize-triggered SSE reconnects and its clock
      // from disturbing retention/idle-loop checks on the main page.
      const positionContext=await browser.newContext({viewport:{width:1920,height:1080},reducedMotion:'reduce'});
      await positionContext.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
      const page=await positionContext.newPage();page.on('pageerror',error=>errors.push(error.message));
      await page.clock.install({time:new Date()});
      await page.clock.pauseAt(new Date(Date.now()+1000));
      await page.goto(`${origin}/overlay?token=fictional-position-token`);
      await page.locator('#ov.ready').waitFor();await page.evaluate(()=>document.fonts.ready);
      const emit=(event,data)=>page.evaluate(({event,data})=>source.dispatchEvent(new MessageEvent(event,{data:JSON.stringify(data)})),{event,data});
      const bounds=()=>page.evaluate(()=>Object.fromEntries(['block','sc'].map(id=>{
        const r=document.getElementById(id).getBoundingClientRect();return [id,{x:r.x,y:r.y,width:r.width,height:r.height}];
      })));
      const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<.02,`${actual} should equal ${expected}`);
      await page.evaluate(()=>{window.__positionRows=[...document.querySelectorAll('#list .item')];});
      for(const viewport of [{width:1920,height:1080},{width:1280,height:720}]) {
        await page.setViewportSize(viewport);
        for(const corner of ['top_left','top_right','bottom_left','bottom_right']) {
          for(const scale of [.5,1,2]) {
            await emit('config',{corner,scale,offset_x:0,offset_y:0});
            const original=await bounds();
            await emit('config',{offset_x:17,offset_y:-23});
            const moved=await bounds();
            for(const id of ['block','sc']) {
              close(moved[id].x-original[id].x,17);close(moved[id].y-original[id].y,-23);
              close(moved[id].width,original[id].width);close(moved[id].height,original[id].height);
            }
            await emit('config',{offset_x:18,offset_y:-22});
            const nudged=await bounds();
            for(const id of ['block','sc']) {
              close(nudged[id].x-moved[id].x,1);close(nudged[id].y-moved[id].y,1);
            }
          }
        }
      }
      await page.setViewportSize({width:1920,height:1080});
      await emit('config',{corner:'top_left',scale:1,offset_x:0,offset_y:0});
      assert.equal(await page.evaluate(()=>window.__positionRows.every((el,i)=>el===document.querySelectorAll('#list .item')[i])),true,'position edits retain the existing message elements');
      assert.equal(await page.locator('#ov').evaluate(el=>getComputedStyle(el).transform),'matrix(1, 0, 0, 1, 0, 0)');
      await positionContext.close();
    });
    await check('reading lights the line in place and completion keeps the same DOM node and size',async()=>{
      await page.evaluate(()=>{window.__kept=[...document.querySelectorAll('#list .item:not(.out)')].pop();});
      await emit('reading',{job_id:4,played_ms:500,queued_ms:2000,chars:6});await advance(700);
      assert.equal(await page.locator('.reading .name').innerText(),'观众4');
      assert.equal(await page.locator('.reading .text').evaluate(el=>getComputedStyle(el).fontSize),'28px');
      assert.equal(await page.locator('.spot').count(),0,'the spine has no spotlight state');
      await page.screenshot({path:path.join(out,'reading.png')});
      await emit('reading',null);await advance(100);assert.equal(await page.locator('.reading').count(),0);
      assert.equal(await page.evaluate(()=>window.__kept.isConnected && window.__kept===[...document.querySelectorAll('#list .item:not(.out)')].pop()),true);
      assert.equal(await page.locator('.tip .text').evaluate(el=>getComputedStyle(el).fontSize),'28px');
      assert.equal(await page.locator('.tip .av').evaluate(el=>getComputedStyle(el).width),'36px');
      assert.deepEqual(await rows().evaluateAll(nodes=>nodes.map(el=>getComputedStyle(el).opacity)),['0.72','0.88','1']);
    });
    await check('five minutes idle preserves spine rows, rests, and stops the JavaScript frame loop',async()=>{
      const retained=await rows().locator('.text').allTextContents(), raf=await page.evaluate(()=>window.__rafRequests);
      await advance(300000);
      assert.deepEqual(await rows().locator('.text').allTextContents(),retained);
      assert.deepEqual(await rows().locator('.age').allTextContents(),['15 min ago','15 min ago','15 min ago']);
      assert.equal(await page.locator('#ov.resting').count(),1);
      assert.equal(await page.locator('.flow').evaluate(el=>getComputedStyle(el,'::before').animationName),'flow','the idle light runs only at rest');
      assert.deepEqual(await page.locator('.rule').evaluate(el=>[getComputedStyle(el,'::before').animationName,getComputedStyle(el,'::after').animationName]),['fork-glint','fork-light']);
      // The branch lights just as the idle light's head reaches the fork.
      const meet=await page.evaluate(()=>{
        const spine=document.querySelector('.spine'),rule=document.querySelector('.rule'),at=parseFloat(rule.style.getPropertyValue('--fork-at'));
        const light=document.getAnimations().find(a=>a.animationName==='flow'),was=light.currentTime;
        light.pause();light.currentTime=at;
        const head=new DOMMatrix(getComputedStyle(spine.querySelector('.flow'),'::before').transform).m42+.07*spine.offsetHeight;
        light.currentTime=was;light.play();
        const fork=rule.getBoundingClientRect().top+rule.offsetHeight/2-6-spine.getBoundingClientRect().top;
        return {head,fork,delay:document.getAnimations().find(a=>a.animationName==='fork-light').effect.getTiming().delay,at};
      });
      assert.ok(Math.abs(meet.head-meet.fork)<1.5,`idle light at ${meet.head}px should meet the fork at ${meet.fork}px`);
      assert.equal(meet.delay,meet.at);
      assert.equal(await page.evaluate(()=>window.__rafRequests),raf);
      await page.screenshot({path:path.join(out,'idle-retained.png')});
    });
    await check('a burst waits its turns: one line at a time, in order, three on screen, nothing skipped',async()=>{
      await page.evaluate(()=>{window.__seen=new Set();new MutationObserver(()=>document.querySelectorAll('#list .item .name').forEach(n=>window.__seen.add(n.textContent))).observe(document.getElementById('list'),{childList:true});});
      for(let seq=5;seq<=16;seq++){await emit('item',item(seq));await advance(350);}
      // Each display-only line holds the stage for its display time before
      // the next appears; the socket counts the lines still waiting.
      await advance(2800);
      assert.equal(await rows().count(),3);assert.equal(await page.locator('.spot').count(),0);
      assert.equal(await page.locator('.item.current').count(),1);
      assert.equal(await page.locator('#ov.waiting').count(),1);
      assert.match(await page.locator('#more').innerText(),/^\+\d+$/);
      assert.equal(await page.locator('#ov.resting').count(),0);
      await advance(24000);
      assert.equal(await page.locator('#ov.waiting').count(),0);assert.equal(await page.locator('.item.current').count(),0);
      assert.equal(await rows().count(),3);
      assert.equal(await page.locator('.item.arrive, #ov.arriving').count(),0,'reduced motion shows lines without the arrival animation');
      assert.deepEqual(await rows().locator('.name').allTextContents(),['观众14','观众15','观众16']);
      assert.equal(await page.locator('.tip .name').innerText(),'观众16');
      assert.equal(await page.evaluate(()=>Array.from({length:12},(_,i)=>'观众'+(i+5)).every(name=>window.__seen.has(name))),true,'every burst line was shown');
    });
    await check('an arrival during a reading waits for it; the next voice brings it on stage',async()=>{
      await emit('item',item(17,17));await advance(350);
      await emit('reading',{job_id:17,played_ms:200,queued_ms:3000,chars:7});await advance(700);
      await emit('item',item(18,18));await advance(350);
      assert.equal(await page.locator('.reading .name').innerText(),'观众17');
      assert.equal(await page.locator('#list .item:not(.out)').last().locator('.name').innerText(),'观众17','the next line waits until the reading ends');
      assert.equal(await page.locator('#more').innerText(),'+1');
      await emit('reading',{job_id:18,played_ms:200,queued_ms:3000,chars:7});await advance(700);
      assert.equal(await page.locator('.reading .name').innerText(),'观众18');
      assert.equal(await page.locator('#list .item:not(.out)').last().locator('.name').innerText(),'观众18');
      assert.equal(await rows().count(),3);
      await emit('reading',null);await advance(2300);assert.equal(await rows().count(),3);
    });
    await check('reload restores an active older job plus the newest two ordinary rows',async()=>{
      opening={...opening,items:Array.from({length:12},(_,i)=>item(20+i,20+i)),reading:{job_id:25,played_ms:600,queued_ms:2000,chars:7}};
      await page.reload();await loaded();await advance(800);
      assert.equal(await rows().count(),3);assert.equal(await page.locator('.reading .name').innerText(),'观众25');
      assert.deepEqual(await page.locator('#list .item:not(.reading):not(.out) .name').allTextContents(),['观众30','观众31']);
      await page.evaluate(()=>{window.__kept=document.querySelector('.reading');});
      await emit('hello',opening);await advance(100);
      assert.equal(await page.evaluate(()=>window.__kept===document.querySelector('.reading')),true);
      await emit('reading',null);await advance(2300);assert.equal(await rows().count(),3);
    });
    await check('missed clear is detected by hello session and cannot revive queued old items',async()=>{
      await emit('item',item(32,32));await emit('item',item(33,33));
      await emit('hello',{...opening,session:1,items:[],reading:null});await advance(1200);
      assert.equal(await rows().count(),0);
      await emit('item',item(34,34));await advance(350);
      await emit('reading',{job_id:34,played_ms:500,queued_ms:2000,chars:7});
      await emit('clear',{session:2});await advance(2500);
      assert.equal(await rows().count(),0);assert.equal(await page.locator('.reading').count(),0);
    });
    await check('late old-session items, reading completion, clear and hello cannot revive or erase current rows',async()=>{
      await emit('item',{...item(35,35),session:1});
      await emit('reading',{job_id:35,session:1,played_ms:500,queued_ms:2000,chars:7});await advance(350);
      assert.equal(await rows().count(),0);
      await emit('item',{...item(36,36),session:2});await advance(350);
      await emit('reading',{job_id:36,session:2,played_ms:500,queued_ms:2000,chars:7});
      await emit('reading',{session:1,job_id:null});await emit('clear',{session:1});
      await emit('hello',{...opening,session:1,items:[],reading:null});await advance(2300);
      assert.equal(await rows().count(),1);assert.equal(await page.locator('.reading .name').innerText(),'观众36');
      await emit('reading',{session:2,job_id:null});await advance(2300);
      assert.equal(await page.locator('.reading').count(),0);assert.equal(await rows().count(),1);
    });
    await check('clear queued before a reconnect hello cannot erase rows already restored from that session',async()=>{
      const fresh={...opening,session:3,items:[{...item(37,37),session:3},{...item(38,38),session:3}],reading:{session:3,job_id:38,played_ms:500,queued_ms:2000,chars:7}};
      await emit('hello',fresh);await emit('clear',{session:3});await advance(2300);
      assert.equal(await rows().count(),2);assert.equal(await page.locator('.reading .name').innerText(),'观众38');
    });
    await check('restoring a long queued job with a newer sequence keeps the original row and reading node',async()=>{
      await page.evaluate(()=>{window.__kept=document.querySelector('.reading');});
      await emit('item',{...item(39,38),session:3});await advance(700);
      assert.equal(await rows().count(),2);
      assert.equal(await page.evaluate(()=>window.__kept===document.querySelector('.reading')),true);
      await emit('hello',{...opening,session:3,items:[{...item(40,38),session:3}],reading:{session:3,job_id:38,played_ms:500,queued_ms:2000,chars:7}});await advance(700);
      assert.equal(await rows().count(),2);
      assert.equal(await page.evaluate(()=>window.__kept===document.querySelector('.reading')),true);
      await emit('reading',{session:3,job_id:null});await advance(2300);
      assert.equal(await page.locator('.reading').count(),0);assert.equal(await rows().count(),2);
    });
    await check('new application instance can reuse sequence numbers without old callback deletion',async()=>{
      await emit('hello',{...opening,instance:'fictional-app-next',session:0,items:[item(1,1)],reading:{job_id:1,played_ms:500,queued_ms:2000,chars:6}});await advance(700);
      await emit('reading',null);
      await emit('hello',{...opening,instance:'fictional-app-third',session:0,items:[item(1,1)],reading:{job_id:1,played_ms:500,queued_ms:2000,chars:6}});await advance(2300);
      assert.equal(await rows().count(),1);assert.equal(await page.locator('.reading').count(),1);
      assert.equal(await page.locator('.reading .name').innerText(),'观众1');
    });
    await check('one-card style retains its original age filtering and expiry',async()=>{
      await emit('hello',{...opening,instance:'fictional-card',session:0,config:{style:'card',linger_seconds:14},items:[item(1,1)],reading:null});await advance(700);
      assert.equal(await rows().count(),0);
      const at=await page.evaluate(()=>Date.now());
      await emit('item',item(2,null,at));await advance(350);
      assert.equal(await rows().count(),1);
      await advance(8000);
      assert.equal(await page.locator('.spot').count(),0);
      const waitingRaf=await page.evaluate(()=>window.__rafRequests);
      await advance(3000);
      assert.equal(await page.evaluate(()=>window.__rafRequests),waitingRaf,'expiry-only wait must not request animation frames');
      await advance(30000);assert.equal(await rows().count(),0);
    });
    await check('Super Chat keeps its price duration and expires while spine ordinary rows remain',async()=>{
      await emit('hello',{...opening,instance:'fictional-sc',session:0,config:{style:'spine',linger_seconds:14},items:[],reading:null});
      const at=await page.evaluate(()=>Date.now());
      await emit('item',{...item(1,null,at),kind:'super_chat',price:30});
      await emit('item',item(2,null,at));await advance(350);
      assert.equal(await page.locator('.ticket').count(),1);
      await page.evaluate(()=>{
        window.__countdownNode=document.querySelector('.sleft').firstChild;
        window.__countdownWrites=0;
        new MutationObserver(records=>window.__countdownWrites+=records.length).observe(document.querySelector('.sleft'),{childList:true});
      });
      await page.evaluate(() => {
        const ticket=document.querySelector('.ticket'), original=ticket.style.getPropertyValue('--left');
        for(const stub of [false,true]) {
          ticket.classList.toggle('stub',stub);
          const fill=ticket.querySelector(stub?'.strack i':'.ttrack i'), track=fill.parentElement;
          for(const fraction of [0,.25,.5,1]) {
            ticket.style.setProperty('--left',String(fraction));
            const actual=fill.getBoundingClientRect(), parent=track.getBoundingClientRect();
            if(Math.abs(actual.width-parent.width*fraction)>.02 || Math.abs(actual.left-parent.left)>.02) throw Error('SC track visual extent changed');
            if(Math.abs(parseFloat(getComputedStyle(fill).width)-parent.width)>.02) throw Error('SC progress still changes layout width');
          }
        }
        ticket.classList.remove('stub');ticket.style.setProperty('--left',original);
      });
      const initialTrack=await page.locator('.ticket .ttrack i').evaluate(el=>getComputedStyle(el).getPropertyValue('--left'));
      await advance(200);
      assert.equal(await page.evaluate(()=>window.__countdownNode===document.querySelector('.sleft').firstChild),true,'unchanged countdown preserves its text node');
      assert.notEqual(await page.locator('.ticket .ttrack i').evaluate(el=>getComputedStyle(el).getPropertyValue('--left')),initialTrack,'progress track keeps animating');
      assert.equal(await page.locator('.ticket .ttrack i').evaluate(el=>getComputedStyle(el).getPropertyValue('--left')),await page.locator('.ticket .strack i').evaluate(el=>getComputedStyle(el).getPropertyValue('--left')),'both original tracks stay synchronized');
      await advance(1800);
      assert.ok(await page.evaluate(()=>window.__countdownWrites>=1 && window.__countdownWrites<=3),'countdown only mutates at second boundaries');
      await advance(62000);assert.equal(await page.locator('.ticket').count(),0);
      assert.equal(await rows().count(),1);
    });
    await check('a line waiting to be read stays grey without frame work and stops looking queued after 30 s',async()=>{
      await emit('item',item(3,3));await advance(350);
      assert.equal(await page.locator('.item.queued').count(),1);assert.equal(await page.locator('.spot').count(),0);
      const waitingRaf=await page.evaluate(()=>window.__rafRequests);await advance(10000);
      assert.equal(await page.evaluate(()=>window.__rafRequests),waitingRaf,'a queued line waits without per-frame work');
      await advance(22000);assert.equal(await page.locator('.item.queued').count(),0);
      const raf=await page.evaluate(()=>window.__rafRequests);await advance(30000);
      assert.equal(await page.evaluate(()=>window.__rafRequests),raf);assert.equal(await rows().count(),2);
    });
    await check('a reading starts frame work only while it plays and lights its line in place',async()=>{
      await emit('item',item(4,4));await advance(350);
      const raf=await page.evaluate(()=>window.__rafRequests);await advance(1000);
      assert.equal(await page.evaluate(()=>window.__rafRequests),raf);
      await emit('reading',{job_id:4,played_ms:100,queued_ms:3000,chars:12});await advance(400);
      assert.ok(await page.evaluate(()=>window.__rafRequests)>raf);
      assert.equal(await page.locator('.item.reading').count(),1);assert.equal(await page.locator('.spot').count(),0);
      await emit('reading',null);await advance(2300);
      assert.equal(await page.locator('.item.reading').count(),0);
    });
    await check('long Super Chat skips unchanged progress styles without slowing its frame loop',async()=>{
      await emit('hello',{...opening,instance:'fictional-long-sc',session:0,items:[],reading:null});
      await emit('item',{...item(1,null,await page.evaluate(()=>Date.now())),kind:'super_chat',price:2000});
      await advance(800);
      await page.evaluate(()=>{
        window.__trackWrites=0;
        window.__trackObserver=new MutationObserver(records=>window.__trackWrites+=records.length);
        window.__trackObserver.observe(document.querySelector('.ticket'),{attributes:true,attributeFilter:['style']});
      });
      const raf=await page.evaluate(()=>window.__rafRequests);
      const progress=await page.locator('.ticket .ttrack i').evaluate(el=>getComputedStyle(el).getPropertyValue('--left'));
      await advance(100);
      assert.ok(await page.evaluate(()=>window.__rafRequests)>raf,'visible animation keeps the browser frame cadence');
      assert.equal(await page.evaluate(()=>window.__trackWrites),0,'rounded progress did not change, so no style assignment is needed');
      await advance(300);
      assert.notEqual(await page.locator('.ticket .ttrack i').evaluate(el=>getComputedStyle(el).getPropertyValue('--left')),progress);
      assert.equal(await page.evaluate(()=>window.__trackWrites),1);
      await page.evaluate(()=>window.__trackObserver.disconnect());
    });
    await check('normal motion keeps the read line in place, the same node and its position size',async()=>{
      opening={...opening,instance:'fictional-normal-motion',session:0,items:[1,2,3,4,5].map(seq=>item(seq,seq)),reading:{job_id:5,played_ms:500,queued_ms:2000,chars:6}};
      // Playwright clocks are shared by pages in a context. Use a separate
      // context so this check observes real timers and the original CSS motion.
      const normalContext=await browser.newContext({viewport:{width:1920,height:1080},reducedMotion:'no-preference'});
      await normalContext.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
      const normal=await normalContext.newPage();normal.on('pageerror',error=>errors.push(error.message));
      await normal.goto(`${origin}/overlay?token=fictional-retention-token`);
      await normal.locator('.item.reading').waitFor();await normal.evaluate(()=>document.fonts.ready);
      await normal.waitForTimeout(700);
      assert.equal(await normal.locator('.reading .text').evaluate(el=>getComputedStyle(el).fontSize),'28px');
      assert.equal(await normal.locator('.reading .text').evaluate(el=>getComputedStyle(el).transitionDuration),'0.52s');
      await normal.evaluate(()=>{window.__kept=document.querySelector('.reading');source.dispatchEvent(new MessageEvent('reading',{data:'null'}));});
      await normal.waitForTimeout(300);assert.equal(await normal.locator('.reading').count(),0);
      assert.equal(await normal.evaluate(()=>window.__kept.isConnected&&window.__kept.classList.contains('tip')),true);
      assert.equal(await normal.locator('.tip .text').evaluate(el=>getComputedStyle(el).fontSize),'28px');
      assert.equal(await normal.locator('.tip .av').evaluate(el=>getComputedStyle(el).width),'36px');
      assert.equal(await normal.locator('.item').count(),3);
      await normal.screenshot({path:path.join(out,'normal-motion-settled.png')});
      // A new line is drawn out of the thread: the socket hands its place to
      // the new avatar while a branch of light reveals the text, then both
      // clean up so the settled line has no mask clipping its halo.
      await normal.evaluate(()=>source.dispatchEvent(new MessageEvent('item',{data:JSON.stringify({seq:40,at:Date.now(),job_id:null,kind:'danmaku',viewer:'fictional-40',name:'观众40',message:'第40条弹幕'})})));
      // The light pours down the thread first; the full thread's oldest line
      // makes way while it runs, and the new line appears only when it lands.
      await normal.locator('#sweep.pour').waitFor({state:'attached',timeout:1000});
      assert.equal(await normal.locator('#list .item .name',{hasText:'观众40'}).count(),0,'the new line waits for the light to land');
      assert.equal(await normal.locator('#list .item.fading:not(.out)').count(),1);
      assert.equal(await normal.locator('#more').innerText(),'+1');
      await normal.locator('.item.arrive').waitFor({timeout:2000});
      assert.equal(await normal.locator('#sweep.land').count(),1,'the light flashes where the avatar is born');
      assert.equal(await normal.locator('#ov.arriving').count(),1,'the socket hides while the avatar blooms in its place');
      assert.equal(await normal.locator('.item.arrive .name').innerText(),'观众40');
      assert.equal(await normal.locator('.item.arrive').evaluate(el=>el===[...document.querySelectorAll('#list .item:not(.out)')].pop()&&el.classList.contains('tip')),true);
      assert.match(await normal.locator('.item.arrive .body').evaluate(el=>getComputedStyle(el).maskImage||getComputedStyle(el).webkitMaskImage),/linear-gradient/);
      assert.equal(await normal.locator('.item.arrive .beam').evaluate(el=>getComputedStyle(el).display),'block');
      await normal.screenshot({path:path.join(out,'normal-motion-arriving.png')});
      await normal.waitForTimeout(1800);
      assert.equal(await normal.locator('.item.arrive, #ov.arriving').count(),0);
      const settled=normal.locator('#list .item:not(.out)').last();
      assert.equal(await settled.locator('.name').innerText(),'观众40');
      assert.deepEqual(await settled.locator('.body').evaluate(el=>[getComputedStyle(el).maskImage||getComputedStyle(el).webkitMaskImage,getComputedStyle(el).paddingTop]),['none','0px']);
      assert.equal(await settled.locator('.beam').evaluate(el=>getComputedStyle(el).display),'none');
      assert.equal(await settled.locator('.text').evaluate(el=>getComputedStyle(el).fontSize),'28px');
      assert.equal(await normal.locator('#list .item:not(.out)').count(),3);
      await normalContext.close();
    });
    await check('a line that is one emote shows the emote alone, sized by its place, with its count at its foot',async()=>{
      // B站 sticker or a single small emote alike; mixed text keeps its emotes inline.
      const emote=(seq,message,text,large)=>({...item(seq,null,Date.now()),message,emotes:[{text,url:`https://i0.hdslb.com/bfs/emote/fictional-${seq}.png`,large}],sticker:large});
      const saved=opening;
      opening={...saved,instance:'fictional-emote-app',items:[emote(51,'[天使]','[天使]',true),item(52,null,Date.now()),emote(53,' [dog] ','[dog]',false)]};
      const emoteContext=await browser.newContext({viewport:{width:1920,height:1080},reducedMotion:'reduce'});
      await emoteContext.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
      const page=await emoteContext.newPage();page.on('pageerror',error=>errors.push(error.message));
      await page.goto(`${origin}/overlay?token=fictional-emote-token`);await page.locator('#ov.ready').waitFor();
      opening=saved;
      const emit=(event,data)=>page.evaluate(({event,data})=>source.dispatchEvent(new MessageEvent(event,{data:JSON.stringify(data)})),{event,data});
      const rows=page.locator('#list .item:not(.out)');
      // Offline the images are refused, so each lone emote keeps its box as a graphic fallback.
      await page.waitForFunction(()=>document.querySelectorAll('#list .sticker.emote-unavailable').length===2);
      const lines=()=>rows.evaluateAll(nodes=>nodes.map(el=>[el.querySelector('.text').classList.contains('solo'),el.querySelector('.lit').textContent,el.querySelector('.sticker')?.getAttribute('aria-label')??null,el.querySelector('.sticker')?getComputedStyle(el.querySelector('.sticker')).height:null]));
      assert.deepEqual(await lines(),[[true,'','[天使]','44px'],[false,'第52条弹幕',null,null],[true,'','[dog]','88px']]);
      assert.deepEqual(await rows.locator('.sticker').evaluateAll(nodes=>nodes.map(el=>getComputedStyle(el).width)),['44px','88px']);
      await emit('item',emote(54,'[dog]','[dog]',false));
      await page.waitForFunction(()=>[...document.querySelectorAll('#list .item:not(.out) .count')].some(el=>el.textContent==='×2'));
      const foot=await rows.last().evaluate(el=>{const s=el.querySelector('.sticker').getBoundingClientRect(),c=el.querySelector('.count').getBoundingClientRect();return {beside:c.left>=s.right,gap:Math.round(s.bottom-c.bottom)};});
      assert.deepEqual(foot,{beside:true,gap:6},'the repeat count sits at the emote\'s foot, not below it');
      await emit('item',emote(55,'好[天使]','[天使]',false));
      await page.waitForFunction(()=>[...document.querySelectorAll('#list .item:not(.out)')].pop()?.querySelector('.lit')?.textContent==='好');
      assert.deepEqual(await lines(),[[false,'第52条弹幕',null,null],[true,'','[dog]','56px'],[false,'好',null,null]]);
      assert.equal(await rows.last().locator('.emote').count(),1);
      await page.screenshot({path:path.join(out,'lone-emote.png'),clip:{x:0,y:0,width:900,height:640}});
      await emoteContext.close();
    });
    assert.deepEqual(errors,[]);
    await fs.writeFile(path.join(out,'results.json'),JSON.stringify({passed:true,checks,errors,requests,pageSha256:hash(html),cssSha256:hash(section(html,'<style>','</style>')),productionAccounts:false,nativeOBS:false},null,2));
    console.log(`${checks.length} checks passed`);
  } catch(error) {
    await fs.writeFile(path.join(out,'failed.json'),JSON.stringify({passed:false,checks,errors,error:error.stack,pageSha256:hash(html)},null,2));
    throw error;
  } finally {
    await browser?.close();for(const client of clients)client.destroy();await new Promise(resolve=>server.close(resolve));
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
