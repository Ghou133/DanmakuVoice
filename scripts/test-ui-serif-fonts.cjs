// Independent original Google font bytes versus actual production font declarations.
// Font specimen only: no app fixture, account, IPC, network, native window or broadcast.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const {createHash}=require('node:crypto');
const {chromium}=require('playwright');
const {PNG}=require('pngjs');
const repo=path.resolve(__dirname,'..'), ui=path.join(repo,'crates/desktop/ui'), cache=path.resolve(process.env.DV_REFERENCE_FONT_CACHE||path.join(repo,'target/lake-reference/font-cache')), output=path.join(repo,'target/lake-font-rebuild/browser');
const specimens=[
 ...[400,500,700,900].map(weight=>({id:`cjk-${weight}`,weight,size:48,style:'normal',family:'serif',text:'今晚一起听歌，顺便聊聊天。这首歌的前奏也太好听了吧'})),
 {id:'prepared-history',weight:500,size:20,style:'normal',family:'serif',text:'上一场 · 暂无记录　弹幕 · 暂无记录'},
 {id:'title',weight:500,size:14.5,style:'normal',family:'serif',text:'今晚一起听歌，顺便聊聊天'},
 {id:'latin-italic',weight:400,size:64,style:'italic',family:'latin',text:'Tuesday night'},
 {id:'latin-normal',weight:400,size:13,style:'normal',family:'latin',text:'OCT 06 · 22:24'},
];

(async()=>{
 await fs.mkdir(output,{recursive:true});
 const manifest=JSON.parse(await fs.readFile(path.join(cache,'manifest.json'),'utf8'));
 for(const file of manifest.files)assert.equal(createHash('sha256').update(await fs.readFile(path.join(cache,file.name))).digest('hex'),file.sha256);
 const actualRules=(await fs.readFile(path.join(ui,'styles.css'),'utf8')).match(/@font-face\{[^}]+\}/g).slice(0,5).join('\n').replaceAll('url("./','url("/production/');
 const originalRules=[500,700,900].map(w=>`@font-face{font-family:"Noto Serif SC";src:url("/original/NotoSerifSC-original.ttf") format("truetype");font-weight:${w};font-style:normal;font-display:swap}`).join('\n')+'\n'+['Regular','Italic'].map(style=>`@font-face{font-family:"Instrument Serif";src:url("/original/InstrumentSerif-${style}-original.woff2") format("woff2");font-weight:400;font-style:${style==='Italic'?'italic':'normal'};font-display:swap}`).join('\n');
 const pageHTML=production=>`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${production?actualRules:originalRules}*{box-sizing:border-box}body{margin:0;background:#fff;color:#000}div{height:120px;padding:8px}span{display:inline-block;font-synthesis:none;-webkit-font-smoothing:antialiased;white-space:pre}</style>${specimens.map(s=>`<div><span id="${s.id}" style="font-family:'${s.family==='latin'?'Instrument Serif':production?'DanmakuVoice Serif SC':'Noto Serif SC'}';font-weight:${s.weight};font-style:${s.style};font-size:${s.size}px;line-height:1.4">${s.text}</span></div>`).join('')}`;
 const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://127.0.0.1');if(url.pathname==='/reference'||url.pathname==='/actual')return res.writeHead(200,{'Content-Type':'text/html'}).end(pageHTML(url.pathname==='/actual'));const prefix=url.pathname.startsWith('/original/')?'original':'production';const name=decodeURIComponent(url.pathname.slice(prefix.length+2));if(name.includes('/')||name.includes('..'))return res.writeHead(403).end();const file=path.join(prefix==='original'?cache:path.join(ui,'fonts'),name);res.writeHead(200,{'Content-Type':name.endsWith('.ttf')?'font/ttf':'font/woff2'}).end(await fs.readFile(file));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 let browser;const errors=[],evidence={passed:false,evidence:'Independent untouched official original Google fonts loaded separately from actual production font rules; headless Edge font specimens. Exact per-row glyph raster, CSS weight400 nearest500, real CDP platform fonts, no app/network/native acceptance.',originalFontSources:manifest,pages:{},gates:[]};
 try{
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-features=msWindowTabManagerPublic']});const context=await browser.newContext({viewport:{width:1600,height:960}});await context.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());
  for(const mode of ['reference','actual']){
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',r=>errors.push(`${r.url()} ${r.failure()?.errorText}`));await page.goto(`${origin}/${mode}`);await page.evaluate(()=>document.fonts.ready);
   const cdp=await context.newCDPSession(page);await cdp.send('DOM.enable');await cdp.send('CSS.enable');const doc=await cdp.send('DOM.getDocument');const nodes={};for(const s of specimens){const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:`#${s.id}`});const fonts=await cdp.send('CSS.getPlatformFontsForNode',{nodeId});nodes[s.id]={...await page.locator(`#${s.id}`).evaluate(n=>{const r=n.getBoundingClientRect(),c=getComputedStyle(n);return{width:r.width,height:r.height,fontSize:c.fontSize,fontWeight:c.fontWeight,fontStyle:c.fontStyle}}),fonts:fonts.fonts};}
   evidence.pages[mode]=nodes;await page.screenshot({path:path.join(output,`${mode}.png`)});await page.close();
  }
  const a=PNG.sync.read(await fs.readFile(path.join(output,'actual.png'))),r=PNG.sync.read(await fs.readFile(path.join(output,'reference.png')));
  for(let row=0;row<specimens.length;row++){
   const id=specimens[row].id;let different=0;for(let y=row*120;y<(row+1)*120;y++)for(let x=0;x<1600;x++){const i=(y*1600+x)*4;if(a.data[i]!==r.data[i]||a.data[i+1]!==r.data[i+1]||a.data[i+2]!==r.data[i+2])different++;}
   const source=evidence.pages.reference[id],actual=evidence.pages.actual[id];evidence.gates.push({name:`${id} independent exact glyph raster`,passed:different===0,differentPixels:different});evidence.gates.push({name:`${id} actual loaded custom font and geometry`,passed:source.fonts.some(f=>f.isCustomFont)&&actual.fonts.some(f=>f.isCustomFont)&&JSON.stringify(source.fonts.filter(f=>!f.isCustomFont))===JSON.stringify(actual.fonts.filter(f=>!f.isCustomFont))&&source.width===actual.width&&source.height===actual.height,source,actual});
  }
  evidence.gates.push({name:'no browser or font request errors',passed:errors.length===0,errors});evidence.passed=evidence.gates.every(g=>g.passed);await fs.writeFile(path.join(output,'results.json'),JSON.stringify(evidence,null,2));console.log(`${evidence.gates.filter(g=>g.passed).length}/${evidence.gates.length} independent browser font gates passed`);assert.ok(evidence.passed,JSON.stringify(evidence.gates.filter(g=>!g.passed)));
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
