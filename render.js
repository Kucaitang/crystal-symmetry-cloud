/*!
 * render.js — 简单但够用的 WebGL 点云渲染器（无第三方依赖）
 *
 * 功能：
 *   - 点云（按距离缩放的点精灵、圆形软边、深度测试 / 加法发光两种模式）
 *   - 屏幕空间加粗线段（晶胞棱、坐标轴、对称轴）
 *   - 半透明三角形平面（镜面）
 *   - 轨道相机（拖拽旋转、滚轮缩放、自动旋转）
 *   - 向回调输出投影信息，供 HTML 标注使用
 *
 * 浏览器中挂 window.CrystalRender。
 */
(function (root) {
  'use strict';

  var TAU = Math.PI * 2;
  var BG = [0.045, 0.058, 0.10];

  /* ------------------------------------------------------------------ */
  /*  mat4（列主序）                                                      */
  /* ------------------------------------------------------------------ */

  function mat4Multiply(a, b) {
    var o = new Float32Array(16);
    for (var c = 0; c < 4; c++) {
      for (var r = 0; r < 4; r++) {
        o[c * 4 + r] =
          a[0 * 4 + r] * b[c * 4 + 0] +
          a[1 * 4 + r] * b[c * 4 + 1] +
          a[2 * 4 + r] * b[c * 4 + 2] +
          a[3 * 4 + r] * b[c * 4 + 3];
      }
    }
    return o;
  }

  function mat4Perspective(fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2);
    var nf = 1 / (near - far);
    var m = new Float32Array(16);
    m[0] = f / aspect;
    m[5] = f;
    m[10] = (far + near) * nf;
    m[11] = -1;
    m[14] = 2 * far * near * nf;
    return m;
  }

  function mat4LookAt(eye, center, up) {
    var z0 = eye[0] - center[0], z1 = eye[1] - center[1], z2 = eye[2] - center[2];
    var zl = Math.hypot(z0, z1, z2) || 1;
    z0 /= zl; z1 /= zl; z2 /= zl;
    var x0 = up[1] * z2 - up[2] * z1;
    var x1 = up[2] * z0 - up[0] * z2;
    var x2 = up[0] * z1 - up[1] * z0;
    var xl = Math.hypot(x0, x1, x2);
    if (xl < 1e-9) { x0 = 1; x1 = 0; x2 = 0; xl = 1; }
    x0 /= xl; x1 /= xl; x2 /= xl;
    var y0 = z1 * x2 - z2 * x1;
    var y1 = z2 * x0 - z0 * x2;
    var y2 = z0 * x1 - z1 * x0;
    var m = new Float32Array(16);
    m[0] = x0; m[1] = y0; m[2] = z0; m[3] = 0;
    m[4] = x1; m[5] = y1; m[6] = z1; m[7] = 0;
    m[8] = x2; m[9] = y2; m[10] = z2; m[11] = 0;
    m[12] = -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]);
    m[13] = -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]);
    m[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]);
    m[15] = 1;
    return m;
  }

  /* ------------------------------------------------------------------ */
  /*  着色器                                                              */
  /* ------------------------------------------------------------------ */

  var VS_POINTS = [
    'attribute vec3 aPos;',
    'attribute vec3 aCol;',
    'uniform mat4 uView;',
    'uniform mat4 uProj;',
    'uniform float uSizeWorld;',
    'uniform float uFocal;',
    'uniform float uFogNear;',
    'uniform float uFogFar;',
    'uniform float uFogStrength;',
    'varying vec3 vCol;',
    'varying float vFog;',
    'void main() {',
    '  vec4 vp = uView * vec4(aPos, 1.0);',
    '  gl_Position = uProj * vp;',
    '  float dist = max(0.0001, -vp.z);',
    '  gl_PointSize = clamp(uSizeWorld * uFocal / dist, 1.0, 160.0);',
    '  float fog = smoothstep(uFogNear, uFogFar, dist);',
    '  vFog = fog * uFogStrength;',
    '  vCol = aCol;',
    '}'
  ].join('\n');

  var FS_POINTS = [
    'precision mediump float;',
    'varying vec3 vCol;',
    'varying float vFog;',
    'uniform float uAlpha;',
    'uniform vec3 uBg;',
    'uniform float uSoft;',
    'void main() {',
    '  vec2 d = gl_PointCoord * 2.0 - 1.0;',
    '  float r2 = dot(d, d);',
    '  if (r2 > 1.0) discard;',
    '  float edge = 1.0 - smoothstep(1.0 - uSoft, 1.0, r2);',
    '  vec3 col = mix(vCol, uBg, vFog);',
    '  col *= 0.94 + 0.12 * (1.0 - r2);',
    '  gl_FragColor = vec4(col, uAlpha * edge);',
    '}'
  ].join('\n');

  var VS_LINES = [
    'attribute vec3 aPos;',
    'attribute vec3 aOther;',
    'attribute vec3 aCol;',
    'attribute float aSide;',
    'uniform mat4 uView;',
    'uniform mat4 uProj;',
    'uniform vec2 uViewport;',
    'uniform float uWidth;',
    'varying vec3 vCol;',
    'void main() {',
    '  vec4 cp = uProj * uView * vec4(aPos, 1.0);',
    '  vec4 co = uProj * uView * vec4(aOther, 1.0);',
    '  vec2 sp = cp.xy / cp.w;',
    '  vec2 so = co.xy / max(co.w, 0.0001);',
    '  vec2 d = sp - so;',
    '  float dl = length(d);',
    '  vec2 dir = dl > 1e-7 ? d / dl : vec2(1.0, 0.0);',
    '  vec2 perp = vec2(-dir.y, dir.x);',
    '  cp.xy += perp * aSide * (uWidth / uViewport) * 2.0 * cp.w;',
    '  gl_Position = cp;',
    '  vCol = aCol;',
    '}'
  ].join('\n');

  var FS_LINES = [
    'precision mediump float;',
    'varying vec3 vCol;',
    'uniform float uAlpha;',
    'void main() {',
    '  gl_FragColor = vec4(vCol, uAlpha);',
    '}'
  ].join('\n');

  var VS_FLAT = [
    'attribute vec3 aPos;',
    'attribute vec3 aCol;',
    'uniform mat4 uView;',
    'uniform mat4 uProj;',
    'varying vec3 vCol;',
    'void main() {',
    '  gl_Position = uProj * uView * vec4(aPos, 1.0);',
    '  vCol = aCol;',
    '}'
  ].join('\n');

  var FS_FLAT = [
    'precision mediump float;',
    'varying vec3 vCol;',
    'uniform float uAlpha;',
    'void main() {',
    '  gl_FragColor = vec4(vCol, uAlpha);',
    '}'
  ].join('\n');

  /* 背景：径向渐变 + 轻微暗角 */

  var VS_BG = [
    'attribute vec2 aPos;',
    'void main() {',
    '  gl_Position = vec4(aPos, 0.0, 1.0);',
    '}'
  ].join('\n');

  var FS_BG = [
    'precision mediump float;',
    'uniform vec2 uRes;',
    'void main() {',
    '  vec2 p = gl_FragCoord.xy / uRes - 0.5;',
    '  float d = length(p * vec2(1.0, 1.12));',
    '  float t = smoothstep(0.02, 0.82, d);',
    '  vec3 c0 = vec3(0.052, 0.068, 0.112);',
    '  vec3 c1 = vec3(0.011, 0.015, 0.030);',
    '  vec3 col = mix(c0, c1, t);',
    '  col *= 0.94 + 0.06 * (1.0 - t);',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  /* ------------------------------------------------------------------ */
  /*  工具                                                                */
  /* ------------------------------------------------------------------ */

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('着色器编译失败：' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  function createProgram(gl, vsSrc, fsSrc) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('着色器链接失败：' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  function makeBuffer(gl, data) {
    var b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return b;
  }

  /**
   * 把线段列表构建成「屏幕空间加粗线段」三角形顶点。
   * segments: [{ a:[x,y,z], b:[x,y,z], ca:[r,g,b], cb:[r,g,b] }]
   * 顶点属性：pos3 + other3 + col3 + side1 = 10 floats
   */
  function buildThickLines(segments) {
    var n = segments.length;
    if (!n) return new Float32Array(0);
    var out = new Float32Array(n * 6 * 10);
    var o = 0;
    function vert(p, other, c, side) {
      out[o++] = p[0]; out[o++] = p[1]; out[o++] = p[2];
      out[o++] = other[0]; out[o++] = other[1]; out[o++] = other[2];
      out[o++] = c[0]; out[o++] = c[1]; out[o++] = c[2];
      out[o++] = side;
    }
    for (var i = 0; i < n; i++) {
      var s = segments[i];
      var ca = s.ca || s.c || [1, 1, 1];
      var cb = s.cb || s.c || ca;
      // 三角形 1: A(p0,+1) B(p0,-1) C(p1,-1)
      vert(s.a, s.b, ca, 1);
      vert(s.a, s.b, ca, -1);
      vert(s.b, s.a, cb, -1);
      // 三角形 2: A(p0,+1) C(p1,-1) D(p1,+1)
      vert(s.a, s.b, ca, 1);
      vert(s.b, s.a, cb, -1);
      vert(s.b, s.a, cb, 1);
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /*  渲染器                                                              */
  /* ------------------------------------------------------------------ */

  function create(canvas) {
    var gl = canvas.getContext('webgl', {
      antialias: true,
      alpha: false,
      depth: true,
      preserveDrawingBuffer: true
    });
    if (!gl) return null;

    var progPoints = createProgram(gl, VS_POINTS, FS_POINTS);
    var progLines = createProgram(gl, VS_LINES, FS_LINES);
    var progFlat = createProgram(gl, VS_FLAT, FS_FLAT);
    var progBg = createProgram(gl, VS_BG, FS_BG);

    var loc = {
      points: {
        aPos: gl.getAttribLocation(progPoints, 'aPos'),
        aCol: gl.getAttribLocation(progPoints, 'aCol'),
        uView: gl.getUniformLocation(progPoints, 'uView'),
        uProj: gl.getUniformLocation(progPoints, 'uProj'),
        uSizeWorld: gl.getUniformLocation(progPoints, 'uSizeWorld'),
        uFocal: gl.getUniformLocation(progPoints, 'uFocal'),
        uFogNear: gl.getUniformLocation(progPoints, 'uFogNear'),
        uFogFar: gl.getUniformLocation(progPoints, 'uFogFar'),
        uFogStrength: gl.getUniformLocation(progPoints, 'uFogStrength'),
        uAlpha: gl.getUniformLocation(progPoints, 'uAlpha'),
        uBg: gl.getUniformLocation(progPoints, 'uBg'),
        uSoft: gl.getUniformLocation(progPoints, 'uSoft')
      },
      lines: {
        aPos: gl.getAttribLocation(progLines, 'aPos'),
        aOther: gl.getAttribLocation(progLines, 'aOther'),
        aCol: gl.getAttribLocation(progLines, 'aCol'),
        aSide: gl.getAttribLocation(progLines, 'aSide'),
        uView: gl.getUniformLocation(progLines, 'uView'),
        uProj: gl.getUniformLocation(progLines, 'uProj'),
        uViewport: gl.getUniformLocation(progLines, 'uViewport'),
        uWidth: gl.getUniformLocation(progLines, 'uWidth'),
        uAlpha: gl.getUniformLocation(progLines, 'uAlpha')
      },
      flat: {
        aPos: gl.getAttribLocation(progFlat, 'aPos'),
        aCol: gl.getAttribLocation(progFlat, 'aCol'),
        uView: gl.getUniformLocation(progFlat, 'uView'),
        uProj: gl.getUniformLocation(progFlat, 'uProj'),
        uAlpha: gl.getUniformLocation(progFlat, 'uAlpha')
      }
    };

    var bgBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bgBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var bgLoc = {
      aPos: gl.getAttribLocation(progBg, 'aPos'),
      uRes: gl.getUniformLocation(progBg, 'uRes')
    };

    var buffers = {
      pointsPos: null, pointsCol: null, pointCount: 0,
      cell: null, cellCount: 0,
      neighbor: null, neighborCount: 0,
      axes: null, axesCount: 0,
      symAxes: null, symAxesCount: 0,
      planes: null, planeCount: 0,
      hlPos: null, hlCol: null, hlCount: 0
    };

    var cam = {
      theta: -0.72,
      phi: 0.34,
      dist: 3.1,
      target: [0, 0, 0],
      reach: 1,
      up: [0, 0, 1]
    };

    var view = {
      autoRotate: false,
      pointSizeWorld: 0.05,
      alpha: 1,
      blend: 'solid',
      showNeighbors: false,
      showSymAxes: false,
      showMirrors: false,
      lineWidth: 1.6
    };

    var frameCb = null;
    var running = false;
    var lastTime = 0;
    var frameInfo = null;
    var dpr = Math.min(window.devicePixelRatio || 1, 2.5);

    function resize() {
      var w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      var h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    }

    function eyePosition() {
      var cp = Math.cos(cam.phi);
      return [
        cam.target[0] + cam.dist * cam.reach * cp * Math.cos(cam.theta),
        cam.target[1] + cam.dist * cam.reach * cp * Math.sin(cam.theta),
        cam.target[2] + cam.dist * cam.reach * Math.sin(cam.phi)
      ];
    }

    function matrices() {
      var eye = eyePosition();
      var up = cam.up;
      // 相机接近正上方时换一个 up，避免退化
      if (Math.abs(Math.sin(cam.phi)) > 0.985) up = [0, 1, 0];
      var v = mat4LookAt(eye, cam.target, up);
      var aspect = canvas.width / Math.max(1, canvas.height);
      var fovy = 38 * Math.PI / 180;
      var far = cam.dist * cam.reach * 6 + cam.reach * 6;
      var p = mat4Perspective(fovy, aspect, far * 0.002, far);
      return { view: v, proj: p, eye: eye, fovy: fovy, far: far };
    }

    function projectPoint(p) {
      var m = frameInfo;
      if (!m) return null;
      var x = m.mvp[0] * p[0] + m.mvp[4] * p[1] + m.mvp[8] * p[2] + m.mvp[12];
      var y = m.mvp[1] * p[0] + m.mvp[5] * p[1] + m.mvp[9] * p[2] + m.mvp[13];
      var w = m.mvp[3] * p[0] + m.mvp[7] * p[1] + m.mvp[11] * p[2] + m.mvp[15];
      if (w <= 0.0001) return { x: 0, y: 0, visible: false };
      var sx = (x / w * 0.5 + 0.5) * canvas.clientWidth;
      var sy = (-y / w * 0.5 + 0.5) * canvas.clientHeight;
      return { x: sx, y: sy, visible: true };
    }

    function bindPointBuffer(buf, attrib, size) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(attrib);
      gl.vertexAttribPointer(attrib, size, gl.FLOAT, false, 0, 0);
    }

    function drawLines(buffer, count, widthPx, alpha) {
      if (!count) return;
      gl.useProgram(progLines);
      gl.uniformMatrix4fv(loc.lines.uView, false, frameInfo.view);
      gl.uniformMatrix4fv(loc.lines.uProj, false, frameInfo.proj);
      gl.uniform2f(loc.lines.uViewport, canvas.width, canvas.height);
      gl.uniform1f(loc.lines.uWidth, widthPx * dpr * 0.5);
      gl.uniform1f(loc.lines.uAlpha, alpha);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      var stride = 10 * 4;
      gl.enableVertexAttribArray(loc.lines.aPos);
      gl.vertexAttribPointer(loc.lines.aPos, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(loc.lines.aOther);
      gl.vertexAttribPointer(loc.lines.aOther, 3, gl.FLOAT, false, stride, 3 * 4);
      gl.enableVertexAttribArray(loc.lines.aCol);
      gl.vertexAttribPointer(loc.lines.aCol, 3, gl.FLOAT, false, stride, 6 * 4);
      gl.enableVertexAttribArray(loc.lines.aSide);
      gl.vertexAttribPointer(loc.lines.aSide, 1, gl.FLOAT, false, stride, 9 * 4);
      gl.drawArrays(gl.TRIANGLES, 0, count);
      gl.disableVertexAttribArray(loc.lines.aPos);
      gl.disableVertexAttribArray(loc.lines.aOther);
      gl.disableVertexAttribArray(loc.lines.aCol);
      gl.disableVertexAttribArray(loc.lines.aSide);
    }

    function draw() {
      resize();
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(BG[0], BG[1], BG[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      var mm = matrices();
      frameInfo = {
        view: mm.view,
        proj: mm.proj,
        mvp: mat4Multiply(mm.proj, mm.view),
        eye: mm.eye,
        target: cam.target,
        reach: cam.reach,
        fovy: mm.fovy,
        focal: 0.5 * canvas.height / Math.tan(mm.fovy / 2)
      };

      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      /* --- 背景渐变 --- */
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.useProgram(progBg);
      gl.uniform2f(bgLoc.uRes, canvas.width, canvas.height);
      gl.bindBuffer(gl.ARRAY_BUFFER, bgBuffer);
      gl.enableVertexAttribArray(bgLoc.aPos);
      gl.vertexAttribPointer(bgLoc.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disableVertexAttribArray(bgLoc.aPos);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      /* --- 镜面（先画，作为背景色调） --- */
      if (view.showMirrors && buffers.planeCount) {
        gl.disable(gl.DEPTH_TEST);
        gl.depthMask(false);
        gl.useProgram(progFlat);
        gl.uniformMatrix4fv(loc.flat.uView, false, frameInfo.view);
        gl.uniformMatrix4fv(loc.flat.uProj, false, frameInfo.proj);
        gl.uniform1f(loc.flat.uAlpha, 0.075);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers.planes);
        gl.enableVertexAttribArray(loc.flat.aPos);
        gl.vertexAttribPointer(loc.flat.aPos, 3, gl.FLOAT, false, 24, 0);
        gl.enableVertexAttribArray(loc.flat.aCol);
        gl.vertexAttribPointer(loc.flat.aCol, 3, gl.FLOAT, false, 24, 12);
        gl.drawArrays(gl.TRIANGLES, 0, buffers.planeCount);
        gl.disableVertexAttribArray(loc.flat.aPos);
        gl.disableVertexAttribArray(loc.flat.aCol);
      }

      /* --- 点云 --- */
      if (buffers.pointCount) {
        gl.useProgram(progPoints);
        gl.uniformMatrix4fv(loc.points.uView, false, frameInfo.view);
        gl.uniformMatrix4fv(loc.points.uProj, false, frameInfo.proj);
        gl.uniform1f(loc.points.uFocal, frameInfo.focal);
        gl.uniform1f(loc.points.uSizeWorld, view.pointSizeWorld);
        var eyeDistance = Math.hypot(
          frameInfo.eye[0] - cam.target[0],
          frameInfo.eye[1] - cam.target[1],
          frameInfo.eye[2] - cam.target[2]
        );
        gl.uniform1f(loc.points.uFogNear, eyeDistance - cam.reach * 0.35);
        gl.uniform1f(loc.points.uFogFar, eyeDistance + cam.reach * 1.25);
        gl.uniform1f(loc.points.uFogStrength, view.blend === 'glow' ? 0.20 : 0.18);
        gl.uniform1f(loc.points.uAlpha, view.alpha);
        gl.uniform3f(loc.points.uBg, BG[0], BG[1], BG[2]);
        gl.uniform1f(loc.points.uSoft, view.blend === 'glow' ? 1.0 : 0.35);

        if (view.blend === 'glow') {
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
          gl.disable(gl.DEPTH_TEST);
          gl.depthMask(false);
        } else {
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.enable(gl.DEPTH_TEST);
          gl.depthFunc(gl.LEQUAL);
          gl.depthMask(true);
        }

        bindPointBuffer(buffers.pointsPos, loc.points.aPos, 3);
        bindPointBuffer(buffers.pointsCol, loc.points.aCol, 3);
        gl.drawArrays(gl.POINTS, 0, buffers.pointCount);
        gl.disableVertexAttribArray(loc.points.aPos);
        gl.disableVertexAttribArray(loc.points.aCol);
      }

      /* --- 高亮轨道（更大、加法发光，覆盖在最上层） --- */
      if (buffers.hlCount) {
        gl.useProgram(progPoints);
        gl.uniformMatrix4fv(loc.points.uView, false, frameInfo.view);
        gl.uniformMatrix4fv(loc.points.uProj, false, frameInfo.proj);
        gl.uniform1f(loc.points.uFocal, frameInfo.focal);
        gl.uniform1f(loc.points.uSizeWorld, view.pointSizeWorld * 1.9);
        gl.uniform1f(loc.points.uFogNear, 1e7);
        gl.uniform1f(loc.points.uFogFar, 1e7 + 1);
        gl.uniform1f(loc.points.uFogStrength, 0.0);
        gl.uniform1f(loc.points.uAlpha, 1.0);
        gl.uniform3f(loc.points.uBg, BG[0], BG[1], BG[2]);
        gl.uniform1f(loc.points.uSoft, 1.0);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.disable(gl.DEPTH_TEST);
        gl.depthMask(false);
        bindPointBuffer(buffers.hlPos, loc.points.aPos, 3);
        bindPointBuffer(buffers.hlCol, loc.points.aCol, 3);
        gl.drawArrays(gl.POINTS, 0, buffers.hlCount);
        gl.disableVertexAttribArray(loc.points.aPos);
        gl.disableVertexAttribArray(loc.points.aCol);
      }

      /* --- 线段（线框永远画在最上层） --- */
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);

      if (view.showNeighbors && buffers.neighborCount) {
        drawLines(buffers.neighbor, buffers.neighborCount, view.lineWidth * 0.85, 0.24);
      }
      if (buffers.cellCount) {
        drawLines(buffers.cell, buffers.cellCount, view.lineWidth, 0.62);
      }
      if (buffers.axesCount) {
        drawLines(buffers.axes, buffers.axesCount, view.lineWidth * 1.15, 0.95);
      }
      if (view.showSymAxes && buffers.symAxesCount) {
        drawLines(buffers.symAxes, buffers.symAxesCount, view.lineWidth * 1.05, 0.72);
      }

      gl.depthMask(true);
      if (frameCb) frameCb(frameInfo);
    }

    function loop(t) {
      if (!running) return;
      var dt = lastTime ? Math.min(0.05, (t - lastTime) / 1000) : 0.016;
      lastTime = t;
      if (view.autoRotate) cam.theta += dt * 0.22;
      draw();
      requestAnimationFrame(loop);
    }

    /* ------------------------- 交互 ------------------------- */

    var drag = null;
    canvas.addEventListener('pointerdown', function (e) {
      drag = { x: e.clientX, y: e.clientY, theta: cam.theta, phi: cam.phi };
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!drag) return;
      cam.theta = drag.theta - (e.clientX - drag.x) * 0.008;
      cam.phi = Math.max(-1.45, Math.min(1.45, drag.phi + (e.clientY - drag.y) * 0.008));
    });
    canvas.addEventListener('pointerup', function (e) {
      drag = null;
      canvas.style.cursor = 'grab';
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    canvas.addEventListener('pointercancel', function () { drag = null; });
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      cam.dist *= Math.exp(Math.max(-200, Math.min(200, e.deltaY)) * 0.0012);
      cam.dist = Math.max(1.2, Math.min(9, cam.dist));
    }, { passive: false });
    canvas.addEventListener('dblclick', function () { resetView(); });

    function resetView() {
      cam.theta = -0.72;
      cam.phi = 0.34;
      cam.dist = 3.1;
    }

    /* ------------------------- 对外 API ------------------------- */

    var api = {
      gl: gl,

      setCamera: function (c) {
        if (typeof c.theta === 'number') cam.theta = c.theta;
        if (typeof c.phi === 'number') cam.phi = c.phi;
        if (typeof c.dist === 'number') cam.dist = c.dist;
      },

      resetView: resetView,

      /** B: 3×3 列主序晶胞基矢；生成晶胞棱、邻胞棱、坐标轴 */
      setCell: function (B) {
        var corners = [];
        for (var i = 0; i < 8; i++) {
          var f = [i & 1, (i >> 1) & 1, (i >> 2) & 1];
          corners.push([
            B[0][0] * f[0] + B[0][1] * f[1] + B[0][2] * f[2],
            B[1][0] * f[0] + B[1][1] * f[1] + B[1][2] * f[2],
            B[2][0] * f[0] + B[2][1] * f[1] + B[2][2] * f[2]
          ]);
        }
        // 12 条棱：沿每个方向变化的角点对
        var edgePairs = [];
        for (var d = 0; d < 3; d++) {
          for (var k = 0; k < 8; k++) {
            if (k & (1 << d)) continue;
            edgePairs.push([k, k | (1 << d), d]);
          }
        }
        var cellSegs = [];
        for (var e = 0; e < edgePairs.length; e++) {
          var pair = edgePairs[e];
          cellSegs.push({ a: corners[pair[0]], b: corners[pair[1]], c: [0.55, 0.63, 0.82] });
        }
        var cellData = buildThickLines(cellSegs);
        if (buffers.cell) gl.deleteBuffer(buffers.cell);
        buffers.cell = makeBuffer(gl, cellData);
        buffers.cellCount = cellSegs.length * 6;

        // 邻胞：沿 ±a、±b、±c 平移的 6 个胞
        var neighborSegs = [];
        var offsets = [
          [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]
        ];
        var ncol = [0.32, 0.38, 0.55];
        for (var oi = 0; oi < offsets.length; oi++) {
          var off = offsets[oi];
          var shift = [
            B[0][0] * off[0] + B[0][1] * off[1] + B[0][2] * off[2],
            B[1][0] * off[0] + B[1][1] * off[1] + B[1][2] * off[2],
            B[2][0] * off[0] + B[2][1] * off[1] + B[2][2] * off[2]
          ];
          for (var q = 0; q < edgePairs.length; q++) {
            var pr = edgePairs[q];
            var a0 = corners[pr[0]], b0 = corners[pr[1]];
            neighborSegs.push({
              a: [a0[0] + shift[0], a0[1] + shift[1], a0[2] + shift[2]],
              b: [b0[0] + shift[0], b0[1] + shift[1], b0[2] + shift[2]],
              c: ncol
            });
          }
        }
        var nbData = buildThickLines(neighborSegs);
        if (buffers.neighbor) gl.deleteBuffer(buffers.neighbor);
        buffers.neighbor = makeBuffer(gl, nbData);
        buffers.neighborCount = neighborSegs.length * 6;

        // 坐标轴 a / b / c（从原点出发）
        var axisSegs = [
          { a: corners[0], b: corners[1], c: [1.0, 0.45, 0.55] },
          { a: corners[0], b: corners[2], c: [0.45, 0.95, 0.72] },
          { a: corners[0], b: corners[4], c: [0.48, 0.62, 1.0] }
        ];
        var axData = buildThickLines(axisSegs);
        if (buffers.axes) gl.deleteBuffer(buffers.axes);
        buffers.axes = makeBuffer(gl, axData);
        buffers.axesCount = 3 * 6;

        // 相机目标与尺度
        var cx = 0, cy = 0, cz = 0;
        for (var ci = 0; ci < 8; ci++) { cx += corners[ci][0]; cy += corners[ci][1]; cz += corners[ci][2]; }
        cam.target = [cx / 8, cy / 8, cz / 8];
        var maxR = 0;
        for (var ri = 0; ri < 8; ri++) {
          var dx = corners[ri][0] - cam.target[0];
          var dy = corners[ri][1] - cam.target[1];
          var dz = corners[ri][2] - cam.target[2];
          maxR = Math.max(maxR, Math.hypot(dx, dy, dz));
        }
        cam.reach = maxR * 1.02;
      },

      setPoints: function (positions, colors, count) {
        if (buffers.pointsPos) gl.deleteBuffer(buffers.pointsPos);
        if (buffers.pointsCol) gl.deleteBuffer(buffers.pointsCol);
        buffers.pointCount = count;
        if (!count) {
          buffers.pointsPos = null;
          buffers.pointsCol = null;
          return;
        }
        buffers.pointsPos = makeBuffer(gl, positions);
        buffers.pointsCol = makeBuffer(gl, colors);
      },

      /** 高亮轨道：单独一层、更大的点、加法发光，画在最上层 */
      setHighlightPoints: function (positions, colors, count) {
        if (buffers.hlPos) { gl.deleteBuffer(buffers.hlPos); buffers.hlPos = null; }
        if (buffers.hlCol) { gl.deleteBuffer(buffers.hlCol); buffers.hlCol = null; }
        buffers.hlCount = count || 0;
        if (!count) return;
        buffers.hlPos = makeBuffer(gl, positions);
        buffers.hlCol = makeBuffer(gl, colors);
      },

      /**
       * 对称元素：{ axes:[{a,b,c}], planes:[{corners:[4×[x,y,z]], color:[r,g,b]}] }
       * 坐标均为笛卡尔坐标。
       */
      setSymmetryGeometry: function (sym) {
        var segs = (sym && sym.axes) || [];
        if (buffers.symAxes) { gl.deleteBuffer(buffers.symAxes); buffers.symAxes = null; }
        if (segs.length) {
          buffers.symAxes = makeBuffer(gl, buildThickLines(segs));
          buffers.symAxesCount = segs.length * 6;
        } else {
          buffers.symAxesCount = 0;
        }

        var planes = (sym && sym.planes) || [];
        if (buffers.planes) { gl.deleteBuffer(buffers.planes); buffers.planes = null; }
        var triCount = planes.length * 2 * 3;
        if (triCount) {
          var data = new Float32Array(triCount * 6);
          var w = 0;
          for (var i = 0; i < planes.length; i++) {
            var pl = planes[i];
            var cs = pl.corners;
            var col = pl.color || [0.55, 0.65, 1.0];
            var order = [0, 1, 2, 0, 2, 3];
            for (var k = 0; k < 6; k++) {
              var v = cs[order[k]];
              data[w++] = v[0]; data[w++] = v[1]; data[w++] = v[2];
              data[w++] = col[0]; data[w++] = col[1]; data[w++] = col[2];
            }
          }
          buffers.planes = makeBuffer(gl, data);
          buffers.planeCount = triCount;
        } else {
          buffers.planeCount = 0;
        }
      },

      configure: function (patch) {
        for (var k in patch) {
          if (Object.prototype.hasOwnProperty.call(patch, k) && k in view) view[k] = patch[k];
        }
      },

      onFrame: function (cb) { frameCb = cb; },

      project: projectPoint,

      getFrame: function () { return frameInfo; },

      getReach: function () { return cam.reach; },

      start: function () {
        if (running) return;
        running = true;
        lastTime = 0;
        requestAnimationFrame(loop);
      },

      stop: function () { running = false; },

      renderNow: function () { draw(); },

      toDataURL: function () {
        draw();
        return canvas.toDataURL('image/png');
      },

      destroy: function () {
        api.stop();
      }
    };

    return api;
  }

  root.CrystalRender = {
    create: create,
    BG: BG
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
