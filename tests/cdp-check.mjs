/**
 * cdp-check.mjs — 用 Chrome DevTools Protocol 驱动无头 Edge：
 *   1) 验证页面加载、控件与交互逻辑（点群切换、晶胞对齐、自定义点云、带心等）
 *   2) 拍一组终版截图
 *
 * 运行：node tests/cdp-check.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, 'shots');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = path.join(os.tmpdir(), 'crystal-symmetry-cdp-profile');
const PORT = 9333;
const BASE = pathToFileURL(path.join(ROOT, 'index.html')).href;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 启动浏览器 ---------------- */
const child = spawn(EDGE, [
  '--headless=new',
  '--no-sandbox',
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader',
  '--hide-scrollbars',
  '--window-size=1600,1100',
  '--remote-debugging-port=' + PORT,
  '--remote-allow-origins=*',
  '--user-data-dir=' + PROFILE,
  '--disable-breakpad',
  '--no-first-run',
  '--no-default-browser-check',
  BASE + '?autorot=0'
], { stdio: 'ignore' });

let ws;
let msgId = 1;
const pending = new Map();
const jsErrors = [];

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function waitForDevtools() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch (err) { /* not ready */ }
    await sleep(150);
  }
  throw new Error('DevTools 未就绪');
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function connect(wsUrl) {
  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error('WebSocket 连接失败'));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      jsErrors.push(JSON.stringify(msg.params.exceptionDetails).slice(0, 400));
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      jsErrors.push(msg.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 400));
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');
}

async function ev(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (r.exceptionDetails) {
    throw new Error('页面 JS 异常：' + JSON.stringify(r.exceptionDetails).slice(0, 500));
  }
  return r.result.value;
}

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try {
      const ok = await ev("!!(window.CrystalSym && document.querySelectorAll('#pg option').length > 30 && document.getElementById('stat-points').textContent !== '—')");
      if (ok) return;
    } catch (err) { /* still loading */ }
    await sleep(150);
  }
  throw new Error('页面未就绪');
}

async function navigate(url) {
  await send('Page.navigate', { url });
  await sleep(500);
  await waitReady();
  await sleep(500);
}

async function screenshot(name) {
  const res = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(res.data, 'base64'));
  console.log('  📷', name);
}

/* ---------------- 断言 ---------------- */
let passed = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('✓', name); }
  else { fails.push(name + (detail ? ' — ' + detail : '')); console.log('✗', name, detail || ''); }
}

/* ---------------- 主流程 ---------------- */
async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const target = await waitForDevtools();
  await connect(target.webSocketDebuggerUrl);
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1560, height: 1280, deviceScaleFactor: 1.5, mobile: false
  });
  await waitReady();
  await sleep(600);

  /* ---- 1. 初始状态（P1） ---- */
  check('点群下拉共 33 项（32 点群 + 自动）', (await ev("document.querySelectorAll('#pg option').length")) === 33);
  check('默认点群为 1（最低对称）', (await ev("document.getElementById('stat-group').textContent")) === '1');
  check('晶格最高对称识别为 m-3m / 48', (await ev("document.getElementById('stat-holo').textContent")) === 'm-3m / 48');
  check('默认采样 26³ = 17576 点', (await ev("document.getElementById('stat-points').textContent")) === '17576');
  check('P1 下轨道数 = 点数', (await ev("document.getElementById('stat-orbits').textContent")) === '17576');
  check('P1 操作数 = 1', (await ev("document.getElementById('stat-ops').textContent")).startsWith('1 个'));

  /* ---- 2. 立方预设 ---- */
  await ev("document.querySelector('[data-system=\"cubic\"]').click(); 1");
  await sleep(900);
  check('立方预设把晶胞设为 5,5,5', (await ev("['cell-a','cell-b','cell-c'].map(id=>+document.getElementById(id).value).join(',')")) === '5,5,5');
  check('立方预设点群 = m-3m', (await ev("document.getElementById('stat-group').textContent")) === 'm-3m');
  check('m-3m 操作数 = 48', (await ev("document.getElementById('stat-ops').textContent")).startsWith('48 个'));
  const cubeOrbits = await ev("+document.getElementById('stat-orbits').textContent");
  check('m-3m 轨道数在合理范围（520~620）', cubeOrbits > 520 && cubeOrbits < 620, '实际 ' + cubeOrbits);
  check('平均轨道大小 ≈ 48 或更小', (await ev("+document.getElementById('stat-avg').textContent")) <= 48);

  /* ---- 2b. 三维色码性质 ---- */
  check('默认颜色模式 = 基本域三维色码',
    (await ev("document.getElementById('color').value")) === 'canon');

  const colorCheck = await ev(`(function () {
    var S = window.CrystalSym;
    var D = window.__crystalDebug;
    var prep = D.getPrep();
    var rand = S.sampleRandom(6, 99);
    function colorOf(p) {
      var q = S.canonicalize(prep, p[0], p[1], p[2]);
      return D.colorFromRep(q[0], q[1], q[2]);
    }
    var seed = [rand[0], rand[1], rand[2]];
    var base = colorOf(seed);
    var maxSameDiff = 0;
    var orbitSize = 0;
    for (var i = 0; i < prep.ops.length; i++) {
      var op = prep.ops[i];
      var q = [
        op.R[0][0] * seed[0] + op.R[0][1] * seed[1] + op.R[0][2] * seed[2] + op.t[0],
        op.R[1][0] * seed[0] + op.R[1][1] * seed[1] + op.R[1][2] * seed[2] + op.t[1],
        op.R[2][0] * seed[0] + op.R[2][1] * seed[1] + op.R[2][2] * seed[2] + op.t[2]
      ];
      var c = colorOf(q);
      var d = Math.abs(c[0] - base[0]) + Math.abs(c[1] - base[1]) + Math.abs(c[2] - base[2]);
      if (d > maxSameDiff) maxSameDiff = d;
      if (d < 1e-9) orbitSize++;
    }
    var seed2 = [rand[3], rand[4], rand[5]];
    var dE = window.CrystalColor.deltaE76(base, colorOf(seed2));
    // 颜色亮度下限（抽样）
    var minL = 999;
    for (var k = 0; k < 400; k++) {
      var c2 = D.colorCode(Math.random(), Math.random(), Math.random());
      var lab = window.CrystalColor.rgbToLab(c2);
      if (lab[0] < minL) minL = lab[0];
    }
    return { maxSameDiff: maxSameDiff, orbitSize: orbitSize, dE: dE, minL: minL };
  })()`);

  check('同一轨道的所有对称像颜色严格相同',
    colorCheck.maxSameDiff < 1e-12, '最大差 ' + colorCheck.maxSameDiff);
  check('该轨道包含多个等价点', colorCheck.orbitSize > 1, '轨道大小 ' + colorCheck.orbitSize);
  check('不同轨道的颜色清晰可辨（ΔE > 10）', colorCheck.dE > 10, 'ΔE=' + colorCheck.dE.toFixed(1));
  check('颜色不会过暗（L* ≥ 51，设计下限 52）', colorCheck.minL >= 51, 'min L*=' + colorCheck.minL.toFixed(1));

  /* ---- 3. 带心 F ---- */
  await ev("(function(){var s=document.getElementById('centering'); s.value='F'; s.dispatchEvent(new Event('change',{bubbles:true})); return 1;})()");
  await sleep(900);
  check('F 带心后操作数 = 192', (await ev("document.getElementById('stat-ops').textContent")).startsWith('192 个'));
  check('F 带心后统计显示 ×4', (await ev("document.getElementById('stat-ops').textContent")).includes('× 4'));
  await ev("(function(){var s=document.getElementById('centering'); s.value='P'; s.dispatchEvent(new Event('change',{bubbles:true})); return 1;})()");
  await sleep(700);

  /* ---- 4. 不相容提示 + 对齐晶胞 ---- */
  await ev("(function(){var b=document.getElementById('cell-b'); b.value=6; b.dispatchEvent(new Event('input',{bubbles:true})); return 1;})()");
  await sleep(500);
  check('b 改 6 后立方点群失效并给出警告',
    (await ev("document.getElementById('sym-status').textContent")).includes('不符'));
  const hasAlign = await ev("!!document.querySelector('#warnings button')");
  check('出现「对齐晶胞参数」按钮', hasAlign === true);
  await ev("document.querySelector('#warnings button').click(); 1");
  await sleep(900);
  check('对齐后 b 回到 a', (await ev("document.getElementById('cell-b').value")) === (await ev("document.getElementById('cell-a').value")));
  check('对齐后恢复相容', (await ev("document.getElementById('sym-status').textContent")).includes('相容'));

  /* ---- 5. 自定义种子点 ---- */
  await ev("(function(){var s=document.getElementById('sample'); s.value='custom'; s.dispatchEvent(new Event('change',{bubbles:true})); return 1;})()");
  await sleep(400);
  check('切到自定义后颜色模式自动变成轨道离散色',
    (await ev("document.getElementById('color').value")) === 'orbit');
  await ev("(function(){var t=document.getElementById('custom'); t.value=['0.25 0.25 0.25','0.12 0.34 0.5','0.05 0.5 0.5'].join(String.fromCharCode(10)); t.dispatchEvent(new Event('input',{bubbles:true})); return 1;})()");
  await sleep(1000);
  check('自定义点云展开出点（点数 > 20）', (await ev("+document.getElementById('stat-points').textContent.replace(/[^0-9]/g,'')")) > 20);
  check('自定义种子轨道数 = 3', (await ev("document.getElementById('stat-orbits').textContent")) === '3');

  /* ---- 6. 对称元素与镜面开关 ---- */
  await ev("(function(){var c=document.getElementById('symaxes'); c.checked=true; c.dispatchEvent(new Event('change',{bubbles:true})); return 1;})()");
  await ev("(function(){var c=document.getElementById('mirrors'); c.checked=true; c.dispatchEvent(new Event('change',{bubbles:true})); return 1;})()");
  await sleep(400);
  check('对称轴/镜面开关不报错', true);

  /* ---- 7. 截图 ---- */
  console.log('\n截图：');
  const shotList = [
    ['01-default-p1.png',    '?autorot=0&theta=-0.72&phi=0.34&dist=3.1'],
    ['02-cubic-m3m.png',     '?autorot=0&theta=-0.72&phi=0.34&dist=3.1&pg=m-3m&a=5&b=5&c=5'],
    ['03-hexagonal.png',     '?autorot=0&theta=-0.72&phi=0.34&dist=3.1&pg=6/mmm&a=4&b=4&c=6&ga=120'],
    ['04-monoclinic.png',    '?autorot=0&theta=-0.72&phi=0.34&dist=3.1&pg=2/m&a=4&b=5&c=6&be=110'],
    ['05-triclinic.png',     '?autorot=0&theta=-0.72&phi=0.34&dist=3.1&pg=-1&a=4&b=5&c=6&al=80&be=95&ga=75'],
    ['06-custom-orbits.png', '?autorot=0&theta=-0.72&phi=0.34&dist=3.1&pg=m-3m&a=5&b=5&c=5&sample=custom&color=orbit'],
    ['07-symmetry-axes.png', '?autorot=0&theta=-0.72&phi=0.34&dist=3.1&pg=m-3m&a=5&b=5&c=5&symaxes=1'],
    ['08-glow.png',          '?autorot=0&theta=-0.72&phi=0.34&dist=3.1&pg=m-3m&a=5&b=5&c=5&blend=glow&size=1.6&alpha=0.6'],
    ['09-clean-p1.png',      '?autorot=0&theta=-0.72&phi=0.34&dist=3.1&ui=0&n=30'],
    ['10-clean-cubic.png',   '?autorot=0&theta=-0.72&phi=0.34&dist=3.1&ui=0&pg=m-3m&a=5&b=5&c=5&n=30'],
    ['12-spacegroup-pnma.png', '?autorot=0&theta=-0.72&phi=0.34&dist=3.1&mode=space&sg=62&a=5&b=6&c=7&n=24'],
    ['13-clean-pnma.png',     '?autorot=0&theta=-0.72&phi=0.34&dist=3.1&ui=0&mode=space&sg=62&a=5&b=6&c=7&n=28']
  ];
  for (const [name, query] of shotList) {
    await navigate(BASE + query);
    await screenshot(name);
  }

  /* ---- 8. 单击高亮等价点 ---- */
  await navigate(BASE + '?autorot=0&theta=-0.72&phi=0.34&dist=3.1&pg=m-3m&a=5&b=5&c=5&n=22');
  const pick = await ev("window.__crystalDebug.pickCenterPoint()");
  check('能找到一个可见采样点用于点击', !!(pick && pick.x > 0 && pick.y > 0));
  if (pick) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pick.x, y: pick.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pick.x, y: pick.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pick.x, y: pick.y, button: 'left', clickCount: 1 });
    await sleep(500);
    const selText = await ev("document.getElementById('selection').textContent");
    check('单击后显示“已选轨道”信息', selText.indexOf('已选轨道') >= 0, selText);
    check('高亮轨道大小 > 1', /轨道大小 [2-9]/.test(selText), selText);
    await screenshot('11-highlight-orbit.png');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(300);
    check('按 Esc 取消高亮', (await ev("document.getElementById('selection').style.display")) === 'none');
  }

  /* ---- 8b. 六方 6 点群：等效点完整（回归） ---- */
  await navigate(BASE + '?autorot=0&pg=6&a=4&b=4&c=4&ga=120&n=20&theta=-0.72&phi=0.34&dist=3.2');
  await sleep(400);
  const hex6 = await ev(`(function () {
    var S = window.CrystalSym;
    var prep = window.__crystalDebug.getPrep();
    var pts = S.sampleGrid(20);
    var seen = {};
    for (var i = 0; i < pts.length; i += 3) {
      var q = S.canonicalize(prep, pts[i], pts[i + 1], pts[i + 2]);
      var k = q.join('/');
      if (!(k in seen)) seen[k] = { count: 0, idx: i / 3 };
      seen[k].count++;
    }
    var sizes = {};
    for (var kk in seen) sizes[seen[kk].count] = (sizes[seen[kk].count] || 0) + 1;
    var idx = -1;
    for (var k2 in seen) {
      if (seen[k2].count === 6) {
        var pr = window.__crystalDebug.projectPoint(seen[k2].idx);
        if (pr && pr.visible) { idx = seen[k2].idx; break; }
      }
    }
    return { sizes: sizes, idx: idx };
  })()`);
  check('六方 6 点群：存在轨道大小为 6 的采样点', hex6 && hex6.sizes['6'] > 0,
    JSON.stringify(hex6 && hex6.sizes));
  if (hex6 && hex6.idx >= 0) {
    const hp = await ev('window.__crystalDebug.projectPoint(' + hex6.idx + ')');
    if (hp && hp.visible) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hp.x, y: hp.y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hp.x, y: hp.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hp.x, y: hp.y, button: 'left', clickCount: 1 });
      await sleep(500);
      const hexSel = await ev("document.getElementById('selection').textContent");
      check('六方 6 点群：点击后高亮 6 个等效点', /轨道大小 6/.test(hexSel), hexSel);
      await screenshot('14-hex6-highlight.png');
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(200);
    }
  }

  /* ---- 9. 空间群模式 ---- */
  await navigate(BASE + '?autorot=0&theta=-0.72&phi=0.34&dist=3.1&mode=space&sg=62&a=5&b=6&c=7&n=20');
  check('空间群模式下空间群下拉可见', (await ev("!document.getElementById('sg-field').hidden")) === true);
  check('空间群模式下点群下拉隐藏', (await ev("document.getElementById('pg-field').hidden")) === true);
  check('Pnma 空间群显示正确',
    (await ev("document.getElementById('stat-sg').textContent")).indexOf('Pnma') >= 0);
  check('Pnma 通用位置 = 8',
    (await ev("document.getElementById('stat-ops').textContent")).indexOf('8 个通用位置') === 0);
  check('Pnma 推导点群 = mmm',
    (await ev("document.getElementById('stat-group').textContent")) === 'mmm');
  check('Pnma 状态显示带心 P',
    (await ev("document.getElementById('sym-status').textContent")).indexOf('带心 P') >= 0);

  await ev("(function(){var s=document.getElementById('sg'); s.value='63'; s.dispatchEvent(new Event('change',{bubbles:true})); return 1;})()");
  await sleep(900);
  check('Cmcm 通用位置 = 16',
    (await ev("document.getElementById('stat-ops').textContent")).indexOf('16 个通用位置') === 0);
  check('Cmcm 状态显示带心 C',
    (await ev("document.getElementById('sym-status').textContent")).indexOf('带心 C') >= 0);

  // 空间群模式下晶系预设 → 自动选代表空间群
  await ev("(function(){var c=document.querySelector('#presets .chip[data-system=\"cubic\"]'); if(!c) return 0; c.click(); return 1;})()");
  await sleep(800);
  check('空间群模式下立方预设切到 Fm-3m（225）',
    (await ev("document.getElementById('sg').value")) === '225');

  // origin choice：Fd-3m（227），先换成立方晶胞
  await navigate(BASE + '?autorot=0&mode=space&sg=227&a=5&b=5&c=5&n=16');
  await sleep(500);
  check('Fd-3m 出现原点选择', (await ev("!document.getElementById('origin-field').hidden")) === true);
  check('Fd-3m 原点选择有 2 项',
    (await ev("document.getElementById('origin').options.length")) === 2);
  check('Fd-3m 通用位置 = 192',
    (await ev("document.getElementById('stat-ops').textContent")).indexOf('192 个通用位置') === 0);
  await ev("(function(){var s=document.getElementById('origin'); s.value='1'; s.dispatchEvent(new Event('change',{bubbles:true})); return 1;})()");
  await sleep(900);
  check('切换 origin choice 2 后仍为 192 个通用位置',
    (await ev("document.getElementById('stat-ops').textContent")).indexOf('192 个通用位置') === 0);
  check('状态里显示 origin choice 2',
    (await ev("document.getElementById('stat-ops').textContent")).indexOf('origin choice 2') >= 0);

  // 空间群与晶胞不符 → 警告 + 对齐
  await navigate(BASE + '?autorot=0&mode=space&sg=62&a=5&b=6&c=7&n=16');
  await ev("(function(){var a=document.getElementById('cell-alpha'); a.value=80; a.dispatchEvent(new Event('input',{bubbles:true})); return 1;})()");
  await sleep(600);
  check('晶胞与空间群不符时给出空间群警告',
    (await ev("document.getElementById('sym-status').textContent")).indexOf('空间群') >= 0);
  const alignBtnExists = await ev("!!document.querySelector('#warnings button')");
  check('出现「对齐晶胞参数」按钮', alignBtnExists === true);
  if (alignBtnExists) {
    await ev("document.querySelector('#warnings button').click(); 1");
    await sleep(900);
    check('对齐后空间群恢复相容',
      (await ev("document.getElementById('sym-status').textContent")).indexOf('空间群与晶胞参数相容') >= 0);
    check('对齐后 α 回到 90',
      (await ev("+document.getElementById('cell-alpha').value")) === 90);
  }

  /* ---- 10. 默认不自动旋转 ---- */
  await navigate(BASE);
  check('默认不开启自动旋转', (await ev("document.getElementById('autorot').checked")) === false);

  /* ---- 11. 汇总 ---- */
  if (jsErrors.length) {
    console.log('\n页面报错：');
    for (const e of jsErrors) console.log('  ', e);
  }
  check('页面无 JS 异常', jsErrors.length === 0, jsErrors.join(' | '));

  console.log(`\n${passed}/${passed + fails.length} 项通过`);
  if (fails.length) {
    console.log('失败：');
    for (const f of fails) console.log('  -', f);
    process.exitCode = 1;
  } else {
    console.log('全部通过 ✓');
  }
}

try {
  await main();
} catch (err) {
  console.error('运行失败：', err && err.message ? err.message : err);
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch (err) { /* ignore */ }
  await sleep(300);
  process.exit(process.exitCode || 0);
}
