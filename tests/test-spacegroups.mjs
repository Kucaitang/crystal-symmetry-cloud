/**
 * 空间群数据自检（Node）
 *   node tests/test-spacegroups.mjs
 */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const S = require('../symmetry.js');
const SG = require('../spacegroups.js');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { failures.push({ name, err }); console.error(`✗ ${name}\n    ${err.message}`); }
}

/* ---------------- 工具 ---------------- */
function decode(variant) {
  const ops = [];
  const d = variant.ops;
  for (let i = 0; i < d.length; i += 12) {
    ops.push({
      R: [[d[i], d[i + 1], d[i + 2]], [d[i + 3], d[i + 4], d[i + 5]], [d[i + 6], d[i + 7], d[i + 8]]],
      t: [d[i + 9] / 12, d[i + 10] / 12, d[i + 11] / 12]
    });
  }
  return ops;
}
function key(R, t) {
  const s = (x) => ((Math.round(x * 12) % 12) + 12) % 12;
  return R.map((r) => r.join(',')).join(';') + '|' + s(t[0]) + ',' + s(t[1]) + ',' + s(t[2]);
}
function compose(a, b) {
  const R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    R[i][j] = a.R[i][0] * b.R[0][j] + a.R[i][1] * b.R[1][j] + a.R[i][2] * b.R[2][j];
  const t = [0, 0, 0];
  for (let i = 0; i < 3; i++)
    t[i] = a.R[i][0] * b.t[0] + a.R[i][1] * b.t[1] + a.R[i][2] * b.t[2] + a.t[i];
  return { R, t };
}
function orbitSize(ops, p) {
  const seen = new Set();
  for (const o of ops) {
    const q = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      q[i] = o.R[i][0] * p[0] + o.R[i][1] * p[1] + o.R[i][2] * p[2] + o.t[i];
      q[i] -= Math.floor(q[i]);
    }
    seen.add(q.map((x) => Math.round(x * 1e6) % 1e6).join(','));
  }
  return seen.size;
}

/* ---------------- 1. 数据完整性 ---------------- */
test('230 个空间群齐全，编号 1..230', () => {
  assert.equal(SG.groups.length, 230);
  for (let i = 0; i < 230; i++) assert.equal(SG.groups[i].n, i + 1);
  assert.equal(Object.keys(SG.byNumber).length, 230);
});

test('每个空间群的点群/晶系/带心字段合法', () => {
  for (const g of SG.groups) {
    assert.ok(S.POINT_GROUP_MAP[g.pg], `#${g.n} pg ${g.pg}`);
    assert.ok(S.CENTERINGS[g.centering], `#${g.n} centering ${g.centering}`);
    assert.ok(S.SYSTEM_SAMPLES[g.system], `#${g.n} system ${g.system}`);
    assert.ok(g.hm && g.full, `#${g.n} symbols`);
    assert.ok(g.variants.length >= 1);
  }
});

test('每个操作数 = 点群阶 × 带心数', () => {
  for (const g of SG.groups) {
    const expected = S.POINT_GROUP_MAP[g.pg].order * S.CENTERINGS[g.centering].length;
    for (const v of g.variants) {
      assert.equal(v.ops.length / 12, expected, `#${g.n} ${g.hm} variants ${v.ops.length / 12} vs ${expected}`);
    }
  }
});

test('旋转矩阵为整数、det=±1，且保持标准晶胞度规', () => {
  for (const g of SG.groups) {
    const cell = S.SYSTEM_SAMPLES[g.system];
    const G = S.metricTensor(S.cellBasis(cell));
    for (const v of g.variants) {
      for (const o of decode(v)) {
        for (const row of o.R) for (const x of row) assert.equal(x, Math.round(x));
        assert.equal(Math.abs(Math.abs(S.det3(o.R)) - 1), 0);
        assert.ok(S.metricPreserved(o.R, G, 1e-4), `#${g.n} metric`);
      }
    }
  }
});

test('每个空间群的操作对乘法封闭', () => {
  for (const g of SG.groups) {
    for (const v of g.variants) {
      const ops = decode(v);
      const keys = new Set(ops.map((o) => key(o.R, o.t)));
      for (const a of ops) for (const b of ops) {
        const c = compose(a, b);
        assert.ok(keys.has(key(c.R, c.t)), `#${g.n} closure`);
      }
    }
  }
});

test('24 个群有 origin choice 1/2，其余单一标准设置', () => {
  const two = SG.groups.filter((g) => g.variants.length === 2);
  const one = SG.groups.filter((g) => g.variants.length === 1);
  assert.equal(two.length, 24);
  assert.equal(one.length, 206);
  for (const g of two) {
    assert.deepEqual(g.variants.map((v) => v.choice).sort(), ['1', '2']);
  }
});

/* ---------------- 2. 符号与别名 ---------------- */
test('别名解析：Pnma=62, Cmcm=63', () => {
  assert.equal(SG.aliases.pnma, 62);
  assert.equal(SG.aliases.cmcm, 63);
  assert.equal(SG.aliases['p2_1/c'.replace('_', '')], 14);
});

test('短符号与全符号都能查到编号', () => {
  for (const g of SG.groups) {
    const norm = (s) => s.toLowerCase().replace(/[₀-₉]/g, (c) => '₀₁₂₃₄₅₆₇₈₉'.indexOf(c)).replace(/[\s_]/g, '');
    assert.equal(SG.aliases[norm(g.hm)], g.n, `#${g.n} hm alias`);
    assert.equal(SG.aliases[norm(g.full)], g.n, `#${g.n} full alias`);
  }
});

test('显示符号不含下划线（已转成 Unicode 下标）', () => {
  for (const g of SG.groups) assert.equal(g.hm.indexOf('_'), -1, g.hm);
});

/* ---------------- 3. 已知群的基本事实 ---------------- */
test('Pnma（62）：8 个通用位置，全符号 P 2₁/n 2₁/m 2₁/a', () => {
  const g = SG.byNumber[62];
  assert.equal(g.hm, 'Pnma');
  assert.equal(g.pg, 'mmm');
  assert.equal(g.variants[0].ops.length / 12, 8);
  assert.equal(g.full, 'P 2_1/n 2_1/m 2_1/a');
});

test('Cmcm（63）：16 个通用位置（8 × C 带心）', () => {
  const g = SG.byNumber[63];
  assert.equal(g.hm, 'Cmcm');
  assert.equal(g.pg, 'mmm');
  assert.equal(g.variants[0].ops.length / 12, 16);
});

test('对称群（symmorphic）恰好 73 个', () => {
  let count = 0;
  for (const g of SG.groups) {
    const ops = decode(g.variants[0]);
    const centering = S.CENTERINGS[g.centering].map((t) => t.map((x) => Math.round(x * 12) % 12).join(','));
    const symmorphic = ops.every((o) =>
      centering.includes(o.t.map((x) => Math.round(x * 12) % 12).join(',')));
    if (symmorphic) count++;
  }
  assert.equal(count, 73);
});

test('无歧义取向的对称群与「点群 × 带心」操作集合完全一致', () => {
  // 这些点群在标准设置下取向唯一，可直接比对操作集合
  const whitelist = [1, 2, 10, 47, 65, 83, 99, 123, 139, 166, 191, 221, 225];
  for (const n of whitelist) {
    const g = SG.byNumber[n];
    const ops = decode(g.variants[0]);
    const cell = S.SYSTEM_SAMPLES[g.system];
    const pg = S.buildPointGroup(g.pg, cell);
    const expected = S.prepareOperations(pg.matrices, g.centering);
    const expectedKeys = new Set(expected.ops.map((o) => key(o.R, o.t)));
    const actualKeys = new Set(ops.map((o) => key(o.R, o.t)));
    assert.equal(actualKeys.size, expectedKeys.size, `#${n} size`);
    for (const k of actualKeys) assert.ok(expectedKeys.has(k), `#${n} ops differ`);
  }
});

/* ---------------- 4. Wyckoff 特殊位置（按 ITA 已知多重度核对） ---------------- */
test('Pnma 特殊位置：4a/4b/4c 轨道大小 4，一般位置 8', () => {
  const ops = decode(SG.byNumber[62].variants[0]);
  assert.equal(orbitSize(ops, [0, 0, 0]), 4);          // 4a
  assert.equal(orbitSize(ops, [0, 0, 0.5]), 4);        // 4b
  assert.equal(orbitSize(ops, [0.1, 0.25, 0.3]), 4);   // 4c
  assert.equal(orbitSize(ops, [0.1, 0.2, 0.3]), 8);    // 8d
});

test('Cmcm 特殊位置：4a/4b/4c 为 4，8d~8g 为 8，一般位置 16', () => {
  const ops = decode(SG.byNumber[63].variants[0]);
  assert.equal(orbitSize(ops, [0, 0, 0]), 4);            // 4a
  assert.equal(orbitSize(ops, [0, 0, 0.5]), 4);          // 4b
  assert.equal(orbitSize(ops, [0, 0.3, 0.25]), 4);       // 4c
  assert.equal(orbitSize(ops, [0.25, 0.25, 0]), 8);      // 8d
  assert.equal(orbitSize(ops, [0.1, 0, 0]), 8);          // 8e
  assert.equal(orbitSize(ops, [0, 0.2, 0.3]), 8);        // 8f
  assert.equal(orbitSize(ops, [0.1, 0.2, 0.25]), 8);     // 8g
  assert.equal(orbitSize(ops, [0.1, 0.2, 0.3]), 16);     // 16h
});

test('Pm-3m：原点/体心轨道为 1，面心为 3', () => {
  const ops = decode(SG.byNumber[221].variants[0]);
  assert.equal(orbitSize(ops, [0, 0, 0]), 1);
  assert.equal(orbitSize(ops, [0.5, 0.5, 0.5]), 1);
  assert.equal(orbitSize(ops, [0.5, 0.5, 0]), 3);
});

test('Fm-3m：4a/4b 为 4，8c 为 8', () => {
  const ops = decode(SG.byNumber[225].variants[0]);
  assert.equal(orbitSize(ops, [0, 0, 0]), 4);
  assert.equal(orbitSize(ops, [0.5, 0.5, 0.5]), 4);
  assert.equal(orbitSize(ops, [0.25, 0.25, 0.25]), 8);
});

test('P6/mmm：1a/1b 为 1，2c 为 2', () => {
  const ops = decode(SG.byNumber[191].variants[0]);
  assert.equal(orbitSize(ops, [0, 0, 0]), 1);
  assert.equal(orbitSize(ops, [0, 0, 0.5]), 1);
  assert.equal(orbitSize(ops, [1 / 3, 2 / 3, 0]), 2);
});

/* ---------------- 5. 轨道不变量（含非共形群） ---------------- */
test('非共形空间群：同轨道的点必得同一基本域代表点', () => {
  for (const num of [62, 63, 74, 167, 194, 227]) {
    const g = SG.byNumber[num];
    const ops = decode(g.variants[0]);
    const prep = S.prepareOperationsFromList(ops);
    for (let s = 0; s < 40; s++) {
      const p = [Math.random(), Math.random(), Math.random()];
      const base = S.canonicalKey(S.canonicalize(prep, p[0], p[1], p[2]).slice());
      for (const o of ops) {
        const q = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
          q[i] = o.R[i][0] * p[0] + o.R[i][1] * p[1] + o.R[i][2] * p[2] + o.t[i];
        }
        const k = S.canonicalKey(S.canonicalize(prep, q[0], q[1], q[2]).slice());
        assert.equal(k, base, `#${num} orbit invariant`);
      }
    }
  }
});

test('双 origin choice：两个变体操作数相同、操作集合不同、各自封闭', () => {
  for (const g of SG.groups.filter((x) => x.variants.length === 2)) {
    const a = decode(g.variants[0]);
    const b = decode(g.variants[1]);
    assert.equal(a.length, b.length, `#${g.n} count`);
    const ka = new Set(a.map((o) => key(o.R, o.t)));
    const kb = new Set(b.map((o) => key(o.R, o.t)));
    assert.notDeepEqual([...ka].sort(), [...kb].sort(), `#${g.n} origin choices identical`);
  }
});

/* ---------------- 汇总 ---------------- */
const total = passed + failures.length;
console.log(`\n${passed}/${total} 项通过`);
if (failures.length) {
  for (const f of failures) console.log('  -', f.name);
  process.exit(1);
} else {
  console.log('全部通过 ✓');
}
