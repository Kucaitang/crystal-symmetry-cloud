/**
 * 三维颜色码自检（Node）
 *   node tests/test-color.mjs
 */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const C = require('../color.js');

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push({ name, err });
    console.error(`✗ ${name}\n    ${err.message}`);
  }
}

/* 采样一组 (u,v,w) */
const N = 10;
const samples = [];
const rgb = [];
for (let i = 0; i < N; i++) {
  for (let j = 0; j < N; j++) {
    for (let k = 0; k < N; k++) {
      const u = i / (N - 1), v = j / (N - 1), w = k / (N - 1);
      const c = C.colorCode(u, v, w);
      samples.push([u, v, w]);
      rgb.push(c);
    }
  }
}

test('颜色全部落在 sRGB 色域内（不裁切）', () => {
  for (const c of rgb) {
    for (const x of c) {
      assert.ok(x >= -1e-6 && x <= 1 + 1e-6, `通道越界 ${x}`);
    }
  }
});

test('亮度下限：所有颜色 L* ≥ L_MIN - 1.5（不会过暗）', () => {
  let minL = Infinity;
  for (const c of rgb) minL = Math.min(minL, C.rgbToLab(c)[0]);
  assert.ok(minL >= C.L_MIN - 1.5, `最低 L* = ${minL}`);
});

test('亮度上限：所有颜色 L* ≤ L_MAX + 1.5', () => {
  let maxL = -Infinity;
  for (const c of rgb) maxL = Math.max(maxL, C.rgbToLab(c)[0]);
  assert.ok(maxL <= C.L_MAX + 1.5, `最高 L* = ${maxL}`);
});

test('同一输入 → 同一颜色（严格相等）', () => {
  for (let t = 0; t < 30; t++) {
    const u = Math.random(), v = Math.random(), w = Math.random();
    const a = C.colorCode(u, v, w);
    const b = C.colorCode(u, v, w);
    assert.deepEqual(a, b);
  }
});

test('不同输入（网格采样）→ 不同颜色（8bit 量化后仍唯一）', () => {
  const set = new Set();
  for (const c of rgb) {
    set.add(c.map((x) => Math.round(x * 255)).join(','));
  }
  assert.equal(set.size, rgb.length, `唯一色 ${set.size} / ${rgb.length}`);
});

test('距离单调：代表点距离越大，颜色差中位数越大', () => {
  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }
  const rand = rng(2024);
  const bins = [[0, 0.1], [0.1, 0.2], [0.2, 0.35], [0.35, 0.5], [0.5, 0.7], [0.7, 0.9], [0.9, 1.3]];
  const acc = bins.map(() => []);
  for (let t = 0; t < 30000; t++) {
    const a = (rand() * rgb.length) | 0;
    const b = (rand() * rgb.length) | 0;
    if (a === b) continue;
    const d = Math.hypot(
      samples[a][0] - samples[b][0],
      samples[a][1] - samples[b][1],
      samples[a][2] - samples[b][2]
    );
    for (let bi = 0; bi < bins.length; bi++) {
      if (d >= bins[bi][0] && d < bins[bi][1]) {
        acc[bi].push(C.deltaE76(rgb[a], rgb[b]));
        break;
      }
    }
  }
  const medians = [];
  for (const arr of acc) {
    if (arr.length < 30) continue; // 样本太少的档位跳过
    arr.sort((x, y) => x - y);
    medians.push(arr[Math.floor(arr.length / 2)]);
  }
  assert.ok(medians.length >= 5, `有效分档太少：${medians.length}`);
  for (let bi = 1; bi < medians.length; bi++) {
    assert.ok(medians[bi] > medians[bi - 1], `第 ${bi} 档中位 ΔE 没有增大：${medians}`);
  }
  // 最远一档的颜色差应该显著（清晰可辨）
  assert.ok(medians[medians.length - 1] > 50, `最远档中位 ΔE 太小：${medians[medians.length - 1]}`);
});

test('中近距离颜色差大于 JND（相邻太近仍连续，但不至于完全同色）', () => {
  const a = C.colorCode(0.5, 0.2, 0.5);
  const b = C.colorCode(0.5, 0.27, 0.5);
  assert.ok(C.deltaE76(a, b) > 2.3, 'Δ(u)=0 时颜色变化过小');
});

const total = passed + failures.length;
console.log(`\n${passed}/${total} 项通过`);
if (failures.length) {
  for (const f of failures) console.log('  -', f.name);
  process.exit(1);
} else {
  console.log('全部通过 ✓');
}
