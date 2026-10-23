/*!
 * app.js — 晶体对称性点云：界面、采样、着色与统计
 */
(function () {
  'use strict';

  var S = window.CrystalSym;
  var C = window.CrystalColor;
  var SG = window.CrystalSpaceGroups;
  var TAU = Math.PI * 2;
  var QUANT = S.QUANT;

  var canvas = document.getElementById('gl');
  var renderer = window.CrystalRender.create(canvas);

  function byId(id) { return document.getElementById(id); }

  var el = {
    cellA: byId('cell-a'), cellB: byId('cell-b'), cellC: byId('cell-c'),
    cellAlpha: byId('cell-alpha'), cellBeta: byId('cell-beta'), cellGamma: byId('cell-gamma'),
    pg: byId('pg'), centering: byId('centering'),
    symMode: byId('sym-mode'), pgField: byId('pg-field'), centeringField: byId('centering-field'),
    sg: byId('sg'), sgField: byId('sg-field'), origin: byId('origin'), originField: byId('origin-field'),
    sgHint: byId('sg-hint'), statSg: byId('stat-sg'),
    sample: byId('sample'), res: byId('res'), resValue: byId('res-value'),
    resField: byId('res-field'), custom: byId('custom'), customField: byId('custom-field'),
    sampleHint: byId('sample-hint'),
    color: byId('color'), psize: byId('psize'), psizeValue: byId('psize-value'),
    alpha: byId('alpha'), alphaValue: byId('alpha-value'), blend: byId('blend'),
    autorot: byId('autorot'), neighbors: byId('neighbors'),
    symaxes: byId('symaxes'), mirrors: byId('mirrors'),
    symStatus: byId('sym-status'), presets: byId('presets'),
    statGroup: byId('stat-group'), statSystem: byId('stat-system'), statOps: byId('stat-ops'),
    statHolo: byId('stat-holo'), statPoints: byId('stat-points'),
    statOrbits: byId('stat-orbits'), statAvg: byId('stat-avg'),
    elements: byId('elements'), warnings: byId('warnings'),
    hud: byId('hud'), labels: byId('labels'), selection: byId('selection'),
    selX: byId('sel-x'), selY: byId('sel-y'), selZ: byId('sel-z'), coordHint: byId('coord-hint')
  };

  if (!renderer) {
    el.hud.innerHTML = '<strong>WebGL 不可用</strong><small>请换用支持 WebGL 的浏览器</small>';
    return;
  }

  /* ================================================================
   *  状态
   * ================================================================ */

  var state = {
    cell: { a: 4.5, b: 4.5, c: 4.5, alpha: 90, beta: 90, gamma: 90 },
    pointGroup: '1',
    centering: 'P',
    symmetryMode: 'point',      // 'point' | 'space'
    spaceGroupNo: 62,           // 空间群编号（仅空间群模式使用）
    spaceGroupVariant: 0,       // origin choice 等变体下标
    sampleMode: 'grid',
    resolution: 26,
    customText: el.custom.value,
    colorMode: 'canon',
    pointSize: 1,
    alpha: 1,
    blend: 'solid',
    autoRotate: false,
    coordSel: null,              // 按坐标选取的分数坐标 {x,y,z}
    showNeighbors: false,
    showSymAxes: false,
    showMirrors: false
  };

  var PRESETS = {
    triclinic:    { group: '1',     centering: 'P' },
    monoclinic:   { group: '2/m',   centering: 'P' },
    orthorhombic: { group: 'mmm',   centering: 'P' },
    tetragonal:   { group: '4/mmm', centering: 'P' },
    trigonal:     { group: '-3m',   centering: 'R' },
    hexagonal:    { group: '6/mmm', centering: 'P' },
    cubic:        { group: 'm-3m',  centering: 'P' }
  };

  // 空间群模式下的晶系预设：每个晶系给一个代表性空间群编号
  var SPACE_PRESETS = {
    triclinic: 2,      // P-1
    monoclinic: 14,    // P2₁/c
    orthorhombic: 62,  // Pnma
    tetragonal: 123,   // P4/mmm
    trigonal: 166,     // R-3m
    hexagonal: 194,    // P6₃/mmc
    cubic: 225         // Fm-3m
  };

  var lastB = null;
  var labelEls = [];
  var holoCache = { key: '', value: null };
  var lastCellKey = '';
  var pendingTimer = 0;
  var lastSizeWorld = 0.05;
  var lastPoints = null;
  var selectedOrbit = -1;
  var lastGroupInfo = null;
  var lastHighlightCount = 0;
  var lastPrep = null;
  var lastBounds = null;

  /* ================================================================
   *  颜色
   * ================================================================ */

  // 备用：轨道离散色（每轨道一色，用于自定义点集/对照）
  function hashOrbit(a, b, c) {
    var h = 2166136261;
    h = Math.imul(h ^ (a | 0), 16777619);
    h = Math.imul(h ^ (b | 0), 16777619);
    h = Math.imul(h ^ (c | 0), 16777619);
    h ^= h >>> 15;
    h = Math.imul(h, 2246822507);
    h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
  }

  function hslToRgb(h, s, l) {
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var hp = h * 6;
    var x = c * (1 - Math.abs((hp % 2) - 1));
    var r = 0, g = 0, b = 0;
    if (hp < 1) { r = c; g = x; }
    else if (hp < 2) { r = x; g = c; }
    else if (hp < 3) { g = c; b = x; }
    else if (hp < 4) { g = x; b = c; }
    else if (hp < 5) { r = x; b = c; }
    else { r = c; b = x; }
    var m = l - c / 2;
    return [r + m, g + m, b + m];
  }

  function colorOrbit(a, b, c) {
    var h = hashOrbit(a, b, c);
    var l = 0.46 + 0.16 * hashOrbit(b + 17, c + 41, a + 7);
    return hslToRgb(h, 0.82, l);
  }

  /* ------------------------------------------------------------------
   *  基本域三维色码（默认颜色模式）
   *
   *  轨道代表点 (x,y,z) → 各轴按代表点分布范围归一化到 [0,1]³
   *    u → Lab 亮度 L（52..78，不会过暗）
   *    (v,w) → 方-圆同心映射到色度平面上的圆盘
   *           半径 → 色度，角度 → 色相；色度上限由 sRGB 色域边界决定
   *
   *  性质：
   *    · 同一轨道 → 同一代表点 → 同一个颜色（严格相等）；
   *    · 映射连续、单射，没有循环回绕，因此不会出现“整张等色面”；
   *    · 代表点相距越远，颜色差（ΔE）越大；
   *    · 所有颜色都在 sRGB 色域内，且 L* ≥ 55，不会出现过暗的点。
   *
   *  归一化范围用固定种子的随机轨道估计（与显示密度无关），
   *  因此调整点云密度时颜色不会漂移。
   * ------------------------------------------------------------------ */

  var canonBoundsCache = Object.create(null);

  function canonicalBounds(key, prep) {
    if (canonBoundsCache[key]) return canonBoundsCache[key];
    var pts = S.sampleRandom(2048, 20241022);
    var mn = [2, 2, 2], mx = [-2, -2, -2];
    for (var i = 0; i < pts.length; i += 3) {
      var q = S.canonicalize(prep, pts[i], pts[i + 1], pts[i + 2]);
      for (var k = 0; k < 3; k++) {
        var val = q[k] / QUANT;
        if (val < mn[k]) mn[k] = val;
        if (val > mx[k]) mx[k] = val;
      }
    }
    var b = {
      min: mn,
      ext: [
        Math.max(1e-6, mx[0] - mn[0]),
        Math.max(1e-6, mx[1] - mn[1]),
        Math.max(1e-6, mx[2] - mn[2])
      ]
    };
    canonBoundsCache[key] = b;
    return b;
  }

  /** 基本域代表点（量化整数坐标）→ sRGB */
  function colorFromRep(qx, qy, qz, bounds) {
    return C.colorCode(
      (qx / QUANT - bounds.min[0]) / bounds.ext[0],
      (qy / QUANT - bounds.min[1]) / bounds.ext[1],
      (qz / QUANT - bounds.min[2]) / bounds.ext[2]
    );
  }

  /* ================================================================
   *  向量小工具
   * ================================================================ */

  function norm3(v) { return Math.hypot(v[0], v[1], v[2]); }

  function unit(v) {
    var n = norm3(v) || 1;
    return [v[0] / n, v[1] / n, v[2] / n];
  }

  function cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ];
  }

  function gcdInt(a, b) {
    a = Math.abs(a); b = Math.abs(b);
    while (b) { var t = a % b; a = b; b = t; }
    return a;
  }

  /** M 为整数 3×3 奇异矩阵，返回其零空间的整数方向（规范符号），无解返回 null */
  function nullDirection(M) {
    var best = null, bestN = 0;
    var pairs = [[0, 1], [0, 2], [1, 2]];
    for (var p = 0; p < pairs.length; p++) {
      var a = M[pairs[p][0]], b = M[pairs[p][1]];
      var c = cross(a, b);
      var n = norm3(c);
      if (n > bestN) { bestN = n; best = c; }
    }
    if (!best || bestN < 1e-9) return null;
    var v = [Math.round(best[0]), Math.round(best[1]), Math.round(best[2])];
    var g2 = gcdInt(gcdInt(v[0], v[1]), v[2]) || 1;
    v = [v[0] / g2, v[1] / g2, v[2] / g2];
    // 规范符号：第一个非零分量为正
    for (var i = 0; i < 3; i++) {
      if (v[i] !== 0) {
        if (v[i] < 0) { v = [-v[0], -v[1], -v[2]]; }
        break;
      }
    }
    return v;
  }

  /* ================================================================
   *  对称元素几何（画在胞心，方便观察）
   * ================================================================ */

  var AXIS_COLORS = {
    2: [0.36, 0.82, 1.0],
    3: [0.42, 0.97, 0.70],
    4: [1.0, 0.74, 0.36],
    6: [1.0, 0.42, 0.85]
  };

  function buildSymmetryGeometry(group, B, reach) {
    var center = S.fracToCart(B, [0.5, 0.5, 0.5]);
    var L = reach * 0.94;
    var axes = [], planes = [];
    var seenA = Object.create(null), seenP = Object.create(null);

    for (var m = 0; m < group.matrices.length; m++) {
      var R = group.matrices[m];
      var det = S.det3(R);
      var order = S.matrixOrder(R);
      if (det > 0 && order > 1) {
        var axis = nullDirection([
          [R[0][0] - 1, R[0][1], R[0][2]],
          [R[1][0], R[1][1] - 1, R[1][2]],
          [R[2][0], R[2][1], R[2][2] - 1]
        ]);
        if (!axis) continue;
        var keyA = 'A' + axis.join(',') + ':' + order;
        if (seenA[keyA]) continue;
        seenA[keyA] = true;
        var dir = unit(S.fracToCart(B, axis));
        axes.push({
          a: [center[0] - dir[0] * L, center[1] - dir[1] * L, center[2] - dir[2] * L],
          b: [center[0] + dir[0] * L, center[1] + dir[1] * L, center[2] + dir[2] * L],
          c: AXIS_COLORS[order] || [0.8, 0.8, 0.9]
        });
      } else if (det < 0 && order === 2) {
        var nrm = nullDirection([
          [R[0][0] + 1, R[0][1], R[0][2]],
          [R[1][0], R[1][1] + 1, R[1][2]],
          [R[2][0], R[2][1], R[2][2] + 1]
        ]);
        if (!nrm) continue;
        var keyP = 'P' + nrm.join(',');
        if (seenP[keyP]) continue;
        seenP[keyP] = true;
        var n = unit(S.fracToCart(B, nrm));
        var u = cross(n, [0, 0, 1]);
        if (norm3(u) < 1e-4) u = cross(n, [1, 0, 0]);
        u = unit(u);
        var w = cross(n, u);
        var s = reach * 0.72;
        var q = [
          [center[0] - u[0] * s - w[0] * s, center[1] - u[1] * s - w[1] * s, center[2] - u[2] * s - w[2] * s],
          [center[0] + u[0] * s - w[0] * s, center[1] + u[1] * s - w[1] * s, center[2] + u[2] * s - w[2] * s],
          [center[0] + u[0] * s + w[0] * s, center[1] + u[1] * s + w[1] * s, center[2] + u[2] * s + w[2] * s],
          [center[0] - u[0] * s + w[0] * s, center[1] - u[1] * s + w[1] * s, center[2] - u[2] * s + w[2] * s]
        ];
        planes.push({ corners: q, color: [0.55, 0.68, 1.0] });
      }
    }
    return { axes: axes, planes: planes };
  }

  /* ================================================================
   *  采样
   * ================================================================ */

  function parseCustomPoints(text) {
    var out = [];
    var lines = String(text || '').split(/[\n;]+/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === '#') continue;
      var nums = line.split(/[\s,]+/).map(Number).filter(function (v) { return isFinite(v); });
      if (nums.length < 3) continue;
      out.push([
        nums[0] - Math.floor(nums[0]),
        nums[1] - Math.floor(nums[1]),
        nums[2] - Math.floor(nums[2])
      ]);
    }
    return out;
  }

  /* ================================================================
   *  点群缓存 / 读取
   * ================================================================ */

  function holoFor(cell, centering) {
    var key = [cell.a, cell.b, cell.c, cell.alpha, cell.beta, cell.gamma, centering].join('|');
    if (holoCache.key === key) return holoCache.value;
    var v = S.holohedryInfo(cell, centering);
    holoCache = { key: key, value: v };
    return v;
  }

  function readCellState() {
    return {
      a: state.cell.a, b: state.cell.b, c: state.cell.c,
      alpha: state.cell.alpha, beta: state.cell.beta, gamma: state.cell.gamma
    };
  }

  /* ================================================================
   *  空间群（230 个 ITA 标准设置，数据见 spacegroups.js）
   * ================================================================ */

  function decodeSpaceGroupOps(variant) {
    var data = variant.ops;
    var ops = [];
    for (var i = 0; i < data.length; i += 12) {
      ops.push({
        R: [
          [data[i], data[i + 1], data[i + 2]],
          [data[i + 3], data[i + 4], data[i + 5]],
          [data[i + 6], data[i + 7], data[i + 8]]
        ],
        t: [data[i + 9] / 12, data[i + 10] / 12, data[i + 11] / 12]
      });
    }
    return ops;
  }

  function currentSpaceGroup() {
    return (SG && SG.byNumber) ? SG.byNumber[state.spaceGroupNo] : null;
  }

  function fillSpaceGroupSelect() {
    if (!SG || !SG.bySystem || !el.sg) return;
    var order = ['triclinic', 'monoclinic', 'orthorhombic', 'tetragonal', 'trigonal', 'hexagonal', 'cubic'];
    var html = '';
    for (var i = 0; i < order.length; i++) {
      var sys = order[i];
      var list = SG.bySystem[sys] || [];
      html += '<optgroup label="' + S.SYSTEM_LABELS[sys] + '">';
      for (var k = 0; k < list.length; k++) {
        var g = list[k];
        html += '<option value="' + g.n + '">' + g.n + ' · ' + g.hm + '</option>';
      }
      html += '</optgroup>';
    }
    el.sg.innerHTML = html;
  }

  function updateSymmetryModeUI() {
    var isSpace = state.symmetryMode === 'space';
    if (el.pgField) el.pgField.hidden = isSpace;
    if (el.centeringField) el.centeringField.hidden = isSpace;
    if (el.sgField) el.sgField.hidden = !isSpace;
    if (el.sgHint) el.sgHint.hidden = !isSpace;
    if (el.pg) el.pg.disabled = isSpace;
    if (el.centering) el.centering.disabled = isSpace;

    var btns = el.symMode ? el.symMode.querySelectorAll('.mode-btn') : [];
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-mode') === state.symmetryMode);
    }

    var sg = currentSpaceGroup();
    var variants = sg ? sg.variants : [];
    if (el.originField) el.originField.hidden = !isSpace || variants.length <= 1;
    if (isSpace && el.origin) {
      el.origin.innerHTML = '';
      for (var k = 0; k < variants.length; k++) {
        var opt = document.createElement('option');
        opt.value = String(k);
        opt.textContent = variants.length > 1 ? ('Origin choice ' + variants[k].choice) : '标准设置';
        el.origin.appendChild(opt);
      }
      el.origin.value = String(Math.min(state.spaceGroupVariant, Math.max(0, variants.length - 1)));
    }
  }

  /**
   * 随机种子点 → 每个种子点的完整轨道（去重）。
   * 随机点本身通常不会恰好包含全部对称像，补全后点击高亮才会显示完整轨道。
   */
  function expandRandomOrbits(prep, seeds) {
    var f = prep.flat, cnt = prep.count, Q = S.QUANT;
    var seenOrb = Object.create(null), seenPt = Object.create(null);
    var out = [];
    for (var i = 0; i < seeds.length; i += 3) {
      var sx = seeds[i], sy = seeds[i + 1], sz = seeds[i + 2];
      var q = S.canonicalize(prep, sx, sy, sz);
      var okey = q[0] + '/' + q[1] + '/' + q[2];
      if (seenOrb[okey]) continue;
      seenOrb[okey] = true;
      for (var j = 0; j < cnt; j++) {
        var o = j * 12;
        var x = f[o] * sx + f[o + 1] * sy + f[o + 2] * sz + f[o + 9];
        var y = f[o + 3] * sx + f[o + 4] * sy + f[o + 5] * sz + f[o + 10];
        var z = f[o + 6] * sx + f[o + 7] * sy + f[o + 8] * sz + f[o + 11];
        x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
        var kx = Math.round(x * Q) % Q, ky = Math.round(y * Q) % Q, kz = Math.round(z * Q) % Q;
        if (kx < 0) kx += Q;
        if (ky < 0) ky += Q;
        if (kz < 0) kz += Q;
        var pkey = kx + '/' + ky + '/' + kz;
        if (seenPt[pkey]) continue;
        seenPt[pkey] = true;
        out.push(x, y, z);
      }
    }
    return Float64Array.from(out);
  }

  /* ================================================================
   *  主计算流程
   * ================================================================ */

  function recompute() {
    var cell = readCellState();
    var B = S.cellBasis(cell);
    if (!B) {
      el.symStatus.className = 'status warn';
      el.symStatus.textContent = '晶胞参数无效：请检查边长 > 0、0° < 角度 < 180°，且三个基矢不共面。';
      return;
    }

    var ckey = JSON.stringify(cell);
    if (ckey !== lastCellKey) {
      lastCellKey = ckey;
      renderer.setCell(B);
      lastB = B;
    }
    if (!lastB) lastB = B;
    var reach = renderer.getReach();

    /* ---- 对称性来源：点群 / 空间群 ---- */
    var spaceSG = state.symmetryMode === 'space' ? currentSpaceGroup() : null;
    var centering = spaceSG ? spaceSG.centering : state.centering;
    var holo = holoFor(cell, centering);

    var group;
    var warning = null;
    var alignSystem = null;
    var groupKey = '';

    if (state.symmetryMode === 'space') {
      if (!spaceSG) {
        warning = '未找到空间群数据（spacegroups.js 未加载）';
        group = S.buildPointGroup('1', cell);
      } else {
        var variant = spaceSG.variants[Math.min(state.spaceGroupVariant, spaceSG.variants.length - 1)];
        var opList = decodeSpaceGroupOps(variant);
        var matrices = S.prepareOperationsFromList(opList).matrices;
        var G = S.metricTensor(B);
        var gscale = 1;
        for (var gi = 0; gi < 3; gi++) {
          for (var gj = 0; gj < 3; gj++) gscale = Math.max(gscale, Math.abs(G[gi][gj]));
        }
        var metricOk = true;
        for (var mi = 0; mi < matrices.length; mi++) {
          if (!S.metricPreserved(matrices[mi], G, 1e-6 * gscale)) { metricOk = false; break; }
        }
        if (!metricOk) {
          warning = '空间群 ' + spaceSG.hm + ' 的标准设置与当前晶胞的轴 / 角度不符';
          alignSystem = spaceSG.system;
          group = S.buildPointGroup('1', cell);
        } else {
          group = {
            ok: true, space: true, number: spaceSG.n, hm: spaceSG.hm,
            full: spaceSG.full, system: spaceSG.system, pointGroup: spaceSG.pg,
            order: opList.length, matrices: matrices, ops: opList,
            centering: spaceSG.centering, choice: variant.choice
          };
        }
      }
    } else if (state.pointGroup === '__auto') {
      if (holo.ok) {
        group = {
          ok: true, auto: true,
          hm: holo.hm || '全对称', system: holo.system,
          order: holo.order, matrices: holo.matrices
        };
      } else {
        warning = holo.reason;
        group = S.buildPointGroup('1', cell);
      }
    } else {
      group = S.buildPointGroup(state.pointGroup, cell);
      if (!group.ok) {
        warning = group.reason;
        var def = S.POINT_GROUP_MAP[state.pointGroup];
        alignSystem = def ? def.system : null;
        group = S.buildPointGroup('1', cell);
      }
    }
    if (!group || !group.ok) {
      el.symStatus.className = 'status warn';
      el.symStatus.textContent = '无法构造对称群：' + ((group && group.reason) || '未知错误');
      return;
    }

    var prep;
    if (group.space) {
      prep = S.prepareOperationsFromList(group.ops);
      groupKey = 'sg' + group.number + '#' + state.spaceGroupVariant;
    } else {
      prep = S.prepareOperations(group.matrices, centering);
      groupKey = (group.hm || 'auto') + '|' + group.order + '|' + centering;
    }

    /* ---- 采样 ---- */
    var n = state.resolution;
    var count = 0;
    var positions = null;
    var colors = null;
    var orbitKeys = Object.create(null);   // 轨道 key → 轨道 id
    var orbitReps = [];                    // id → 代表点（分数坐标）
    var orbitCount = 0;
    var customInfo = null;
    var pointOrbit = null;                 // 每个采样点的轨道 id

    var frac = null;
    var gridInfo = null;
    if (state.sampleMode === 'grid') {
      // 整数旋转把格点映到格点；分数平移要求 n 是其分母的倍数，否则轨道会被采样网格截断
      var gridMul = S.translationDenom(prep);
      var nSnap = Math.max(2, Math.ceil(n / gridMul) * gridMul);
      if (nSnap !== n) gridInfo = { mul: gridMul, n: nSnap };
      n = nSnap;
      frac = S.sampleGrid(n);
      if (gridInfo) {
        el.sampleHint.textContent = '在晶胞内取 ' + Math.pow(n, 3) + ' 个均匀格点（为完整轨道，密度自动对齐到 ' +
          n + '³，平移分母 ' + gridMul + '）。';
      }
    } else if (state.sampleMode === 'random') {
      // 随机点会补全每个种子点的整个轨道
      frac = expandRandomOrbits(prep, S.sampleRandom(n * n * n, 20241016));
    }

    var colorMode = state.colorMode;
    var canonBounds = canonicalBounds(groupKey, prep);

    function orbitIdOf(qx, qy, qz) {
      var key = qx + '/' + qy + '/' + qz;
      var id = orbitKeys[key];
      if (id === undefined) {
        id = orbitCount++;
        orbitKeys[key] = id;
        orbitReps[id] = [qx / QUANT, qy / QUANT, qz / QUANT];
      }
      return id;
    }

    if (frac) {
      count = frac.length / 3;
      positions = new Float32Array(count * 3);
      colors = new Float32Array(count * 3);
      pointOrbit = new Int32Array(count);
      var B00 = B[0][0], B01 = B[0][1], B02 = B[0][2];
      var B10 = B[1][0], B11 = B[1][1], B12 = B[1][2];
      var B20 = B[2][0], B21 = B[2][1], B22 = B[2][2];
      for (var i = 0; i < count; i++) {
        var x = frac[i * 3], y = frac[i * 3 + 1], z = frac[i * 3 + 2];
        positions[i * 3] = B00 * x + B01 * y + B02 * z;
        positions[i * 3 + 1] = B10 * x + B11 * y + B12 * z;
        positions[i * 3 + 2] = B20 * x + B21 * y + B22 * z;
        var q = S.canonicalize(prep, x, y, z);
        var qx = q[0], qy = q[1], qz = q[2];
        pointOrbit[i] = orbitIdOf(qx, qy, qz);
        var col;
        if (colorMode === 'orbit') col = colorOrbit(qx, qy, qz);
        else if (colorMode === 'pos') col = C.colorCode(x, y, z);
        else col = colorFromRep(qx, qy, qz, canonBounds);
        colors[i * 3] = col[0];
        colors[i * 3 + 1] = col[1];
        colors[i * 3 + 2] = col[2];
      }
    } else {
      var seeds = parseCustomPoints(state.customText);
      customInfo = { seeds: seeds.length, orbits: [] };
      var seedList = [];
      for (var s = 0; s < seeds.length; s++) {
        var sd = seeds[s];
        var qq = S.canonicalize(prep, sd[0], sd[1], sd[2]);
        var qc = [qq[0], qq[1], qq[2]];
        var okey2 = qc[0] + '/' + qc[1] + '/' + qc[2];
        if (orbitKeys[okey2] !== undefined) continue; // 重复轨道
        var oid2 = orbitIdOf(qc[0], qc[1], qc[2]);
        var mode2 = colorMode === 'pos' ? 'canon' : colorMode;
        seedList.push({
          orb: S.orbitOf(prep, sd[0], sd[1], sd[2]),
          oid: oid2,
          rep: orbitReps[oid2],
          discrete: mode2 === 'orbit'
        });
      }
      var pts = [];
      var cols = [];
      var orbIds = [];
      for (var sk = 0; sk < seedList.length; sk++) {
        var item = seedList[sk];
        var base;
        if (item.discrete) {
          // 离散模式：按种子序号取黄金角色相，保证各轨道颜色尽量分开
          base = hslToRgb((0.08 + sk * 0.6180339887) % 1, 0.82, 0.56);
        } else {
          base = colorFromRep(
            item.rep[0] * QUANT, item.rep[1] * QUANT, item.rep[2] * QUANT, canonBounds);
        }
        customInfo.orbits.push({ size: item.orb.length, color: base });
        for (var oi = 0; oi < item.orb.length; oi++) {
          pts.push(item.orb[oi]);
          cols.push(base);
          orbIds.push(item.oid);
        }
      }
      count = pts.length;
      positions = new Float32Array(count * 3);
      colors = new Float32Array(count * 3);
      pointOrbit = new Int32Array(count);
      for (var j = 0; j < count; j++) {
        var p = pts[j];
        positions[j * 3] = B[0][0] * p[0] + B[0][1] * p[1] + B[0][2] * p[2];
        positions[j * 3 + 1] = B[1][0] * p[0] + B[1][1] * p[1] + B[1][2] * p[2];
        positions[j * 3 + 2] = B[2][0] * p[0] + B[2][1] * p[1] + B[2][2] * p[2];
        var cc = cols[j];
        colors[j * 3] = cc[0];
        colors[j * 3 + 1] = cc[1];
        colors[j * 3 + 2] = cc[2];
        pointOrbit[j] = orbIds[j];
      }
      if (customInfo.seeds !== orbitCount) customInfo.seeds = orbitCount;
    }

    /* ---- 记录点数据（供点击高亮等价点使用） ---- */
    lastPoints = {
      positions: positions,
      baseColors: colors.slice(),
      orbitIds: pointOrbit,
      count: count,
      reps: orbitReps
    };
    selectedOrbit = -1;
    lastGroupInfo = group;
    lastPrep = prep;
    lastBounds = canonBounds;
    updateSelectionInfo();

    /* ---- 推给渲染器 ---- */
    var lenA = Math.hypot(B[0][0], B[1][0], B[2][0]);
    var lenB = Math.hypot(B[0][1], B[1][1], B[2][1]);
    var lenC = Math.hypot(B[0][2], B[1][2], B[2][2]);
    var minLen = Math.min(lenA, lenB, lenC) || 1;
    var gridSpacing = minLen / Math.max(4, Math.round(Math.cbrt(Math.max(1, count))));
    var sizeWorld = (state.sampleMode === 'custom' ? reach * 0.075 : gridSpacing * 1.05) * state.pointSize;
    lastSizeWorld = sizeWorld / Math.max(0.01, state.pointSize);

    renderer.setPoints(positions, colors, count);
    renderer.setHighlightPoints(null, null, 0);
    renderer.configure({
      pointSizeWorld: sizeWorld,
      alpha: state.blend === 'glow' ? state.alpha * 0.085 : state.alpha,
      blend: state.blend,
      showNeighbors: state.showNeighbors,
      showSymAxes: state.showSymAxes,
      showMirrors: state.showMirrors,
      autoRotate: state.autoRotate
    });

    var symGeo = buildSymmetryGeometry(group, B, reach);
    renderer.setSymmetryGeometry(symGeo);

    /* ---- 界面信息 ---- */
    updateStats({ group: group, prep: prep, count: count, orbitCount: orbitCount, customInfo: customInfo });
    updateStatus({
      group: group, holo: holo, warning: warning, alignSystem: alignSystem,
      cell: cell, count: count, customInfo: customInfo
    });
    updateHud(group, count, orbitCount);

    // 如果此前用坐标选取过等价点，晶胞/群变化后重新展开
    if (state.coordSel) {
      applyCoordSelection(state.coordSel.x, state.coordSel.y, state.coordSel.z);
    }
  }

  /* ================================================================
   *  界面更新
   * ================================================================ */

  function updateStats(info) {
    var group = info.group;
    el.statSg.textContent = group.space
      ? (group.hm + '（No. ' + group.number + '）')
      : '—';
    el.statGroup.textContent = group.space
      ? group.pointGroup
      : (group.hm + (group.auto ? ' · 自动' : ''));
    el.statSystem.textContent = S.SYSTEM_LABELS[group.system] || group.system || '—';
    if (group.space) {
      el.statOps.textContent = info.prep.count + ' 个通用位置' +
        (group.choice && group.choice !== '' ? '（origin choice ' + group.choice + '）' : '');
    } else {
      el.statOps.textContent = info.prep.count + ' 个（' + group.order + ' × ' +
        S.CENTERINGS[state.centering].length + '）';
    }
    el.statPoints.textContent = String(info.count) +
      (info.customInfo ? '（' + info.customInfo.seeds + ' 种子）' : '');
    el.statOrbits.textContent = String(info.orbitCount);
    el.statAvg.textContent = (info.count / Math.max(1, info.orbitCount)).toFixed(2);

    el.elements.innerHTML = '';
    var summary = S.summarizeMatrices(group.matrices);
    summary.sort(function (a, b) { return b.order - a.order; });
    for (var i = 0; i < summary.length; i++) {
      var it = summary[i];
      var tag = document.createElement('span');
      tag.textContent = (S.KIND_LABELS[it.kind] || it.kind) + ' ×' + it.count;
      el.elements.appendChild(tag);
    }
  }

  function updateStatus(info) {
    el.statHolo.textContent = info.holo.ok
      ? (info.holo.hm + ' / ' + info.holo.order)
      : '—';

    var statusLines = [];
    var conventional = info.group.space ? true :
      (S.CENTERING_BY_SYSTEM[info.group.system] || ['P']).indexOf(state.centering) >= 0;

    if (info.warning) {
      statusLines.push('⚠ ' + (info.group.space ? '空间群' : '点群') +
        '与晶胞参数不符，已临时按 P1 显示：' + info.warning);
    } else {
      statusLines.push('✓ ' + (info.group.space ? '空间群与晶胞参数相容' : '点群与晶胞参数相容'));
    }
    if (info.group.space) {
      statusLines.push('空间群 ' + info.group.hm + '（No. ' + info.group.number + '）· 点群 ' +
        info.group.pointGroup + ' · 带心 ' + info.group.centering);
    }
    if (info.holo.ok) {
      statusLines.push('点阵最高对称性：' + info.holo.hm + '（' + info.holo.order + '）');
    }
    if (!conventional) {
      statusLines.push('注：' + state.centering + ' 带心不是该晶系常用设置；轨道仍按「点群 × 带心平移」计算。');
    }
    el.symStatus.className = 'status ' + (info.warning ? 'warn' : 'ok');
    el.symStatus.textContent = statusLines.join('\n');
    el.symStatus.style.whiteSpace = 'pre-line';

    el.warnings.innerHTML = '';
    if (info.warning && info.alignSystem) {
      var msg = document.createElement('div');
      msg.textContent = '可把晶胞参数对齐到「' + S.SYSTEM_LABELS[info.alignSystem] + '」以匹配该' +
        (info.group.space ? '空间群' : '点群') + '：';
      el.warnings.appendChild(msg);
      var btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = '对齐晶胞参数';
      btn.addEventListener('click', function () {
        state.cell = S.alignCellToSystem(readCellState(), info.alignSystem);
        syncCellInputs();
        schedule(0);
      });
      el.warnings.appendChild(btn);
    } else if (info.customInfo) {
      var msg2 = document.createElement('div');
      msg2.textContent = '种子点 ' + info.customInfo.seeds + ' 个，展开后 ' +
        info.count + ' 个点；同色 = 同一轨道。';
      el.warnings.appendChild(msg2);
    }
  }

  function updateHud(group, count, orbitCount) {
    el.hud.innerHTML = '';
    var strong = document.createElement('strong');
    strong.textContent = group.space
      ? (group.hm + '（' + group.pointGroup + '）')
      : ((state.pointGroup === '__auto' ? '自动 · ' : '') + group.hm);
    var small = document.createElement('small');
    small.textContent = count + ' 点 · ' + orbitCount + ' 轨道 · ' +
      (S.SYSTEM_LABELS[group.system] || '');
    el.hud.appendChild(strong);
    el.hud.appendChild(small);
  }

  function initLabels() {
    var items = [
      { text: 'a', color: '#ff8095' },
      { text: 'b', color: '#6ff0b4' },
      { text: 'c', color: '#7aa2ff' }
    ];
    for (var i = 0; i < items.length; i++) {
      var d = document.createElement('div');
      d.className = 'axis-label';
      d.textContent = items[i].text;
      d.style.color = items[i].color;
      d.style.display = 'none';
      el.labels.appendChild(d);
      labelEls.push(d);
    }
  }

  function updateLabels() {
    if (!lastB) return;
    var ends = [
      [lastB[0][0], lastB[1][0], lastB[2][0]],
      [lastB[0][1], lastB[1][1], lastB[2][1]],
      [lastB[0][2], lastB[1][2], lastB[2][2]]
    ];
    var W = canvas.clientWidth, H = canvas.clientHeight;
    for (var i = 0; i < 3; i++) {
      var p = renderer.project(ends[i]);
      if (!p || !p.visible) { labelEls[i].style.display = 'none'; continue; }
      var x = Math.max(10, Math.min(W - 10, p.x));
      var y = Math.max(12, Math.min(H - 12, p.y));
      labelEls[i].style.display = 'block';
      labelEls[i].style.transform = 'translate(' + x + 'px,' + y + 'px) translate(-50%,-50%)';
    }
  }

  /* ================================================================
   *  表单同步 / 事件
   * ================================================================ */

  function fillPointGroupSelect() {
    var order = ['triclinic', 'monoclinic', 'orthorhombic', 'tetragonal', 'trigonal', 'hexagonal', 'cubic'];
    var bySystem = Object.create(null);
    for (var i = 0; i < S.POINT_GROUPS.length; i++) {
      var d = S.POINT_GROUPS[i];
      (bySystem[d.system] = bySystem[d.system] || []).push(d.hm);
    }
    var html = '<option value="__auto">点阵全对称（自动识别）</option>';
    for (var s = 0; s < order.length; s++) {
      var sys = order[s];
      html += '<optgroup label="' + S.SYSTEM_LABELS[sys] + '">';
      var list = bySystem[sys] || [];
      for (var k = 0; k < list.length; k++) {
        html += '<option value="' + list[k] + '">' + list[k] + '</option>';
      }
      html += '</optgroup>';
    }
    el.pg.innerHTML = html;
  }

  function syncCellInputs() {
    el.cellA.value = state.cell.a;
    el.cellB.value = state.cell.b;
    el.cellC.value = state.cell.c;
    el.cellAlpha.value = state.cell.alpha;
    el.cellBeta.value = state.cell.beta;
    el.cellGamma.value = state.cell.gamma;
  }

  function syncUI() {
    syncCellInputs();
    el.pg.value = state.pointGroup;
    el.centering.value = state.centering;
    el.sample.value = state.sampleMode;
    el.res.value = state.resolution;
    el.resValue.textContent = state.resolution + '³';
    el.color.value = state.colorMode;
    el.psize.value = state.pointSize;
    el.psizeValue.textContent = Number(state.pointSize).toFixed(2);
    el.alpha.value = state.alpha;
    el.alphaValue.textContent = Number(state.alpha).toFixed(2);
    el.blend.value = state.blend;
    el.autorot.checked = state.autoRotate;
    el.neighbors.checked = state.showNeighbors;
    el.symaxes.checked = state.showSymAxes;
    el.mirrors.checked = state.showMirrors;
    el.custom.value = state.customText;
    if (SG && SG.byNumber && el.sg) {
      el.sg.value = String(state.spaceGroupNo);
    }
    updateSymmetryModeUI();
    updateSampleVisibility();
  }

  function updateSampleVisibility() {
    var isCustom = state.sampleMode === 'custom';
    el.customField.hidden = !isCustom;
    el.resField.hidden = isCustom;
    if (isCustom) {
      el.sampleHint.textContent = '输入若干分数坐标（每行 x y z）；每个种子点按当前对称群展开成轨道，同一轨道的点同色。';
    } else if (state.sampleMode === 'random') {
      el.sampleHint.textContent = '在晶胞内随机取 ' + Math.pow(state.resolution, 3) +
        ' 个种子点，并把每个种子点的完整轨道补全（去重）；点击任意点即可看到完整等效点。';
    } else {
      el.sampleHint.textContent = '在晶胞内取 ' + Math.pow(state.resolution, 3) +
        ' 个均匀格点；带心 / 滑移 / 螺旋的群会把密度对齐到所需倍数，保证等效点完整。';
    }
  }

  function schedule(ms) {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(function () {
      pendingTimer = 0;
      recompute();
    }, ms === undefined ? 45 : ms);
  }

  function bindEvents() {
    function cellInput(key, input, isAngle) {
      input.addEventListener('input', function () {
        var v = Number(input.value);
        if (!isFinite(v) || v <= 0) return;
        if (isAngle && (v <= 0 || v >= 180)) return;
        state.cell[key] = v;
        schedule();
      });
      input.addEventListener('change', function () {
        var v = Number(input.value);
        if (!isFinite(v) || v <= 0 || (isAngle && (v <= 0 || v >= 180))) {
          syncCellInputs();
          return;
        }
        state.cell[key] = v;
        schedule(0);
      });
    }
    cellInput('a', el.cellA, false);
    cellInput('b', el.cellB, false);
    cellInput('c', el.cellC, false);
    cellInput('alpha', el.cellAlpha, true);
    cellInput('beta', el.cellBeta, true);
    cellInput('gamma', el.cellGamma, true);

    el.pg.addEventListener('change', function () {
      state.pointGroup = el.pg.value;
      schedule(0);
    });
    el.centering.addEventListener('change', function () {
      state.centering = el.centering.value;
      schedule(0);
    });
    el.symMode.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.mode-btn') : null;
      if (!btn) return;
      state.symmetryMode = btn.getAttribute('data-mode') === 'space' ? 'space' : 'point';
      if (state.symmetryMode === 'space') {
        var sg = currentSpaceGroup();
        state.spaceGroupVariant = Math.min(state.spaceGroupVariant,
          Math.max(0, (sg ? sg.variants.length : 1) - 1));
      }
      syncUI();
      schedule(0);
    });
    el.sg.addEventListener('change', function () {
      state.spaceGroupNo = Number(el.sg.value) || 1;
      state.spaceGroupVariant = 0;
      syncUI();
      schedule(0);
    });
    el.origin.addEventListener('change', function () {
      state.spaceGroupVariant = Number(el.origin.value) || 0;
      schedule(0);
    });
    el.sample.addEventListener('change', function () {
      state.sampleMode = el.sample.value;
      // 自定义点集默认用「每轨道一色」，网格/随机点默认用连续色
      if (state.sampleMode === 'custom' && state.colorMode !== 'orbit') {
        state.colorMode = 'orbit';
        el.color.value = 'orbit';
      } else if (state.sampleMode !== 'custom' && state.colorMode === 'orbit') {
        state.colorMode = 'canon';
        el.color.value = 'canon';
      }
      updateSampleVisibility();
      schedule(0);
    });
    el.res.addEventListener('input', function () {
      state.resolution = Number(el.res.value);
      el.resValue.textContent = state.resolution + '³';
      updateSampleVisibility();
      schedule(80);
    });
    el.custom.addEventListener('input', function () {
      state.customText = el.custom.value;
      schedule(260);
    });
    el.color.addEventListener('change', function () {
      state.colorMode = el.color.value;
      schedule(0);
    });
    el.psize.addEventListener('input', function () {
      state.pointSize = Number(el.psize.value);
      el.psizeValue.textContent = state.pointSize.toFixed(2);
      renderer.configure({ pointSizeWorld: lastSizeWorld * state.pointSize });
    });
    el.alpha.addEventListener('input', function () {
      state.alpha = Number(el.alpha.value);
      el.alphaValue.textContent = state.alpha.toFixed(2);
      renderer.configure({
        alpha: state.blend === 'glow' ? state.alpha * 0.085 : state.alpha
      });
    });
    el.blend.addEventListener('change', function () {
      state.blend = el.blend.value;
      schedule(0);
    });
    el.autorot.addEventListener('change', function () {
      state.autoRotate = el.autorot.checked;
      renderer.configure({ autoRotate: state.autoRotate });
    });
    el.neighbors.addEventListener('change', function () {
      state.showNeighbors = el.neighbors.checked;
      renderer.configure({ showNeighbors: state.showNeighbors });
    });
    el.symaxes.addEventListener('change', function () {
      state.showSymAxes = el.symaxes.checked;
      renderer.configure({ showSymAxes: state.showSymAxes });
    });
    el.mirrors.addEventListener('change', function () {
      state.showMirrors = el.mirrors.checked;
      renderer.configure({ showMirrors: state.showMirrors });
    });

    el.presets.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.chip') : null;
      if (!btn) return;
      var sys = btn.getAttribute('data-system');
      var preset = PRESETS[sys];
      var sample = S.SYSTEM_SAMPLES[sys];
      if (!preset || !sample) return;
      state.cell = { a: sample.a, b: sample.b, c: sample.c, alpha: sample.alpha, beta: sample.beta, gamma: sample.gamma };
      if (state.symmetryMode === 'space') {
        if (SPACE_PRESETS[sys]) state.spaceGroupNo = SPACE_PRESETS[sys];
        state.spaceGroupVariant = 0;
      } else {
        state.pointGroup = preset.group;
        state.centering = preset.centering;
      }
      var chips = el.presets.querySelectorAll('.chip');
      for (var i = 0; i < chips.length; i++) {
        chips[i].classList.toggle('active', chips[i] === btn);
      }
      syncUI();
      schedule(0);
    });

    byId('btn-lowest').addEventListener('click', function () {
      state.symmetryMode = 'point';
      state.pointGroup = '1';
      state.centering = 'P';
      syncUI();
      schedule(0);
    });
    byId('btn-maxsym').addEventListener('click', function () {
      state.symmetryMode = 'point';
      state.pointGroup = '__auto';
      syncUI();
      schedule(0);
    });
    byId('btn-sel-coord').addEventListener('click', function () {
      var x = parseFloat(el.selX.value);
      var y = parseFloat(el.selY.value);
      var z = parseFloat(el.selZ.value);
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) {
        if (el.coordHint) el.coordHint.textContent = '请输入有效的分数坐标（数字）。';
        return;
      }
      if (el.coordHint) {
        el.coordHint.textContent = '输入分数坐标（自动对 1 取余），按当前对称群展开完整等价点并高亮；比鼠标点选更精确。';
      }
      if (!applyCoordSelection(x, y, z)) {
        if (el.coordHint) el.coordHint.textContent = '点云尚未就绪，请稍后再试。';
      }
    });
    byId('btn-sel-clear').addEventListener('click', function () {
      clearHighlight();
    });
    byId('btn-reset').addEventListener('click', function () {
      renderer.resetView();
    });
    byId('btn-png').addEventListener('click', function () {
      var url = renderer.toDataURL();
      var a = document.createElement('a');
      a.href = url;
      a.download = 'crystal-symmetry-' + Date.now() + '.png';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
  }

  /* ================================================================
   *  按分数坐标选取等价点（比鼠标点选精确）
   * ================================================================ */

  function normFrac(v) {
    v = v % 1;
    return v < 0 ? v + 1 : v;
  }

  function applyCoordSelection(x, y, z) {
    if (!lastPoints || !lastPrep || !lastB || !lastBounds) return false;
    x = normFrac(x); y = normFrac(y); z = normFrac(z);
    var prep = lastPrep;
    var q = S.canonicalize(prep, x, y, z);
    var rep = [q[0] / S.QUANT, q[1] / S.QUANT, q[2] / S.QUANT];
    var orb = S.orbitOf(prep, x, y, z);
    if (!orb.length) return false;

    var B = lastB;
    var selPos = new Float32Array(orb.length * 3);
    var selCol = new Float32Array(orb.length * 3);
    var colorMode = state.colorMode;
    var baseCol = null;
    if (colorMode === 'orbit') baseCol = colorOrbit(q[0], q[1], q[2]);
    else if (colorMode === 'canon') baseCol = colorFromRep(q[0], q[1], q[2], lastBounds);
    for (var i = 0; i < orb.length; i++) {
      var p = orb[i];
      var col = colorMode === 'pos' ? C.colorCode(p[0], p[1], p[2]) : baseCol;
      selPos[i * 3] = B[0][0] * p[0] + B[0][1] * p[1] + B[0][2] * p[2];
      selPos[i * 3 + 1] = B[1][0] * p[0] + B[1][1] * p[1] + B[1][2] * p[2];
      selPos[i * 3 + 2] = B[2][0] * p[0] + B[2][1] * p[1] + B[2][2] * p[2];
      selCol[i * 3] = 0.45 + 0.55 * col[0];
      selCol[i * 3 + 1] = 0.45 + 0.55 * col[1];
      selCol[i * 3 + 2] = 0.45 + 0.55 * col[2];
    }

    // 底图整体压暗，只留下坐标轨道的发光点
    var base = lastPoints.baseColors;
    var cols = new Float32Array(lastPoints.count * 3);
    for (var k = 0; k < lastPoints.count; k++) {
      var o = k * 3;
      cols[o] = base[o] * 0.10;
      cols[o + 1] = base[o + 1] * 0.10;
      cols[o + 2] = base[o + 2] * 0.10;
    }
    renderer.setPoints(lastPoints.positions, cols, lastPoints.count);
    renderer.setHighlightPoints(selPos, selCol, orb.length);

    selectedOrbit = -1;
    state.coordSel = { x: x, y: y, z: z };
    lastHighlightCount = orb.length;

    if (el.selX) {
      el.selX.value = String(Number(x.toFixed(6)));
      el.selY.value = String(Number(y.toFixed(6)));
      el.selZ.value = String(Number(z.toFixed(6)));
    }
    if (el.selection) {
      el.selection.style.display = 'block';
      el.selection.textContent = '坐标选取 · 输入 (' +
        x.toFixed(3) + ', ' + y.toFixed(3) + ', ' + z.toFixed(3) + ') · 代表点 (' +
        rep[0].toFixed(3) + ', ' + rep[1].toFixed(3) + ', ' + rep[2].toFixed(3) +
        ') · 轨道大小 ' + orb.length + ' · 按 Esc 取消';
    }
    return true;
  }

  function clearCoordSelection() {
    state.coordSel = null;
    lastHighlightCount = 0;
  }

  /* ================================================================
   *  点击高亮等价点
   * ================================================================ */

  function updateSelectionInfo() {
    var box = el.selection;
    if (!box) return;
    if (!lastPoints || selectedOrbit < 0) {
      box.style.display = 'none';
      return;
    }
    var rep = lastPoints.reps[selectedOrbit] || [0, 0, 0];
    var size = 0;
    for (var i = 0; i < lastPoints.count; i++) {
      if (lastPoints.orbitIds[i] === selectedOrbit) size++;
    }
    box.style.display = 'block';
    box.textContent = '已选轨道 · 代表点 (' +
      rep[0].toFixed(3) + ', ' + rep[1].toFixed(3) + ', ' + rep[2].toFixed(3) +
      ') · 轨道大小 ' + size + ' · 按 Esc 取消';
  }

  function paintSelection(oid) {
    if (!lastPoints) return;
    var cols = new Float32Array(lastPoints.count * 3);
    var base = lastPoints.baseColors;
    var selPos = [];
    var selCol = [];
    for (var i = 0; i < lastPoints.count; i++) {
      var o = i * 3;
      var isSel = oid >= 0 && lastPoints.orbitIds[i] === oid;
      if (isSel) {
        // 选中的等价点在底图里淡化（由上面的发光层负责显示）
        cols[o] = base[o] * 0.35;
        cols[o + 1] = base[o + 1] * 0.35;
        cols[o + 2] = base[o + 2] * 0.35;
        selPos.push(lastPoints.positions[o], lastPoints.positions[o + 1], lastPoints.positions[o + 2]);
        // 发光色：接近白色，带一点原色相，避免完全失去颜色身份
        selCol.push(0.45 + 0.55 * base[o], 0.45 + 0.55 * base[o + 1], 0.45 + 0.55 * base[o + 2]);
      } else if (oid >= 0) {
        // 其余点：压暗
        cols[o] = base[o] * 0.10;
        cols[o + 1] = base[o + 1] * 0.10;
        cols[o + 2] = base[o + 2] * 0.10;
      } else {
        cols[o] = base[o];
        cols[o + 1] = base[o + 1];
        cols[o + 2] = base[o + 2];
      }
    }
    renderer.setPoints(lastPoints.positions, cols, lastPoints.count);
    lastHighlightCount = selPos.length / 3;
    if (selPos.length) {
      renderer.setHighlightPoints(
        new Float32Array(selPos),
        new Float32Array(selCol),
        selPos.length / 3
      );
    } else {
      renderer.setHighlightPoints(null, null, 0);
    }
  }

  function highlightOrbit(oid) {
    clearCoordSelection();
    selectedOrbit = oid;
    paintSelection(oid);
    updateSelectionInfo();
  }

  function clearHighlight() {
    clearCoordSelection();
    selectedOrbit = -1;
    paintSelection(-1);
    updateSelectionInfo();
  }

  // 单击（没有拖动）→ 高亮该点所在的等价点集；Esc / 双击 → 取消
  var _pickStart = null;
  canvas.addEventListener('pointerdown', function (e) {
    _pickStart = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointerup', function (e) {
    if (!_pickStart) return;
    var moved = Math.hypot(e.clientX - _pickStart.x, e.clientY - _pickStart.y);
    _pickStart = null;
    if (moved > 5) return; // 拖动旋转，不算点击
    pickNearestPoint(e.clientX, e.clientY);
  });
  canvas.addEventListener('dblclick', function () { clearHighlight(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') clearHighlight();
  });

  /** 屏幕坐标拾取最近的点，并高亮它所在的整个轨道 */
  function pickNearestPoint(clientX, clientY) {
    if (!lastPoints) return;
    var rect = canvas.getBoundingClientRect();
    var px = clientX - rect.left;
    var py = clientY - rect.top;
    var best = -1;
    var bestD = 18 * 18;
    for (var i = 0; i < lastPoints.count; i++) {
      var pr = renderer.project([
        lastPoints.positions[i * 3],
        lastPoints.positions[i * 3 + 1],
        lastPoints.positions[i * 3 + 2]
      ]);
      if (!pr || !pr.visible) continue;
      var dd = (pr.x - px) * (pr.x - px) + (pr.y - py) * (pr.y - py);
      if (dd < bestD) { bestD = dd; best = i; }
    }
    if (best < 0) { clearHighlight(); return; }
    var oid = lastPoints.orbitIds[best];
    if (oid === selectedOrbit) { clearHighlight(); return; }
    highlightOrbit(oid);
  }

  window.__crystalDebug = {
    colorCode: function (u, v, w) { return C.colorCode(u, v, w); },
    colorFromRep: function (qx, qy, qz) {
      return colorFromRep(qx, qy, qz, lastBounds);
    },
    getBounds: function () { return lastBounds; },
    getGroup: function () { return lastGroupInfo; },
    getPrep: function () { return lastPrep; },
    getPointCount: function () { return lastPoints ? lastPoints.count : 0; },
    getHighlightCount: function () { return lastHighlightCount; },
    getCoordSelection: function () { return state.coordSel; },
    selectCoord: function (x, y, z) { return applyCoordSelection(x, y, z); },
    getOrbitCount: function () {
      if (!lastPoints) return 0;
      var ids = Object.create(null);
      var n = 0;
      for (var i = 0; i < lastPoints.count; i++) {
        var id = lastPoints.orbitIds[i];
        if (ids[id] === undefined) { ids[id] = 1; n++; }
      }
      return n;
    },
    /** 返回某个可见点在屏幕上的坐标（测试用） */
    projectPoint: function (index) {
      if (!lastPoints || index < 0 || index >= lastPoints.count) return null;
      var pr = renderer.project([
        lastPoints.positions[index * 3],
        lastPoints.positions[index * 3 + 1],
        lastPoints.positions[index * 3 + 2]
      ]);
      if (!pr || !pr.visible) return null;
      var rect = canvas.getBoundingClientRect();
      return { x: rect.left + pr.x, y: rect.top + pr.y, visible: true };
    },
    /** 找一个靠近画面中心、可见且轨道大小 > 1 的采样点（测试用） */
    pickCenterPoint: function () {
      if (!lastPoints) return null;
      var rect = canvas.getBoundingClientRect();
      var cx = canvas.clientWidth / 2;
      var cy = canvas.clientHeight / 2;
      var counts = Object.create(null);
      for (var q = 0; q < lastPoints.count; q++) {
        var oid0 = lastPoints.orbitIds[q];
        counts[oid0] = (counts[oid0] || 0) + 1;
      }
      var best = -1;
      var bestPr = null;
      var bestD = Infinity;
      for (var i = 0; i < lastPoints.count; i++) {
        if (counts[lastPoints.orbitIds[i]] <= 1) continue;
        var pr = renderer.project([
          lastPoints.positions[i * 3],
          lastPoints.positions[i * 3 + 1],
          lastPoints.positions[i * 3 + 2]
        ]);
        if (!pr || !pr.visible) continue;
        var dd = (pr.x - cx) * (pr.x - cx) + (pr.y - cy) * (pr.y - cy);
        if (dd < bestD) { bestD = dd; best = i; bestPr = pr; }
      }
      if (best < 0 || !bestPr) return null;
      return { index: best, x: rect.left + bestPr.x, y: rect.top + bestPr.y };
    },
    clearHighlight: clearHighlight
  };

  /* ================================================================
   *  查询参数（便于截图 / 分享固定视图）
   * ================================================================ */

  function applyQuery() {
    var q = new URLSearchParams(window.location.search);
    function num(key) {
      var v = q.get(key);
      if (v === null || v === '') return null;
      var n = Number(v);
      return isFinite(n) ? n : null;
    }
    var a = num('a'), b = num('b'), c = num('c');
    var al = num('al'), be = num('be'), ga = num('ga');
    if (a !== null) state.cell.a = a;
    if (b !== null) state.cell.b = b;
    if (c !== null) state.cell.c = c;
    if (al !== null) state.cell.alpha = al;
    if (be !== null) state.cell.beta = be;
    if (ga !== null) state.cell.gamma = ga;
    var pg = q.get('pg');
    if (pg) state.pointGroup = pg;
    var cent = q.get('cent');
    if (cent) state.centering = cent;
    if (q.get('mode') === 'space') state.symmetryMode = 'space';
    var sgn = num('sg');
    if (sgn !== null) {
      state.symmetryMode = 'space';
      state.spaceGroupNo = Math.max(1, Math.min(230, Math.round(sgn)));
    }
    var orig = num('orig');
    if (orig !== null) state.spaceGroupVariant = Math.max(0, Math.round(orig));
    var nv = num('n');
    if (nv !== null) state.resolution = Math.max(4, Math.min(48, Math.round(nv)));
    var sample = q.get('sample');
    if (sample) state.sampleMode = sample;
    var color = q.get('color');
    if (color) state.colorMode = color;
    var size = num('size');
    if (size !== null) state.pointSize = size;
    var alpha = num('alpha');
    if (alpha !== null) state.alpha = alpha;
    var blend = q.get('blend');
    if (blend) state.blend = blend;
    if (q.get('autorot') === '0') state.autoRotate = false;
    if (q.get('autorot') === '1') state.autoRotate = true;
    if (q.get('neighbors') === '1') state.showNeighbors = true;
    if (q.get('symaxes') === '1') state.showSymAxes = true;
    if (q.get('mirrors') === '1') state.showMirrors = true;
    if (q.get('custom')) state.customText = q.get('custom');
    var selx = num('selx'), sely = num('sely'), selz = num('selz');
    if (selx !== null && sely !== null && selz !== null) {
      state.coordSel = { x: selx, y: sely, z: selz };
    }
    var theta = num('theta'), phi = num('phi'), dist = num('dist');
    if (theta !== null) renderer.setCamera({ theta: theta });
    if (phi !== null) renderer.setCamera({ phi: phi });
    if (dist !== null) renderer.setCamera({ dist: dist });
    if (q.get('ui') === '0') {
      byId('panel').style.display = 'none';
    }
    return q;
  }

  /* ================================================================
   *  启动
   * ================================================================ */

  function start() {
    fillPointGroupSelect();
    fillSpaceGroupSelect();
    initLabels();
    bindEvents();
    applyQuery();
    syncUI();
    renderer.onFrame(function () {
      updateLabels();
    });
    recompute();
    renderer.start();
  }

  start();
})();
