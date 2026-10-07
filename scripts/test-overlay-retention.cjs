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
  // Fixed digests of the original artwork before this behavior change keep
  // this gate reproducible without a local target/ backup or browser snapshot.
  assert.equal(hash(section(html, '<style>', '</style>')), '84cee46750f3c1178dffdb7ccf30fbae9b665de974d42cddf15ce8381e9bca1f', 'production CSS must be byte-identical');
  assert.equal(hash(section(html, '<body>', '<script>')), '77ad5f9cf0bcedcdbd46e4a67087de815bda97bc0440a86abc4daa5daa53ca41', 'production DOM must be byte-identical');
  checks.push({name:'original production CSS and DOM bytes preserved',passed:true});
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
      const raf=requestAnimationFrame;
      window.requestAnimationFrame=callback=>{window.__rafRequests++;return raf(callback);};
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
    await check('cold page restores four old spine readings as small rows without replay',async()=>{
      assert.equal(await rows().count(),4);assert.equal(await page.locator('.spot').count(),0);
      assert.equal(await page.locator('.reading').count(),0);
      assert.equal(await page.locator('.recent .text').evaluate(el=>getComputedStyle(el).fontSize),'22px');
      assert.deepEqual(await page.locator('.item:not(.recent) .text').evaluateAll(nodes=>nodes.map(el=>getComputedStyle(el).fontSize)),['18px','18px','18px']);
      assert.deepEqual(await page.locator('.item .lit').evaluateAll(nodes=>nodes.map(el=>el.style.getPropertyValue('--lit')||'100%')),['100%','100%','100%','100%']);
    });
    await check('reading progress and original 1.6-second completion retain the same DOM node',async()=>{
      await page.evaluate(()=>{window.__kept=document.querySelector('#list .item');});
      await emit('reading',{job_id:4,played_ms:500,queued_ms:2000,chars:6});await advance(700);
      assert.equal(await page.locator('.spot .name').innerText(),'观众4');
      assert.equal(await page.locator('.spot .text').evaluate(el=>getComputedStyle(el).fontSize),'30px');
      await page.screenshot({path:path.join(out,'reading.png')});
      await emit('reading',null);await advance(1500);assert.equal(await page.locator('.spot').count(),1);
      await advance(800);assert.equal(await page.locator('.spot').count(),0);
      assert.equal(await page.evaluate(()=>window.__kept.isConnected && window.__kept===document.querySelector('#list .item')),true);
      assert.equal(await page.locator('.recent .text').evaluate(el=>getComputedStyle(el).fontSize),'22px');
      assert.equal(await page.locator('.recent .av').evaluate(el=>getComputedStyle(el).width),'28px');
      assert.deepEqual(await rows().evaluateAll(nodes=>nodes.map(el=>getComputedStyle(el).opacity)),['1','0.72','0.5','0.36']);
    });
    await check('five minutes idle preserves spine rows and stops the JavaScript frame loop',async()=>{
      const retained=await rows().allTextContents(), raf=await page.evaluate(()=>window.__rafRequests);
      await advance(300000);
      assert.deepEqual(await rows().allTextContents(),retained);
      assert.equal(await page.evaluate(()=>window.__rafRequests),raf);
      await page.screenshot({path:path.join(out,'idle-retained.png')});
    });
    await check('rapid arrivals and timer completion preserve the four ordinary plus one spotlight limit',async()=>{
      for(let seq=5;seq<=16;seq++){await emit('item',item(seq));await advance(350);}
      await advance(700);
      assert.equal(await rows().count(),5);assert.equal(await page.locator('.spot').count(),1);
      assert.equal(await page.locator('.spot .name').innerText(),'观众16');
      await advance(9000);
      assert.equal(await rows().count(),4);assert.equal(await page.locator('.spot').count(),0);
      assert.deepEqual(await rows().locator('.name').allTextContents(),['观众16','观众15','观众14','观众13']);
    });
    await check('queued arrivals cannot take the active reading; next job takes original spotlight',async()=>{
      await emit('item',item(17,17));await advance(350);
      await emit('reading',{job_id:17,played_ms:200,queued_ms:3000,chars:7});await advance(700);
      await emit('item',item(18,18));await advance(350);
      assert.equal(await page.locator('.spot .name').innerText(),'观众17');
      await emit('reading',{job_id:18,played_ms:200,queued_ms:3000,chars:7});await advance(700);
      assert.equal(await page.locator('.spot .name').innerText(),'观众18');
      assert.equal(await page.locator('#list .item').first().locator('.name').innerText(),'观众18');
      assert.equal(await rows().count(),5);
      await emit('reading',null);await advance(2300);assert.equal(await rows().count(),4);
    });
    await check('reload restores an active older job plus newest four ordinary rows',async()=>{
      opening={...opening,items:Array.from({length:12},(_,i)=>item(20+i,20+i)),reading:{job_id:25,played_ms:600,queued_ms:2000,chars:7}};
      await page.reload();await loaded();await advance(800);
      assert.equal(await rows().count(),5);assert.equal(await page.locator('.spot .name').innerText(),'观众25');
      assert.deepEqual(await page.locator('#list .item:not(.spot):not(.out) .name').allTextContents(),['观众31','观众30','观众29','观众28']);
      await page.evaluate(()=>{window.__kept=document.querySelector('.spot');});
      await emit('hello',opening);await advance(100);
      assert.equal(await page.evaluate(()=>window.__kept===document.querySelector('.spot')),true);
      await emit('reading',null);await advance(2300);assert.equal(await rows().count(),4);
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
      assert.equal(await rows().count(),1);assert.equal(await page.locator('.spot .name').innerText(),'观众36');
      await emit('reading',{session:2,job_id:null});await advance(2300);
      assert.equal(await page.locator('.spot').count(),0);assert.equal(await rows().count(),1);
    });
    await check('clear queued before a reconnect hello cannot erase rows already restored from that session',async()=>{
      const fresh={...opening,session:3,items:[{...item(37,37),session:3},{...item(38,38),session:3}],reading:{session:3,job_id:38,played_ms:500,queued_ms:2000,chars:7}};
      await emit('hello',fresh);await emit('clear',{session:3});await advance(2300);
      assert.equal(await rows().count(),2);assert.equal(await page.locator('.spot .name').innerText(),'观众38');
    });
    await check('restoring a long queued job with a newer sequence keeps the original row and reading node',async()=>{
      await page.evaluate(()=>{window.__kept=document.querySelector('.spot');});
      await emit('item',{...item(39,38),session:3});await advance(700);
      assert.equal(await rows().count(),2);
      assert.equal(await page.evaluate(()=>window.__kept===document.querySelector('.spot')),true);
      await emit('hello',{...opening,session:3,items:[{...item(40,38),session:3}],reading:{session:3,job_id:38,played_ms:500,queued_ms:2000,chars:7}});await advance(700);
      assert.equal(await rows().count(),2);
      assert.equal(await page.evaluate(()=>window.__kept===document.querySelector('.spot')),true);
      await emit('reading',{session:3,job_id:null});await advance(2300);
      assert.equal(await page.locator('.spot').count(),0);assert.equal(await rows().count(),2);
    });
    await check('new application instance can reuse sequence numbers without old callback deletion',async()=>{
      await emit('hello',{...opening,instance:'fictional-app-next',session:0,items:[item(1,1)],reading:{job_id:1,played_ms:500,queued_ms:2000,chars:6}});await advance(700);
      await emit('reading',null);
      await emit('hello',{...opening,instance:'fictional-app-third',session:0,items:[item(1,1)],reading:{job_id:1,played_ms:500,queued_ms:2000,chars:6}});await advance(2300);
      assert.equal(await rows().count(),1);assert.equal(await page.locator('.spot').count(),1);
      assert.equal(await page.locator('.spot .name').innerText(),'观众1');
    });
    await check('one-card style retains its original age filtering and expiry',async()=>{
      await emit('hello',{...opening,instance:'fictional-card',session:0,config:{style:'card',linger_seconds:14},items:[item(1,1)],reading:null});await advance(700);
      assert.equal(await rows().count(),0);
      const at=await page.evaluate(()=>Date.now());
      await emit('item',item(2,null,at));await advance(350);
      assert.equal(await rows().count(),1);
      await advance(30000);assert.equal(await rows().count(),0);
    });
    await check('Super Chat keeps its price duration and expires while spine ordinary rows remain',async()=>{
      await emit('hello',{...opening,instance:'fictional-sc',session:0,config:{style:'spine',linger_seconds:14},items:[],reading:null});
      const at=await page.evaluate(()=>Date.now());
      await emit('item',{...item(1,null,at),kind:'super_chat',price:30});
      await emit('item',item(2,null,at));await advance(350);
      assert.equal(await page.locator('.ticket').count(),1);
      await advance(62000);assert.equal(await page.locator('.ticket').count(),0);
      assert.equal(await rows().count(),1);
    });
    await check('waiting-only spotlight demotes at the original timeout and becomes idle',async()=>{
      await emit('item',item(3,3));await advance(350);assert.equal(await page.locator('.spot').count(),1);
      await advance(22000);assert.equal(await page.locator('.spot').count(),0);
      const raf=await page.evaluate(()=>window.__rafRequests);await advance(30000);
      assert.equal(await page.evaluate(()=>window.__rafRequests),raf);assert.equal(await rows().count(),2);
    });
    await check('normal motion keeps the original completion hold, shrink and same-node artwork',async()=>{
      opening={...opening,instance:'fictional-normal-motion',session:0,items:[1,2,3,4,5].map(seq=>item(seq,seq)),reading:{job_id:5,played_ms:500,queued_ms:2000,chars:6}};
      // Playwright clocks are shared by pages in a context. Use a separate
      // context so this check observes real timers and the original CSS motion.
      const normalContext=await browser.newContext({viewport:{width:1920,height:1080},reducedMotion:'no-preference'});
      await normalContext.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
      const normal=await normalContext.newPage();normal.on('pageerror',error=>errors.push(error.message));
      await normal.goto(`${origin}/overlay?token=fictional-retention-token`);
      await normal.locator('.spot').waitFor();await normal.evaluate(()=>document.fonts.ready);
      await normal.waitForTimeout(700);
      assert.equal(await normal.locator('.spot .text').evaluate(el=>getComputedStyle(el).fontSize),'30px');
      assert.equal(await normal.locator('.spot .text').evaluate(el=>getComputedStyle(el).transitionDuration),'0.52s');
      await normal.evaluate(()=>{window.__kept=document.querySelector('.spot');source.dispatchEvent(new MessageEvent('reading',{data:'null'}));});
      await normal.waitForTimeout(1450);assert.equal(await normal.locator('.spot').count(),1);
      await normal.waitForTimeout(950);assert.equal(await normal.locator('.spot').count(),0);
      assert.equal(await normal.evaluate(()=>window.__kept.isConnected&&window.__kept.classList.contains('recent')),true);
      assert.equal(await normal.locator('.recent .text').evaluate(el=>getComputedStyle(el).fontSize),'22px');
      assert.equal(await normal.locator('.recent .av').evaluate(el=>getComputedStyle(el).width),'28px');
      assert.equal(await normal.locator('.item').count(),4);
      await normal.screenshot({path:path.join(out,'normal-motion-settled.png')});await normalContext.close();
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
