/*!
 * color.js — 三维颜色码（基本域代表点 → CIELAB 亮色子空间）
 *
 * 设计目标（与需求一一对应）：
 *   1. 同一轨道 → 同一代表点 → 同一个颜色（严格相等，不做任何采样归一化）；
 *   2. 不同轨道 → 不同颜色，且代表点相距越远、颜色差越大（距离单调）；
 *   3. 颜色连续：代表点连续变化时颜色连续变化（无循环回绕、无等色面）；
 *   4. 亮度参与编码，但 L 有下限（不会出现过暗的点），并且所有颜色都在 sRGB 色域内。
 *
 * 做法：
 *   - u → L（CIELAB 亮度，L_MIN..L_MAX）
 *   - 色度用有限斜率曲线 0.5ρ+0.5ρ²（中心梯度有限，避免“色涡”）
 *   - (v,w) → 圆盘（Shirley–Chiu 方-圆同心映射，连续双射）
 *     半径 ρ → 色度 C = ρ · C_max(L, θ)
 *     角度 θ → 色相方向
 *   - 颜色 = Lab(L, a0 + C·cosθ, b0 + C·sinθ)
 *     其中 (a0, b0) 是固定的色度偏移，避免基本域中心落在灰色轴上。
 *   - C_max(L,θ) 用 sRGB 色域边界二分预先算成查找表：所有颜色都不会被裁切。
 *
 * 该映射在 (u,v,w) ∈ [0,1]³ 上是连续单射的。
 * 浏览器挂 window.CrystalColor，Node 下 require() 可用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CrystalColor = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TAU = Math.PI * 2;

  /* ---------------- 参数 ---------------- */
  var L_MIN = 52;      // 最暗亮度：L*=52 仍属中等亮度，不会发黑
  var L_MAX = 78;      // 最亮亮度：拉宽亮度轴，降低“亮度轴太弱”的各向异性
  var OFFSET_A = 0.0;  // 色度平面中心：纯径向映射（灰点只出现在基本域中心一点）
  var OFFSET_B = 0.0;

  var LUT_NL = 25;     // 亮度方向采样数
  var LUT_NH = 72;     // 色相方向采样数
  var GAMUT_MARGIN = 0.995;

  /* ---------------- sRGB / CIELAB ---------------- */
  var D65 = [0.95047, 1.0, 1.08883];

  function labToSrgbRaw(L, a, b) {
    var fy = (L + 16) / 116;
    var fx = fy + a / 500;
    var fz = fy - b / 200;
    var inv = function (t) {
      var t3 = t * t * t;
      return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787;
    };
    var X = inv(fx) * D65[0];
    var Y = inv(fy) * D65[1];
    var Z = inv(fz) * D65[2];
    var r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
    var g = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z;
    var bb = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
    return [r, g, bb]; // 线性 sRGB
  }

  function linearToSrgb(c) {
    return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  }

  function srgbToLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function inGamut(L, a, b) {
    var lin = labToSrgbRaw(L, a, b);
    return lin[0] >= -1e-7 && lin[0] <= 1 + 1e-7 &&
           lin[1] >= -1e-7 && lin[1] <= 1 + 1e-7 &&
           lin[2] >= -1e-7 && lin[2] <= 1 + 1e-7;
  }

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

  /* ---------------- 色域查找表 ---------------- */
  var CMAX = null;

  function buildLut() {
    CMAX = new Float32Array(LUT_NL * LUT_NH);
    for (var i = 0; i < LUT_NL; i++) {
      var L = L_MIN + (L_MAX - L_MIN) * i / (LUT_NL - 1);
      for (var j = 0; j < LUT_NH; j++) {
        var th = (j / LUT_NH) * TAU;
        var cos = Math.cos(th), sin = Math.sin(th);
        var lo = 0, hi = 160;
        for (var k = 0; k < 24; k++) {
          var mid = (lo + hi) / 2;
          if (inGamut(L, OFFSET_A + mid * cos, OFFSET_B + mid * sin)) lo = mid;
          else hi = mid;
        }
        CMAX[i * LUT_NH + j] = lo * GAMUT_MARGIN;
      }
    }
  }

  function chromaMax(L, theta) {
    if (!CMAX) buildLut();
    var fi = (L - L_MIN) / (L_MAX - L_MIN) * (LUT_NL - 1);
    if (fi < 0) fi = 0;
    if (fi > LUT_NL - 1) fi = LUT_NL - 1;
    var i0 = Math.floor(fi);
    var i1 = Math.min(LUT_NL - 1, i0 + 1);
    var ft = fi - i0;

    var th = theta / TAU;
    th -= Math.floor(th);
    th *= LUT_NH;
    var j0 = Math.floor(th) % LUT_NH;
    var j1 = (j0 + 1) % LUT_NH;
    var fh = th - Math.floor(th);

    var c00 = CMAX[i0 * LUT_NH + j0];
    var c01 = CMAX[i0 * LUT_NH + j1];
    var c10 = CMAX[i1 * LUT_NH + j0];
    var c11 = CMAX[i1 * LUT_NH + j1];
    return (c00 * (1 - fh) + c01 * fh) * (1 - ft) +
           (c10 * (1 - fh) + c11 * fh) * ft;
  }

  /* ---------------- 方 → 圆同心映射（Shirley–Chiu） ---------------- */
  function squareToDisk(v, w) {
    var x = 2 * v - 1;
    var y = 2 * w - 1;
    if (x === 0 && y === 0) return [0, 0];
    var r, phi;
    if (x * x > y * y) {
      r = x;
      phi = (Math.PI / 4) * (y / x);
    } else {
      r = y;
      phi = Math.PI / 2 - (Math.PI / 4) * (x / y);
    }
    return [r * Math.cos(phi), r * Math.sin(phi)];
  }

  /* ---------------- 主映射 ---------------- */
  /**
   * (u,v,w) ∈ [0,1]³ → sRGB ∈ [0,1]³
   * 连续、单射（在浮点精度内）、全部落在 sRGB 色域内、亮度不低于 L_MIN。
   */
  function colorCode(u, v, w) {
    var L = L_MIN + (L_MAX - L_MIN) * clamp01(u);
    var d = squareToDisk(clamp01(v), clamp01(w));
    var rho = Math.hypot(d[0], d[1]);
    if (rho > 1) rho = 1;
    var theta = Math.atan2(d[1], d[0]);
    // 有限斜率曲线 0.5ρ + 0.5ρ²：
    // 保留“中段更饱和”的效果，但 ρ=0 处导数有限（0.5），
    // 从而消除 ρ^0.45 在色度中心（立方体中心）的无限大梯度，
    // 让面对角线 / 体对角线穿过中心时不再突然爆彩。
    var f = 0.5 * rho + 0.5 * rho * rho;
    var C = f * chromaMax(L, theta);
    var a = OFFSET_A + C * Math.cos(theta);
    var b = OFFSET_B + C * Math.sin(theta);
    var lin = labToSrgbRaw(L, a, b);
    return [clamp01(linearToSrgb(lin[0])),
            clamp01(linearToSrgb(lin[1])),
            clamp01(linearToSrgb(lin[2]))];
  }

  /** 颜色 → CIELAB（测试/诊断用） */
  function rgbToLab(rgb) {
    var r = srgbToLinear(clamp01(rgb[0]));
    var g = srgbToLinear(clamp01(rgb[1]));
    var b = srgbToLinear(clamp01(rgb[2]));
    var X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
    var Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    var Z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
    var f = function (t) { return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; };
    var fx = f(X / D65[0]), fy = f(Y / D65[1]), fz = f(Z / D65[2]);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  function deltaE76(c1, c2) {
    var a = rgbToLab(c1), b = rgbToLab(c2);
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }

  return {
    L_MIN: L_MIN,
    L_MAX: L_MAX,
    OFFSET_A: OFFSET_A,
    OFFSET_B: OFFSET_B,
    colorCode: colorCode,
    squareToDisk: squareToDisk,
    chromaMax: chromaMax,
    rgbToLab: rgbToLab,
    deltaE76: deltaE76,
    labToSrgbRaw: labToSrgbRaw,
    inGamut: inGamut
  };
});
