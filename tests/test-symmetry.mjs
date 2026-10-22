/**
 * 对称性核心自检（Node）
 *   node tests/test-symmetry.mjs
 */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const S = require('../symmetry.js');

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

const CELLS = {
  triclinic:    { a: 4.2, b: 5.1, c: 6.3, alpha: 78, beta: 83, gamma: 71 },
  monoclinic:   { a: 5.0, b: 6.4, c: 7.2, alpha: 90, beta: 104, gamma: 90 },
  orthorhombic: { a: 5.0, b: 6.5, c: 8.0, alpha: 90, beta: 90, gamma: 90 },
  tetragonal:   { a: 5.0, b: 5.0, c: 7.5, alpha: 90, beta: 90, gamma: 90 },
  trigonal:     { a: 5.0, b: 5.0, c: 8.0, alpha: 90, beta: 90, gamma: 120 },
  hexagonal:    { a: 5.0, b: 5.0, c: 8.0, alpha: 90, beta: 90, gamma: 120 },
  cubic:        { a: 5.0, b: 5.0, c: 5.0, alpha: 90, beta: 90, gamma: 90 }
};

/* ---------------- 1. 晶胞几何 ---------------- */
test('晶胞基矢：立方 a=5 的体积应为 125', () => {
  assert.ok(Math.abs(S.cellVolume(CELLS.cubic) - 125) < 1e-9);
});

test('晶胞基矢：六方 a=b=5, c=8 体积应为 5*5*8*sin120', () => {
  const v = S.cellVolume(CELLS.hexagonal);
  const want = 25 * 8 * Math.sin(120 * Math.PI / 180);
  assert.ok(Math.abs(v - want) < 1e-9, `${v} vs ${want}`);
});

test('晶胞基矢：非法参数返回 null', () => {
  assert.equal(S.cellBasis({ a: 0, b: 1, c: 1, alpha: 90, beta: 90, gamma: 90 }), null);
  assert.equal(S.cellBasis({ a: 1, b: 1, c: 1, alpha: 90, beta: 90, gamma: 180 }), null);
  assert.equal(S.cellBasis({ a: 1, b: 1, c: 1, alpha: 170, beta: 170, gamma: 170 }), null);
});

/* ---------------- 2. 32 点群：群阶与度规 ---------------- */
const EXPECTED = {
  '1': 1, '-1': 2, '2': 2, 'm': 2, '2/m': 4,
  '222': 4, 'mm2': 4, 'mmm': 8,
  '4': 4, '-4': 4, '4/m': 8, '422': 8, '4mm': 8, '-42m': 8, '4/mmm': 16,
  '3': 3, '-3': 6, '32': 6, '3m': 6, '-3m': 12,
  '6': 6, '-6': 6, '6/m': 12, '622': 12, '6mm': 12, '-6m2': 12, '6/mmm': 24,
  '23': 12, 'm-3': 24, '432': 24, '-43m': 24, 'm-3m': 48
};

assert.equal(S.POINT_GROUPS.length, 32, '点群表应有 32 项');

for (const def of S.POINT_GROUPS) {
  test(`点群 ${def.hm} 应与 ${def.system} 晶胞匹配且群阶 = ${EXPECTED[def.hm]}`, () => {
    assert.equal(def.order, EXPECTED[def.hm]);
    const g = S.buildPointGroup(def.hm, CELLS[def.system]);
    assert.ok(g.ok, g.reason || '构建失败');
    assert.equal(g.order, EXPECTED[def.hm]);
    assert.equal(g.matrices.length, def.order);
    // 每个矩阵元素都是整数、det = ±1，且保持度规
    const B = S.cellBasis(CELLS[def.system]);
    const G = S.metricTensor(B);
    for (const R of g.matrices) {
      for (const row of R) for (const v of row) assert.equal(v, Math.round(v));
      assert.ok(Math.abs(Math.abs(S.det3(R)) - 1) < 1e-12);
      assert.ok(S.metricPreserved(R, G, 1e-6 * 100));
    }
  });
}

test('点群与晶胞不符时应明确报错', () => {
  const bad1 = S.buildPointGroup('4/mmm', { a: 5, b: 6, c: 7, alpha: 90, beta: 90, gamma: 90 });
  assert.equal(bad1.ok, false, '四方点群不应匹配正交晶胞');
  const bad2 = S.buildPointGroup('m-3m', { a: 5, b: 5, c: 7, alpha: 90, beta: 90, gamma: 90 });
  assert.equal(bad2.ok, false, '立方点群不应匹配四方晶胞');
  const bad3 = S.buildPointGroup('23', { a: 5, b: 5, c: 5, alpha: 90, beta: 90, gamma: 120 });
  assert.equal(bad3.ok, false, '立方点群不应匹配六方晶胞');
});

/* ---------------- 3. 闭包性质 ---------------- */
for (const def of S.POINT_GROUPS) {
  test(`点群 ${def.hm} 的矩阵集合对乘法封闭`, () => {
    const g = S.buildPointGroup(def.hm, CELLS[def.system]);
    assert.ok(g.ok);
    const keys = new Set(g.matrices.map(S.matKeyInt));
    for (const A of g.matrices) {
      for (const B of g.matrices) {
        const P = S.matMul(A, B);
        assert.ok(keys.has(S.matKeyInt(P)), `${def.hm}: 乘积不在群内`);
      }
    }
    // 逆元也在群内（有限群，幂次即可）
    for (const A of g.matrices) {
      let M = A, found = false;
      for (let k = 0; k < 48; k++) {
        if (S.matKeyInt(M) === S.matKeyInt(S.IDENT)) { found = true; break; }
        M = S.matMul(M, A);
      }
      assert.ok(found, `${def.hm}: 逆元缺失`);
    }
  });
}

/* ---------------- 4. 点阵全对称（自动检测） ---------------- */
const HOLO_EXPECT = [
  ['triclinic', 'P', 2, '-1'],
  ['monoclinic', 'P', 4, '2/m'],
  ['orthorhombic', 'P', 8, 'mmm'],
  ['orthorhombic', 'C', 8, 'mmm'],
  ['orthorhombic', 'F', 8, 'mmm'],
  ['orthorhombic', 'I', 8, 'mmm'],
  ['tetragonal', 'P', 16, '4/mmm'],
  ['tetragonal', 'I', 16, '4/mmm'],
  ['hexagonal', 'P', 24, '6/mmm'],
  ['trigonal', 'P', 24, '6/mmm'],
  ['trigonal', 'R', 12, '-3m'],
  ['cubic', 'P', 48, 'm-3m'],
  ['cubic', 'I', 48, 'm-3m'],
  ['cubic', 'F', 48, 'm-3m']
];
for (const [system, centering, order, hm] of HOLO_EXPECT) {
  test(`自动最大对称：${system}/${centering} → ${hm}（${order}）`, () => {
    const info = S.holohedryInfo(CELLS[system], centering);
    assert.ok(info.ok);
    assert.equal(info.order, order);
    assert.equal(info.hm, hm);
  });
}

/* ---------------- 5. 轨道不变量 ---------------- */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

for (const def of S.POINT_GROUPS) {
  test(`点群 ${def.hm}：同轨道点必得同一基本域代表点`, () => {
    const g = S.buildPointGroup(def.hm, CELLS[def.system]);
    assert.ok(g.ok);
    const centering = S.CENTERING_BY_SYSTEM[def.system][0];
    const prep = S.prepareOperations(g.matrices, centering);
    const rand = rng(777 + def.order);
    for (let s = 0; s < 60; s++) {
      const p = [rand(), rand(), rand()];
      const base = S.canonicalKey(S.canonicalize(prep, p[0], p[1], p[2]).slice());
      for (const op of prep.ops) {
        const q = [
          op.R[0][0] * p[0] + op.R[0][1] * p[1] + op.R[0][2] * p[2] + op.t[0],
          op.R[1][0] * p[0] + op.R[1][1] * p[1] + op.R[1][2] * p[2] + op.t[1],
          op.R[2][0] * p[0] + op.R[2][1] * p[1] + op.R[2][2] * p[2] + op.t[2]
        ];
        const key = S.canonicalKey(S.canonicalize(prep, q[0], q[1], q[2]).slice());
        assert.equal(key, base, `${def.hm}: 轨道不变量被破坏`);
      }
    }
  });
}

for (const def of S.POINT_GROUPS) {
  test(`点群 ${def.hm}：轨道大小整除群阶×带心数`, () => {
    const g = S.buildPointGroup(def.hm, CELLS[def.system]);
    const centering = S.CENTERING_BY_SYSTEM[def.system][0];
    const prep = S.prepareOperations(g.matrices, centering);
    const total = g.order * S.CENTERINGS[centering].length;
    const rand = rng(4242);
    for (let s = 0; s < 40; s++) {
      const n = S.orbitOf(prep, rand(), rand(), rand()).length;
      assert.equal(total % n, 0, `${def.hm}: 轨道大小 ${n} 不整除 ${total}`);
    }
  });
}

test('P1：基本域代表点就是点本身（模 1）', () => {
  const g = S.buildPointGroup('1', CELLS.cubic);
  const prep = S.prepareOperations(g.matrices, 'P');
  const q = S.canonicalize(prep, 0.1234, 0.5678, 0.9);
  assert.deepEqual([...q], [123400, 567800, 900000]);
});

test('m-3m：特殊位置轨道大小吻合（模周期平移后）', () => {
  const g = S.buildPointGroup('m-3m', CELLS.cubic);
  const prep = S.prepareOperations(g.matrices, 'P');
  assert.equal(S.orbitOf(prep, 0, 0, 0).length, 1, '原点');
  assert.equal(S.orbitOf(prep, 0.5, 0.5, 0.5).length, 1, '体心');
  assert.equal(S.orbitOf(prep, 0.5, 0, 0).length, 3, '面心（±1/2 等价）');
  assert.equal(S.orbitOf(prep, 0.25, 0.25, 0.25).length, 8, '体对角线上 1/4 点');
  assert.equal(S.orbitOf(prep, 0.5, 0.5, 0).length, 3, '棱心（±1/2 等价）');
});

test('m-3m + F 带心：原点的轨道应为 4 个点', () => {
  const g = S.buildPointGroup('m-3m', CELLS.cubic);
  const prep = S.prepareOperations(g.matrices, 'F');
  const orb = S.orbitOf(prep, 0, 0, 0);
  assert.equal(orb.length, 4);
});

test('不同一般位置应得到不同代表点', () => {
  const g = S.buildPointGroup('m-3m', CELLS.cubic);
  const prep = S.prepareOperations(g.matrices, 'P');
  const rand = rng(99);
  const seen = new Set();
  let n = 0;
  for (let i = 0; i < 500; i++) {
    const key = S.canonicalKey(S.canonicalize(prep, rand(), rand(), rand()).slice());
    if (seen.has(key)) { n++; } else seen.add(key);
  }
  assert.ok(n < 3, `一般位置出现过多碰撞：${n}`);
});

/* ---------------- 6. 群元素分类 ---------------- */
test('m-3m 的元素分类：恒等 1、反演 1、镜面 9、4 重轴 6、3 重轴 8、2 重轴 9、S4 6、S6 8', () => {
  const g = S.buildPointGroup('m-3m', CELLS.cubic);
  const s = S.summarizeMatrices(g.matrices);
  const get = (kind) => (s.find((x) => x.kind === kind) || { count: 0 }).count;
  assert.equal(get('identity'), 1);
  assert.equal(get('inversion'), 1);
  assert.equal(get('mirror'), 9);
  assert.equal(get('rot4'), 6);
  assert.equal(get('rot3'), 8);
  assert.equal(get('rot2'), 9);
  assert.equal(get('rotoinv4'), 6);
  assert.equal(get('rotoinv6'), 8);
  assert.equal(s.reduce((a, b) => a + b.count, 0), 48);
});

test('6/mmm 的元素分类总数应为 24', () => {
  const g = S.buildPointGroup('6/mmm', CELLS.hexagonal);
  const s = S.summarizeMatrices(g.matrices);
  assert.equal(s.reduce((a, b) => a + b.count, 0), 24);
});

/* ---------------- 7. 采样 ---------------- */
test('网格采样数量与范围正确', () => {
  const pts = S.sampleGrid(4);
  assert.equal(pts.length, 4 * 4 * 4 * 3);
  for (let i = 0; i < pts.length; i++) {
    assert.ok(pts[i] > 0 && pts[i] < 1);
  }
});

/* ---------------- 汇总 ---------------- */
const total = passed + failures.length;
console.log(`\n${passed}/${total} 项通过`);
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`);
  for (const f of failures) console.log('  -', f.name);
  process.exit(1);
} else {
  console.log('全部通过 ✓');
}
