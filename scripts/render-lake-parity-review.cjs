// Builds an offline review artifact from the paired browser evidence.
// No demo data or reference runtime is included in the production application.
const fs = require('node:fs/promises');
const path = require('node:path');

(async () => {
  const output = path.resolve(process.env.DV_PARITY_OUTPUT || path.join(__dirname, '../target/lake-parity'));
  const report = JSON.parse(await fs.readFile(path.join(output, 'parity-results.json'), 'utf8'));
  const measured = JSON.parse(await fs.readFile(path.join(output, 'reference-measurements.json'), 'utf8'));
  const fontDescription = measured.fontSources
    ? '原稿加载独立缓存的官方原字体，项目加载自己的离线子集。两侧使用 '
    : '两侧使用相同本地字体、';
  const latestChanges = report.approvedExceptions.some(value => value.includes('prepared-scene tonight'))
    ? '<p>本轮保留大号星期刊头与日期时间。时间下方改为当前用户名＋的直播间，因此对照只匹配原稿这一处动态文本；原稿标题、编辑器和布局仍保留。准备页的 tonight’s title 标签在项目中按要求移除，原稿截图保留它以便查看差异；零观众隐藏、独立发表情与取消直播模式发送限制也列为明确业务差异。</p>'
    : '';
  const motion = JSON.parse(await fs.readFile(path.join(output, 'animation-measurements.json'), 'utf8'));
  const states = Object.keys(measured.measurements);
  const previewMotion = Object.fromEntries(Object.entries(motion).map(([side, captures]) => [side,
    Object.fromEntries(Object.entries(captures).map(([state, elements]) => [state,
      Object.fromEntries(Object.entries(elements).filter(([, entries]) => Array.isArray(entries)).map(([name, entries]) => [name, entries.slice(0, 1).map(entry => ({
        animations: entry.animations.map(({ duration, delay, iterations, direction, fill, easing }) => ({ duration, delay, iterations, direction, fill, easing })),
      }))])),
    ])),
  ]));
  const payload = JSON.stringify({ report, states, motion: previewMotion }).replaceAll('<', '\\u003c');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>水月 · 原稿逐项对照</title><style>
  *{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:#10111a;color:#ece9f5;font:15px/1.6 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1800px;margin:auto;padding:28px}h1{font-size:25px;margin:0 0 10px}p{color:#b8b5c8;margin:8px 0}select,button{font:inherit;color:inherit;background:#262333;border:1px solid #575069;border-radius:9px;padding:7px 12px}label{margin-right:18px}.controls{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:22px 0}.pairs{display:grid;grid-template-columns:1fr 1fr;gap:16px}figure{margin:0;min-width:0}figcaption{margin-bottom:6px;color:#c8b6f0}img{display:block;width:100%;height:auto;border:1px solid #3b354a;border-radius:10px}.status{color:#acd9b3}.fail{color:#ffadc0}details{margin:18px 0;padding:16px;border:1px solid #413b50;border-radius:12px}summary{cursor:pointer;font-size:17px}table{width:100%;border-collapse:collapse;margin-top:14px}td,th{text-align:left;vertical-align:top;border-bottom:1px solid #373242;padding:8px}th{color:#c8b6f0}td:last-child{overflow-wrap:anywhere;font-size:13px}code{font-size:13px;white-space:pre-wrap}input[type=search]{width:min(500px,100%);padding:8px;background:#262333;border:1px solid #575069;border-radius:8px;color:inherit}.overlay{position:relative;width:min(1040px,100%);margin:18px auto}.overlay img{width:100%}.overlay .front{position:absolute;inset:0;opacity:.5}input[type=range]{width:230px}li{margin:5px 0}@media(max-width:1000px){.pairs{grid-template-columns:1fr}main{padding:18px}}
  </style><main><h1>水月 · 原 HTML 与项目逐项对照</h1><p>原稿由导出包自身 DC 运行时渲染；项目使用实际生产页面模块。${fontDescription}1040 × 740 视口和仅用于测试的虚构资料。截图动画冻结在 10 秒；动效检查另行比较完整关键帧与计时参数。</p>${latestChanges}<p>这是离线浏览器证据。真实观众、头像、声音和房间资料保持实际数据；未在真实账号、原生 WebView2、OBS 或实际音频中验收。</p><div id="overall"></div><div class="controls"><label>状态 <select id="state"></select></label><label><input id="blend" type="checkbox"> 重叠对照</label><label id="alpha-label" hidden>项目透明度 <input id="alpha" type="range" min="0" max="100" value="50"></label></div><div class="pairs" id="pairs"><figure><figcaption>原稿</figcaption><img id="reference" alt="原 HTML 截图"></figure><figure><figcaption>项目</figcaption><img id="actual" alt="项目截图"></figure></div><div class="overlay" id="overlay" hidden><img id="back" alt="原稿"><img id="front" class="front" alt="项目"></div><details open><summary>本状态逐项检查</summary><div id="gates"></div></details><details><summary>本状态动画参数</summary><p>每组元素分别核对 duration、delay、repeat、direction、fill、easing 和全部关键帧值；下表显示首个元素的计时概要，完整数据见 animation-measurements.json。</p><div id="motion"></div></details><details><summary>明确保留的业务差异</summary><ul id="exceptions"></ul></details><details><summary>全部检查检索</summary><input id="search" type="search" placeholder="搜索元素或检查名称"><div id="all-gates"></div></details></main><script>
  const data=${payload};
  const el=id=>document.getElementById(id), safe=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const table=gates=>'<table><thead><tr><th>检查</th><th>结果</th><th>证据</th></tr></thead><tbody>'+gates.map(g=>'<tr><td>'+safe(g.name)+'</td><td class="'+(g.passed?'status':'fail')+'">'+(g.passed?'通过':'失败')+'</td><td>'+safe(g.detail)+'</td></tr>').join('')+'</tbody></table>';
  const passed=data.report.gates.filter(g=>g.passed).length;
  el('overall').innerHTML='<strong class="'+(data.report.passed?'status':'fail')+'">'+passed+' / '+data.report.gates.length+' 项通过 · '+data.states.length+' 组成对状态</strong>';
  el('state').innerHTML=data.states.map(s=>'<option>'+safe(s)+'</option>').join('');
  el('exceptions').innerHTML=[...data.report.approvedExceptions,...(data.report.dynamicDataPolicy||[])].map(s=>'<li>'+safe(s)+'</li>').join('');
  const timing=entries=>entries?.[0]?.animations.map(a=>a.duration+' ms / 延迟 '+a.delay+' ms / '+a.iterations+' 次 / '+a.direction+' / '+a.fill+' / '+a.easing).join('<br>')||'无 CSS 动画';
  function update(){const s=el('state').value;el('reference').src=el('back').src='reference-'+s+'.png';el('actual').src=el('front').src='actual-'+s+'.png';el('gates').innerHTML=table(data.report.gates.filter(g=>g.name.startsWith(s+' ')));const ref=data.motion.reference[s]||{},actual=data.motion.actual[s]||{};el('motion').innerHTML='<table><thead><tr><th>元素</th><th>原稿</th><th>项目</th></tr></thead><tbody>'+Object.keys(ref).map(k=>'<tr><td>'+safe(k)+'</td><td>'+timing(ref[k])+'</td><td>'+timing(actual[k])+'</td></tr>').join('')+'</tbody></table>';}
  el('state').onchange=update;el('blend').onchange=()=>{el('pairs').hidden=el('blend').checked;el('overlay').hidden=!el('blend').checked;el('alpha-label').hidden=!el('blend').checked;};el('alpha').oninput=()=>el('front').style.opacity=el('alpha').value/100;el('search').oninput=()=>el('all-gates').innerHTML=table(data.report.gates.filter(g=>g.name.toLowerCase().includes(el('search').value.toLowerCase())));update();el('search').oninput();
  </script></html>`;
  await fs.writeFile(path.join(output, 'review.html'), html);
  console.log(`Review written: ${path.join(output, 'review.html')}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
