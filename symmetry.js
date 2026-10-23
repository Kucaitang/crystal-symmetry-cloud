/*!
 * symmetry.js — 晶体学对称性核心（32 点群 + 点阵带心）
 *
 * 设计要点：
 *   1. 对称操作 R 一律表示为「分数坐标下的 3×3 整数矩阵」；
 *      生成元用几何方式（绕某方向转多少度 / 某法向镜面）给出，
 *      再通过 R_frac = B⁻¹ · R_cart · B 转成整数矩阵（B 为晶胞基矢矩阵）。
 *      这样点群与晶胞参数是否匹配可以被严格判定：
 *      若不允许，矩阵会出现非整数元素（或不能保持度规）。
 *   2. 群由生成元闭包得到，不依赖手抄矩阵表，避免抄错。
 *   3. 轨道 = {(R p + t) mod 1}，t 取点阵带心平移。
 *      基本域代表点 = 轨道中按量化后字典序最小的点（同轨道必然同代表点）。
 *
 * 无 DOM 依赖，浏览器挂 window.CrystalSym，Node 下 require() 可用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CrystalSym = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEG = Math.PI / 180;
  var TAU = Math.PI * 2;
  var IDENT = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

  /* ==================================================================
   *  1. 3×3 整数矩阵工具
   * ================================================================== */

  function matMul(A, B) {
    var C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (var i = 0; i < 3; i++) {
      for (var j = 0; j < 3; j++) {
        C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
      }
    }
    return C;
  }

  function matVec(A, v) {
    return [
      A[0][0] * v[0] + A[0][1] * v[1] + A[0][2] * v[2],
      A[1][0] * v[0] + A[1][1] * v[1] + A[1][2] * v[2],
      A[2][0] * v[0] + A[2][1] * v[1] + A[2][2] * v[2]
    ];
  }

  function matT(A) {
    return [[A[0][0], A[1][0], A[2][0]],
            [A[0][1], A[1][1], A[2][1]],
            [A[0][2], A[1][2], A[2][2]]];
  }

  function det3(A) {
    return A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1])
         - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0])
         + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
  }

  function inv3(A) {
    var a = A[0][0], b = A[0][1], c = A[0][2];
    var d = A[1][0], e = A[1][1], f = A[1][2];
    var g = A[2][0], h = A[2][1], i = A[2][2];
    var A11 = e * i - f * h, A12 = -(d * i - f * g), A13 = d * h - e * g;
    var A21 = -(b * i - c * h), A22 = a * i - c * g, A23 = -(a * h - b * g);
    var A31 = b * f - c * e, A32 = -(a * f - c * d), A33 = a * e - b * d;
    var det = a * A11 + b * A12 + c * A13;
    if (Math.abs(det) < 1e-12) return null;
    var s = 1 / det;
    return [[A11 * s, A21 * s, A31 * s],
            [A12 * s, A22 * s, A32 * s],
            [A13 * s, A23 * s, A33 * s]];
  }

  function neg3(A) {
    return [[-A[0][0], -A[0][1], -A[0][2]],
            [-A[1][0], -A[1][1], -A[1][2]],
            [-A[2][0], -A[2][1], -A[2][2]]];
  }

  function matKeyInt(A) {
    return A[0][0] + ',' + A[0][1] + ',' + A[0][2] + ';' +
           A[1][0] + ',' + A[1][1] + ',' + A[1][2] + ';' +
           A[2][0] + ',' + A[2][1] + ',' + A[2][2];
  }

  /** 把浮点矩阵舍入为整数矩阵；若偏离整数超过容差则返回 null */
  function roundMat(A) {
    var out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (var i = 0; i < 3; i++) {
      for (var j = 0; j < 3; j++) {
        var x = A[i][j];
        var r = Math.round(x);
        if (Math.abs(x - r) > 1e-6 * Math.max(1, Math.abs(x))) return null;
        out[i][j] = r;
      }
    }
    return out;
  }

  function isIdent(A) {
    return A[0][0] === 1 && A[0][1] === 0 && A[0][2] === 0 &&
           A[1][0] === 0 && A[1][1] === 1 && A[1][2] === 0 &&
           A[2][0] === 0 && A[2][1] === 0 && A[2][2] === 1;
  }

  /* ==================================================================
   *  2. 晶胞：基矢、度规、体积
   * ================================================================== */

  /**
   * 由晶胞参数构造基矢矩阵 B（列向量为 a、b、c 的笛卡尔分量）。
   * a 沿 x 轴，b 在 xy 平面内（标准约定）。
   * 参数非法时返回 null。
   */
  function cellBasis(cell) {
    var a = +cell.a, b = +cell.b, c = +cell.c;
    var al = +cell.alpha * DEG, be = +cell.beta * DEG, ga = +cell.gamma * DEG;
    if (!(a > 0 && b > 0 && c > 0)) return null;
    if (!(al > 0 && al < Math.PI && be > 0 && be < Math.PI && ga > 0 && ga < Math.PI)) return null;
    var ca = Math.cos(al), cb = Math.cos(be), cg = Math.cos(ga), sg = Math.sin(ga);
    if (sg < 1e-9) return null;
    var bx = b * cg, by = b * sg;
    var cx = c * cb;
    var cy = c * (ca - cb * cg) / sg;
    var cz2 = c * c - cx * cx - cy * cy;
    if (cz2 <= 1e-12) return null;
    var cz = Math.sqrt(cz2);
    // 列：a=(a,0,0), b=(bx,by,0), c=(cx,cy,cz)
    return [[a, bx, cx],
            [0, by, cy],
            [0, 0, cz]];
  }

  function metricTensor(B) {
    var Bt = matT(B);
    return matMul(Bt, B);
  }

  function cellVolume(cell) {
    var B = cellBasis(cell);
    return B ? Math.abs(det3(B)) : 0;
  }

  /** 分数坐标 → 笛卡尔坐标 */
  function fracToCart(B, p) {
    return matVec(B, p);
  }

  /** 晶胞 8 个角中离原点最远的距离（用于相机取景） */
  function cellReach(B) {
    var best = 0;
    for (var i = 0; i < 8; i++) {
      var x = i & 1, y = (i >> 1) & 1, z = (i >> 2) & 1;
      var c = matVec(B, [x, y, z]);
      var d = Math.hypot(c[0], c[1], c[2]);
      if (d > best) best = d;
    }
    return best;
  }

  /* ==================================================================
   *  3. 几何对称操作 → 分数坐标整数矩阵
   * ================================================================== */

  function normalize(v) {
    var n = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / n, v[1] / n, v[2] / n];
  }

  /** 绕 axis 转 angle 弧度的笛卡尔旋转矩阵（Rodrigues） */
  function rotationMatrixCart(axis, angle) {
    var n = normalize(axis);
    var x = n[0], y = n[1], z = n[2];
    var c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
    return [
      [t * x * x + c,     t * x * y - s * z, t * x * z + s * y],
      [t * x * y + s * z, t * y * y + c,     t * y * z - s * x],
      [t * x * z - s * y, t * y * z + s * x, t * z * z + c]
    ];
  }

  /** 法向为 normal 的镜面反射矩阵 */
  function reflectionMatrixCart(normal) {
    var n = normalize(normal);
    var x = n[0], y = n[1], z = n[2];
    return [
      [1 - 2 * x * x, -2 * x * y,     -2 * x * z],
      [-2 * x * y,     1 - 2 * y * y, -2 * y * z],
      [-2 * x * z,     -2 * y * z,    1 - 2 * z * z]
    ];
  }

  /**
   * 生成元（几何描述）→ 分数坐标整数矩阵。
   * gen.op: 'rot' 旋转 | 'rotinv' 旋转反演 | 'mirror' 镜面 | 'inv' 反演
   * gen.axis: [h,k,l] 晶体学方向（分数坐标）；gen.angle: 角度（度）
   * 若该操作不是此晶胞的对称操作 → null
   */
  function generatorToFractional(gen, B) {
    if (gen.op === 'inv') return [[-1, 0, 0], [0, -1, 0], [0, 0, -1]];
    var axisCart = matVec(B, gen.axis);
    var Rc;
    if (gen.op === 'rot') {
      Rc = rotationMatrixCart(axisCart, gen.angle * DEG);
    } else if (gen.op === 'rotinv') {
      Rc = neg3(rotationMatrixCart(axisCart, gen.angle * DEG));
    } else if (gen.op === 'mirror') {
      Rc = reflectionMatrixCart(axisCart);
    } else {
      return null;
    }
    var Binv = inv3(B);
    if (!Binv) return null;
    return roundMat(matMul(matMul(Binv, Rc), B));
  }

  function describeGen(gen) {
    if (gen.op === 'inv') return '反演中心';
    var ax = '[' + gen.axis.join('') + ']';
    if (gen.op === 'rot') return '绕 ' + ax + ' 的 ' + gen.angle + '° 旋转';
    if (gen.op === 'rotinv') return '绕 ' + ax + ' 的 ' + gen.angle + '° 旋转反演';
    if (gen.op === 'mirror') return '法向 ' + ax + ' 的镜面';
    return '未知操作';
  }

  /** 生成元闭包（最多 64 个元素，点群最大 48） */
  function closure(gens) {
    var set = Object.create(null);
    var list = [IDENT];
    set[matKeyInt(IDENT)] = true;
    for (var head = 0; head < list.length; head++) {
      var A = list[head];
      for (var g = 0; g < gens.length; g++) {
        var P = matMul(A, gens[g]);
        var k = matKeyInt(P);
        if (!set[k]) {
          set[k] = true;
          list.push(P);
          if (list.length > 64) return null;
        }
      }
    }
    return list;
  }

  /* ==================================================================
   *  4. 32 个晶体学点群（生成元，按标准取向）
   *     - 单斜：b 为唯一轴
   *     - 四方 / 三方 / 六方：c 为高次轴；三方、六方用六方轴（a=b, γ=120°）
   *     - 立方：a=b=c，α=β=γ=90°
   * ================================================================== */

  var ROT = function (axis, angle) { return { op: 'rot', axis: axis, angle: angle }; };
  var ROTINV = function (axis, angle) { return { op: 'rotinv', axis: axis, angle: angle }; };
  var MIRROR = function (axis) { return { op: 'mirror', axis: axis }; };
  var INV = { op: 'inv' };

  var POINT_GROUPS = [
    { hm: '1',     system: 'triclinic',    order: 1,  gens: [] },
    { hm: '-1',    system: 'triclinic',    order: 2,  gens: [INV] },

    { hm: '2',     system: 'monoclinic',   order: 2,  gens: [ROT([0, 1, 0], 180)] },
    { hm: 'm',     system: 'monoclinic',   order: 2,  gens: [MIRROR([0, 1, 0])] },
    { hm: '2/m',   system: 'monoclinic',   order: 4,  gens: [ROT([0, 1, 0], 180), INV] },

    { hm: '222',   system: 'orthorhombic', order: 4,  gens: [ROT([1, 0, 0], 180), ROT([0, 1, 0], 180)] },
    { hm: 'mm2',   system: 'orthorhombic', order: 4,  gens: [MIRROR([1, 0, 0]), MIRROR([0, 1, 0])] },
    { hm: 'mmm',   system: 'orthorhombic', order: 8,  gens: [ROT([1, 0, 0], 180), ROT([0, 1, 0], 180), INV] },

    { hm: '4',     system: 'tetragonal',   order: 4,  gens: [ROT([0, 0, 1], 90)] },
    { hm: '-4',    system: 'tetragonal',   order: 4,  gens: [ROTINV([0, 0, 1], 90)] },
    { hm: '4/m',   system: 'tetragonal',   order: 8,  gens: [ROT([0, 0, 1], 90), INV] },
    { hm: '422',   system: 'tetragonal',   order: 8,  gens: [ROT([0, 0, 1], 90), ROT([1, 0, 0], 180)] },
    { hm: '4mm',   system: 'tetragonal',   order: 8,  gens: [ROT([0, 0, 1], 90), MIRROR([1, 0, 0])] },
    { hm: '-42m',  system: 'tetragonal',   order: 8,  gens: [ROTINV([0, 0, 1], 90), ROT([1, 0, 0], 180)] },
    { hm: '4/mmm', system: 'tetragonal',   order: 16, gens: [ROT([0, 0, 1], 90), ROT([1, 0, 0], 180), INV] },

    { hm: '3',     system: 'trigonal',     order: 3,  gens: [ROT([0, 0, 1], 120)] },
    { hm: '-3',    system: 'trigonal',     order: 6,  gens: [ROT([0, 0, 1], 120), INV] },
    { hm: '32',    system: 'trigonal',     order: 6,  gens: [ROT([0, 0, 1], 120), ROT([1, 0, 0], 180)] },
    { hm: '3m',    system: 'trigonal',     order: 6,  gens: [ROT([0, 0, 1], 120), MIRROR([1, 0, 0])] },
    { hm: '-3m',   system: 'trigonal',     order: 12, gens: [ROT([0, 0, 1], 120), ROT([1, 0, 0], 180), INV] },

    { hm: '6',     system: 'hexagonal',    order: 6,  gens: [ROT([0, 0, 1], 60)] },
    { hm: '-6',    system: 'hexagonal',    order: 6,  gens: [ROTINV([0, 0, 1], 60)] },
    { hm: '6/m',   system: 'hexagonal',    order: 12, gens: [ROT([0, 0, 1], 60), INV] },
    { hm: '622',   system: 'hexagonal',    order: 12, gens: [ROT([0, 0, 1], 60), ROT([1, 0, 0], 180)] },
    { hm: '6mm',   system: 'hexagonal',    order: 12, gens: [ROT([0, 0, 1], 60), MIRROR([1, 0, 0])] },
    { hm: '-6m2',  system: 'hexagonal',    order: 12, gens: [ROTINV([0, 0, 1], 60), ROT([1, 0, 0], 180)] },
    { hm: '6/mmm', system: 'hexagonal',    order: 24, gens: [ROT([0, 0, 1], 60), ROT([1, 0, 0], 180), INV] },

    { hm: '23',    system: 'cubic',        order: 12, gens: [ROT([1, 0, 0], 180), ROT([0, 1, 0], 180), ROT([1, 1, 1], 120)] },
    { hm: 'm-3',   system: 'cubic',        order: 24, gens: [ROT([1, 0, 0], 180), ROT([0, 1, 0], 180), ROT([1, 1, 1], 120), INV] },
    { hm: '432',   system: 'cubic',        order: 24, gens: [ROT([0, 0, 1], 90), ROT([1, 1, 1], 120)] },
    { hm: '-43m',  system: 'cubic',        order: 24, gens: [ROTINV([0, 0, 1], 90), ROT([1, 1, 1], 120)] },
    { hm: 'm-3m',  system: 'cubic',        order: 48, gens: [ROT([0, 0, 1], 90), ROT([1, 1, 1], 120), INV] }
  ];

  var POINT_GROUP_MAP = Object.create(null);
  for (var _pg = 0; _pg < POINT_GROUPS.length; _pg++) POINT_GROUP_MAP[POINT_GROUPS[_pg].hm] = POINT_GROUPS[_pg];

  /* ==================================================================
   *  5. 点阵带心
   * ================================================================== */

  var CENTERINGS = {
    P: [[0, 0, 0]],
    A: [[0, 0, 0], [0, 0.5, 0.5]],
    B: [[0, 0, 0], [0.5, 0, 0.5]],
    C: [[0, 0, 0], [0.5, 0.5, 0]],
    I: [[0, 0, 0], [0.5, 0.5, 0.5]],
    F: [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0]],
    R: [[0, 0, 0], [2 / 3, 1 / 3, 1 / 3], [1 / 3, 2 / 3, 2 / 3]]
  };

  var CENTERING_LABELS = {
    P: 'P（简单）', A: 'A（A 底心）', B: 'B（B 底心）', C: 'C（C 底心）',
    I: 'I（体心）', F: 'F（面心）', R: 'R（菱面体带心）'
  };

  /** 各晶系允许的带心类型 */
  var CENTERING_BY_SYSTEM = {
    triclinic:    ['P'],
    monoclinic:   ['P', 'C'],
    orthorhombic: ['P', 'C', 'A', 'B', 'I', 'F'],
    tetragonal:   ['P', 'I'],
    trigonal:     ['P', 'R'],
    hexagonal:    ['P'],
    cubic:        ['P', 'I', 'F']
  };

  /** 各晶系对晶胞参数的约束（用于「对齐晶胞」按钮） */
  var SYSTEM_LABELS = {
    triclinic: '三斜', monoclinic: '单斜（b 唯一轴）', orthorhombic: '正交',
    tetragonal: '四方', trigonal: '三方（六方轴）', hexagonal: '六方', cubic: '立方'
  };

  var SYSTEM_SAMPLES = {
    triclinic:    { a: 4.2, b: 5.1, c: 6.3, alpha: 78, beta: 83, gamma: 71 },
    monoclinic:   { a: 5.0, b: 6.4, c: 7.2, alpha: 90, beta: 104, gamma: 90 },
    orthorhombic: { a: 5.0, b: 6.5, c: 8.0, alpha: 90, beta: 90, gamma: 90 },
    tetragonal:   { a: 5.0, b: 5.0, c: 7.5, alpha: 90, beta: 90, gamma: 90 },
    trigonal:     { a: 5.0, b: 5.0, c: 8.0, alpha: 90, beta: 90, gamma: 120 },
    hexagonal:    { a: 5.0, b: 5.0, c: 8.0, alpha: 90, beta: 90, gamma: 120 },
    cubic:        { a: 5.0, b: 5.0, c: 5.0, alpha: 90, beta: 90, gamma: 90 }
  };

  /** 把晶胞参数对齐到指定晶系（只收紧必要的约束，不改变已有数值） */
  function alignCellToSystem(cell, system) {
    var out = { a: +cell.a, b: +cell.b, c: +cell.c, alpha: +cell.alpha, beta: +cell.beta, gamma: +cell.gamma };
    switch (system) {
      case 'monoclinic':
        out.alpha = 90; out.gamma = 90;
        break;
      case 'orthorhombic':
        out.alpha = 90; out.beta = 90; out.gamma = 90;
        break;
      case 'tetragonal':
        out.b = out.a; out.alpha = 90; out.beta = 90; out.gamma = 90;
        break;
      case 'trigonal':
      case 'hexagonal':
        out.b = out.a; out.alpha = 90; out.beta = 90; out.gamma = 120;
        break;
      case 'cubic':
        out.b = out.a; out.c = out.a;
        out.alpha = 90; out.beta = 90; out.gamma = 90;
        break;
      default:
        break;
    }
    return out;
  }

  /* ==================================================================
   *  6. 构造点群、判定与晶胞是否相容
   * ================================================================== */

  /** 度规是否被 R 保持（R 为分数坐标整数矩阵） */
  function metricPreserved(R, G, tol) {
    var M = matMul(matMul(matT(R), G), R);
    for (var i = 0; i < 3; i++) {
      for (var j = 0; j < 3; j++) {
        if (Math.abs(M[i][j] - G[i][j]) > tol) return false;
      }
    }
    return true;
  }

  function sortMatrices(mats) {
    return mats.slice().sort(function (A, B) {
      var ka = matKeyInt(A), kb = matKeyInt(B);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }

  /**
   * 构造点群。
   * @param {string} hm 点群 Hermann–Mauguin 记号（如 'm-3m'）
   * @param {object} cell 晶胞参数
   * @returns {{ok:true, hm, system, order, matrices}|{ok:false, reason}}
   */
  function buildPointGroup(hm, cell) {
    var def = typeof hm === 'string' ? POINT_GROUP_MAP[hm] : hm;
    if (!def) return { ok: false, reason: '未知点群：' + hm };
    var B = cellBasis(cell);
    if (!B) return { ok: false, reason: '晶胞参数无效（角度或边长不合法）' };
    var G = metricTensor(B);
    var scale = 1;
    for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) scale = Math.max(scale, Math.abs(G[i][j]));

    var gens = [];
    for (var g = 0; g < def.gens.length; g++) {
      var R = generatorToFractional(def.gens[g], B);
      if (!R) {
        return { ok: false, reason: '点群 ' + def.hm + ' 与当前晶胞参数不符：' + describeGen(def.gens[g]) + '不是该点阵的对称操作' };
      }
      gens.push(R);
    }
    var mats = closure(gens);
    if (!mats) return { ok: false, reason: '对称操作无法闭合为有限群' };
    for (var m = 0; m < mats.length; m++) {
      if (!metricPreserved(mats[m], G, 1e-6 * scale)) {
        return { ok: false, reason: '点群 ' + def.hm + ' 与当前晶胞参数不符（度规不被保持）' };
      }
    }
    if (mats.length !== def.order) {
      return { ok: false, reason: '点群生成异常：' + def.hm + ' 期望群阶 ' + def.order + '，实得 ' + mats.length };
    }
    return { ok: true, hm: def.hm, system: def.system, order: def.order, matrices: sortMatrices(mats) };
  }

  function isCenteringPreserved(R, T) {
    for (var i = 0; i < T.length; i++) {
      var v = matVec(R, T[i]);
      var found = false;
      for (var j = 0; j < T.length && !found; j++) {
        var dx = v[0] - T[j][0], dy = v[1] - T[j][1], dz = v[2] - T[j][2];
        if (Math.abs(dx - Math.round(dx)) < 1e-6 &&
            Math.abs(dy - Math.round(dy)) < 1e-6 &&
            Math.abs(dz - Math.round(dz)) < 1e-6) found = true;
      }
      if (!found) return false;
    }
    return true;
  }

  /**
   * 自动求「点阵全对称」点群：枚举整数矩阵（元素 ∈ {-1,0,1}，|det|=1），
   * 保留同时满足「度规不变」与「带心平移被置换」的操作。
   * 返回值含 order，可据此识别晶系（2=三斜, 4=单斜, 8=正交, 16=四方, 24=六方, 48=立方,
   * 12=三方（R 带心））。
   */
  function latticeHolohedry(cell, centeringKey) {
    var B = cellBasis(cell);
    if (!B) return { ok: false, reason: '晶胞参数无效' };
    var G = metricTensor(B);
    var T = CENTERINGS[centeringKey] || CENTERINGS.P;
    var scale = 1;
    for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) scale = Math.max(scale, Math.abs(G[i][j]));
    var tol = 1e-6 * scale;

    var mats = [];
    var digits = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (var code = 0; code < 19683; code++) {
      var c = code;
      for (var k = 0; k < 9; k++) { digits[k] = (c % 3) - 1; c = Math.floor(c / 3); }
      var R = [[digits[0], digits[1], digits[2]],
               [digits[3], digits[4], digits[5]],
               [digits[6], digits[7], digits[8]]];
      var d = det3(R);
      if (d !== 1 && d !== -1) continue;
      if (!metricPreserved(R, G, tol)) continue;
      if (!isCenteringPreserved(R, T)) continue;
      mats.push(R);
    }
    return { ok: true, matrices: sortMatrices(mats), order: mats.length, centering: centeringKey };
  }

  /** 在 32 个点群里识别给定操作集合 */
  function identifyPointGroup(matrices, cell) {
    var target = matrices.map(matKeyInt).sort().join('|');
    for (var i = 0; i < POINT_GROUPS.length; i++) {
      var def = POINT_GROUPS[i];
      if (def.order !== matrices.length) continue;
      var g = buildPointGroup(def.hm, cell);
      if (!g.ok) continue;
      if (g.matrices.map(matKeyInt).sort().join('|') === target) {
        return { hm: def.hm, system: def.system, order: def.order };
      }
    }
    return null;
  }

  /** 点阵全对称的信息（含识别出的点群记号） */
  function holohedryInfo(cell, centeringKey) {
    var h = latticeHolohedry(cell, centeringKey);
    if (!h.ok) return h;
    var id = identifyPointGroup(h.matrices, cell);
    return {
      ok: true,
      matrices: h.matrices,
      order: h.order,
      hm: id ? id.hm : null,
      system: id ? id.system : inferSystemFromOrder(h.order)
    };
  }

  function inferSystemFromOrder(order) {
    switch (order) {
      case 2: return 'triclinic';
      case 4: return 'monoclinic';
      case 8: return 'orthorhombic';
      case 12: return 'trigonal';
      case 16: return 'tetragonal';
      case 24: return 'hexagonal';
      case 48: return 'cubic';
      default: return 'triclinic';
    }
  }

  /* ==================================================================
   *  7. 轨道与基本域代表点
   * ================================================================== */

  var QUANT = 1e6; // 量化格：代表点坐标精确到 1e-6

  /**
   * 从「显式操作列表」构造与 prepareOperations 相同的数据结构。
   * opList: [{ R: 3×3 整数矩阵, t: [tx,ty,tz] }]
   * 用于空间群（含螺旋轴 / 滑移面的平移部分）。
   */
  function prepareOperationsFromList(opList) {
    var count = opList.length;
    var flat = new Float64Array(count * 12);
    var ops = [];
    var mats = [];
    var seen = Object.create(null);
    for (var i = 0; i < count; i++) {
      var R = opList[i].R;
      var t = opList[i].t;
      var o = i * 12;
      flat[o] = R[0][0]; flat[o + 1] = R[0][1]; flat[o + 2] = R[0][2];
      flat[o + 3] = R[1][0]; flat[o + 4] = R[1][1]; flat[o + 5] = R[1][2];
      flat[o + 6] = R[2][0]; flat[o + 7] = R[2][1]; flat[o + 8] = R[2][2];
      flat[o + 9] = t[0]; flat[o + 10] = t[1]; flat[o + 11] = t[2];
      ops.push({ R: R, t: t });
      var k = matKeyInt(R);
      if (!seen[k]) { seen[k] = true; mats.push(R); }
    }
    return {
      count: count,
      flat: flat,
      ops: ops,
      matrices: sortMatrices(mats),
      centering: null
    };
  }

  /**
   * 把「点群操作 × 带心平移」展开成扁平操作表，供热循环使用。
   * 每个操作 12 个数：R11..R33, tx,ty,tz
   */
  function prepareOperations(matrices, centeringKey) {
    var T = CENTERINGS[centeringKey] || CENTERINGS.P;
    var count = matrices.length * T.length;
    var flat = new Float64Array(count * 12);
    var ops = [];
    var idx = 0;
    for (var i = 0; i < matrices.length; i++) {
      var R = matrices[i];
      for (var j = 0; j < T.length; j++) {
        var t = T[j];
        var o = idx * 12;
        flat[o] = R[0][0]; flat[o + 1] = R[0][1]; flat[o + 2] = R[0][2];
        flat[o + 3] = R[1][0]; flat[o + 4] = R[1][1]; flat[o + 5] = R[1][2];
        flat[o + 6] = R[2][0]; flat[o + 7] = R[2][1]; flat[o + 8] = R[2][2];
        flat[o + 9] = t[0]; flat[o + 10] = t[1]; flat[o + 11] = t[2];
        ops.push({ R: R, t: t });
        idx++;
      }
    }
    return { count: count, flat: flat, ops: ops, matrices: matrices, centering: centeringKey };
  }

  var _q = [0, 0, 0];

  /**
   * 基本域代表点（量化整数坐标，量纲 1/QUANT）。
   * 同轨道的点必然得到相同结果；不同轨道（几乎必然）不同。
   * 返回复用数组 _q — 需要保存请自行复制。
   */
  function canonicalize(prep, x, y, z) {
    var f = prep.flat, n = prep.count;
    var bx = QUANT, by = QUANT, bz = QUANT;
    for (var i = 0; i < n; i++) {
      var o = i * 12;
      var qx = f[o] * x + f[o + 1] * y + f[o + 2] * z + f[o + 9];
      var qy = f[o + 3] * x + f[o + 4] * y + f[o + 5] * z + f[o + 10];
      var qz = f[o + 6] * x + f[o + 7] * y + f[o + 8] * z + f[o + 11];
      qx -= Math.floor(qx); qy -= Math.floor(qy); qz -= Math.floor(qz);
      var ix = Math.round(qx * QUANT) % QUANT;
      var iy = Math.round(qy * QUANT) % QUANT;
      var iz = Math.round(qz * QUANT) % QUANT;
      if (ix < bx || (ix === bx && (iy < by || (iy === by && iz < bz)))) {
        bx = ix; by = iy; bz = iz;
      }
    }
    _q[0] = bx; _q[1] = by; _q[2] = bz;
    return _q;
  }

  function canonicalKey(q) {
    return q[0] + '/' + q[1] + '/' + q[2];
  }

  /** 轨道（去重后的分数坐标数组 [[x,y,z], ...]） */
  function orbitOf(prep, x, y, z) {
    var f = prep.flat, n = prep.count;
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < n; i++) {
      var o = i * 12;
      var qx = f[o] * x + f[o + 1] * y + f[o + 2] * z + f[o + 9];
      var qy = f[o + 3] * x + f[o + 4] * y + f[o + 5] * z + f[o + 10];
      var qz = f[o + 6] * x + f[o + 7] * y + f[o + 8] * z + f[o + 11];
      qx -= Math.floor(qx); qy -= Math.floor(qy); qz -= Math.floor(qz);
      var ix = Math.round(qx * QUANT) % QUANT;
      var iy = Math.round(qy * QUANT) % QUANT;
      var iz = Math.round(qz * QUANT) % QUANT;
      var key = ix + '/' + iy + '/' + iz;
      if (!seen[key]) {
        seen[key] = true;
        out.push([ix / QUANT, iy / QUANT, iz / QUANT]);
      }
    }
    return out;
  }

  /* ==================================================================
   *  8. 群元素分类（用于界面上的操作摘要与对称元素显示）
   * ================================================================== */

  function matrixOrder(R) {
    var M = R;
    for (var k = 1; k <= 12; k++) {
      if (isIdent(M)) return k;
      M = matMul(M, R);
    }
    return 0;
  }

  /**
   * 分类：返回 { proper: {2,3,4,6,1}, improper: {inv, mirror, rotoinv} , list }
   * list 中每项 { det, order, kind, count }
   */
  function summarizeMatrices(matrices) {
    var buckets = Object.create(null);
    for (var i = 0; i < matrices.length; i++) {
      var R = matrices[i];
      var det = det3(R);
      var order = matrixOrder(R);
      var kind;
      if (det > 0) {
        kind = order === 1 ? 'identity' : ('rot' + order);
      } else if (order === 2 && R[0][0] === -1 && R[1][1] === -1 && R[2][2] === -1) {
        kind = 'inversion';
      } else if (order === 2) {
        kind = 'mirror';
      } else {
        kind = 'rotoinv' + order;
      }
      var key = kind;
      if (!buckets[key]) buckets[key] = { kind: kind, det: det, order: order, count: 0 };
      buckets[key].count++;
    }
    return Object.keys(buckets).map(function (k) { return buckets[k]; });
  }

  var KIND_LABELS = {
    identity: '恒等',
    inversion: '反演中心',
    mirror: '镜面',
    rot2: '2 重轴', rot3: '3 重轴', rot4: '4 重轴', rot6: '6 重轴',
    rotoinv3: '3 重旋转反演', rotoinv4: '4 重旋转反演', rotoinv6: '6 重旋转反演'
  };

  /* ==================================================================
   *  9. 晶胞采样
   * ================================================================== */

  /**
   * 均匀网格（取格点 i/n）→ 分数坐标 Float64Array。
   * 取格点而不是小格中心，是为了让整数旋转矩阵把网格映到自身；
   * 带心 / 螺旋 / 滑移的分数平移还需要把 n 对齐到 translationDenom() 的倍数，
   * 这样整个轨道的等价点都会落在采样网格里（点击高亮才会完整）。
   */
  function sampleGrid(n) {
    var count = n * n * n;
    var out = new Float64Array(count * 3);
    var p = 0;
    for (var i = 0; i < n; i++) {
      var x = i / n;
      for (var j = 0; j < n; j++) {
        var y = j / n;
        for (var k = 0; k < n; k++) {
          out[p++] = x; out[p++] = y; out[p++] = k / n;
        }
      }
    }
    return out;
  }

  /**
   * 让采样网格在全部操作下保持不变的「最小 n 倍数」。
   * 只取决于分数平移 t：t = k/12 的最简分母的 lcm。
   * 无分数平移（P 带心、点群 1/2/m/mmm/4/mmm/m-3m…）时返回 1。
   */
  function translationDenom(prep) {
    function gcd(a, b) { while (b) { var r = a % b; a = b; b = r; } return a; }
    var m = 1;
    var f = prep.flat, n = prep.count;
    for (var i = 0; i < n; i++) {
      var o = i * 12;
      for (var k = 0; k < 3; k++) {
        var kk = Math.round(f[o + 9 + k] * 12) % 12;
        if (kk < 0) kk += 12;
        if (kk === 0) continue;
        var den = 12 / gcd(kk, 12);
        m = m / gcd(m, den) * den;
      }
    }
    return m;
  }

  /** 伪随机均匀采样（确定性，便于复现） */
  function sampleRandom(count, seed) {
    var out = new Float64Array(count * 3);
    var s = (seed >>> 0) || 12345;
    function rnd() {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    }
    for (var i = 0; i < count * 3; i++) out[i] = rnd();
    return out;
  }

  /* ==================================================================
   *  导出
   * ================================================================== */

  return {
    DEG: DEG,
    TAU: TAU,
    QUANT: QUANT,
    IDENT: IDENT,

    matMul: matMul,
    matVec: matVec,
    matT: matT,
    det3: det3,
    inv3: inv3,
    matKeyInt: matKeyInt,

    cellBasis: cellBasis,
    metricTensor: metricTensor,
    cellVolume: cellVolume,
    cellReach: cellReach,
    fracToCart: fracToCart,

    rotationMatrixCart: rotationMatrixCart,
    reflectionMatrixCart: reflectionMatrixCart,
    generatorToFractional: generatorToFractional,
    closure: closure,
    metricPreserved: metricPreserved,

    POINT_GROUPS: POINT_GROUPS,
    POINT_GROUP_MAP: POINT_GROUP_MAP,
    CENTERINGS: CENTERINGS,
    CENTERING_LABELS: CENTERING_LABELS,
    CENTERING_BY_SYSTEM: CENTERING_BY_SYSTEM,
    SYSTEM_LABELS: SYSTEM_LABELS,
    SYSTEM_SAMPLES: SYSTEM_SAMPLES,
    alignCellToSystem: alignCellToSystem,

    buildPointGroup: buildPointGroup,
    latticeHolohedry: latticeHolohedry,
    holohedryInfo: holohedryInfo,
    identifyPointGroup: identifyPointGroup,

    prepareOperations: prepareOperations,
    prepareOperationsFromList: prepareOperationsFromList,
    canonicalize: canonicalize,
    canonicalKey: canonicalKey,
    orbitOf: orbitOf,

    matrixOrder: matrixOrder,
    summarizeMatrices: summarizeMatrices,
    KIND_LABELS: KIND_LABELS,

    sampleGrid: sampleGrid,
    translationDenom: translationDenom,
    sampleRandom: sampleRandom
  };
});
