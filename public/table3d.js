// テーブルと「カードが飛ぶ演出」だけを three.js で描く層(斜め視点)。
// 席・吹き出し・手札・ボタンなどは従来どおりHTMLのまま。この層は #roundTable の
// 裏に敷く透明な canvas で、HTML側の席や山札・場札の置き場所は、3D座標を画面座標に
// 変換して合わせる。three.js が読めない・WebGLが使えない・重い場合は何もせず、
// 従来のHTMLテーブル(真上から見た円)のまま動く。
(function () {
  'use strict';

  var MARGIN = 90; // テーブルの外側にも描く余白(px)。カードの飛び出し用
  var TILT = 52; // 真上からの傾き(度)
  var WALL = 22; // テーブルの縁の厚み(ワールド単位)
  var PILE_ANCHOR = { x: -38, z: 10 }; // 場の一番上のカードの中心
  var PILE_OFFS = [
    { x: 0, z: 0, w: 56, h: 80, rot: 0 },
    { x: 26, z: -1, w: 44, h: 62, rot: -0.05 },
    { x: 53, z: 1, w: 38, h: 54, rot: 0.07 },
    { x: 79, z: 2, w: 34, h: 48, rot: -0.1 },
  ];
  var state = {
    ready: false,
    failed: false,
    el: null,
    canvas: null,
    renderer: null,
    scene: null,
    camera: null,
    pileGroup: null,
    deckGroup: null,
    tableGroup: null,
    flyGroup: null,
    Wc: 0,
    Hc: 0,
    boxW: 0,
    R: 0,
    canvasTop: 0,
    baseScale: 1,
    tex: {},
    pileKey: '',
    deckKey: '',
    holdTop: 0,
    flights: [],
    raf: 0,
    frameTimes: [],
    lastT: 0,
    shadowTex: null,
  };

  function disabledByUser() {
    try {
      if (/[?&]3d=off\b/.test(location.search)) return true;
      if (/[?&]3d=on\b/.test(location.search)) {
        localStorage.removeItem('pageOneNo3d');
        return false;
      }
      return localStorage.getItem('pageOneNo3d') === '1';
    } catch (e) {
      return false;
    }
  }

  function resetInlineLayout() {
    ['roundTable', 'selfSeat', 'tableCenter', 'drawPile'].forEach(function (id) {
      var e = document.getElementById(id);
      if (e) {
        e.style.height = '';
        e.style.left = '';
        e.style.top = '';
      }
    });
  }

  function disable(reason) {
    if (state.failed) return;
    state.failed = true;
    try {
      if (reason === 'slow') localStorage.setItem('pageOneNo3d', '1');
    } catch (e) {}
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
    document.body.classList.remove('has3d');
    if (state.canvas && state.canvas.parentNode) state.canvas.parentNode.removeChild(state.canvas);
    try {
      if (state.renderer) state.renderer.dispose();
    } catch (e) {}
    state.ready = false;
    state.flights = [];
    resetInlineLayout();
    if (window.__rerender) window.__rerender(); // 席の位置を従来の円卓に戻す
  }

  function makeTex(w, h, draw) {
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    draw(c.getContext('2d'), w, h);
    var t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    return t;
  }

  function cardFaceTex(label, cls, older) {
    var key = 'f|' + label + '|' + cls + '|' + (older ? 1 : 0);
    if (state.tex[key]) return state.tex[key];
    var t = makeTex(128, 180, function (x, w, h) {
      if (cls === 'joker') {
        var g = x.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, '#e6412e');
        g.addColorStop(0.35, '#f2c12e');
        g.addColorStop(0.7, '#3cb371');
        g.addColorStop(1, '#3a6fd8');
        x.fillStyle = g;
      } else {
        x.fillStyle = '#f5f0e6';
      }
      x.fillRect(0, 0, w, h);
      x.fillStyle = cls === 'joker' ? '#fff' : cls === 'red-suit' ? '#d21f1f' : '#1a1a1a';
      x.font = 'bold ' + (older ? 46 : 58) + 'px sans-serif';
      x.textBaseline = 'middle';
      if (older) {
        x.textAlign = 'right';
        x.fillText(label, w - 8, h / 2);
      } else {
        x.textAlign = 'center';
        x.fillText(label, w / 2, h / 2);
      }
    });
    state.tex[key] = t;
    return t;
  }

  function backTex() {
    if (state.tex.back) return state.tex.back;
    state.tex.back = makeTex(128, 180, function (x, w, h) {
      x.fillStyle = '#222';
      x.fillRect(0, 0, w, h);
      x.strokeStyle = '#3a3a3a';
      x.lineWidth = 8;
      for (var i = -h; i < w; i += 18) {
        x.beginPath();
        x.moveTo(i, 0);
        x.lineTo(i + h, h);
        x.stroke();
      }
      x.strokeStyle = '#555';
      x.lineWidth = 6;
      x.strokeRect(3, 3, w - 6, h - 6);
    });
    return state.tex.back;
  }

  function planeCard(map, w, h, opacity) {
    var m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshLambertMaterial({ map: map, transparent: opacity < 1, opacity: opacity })
    );
    m.rotation.x = -Math.PI / 2; // 画面の上 = -z(奥)
    return m;
  }

  function softShadow(w, h, alpha) {
    if (!state.shadowTex) {
      state.shadowTex = makeTex(64, 64, function (x, sw, sh) {
        var g = x.createRadialGradient(sw / 2, sh / 2, 4, sw / 2, sh / 2, sw / 2);
        g.addColorStop(0, 'rgba(0,0,0,0.55)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        x.fillStyle = g;
        x.fillRect(0, 0, sw, sh);
      });
    }
    var m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: state.shadowTex, transparent: true, opacity: alpha, depthWrite: false })
    );
    m.rotation.x = -Math.PI / 2;
    return m;
  }

  function disposeObj(o) {
    o.traverse(function (n) {
      if (n.geometry) n.geometry.dispose();
      if (n.material) n.material.dispose();
    });
  }

  function buildTable(R) {
    if (state.tableGroup) {
      state.scene.remove(state.tableGroup);
      disposeObj(state.tableGroup);
    }
    var g = new THREE.Group();
    var floor = softShadow(R * 2.7, R * 2.2, 0.6);
    floor.position.set(0, -WALL - 26, R * 0.22);
    g.add(floor);

    var base = new THREE.Mesh(
      new THREE.CylinderGeometry(R * 0.78, R * 0.62, 26, 48),
      new THREE.MeshLambertMaterial({ color: 0x3b2a1a })
    );
    base.position.y = -WALL - 13;
    g.add(base);

    var wall = new THREE.Mesh(
      new THREE.CylinderGeometry(R, R * 0.985, WALL, 72, 1, true),
      new THREE.MeshLambertMaterial({ color: 0x7a5a20, side: THREE.DoubleSide })
    );
    wall.position.y = -WALL / 2;
    g.add(wall);

    var bottom = new THREE.Mesh(
      new THREE.CircleGeometry(R * 0.985, 72),
      new THREE.MeshLambertMaterial({ color: 0x4e3813 })
    );
    bottom.rotation.x = -Math.PI / 2;
    bottom.position.y = -WALL;
    g.add(bottom);

    var rimTop = new THREE.Mesh(
      new THREE.RingGeometry(R - 8, R, 72),
      new THREE.MeshLambertMaterial({ color: 0x8a6824 })
    );
    rimTop.rotation.x = -Math.PI / 2;
    rimTop.position.y = 0;
    g.add(rimTop);

    var gold = new THREE.Mesh(
      new THREE.RingGeometry(R - 10, R - 8, 72),
      new THREE.MeshBasicMaterial({ color: 0xc9a227 })
    );
    gold.rotation.x = -Math.PI / 2;
    gold.position.y = 0.3;
    g.add(gold);

    var feltTex = makeTex(512, 512, function (x, w, h) {
      var gr = x.createRadialGradient(w / 2, h * 0.42, 10, w / 2, h / 2, w / 2);
      gr.addColorStop(0, '#14513d');
      gr.addColorStop(0.55, '#0f3d2e');
      gr.addColorStop(1, '#0a2b21');
      x.fillStyle = gr;
      x.fillRect(0, 0, w, h);
    });
    var felt = new THREE.Mesh(new THREE.CircleGeometry(R - 10, 72), new THREE.MeshBasicMaterial({ map: feltTex }));
    felt.rotation.x = -Math.PI / 2;
    felt.position.y = 0.2;
    g.add(felt);
    state.tableGroup = g;
    state.scene.add(g);
  }

  function init() {
    if (state.ready || state.failed) return state.ready;
    if (disabledByUser()) {
      state.failed = true;
      return false;
    }
    if (typeof THREE === 'undefined') return false;
    var tableEl = document.getElementById('roundTable');
    if (!tableEl) return false;
    var rect = tableEl.getBoundingClientRect();
    if (rect.width < 50) return false;
    try {
      var canvas = document.createElement('canvas');
      canvas.id = 'table3d';
      tableEl.insertBefore(canvas, tableEl.firstChild);
      var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
      renderer.setClearColor(0x000000, 0);
      state.canvas = canvas;
      state.renderer = renderer;
      state.el = tableEl;
      state.scene = new THREE.Scene();
      state.scene.add(new THREE.AmbientLight(0xffffff, 0.62));
      var dl = new THREE.DirectionalLight(0xffffff, 0.5);
      dl.position.set(-60, 160, 80);
      state.scene.add(dl);
      state.pileGroup = new THREE.Group();
      state.deckGroup = new THREE.Group();
      state.flyGroup = new THREE.Group();
      state.scene.add(state.pileGroup);
      state.scene.add(state.deckGroup);
      state.scene.add(state.flyGroup);
      state.camera = new THREE.PerspectiveCamera(30, 1, 10, 6000);
      canvas.addEventListener('webglcontextlost', function (e) {
        e.preventDefault();
        disable('lost');
      });
      state.ready = true;
      document.body.classList.add('has3d');
      resize(true);
      if (window.ResizeObserver) {
        var lastW = rect.width;
        new ResizeObserver(function () {
          var w = state.el.getBoundingClientRect().width;
          if (Math.abs(w - lastW) > 0.5) {
            lastW = w;
            resize(false);
          }
        }).observe(tableEl);
      }
      window.addEventListener('resize', function () { resize(false); });
      return true;
    } catch (e) {
      disable('error');
      return false;
    }
  }

  // ワールド座標 → canvas内のピクセル
  function toCanvas(x, y, z) {
    var v = new THREE.Vector3(x, y, z).project(state.camera);
    return { x: ((v.x + 1) / 2) * state.Wc, y: ((1 - v.y) / 2) * state.Hc };
  }
  // ワールド座標 → #roundTable 内の座標(HTML要素の left/top に使う)
  function toBox(x, y, z) {
    var p = toCanvas(x, y, z);
    return { x: p.x - MARGIN, y: p.y + state.canvasTop };
  }
  // 1ワールド単位が画面で何pxか(その点の奥行きでの拡大率)
  function unitPx(x, z) {
    var a = toCanvas(x, 0, z),
      b = toCanvas(x + 1, 0, z);
    return Math.abs(b.x - a.x);
  }

  function resize(force) {
    if (!state.ready) return;
    var rect = state.el.getBoundingClientRect();
    if (rect.width < 50) return;
    if (!force && Math.abs(rect.width - state.boxW) < 0.5) {
      sync();
      return;
    }
    state.boxW = rect.width;
    var R = rect.width / 2;
    state.R = R;
    state.Wc = Math.round(rect.width + MARGIN * 2);
    state.Hc = Math.round(rect.width * 0.95 + MARGIN * 2);
    var c = state.canvas;
    c.style.width = state.Wc + 'px';
    c.style.height = state.Hc + 'px';
    c.style.left = -MARGIN + 'px';
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    state.renderer.setPixelRatio(dpr);
    state.renderer.setSize(state.Wc, state.Hc, false);

    var cam = state.camera;
    var D = R * 3.6;
    var tr = (TILT * Math.PI) / 180;
    cam.aspect = state.Wc / state.Hc;
    cam.position.set(0, D * Math.cos(tr), D * Math.sin(tr));
    cam.up.set(0, 1, 0);
    cam.lookAt(0, -WALL / 2, 0);
    cam.fov = 30;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    // テーブルの一番幅広い所(手前の縁)が #roundTable の幅ちょうどに収まるよう画角を合わせる
    var maxX = 0;
    for (var a = 0; a < 360; a += 10) {
      var rad = (a * Math.PI) / 180;
      var p = toCanvas(Math.sin(rad) * R, 0, Math.cos(rad) * R);
      maxX = Math.max(maxX, Math.abs(p.x - state.Wc / 2));
    }
    var k = (maxX * 2) / rect.width;
    cam.fov = (2 * Math.atan(Math.tan((30 * Math.PI) / 360) * k) * 180) / Math.PI;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    var far = toCanvas(0, 0, -R),
      near = toCanvas(0, -WALL, R);
    var PAD_TOP = 40;
    state.canvasTop = PAD_TOP - far.y;
    c.style.top = state.canvasTop + 'px';
    var boxH = Math.round(near.y - far.y + PAD_TOP);
    state.el.style.height = boxH + 'px';
    state.baseScale = unitPx(0, 0);

    buildTable(R);
    state.pileKey = '';
    state.deckKey = '';
    sync();
  }

  // 席などHTML要素の位置合わせ用。angleDeg は真上(奥)を0、時計回り。
  function seatPoint(angleDeg) {
    if (!state.ready) return null;
    var rad = (angleDeg * Math.PI) / 180;
    var wx = Math.sin(rad) * state.R,
      wz = -Math.cos(rad) * state.R;
    var p = toBox(wx, 0, wz);
    var s = unitPx(wx, wz) / state.baseScale;
    return { x: p.x, y: p.y, scale: Math.max(0.82, Math.min(1.18, s)) };
  }

  function placeEl(id, wx, wz, dy) {
    var e = document.getElementById(id);
    if (!e) return;
    var p = toBox(wx, 0, wz);
    e.style.left = p.x + 'px';
    e.style.top = p.y + (dy || 0) + 'px';
  }

  function layoutHtml() {
    var R = state.R;
    var near = toBox(0, 0, R);
    var self = document.getElementById('selfSeat');
    if (self) {
      self.style.left = near.x + 'px';
      self.style.top = near.y - 4 + 'px';
    }
    placeEl('tableCenter', PILE_ANCHOR.x, PILE_ANCHOR.z, 0);
    placeEl('drawPile', -R * 0.4, -R * 0.3, 0);
  }

  function clearGroup(g) {
    while (g.children.length) {
      var o = g.children.pop();
      disposeObj(o);
    }
  }

  function syncPile() {
    var els = Array.prototype.slice.call(document.querySelectorAll('#historyStack .hist-card'));
    var specs = els.map(function (e) {
      var m = /depth-(\d)/.exec(e.className);
      return {
        label: e.textContent,
        cls: /joker/.test(e.className) ? 'joker' : /red-suit/.test(e.className) ? 'red-suit' : 'black-suit',
        depth: m ? +m[1] : 0,
      };
    });
    var hidden = document.body.classList.contains('peeling');
    var holdTop = state.holdTop > 0;
    var key = specs.map(function (s) { return s.label + ':' + s.cls + ':' + s.depth; }).join('|') + '|' + holdTop + '|' + hidden;
    if (key === state.pileKey) return;
    state.pileKey = key;
    clearGroup(state.pileGroup);
    if (hidden) return;
    var opac = { 0: 1, 1: 0.9, 2: 0.78, 3: 0.65 };
    specs.forEach(function (s) {
      if (holdTop && s.depth === 0) return;
      var o = PILE_OFFS[s.depth] || PILE_OFFS[3];
      var y = 1 + (specs.length - s.depth) * 1.6;
      var g = new THREE.Group();
      var sh = softShadow(o.w * 1.35, o.h * 1.3, s.depth === 0 ? 0.9 : 0.5);
      sh.position.set(3, -y + 0.4, 5);
      g.add(sh);
      var body = new THREE.Mesh(new THREE.BoxGeometry(o.w, 1.4, o.h), new THREE.MeshLambertMaterial({ color: 0xd9d2c0 }));
      body.position.y = -0.8;
      g.add(body);
      g.add(planeCard(cardFaceTex(s.label, s.cls, s.depth > 0), o.w, o.h, opac[s.depth]));
      if (s.depth === 0) {
        var edge = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.PlaneGeometry(o.w, o.h)),
          new THREE.LineBasicMaterial({ color: 0xc9a227 })
        );
        edge.rotation.x = -Math.PI / 2;
        edge.position.y = 0.4;
        g.add(edge);
      }
      g.rotation.y = o.rot;
      g.position.set(PILE_ANCHOR.x + o.x, y, PILE_ANCHOR.z + o.z);
      state.pileGroup.add(g);
    });
  }

  function syncDeck() {
    var el = document.getElementById('drawPile');
    if (!el) return;
    var count = parseInt((el.textContent || '0').replace(/\D/g, ''), 10) || 0;
    var layers = Math.max(1, Math.min(12, Math.ceil(count / 9)));
    var key = layers + ':' + Math.round(state.R);
    if (key === state.deckKey) return;
    state.deckKey = key;
    clearGroup(state.deckGroup);
    var w = 38,
      h = 54;
    var g = new THREE.Group();
    var sh = softShadow(w * 1.6, h * 1.5, 0.8);
    sh.position.set(4, 0.2, 6);
    g.add(sh);
    var thick = layers * 1.6;
    var body = new THREE.Mesh(new THREE.BoxGeometry(w, thick, h), new THREE.MeshLambertMaterial({ color: 0x2b2b2b }));
    body.position.y = thick / 2;
    g.add(body);
    var top = planeCard(backTex(), w, h, 1);
    top.position.y = thick + 0.3;
    g.add(top);
    g.position.set(-state.R * 0.4, 0, -state.R * 0.3);
    state.deckGroup.add(g);
  }

  function sync() {
    if (!state.ready) return;
    layoutHtml();
    syncPile();
    syncDeck();
    requestRender();
  }

  function requestRender() {
    if (!state.ready || state.raf) return;
    state.raf = requestAnimationFrame(loop);
  }

  function ease(k) {
    return k * k * (3 - 2 * k);
  }

  function loop(t) {
    state.raf = 0;
    if (!state.ready) return;
    var now = t || performance.now();
    if (state.flights.length) {
      if (state.lastT) {
        state.frameTimes.push(now - state.lastT);
        if (state.frameTimes.length >= 24) {
          var sorted = state.frameTimes.slice().sort(function (a, b) { return a - b; });
          var median = sorted[sorted.length >> 1];
          state.frameTimes = [];
          if (median > 55) {
            disable('slow');
            return;
          }
        }
      }
      state.lastT = now;
      for (var i = state.flights.length - 1; i >= 0; i--) {
        var f = state.flights[i];
        var k = Math.min((now - f.start) / f.dur, 1);
        var e = ease(k);
        var lift = Math.sin(e * Math.PI);
        f.mesh.position.x = f.from.x + (f.to.x - f.from.x) * e;
        f.mesh.position.z = f.from.z + (f.to.z - f.from.z) * e;
        f.mesh.position.y = 4 + lift * 80;
        f.mesh.rotation.x = lift * -0.5;
        f.mesh.rotation.y = f.spin * e;
        f.shadow.position.set(f.mesh.position.x + 4 + lift * 16, 0.6, f.mesh.position.z + 6 + lift * 22);
        f.shadow.material.opacity = 0.7 - lift * 0.35;
        if (k >= 1) {
          state.flyGroup.remove(f.mesh);
          state.flyGroup.remove(f.shadow);
          disposeObj(f.mesh);
          disposeObj(f.shadow);
          state.flights.splice(i, 1);
          if (f.onLand) f.onLand();
        }
      }
      state.renderer.render(state.scene, state.camera);
      state.raf = requestAnimationFrame(loop);
      return;
    }
    state.lastT = 0;
    state.frameTimes = [];
    state.renderer.render(state.scene, state.camera);
  }

  // 画面(client座標)の点が、テーブルの高さ(y=0)の面でどのワールド座標に当たるか
  function screenToWorld(clientX, clientY) {
    var cr = state.canvas.getBoundingClientRect();
    var nx = ((clientX - cr.left) / cr.width) * 2 - 1;
    var ny = -((clientY - cr.top) / cr.height) * 2 + 1;
    var v = new THREE.Vector3(nx, ny, 0.5).unproject(state.camera);
    var o = state.camera.position;
    var d = v.sub(o);
    var t = (0 - o.y) / d.y;
    return { x: o.x + d.x * t, z: o.z + d.z * t };
  }

  function elCenter(el) {
    var r = el.getBoundingClientRect();
    return screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
  }

  // fromEl → toEl へカードを弧を描いて飛ばす。3Dで処理できたら true を返す。
  function fly(fromEl, toEl, label, cls) {
    if (!init() || !state.ready || !fromEl || !toEl) return false;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    var from = elCenter(fromEl);
    var to = elCenter(toEl);
    var w = 36,
      h = 52;
    var mesh = planeCard(label ? cardFaceTex(label, cls, false) : backTex(), w, h, 1);
    var grp = new THREE.Group();
    grp.add(mesh);
    var shadow = softShadow(w * 1.5, h * 1.4, 0.7);
    state.flyGroup.add(grp);
    state.flyGroup.add(shadow);
    var toPile = toEl.id === 'historyStack';
    if (toPile) {
      state.holdTop += 1;
      state.pileKey = '';
      syncPile();
    }
    state.flights.push({
      mesh: grp,
      shadow: shadow,
      from: from,
      to: to,
      start: performance.now(),
      dur: 700,
      spin: label ? -0.5 : 0.5,
      onLand: function () {
        if (toPile) {
          state.holdTop = Math.max(0, state.holdTop - 1);
          state.pileKey = '';
          syncPile();
        }
      },
    });
    grp.position.set(from.x, 4, from.z);
    requestRender();
    return true;
  }

  window.Table3D = {
    init: init,
    sync: sync,
    fly: fly,
    seatPoint: seatPoint,
    isOn: function () { return state.ready; },
  };
})();
