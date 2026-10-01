// テーブルと「カードが飛ぶ演出」だけを three.js で描く層。
// 席・吹き出し・手札・ボタンなどは従来どおりHTMLのまま。この層は #roundTable の
// 裏に敷く透明な canvas で、座標はDOMの位置をそのまま読んで合わせる。
// three.js が読めない・WebGLが使えない・重い場合は何もせず、従来のHTMLテーブルのまま動く。
(function () {
  'use strict';

  var MARGIN = 90; // テーブルの外側にも描く余白(px)。カードの飛び出し用
  var FOV = 50;
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
    size: 0,
    tableR: 0,
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
  }

  function makeTex(w, h, draw) {
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    draw(c.getContext('2d'), w, h);
    var t = new THREE.CanvasTexture(c);
    t.anisotropy = 2;
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
    m.rotation.x = -Math.PI / 2; // 画面の上 = -z
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

  function buildTable(R) {
    if (state.tableGroup) {
      state.scene.remove(state.tableGroup);
      state.tableGroup.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    var g = new THREE.Group();
    var sh = softShadow(R * 2.55, R * 2.55, 0.55);
    sh.position.set(0, -6, 16);
    g.add(sh);

    var rimMat = new THREE.MeshLambertMaterial({ color: 0x7a5a20 });
    var rim = new THREE.Mesh(new THREE.CylinderGeometry(R, R - 2, 6, 72), rimMat);
    rim.position.y = -3.5;
    g.add(rim);

    var gold = new THREE.Mesh(
      new THREE.RingGeometry(R - 8, R - 6, 72),
      new THREE.MeshBasicMaterial({ color: 0xc9a227 })
    );
    gold.rotation.x = -Math.PI / 2;
    gold.position.y = 0.2;
    g.add(gold);

    var feltTex = makeTex(512, 512, function (x, w, h) {
      var gr = x.createRadialGradient(w / 2, h * 0.42, 10, w / 2, h / 2, w / 2);
      gr.addColorStop(0, '#14513d');
      gr.addColorStop(0.55, '#0f3d2e');
      gr.addColorStop(1, '#0a2b21');
      x.fillStyle = gr;
      x.fillRect(0, 0, w, h);
    });
    var felt = new THREE.Mesh(
      new THREE.CircleGeometry(R - 8, 72),
      new THREE.MeshBasicMaterial({ map: feltTex })
    );
    felt.rotation.x = -Math.PI / 2;
    felt.position.y = 0;
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
      state.camera = new THREE.PerspectiveCamera(FOV, 1, 1, 4000);
      state.camera.up.set(0, 0, -1);
      canvas.addEventListener('webglcontextlost', function (e) {
        e.preventDefault();
        disable('lost');
      });
      state.ready = true;
      resize(true);
      document.body.classList.add('has3d');
      if (window.ResizeObserver) new ResizeObserver(function () { resize(false); }).observe(tableEl);
      window.addEventListener('resize', function () { resize(false); });
      return true;
    } catch (e) {
      disable('error');
      return false;
    }
  }

  function resize(force) {
    if (!state.ready) return;
    var rect = state.el.getBoundingClientRect();
    if (rect.width < 50) return;
    var size = Math.round(rect.width + MARGIN * 2);
    if (!force && size === state.size) {
      sync();
      return;
    }
    state.size = size;
    state.tableR = rect.width / 2;
    var c = state.canvas;
    c.style.width = size + 'px';
    c.style.height = size + 'px';
    c.style.left = -MARGIN - 6 + 'px'; // #roundTable の枠(6px)の内側基準を打ち消す
    c.style.top = -MARGIN - 6 + 'px';
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    state.renderer.setPixelRatio(dpr);
    state.renderer.setSize(size, size, false);
    // 地面(y=0)で 1ワールド単位 = 1CSSpx になる高さにカメラを置く
    var d = size / 2 / Math.tan((FOV / 2) * Math.PI / 180);
    state.camera.position.set(0, d, 0);
    state.camera.lookAt(0, 0, 0);
    state.camera.updateProjectionMatrix();
    buildTable(state.tableR);
    state.pileKey = '';
    state.deckKey = '';
    sync();
  }

  function centerOf(rect) {
    var cr = state.canvas.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2 - (cr.left + cr.width / 2),
      z: rect.top + rect.height / 2 - (cr.top + cr.height / 2),
    };
  }

  function clearGroup(g) {
    while (g.children.length) {
      var o = g.children.pop();
      o.traverse(function (n) {
        if (n.geometry) n.geometry.dispose();
        if (n.material) n.material.dispose();
      });
    }
  }

  function syncPile() {
    var els = Array.prototype.slice.call(document.querySelectorAll('#historyStack .hist-card'));
    var specs = els.map(function (e) {
      var r = e.getBoundingClientRect();
      var m = /depth-(\d)/.exec(e.className);
      return { label: e.textContent, cls: /joker/.test(e.className) ? 'joker' : /red-suit/.test(e.className) ? 'red-suit' : 'black-suit', depth: m ? +m[1] : 0, r: r };
    });
    var hidden = document.body.classList.contains('peeling');
    var holdTop = state.holdTop > 0;
    var key = specs.map(function (s) { return [s.label, s.cls, s.depth, Math.round(s.r.left), Math.round(s.r.top), Math.round(s.r.width)].join(':'); }).join('|') + '|' + holdTop + '|' + hidden;
    if (key === state.pileKey) return;
    state.pileKey = key;
    clearGroup(state.pileGroup);
    if (hidden) return;
    var opac = { 0: 1, 1: 0.88, 2: 0.72, 3: 0.55 };
    specs.forEach(function (s, i) {
      if (holdTop && s.depth === 0) return;
      var c = centerOf(s.r);
      var w = s.r.width,
        h = s.r.height;
      var y = 1 + (specs.length - s.depth) * 1.6;
      var g = new THREE.Group();
      var sh = softShadow(w * 1.35, h * 1.3, s.depth === 0 ? 0.9 : 0.5);
      sh.position.set(2, -y + 0.4, 4);
      g.add(sh);
      var body = new THREE.Mesh(new THREE.BoxGeometry(w, 1.2, h), new THREE.MeshLambertMaterial({ color: 0xd9d2c0 }));
      body.position.y = -0.7;
      g.add(body);
      var face = planeCard(cardFaceTex(s.label, s.cls, s.depth > 0), w, h, opac[s.depth] === undefined ? 1 : opac[s.depth]);
      g.add(face);
      if (s.depth === 0) {
        var edge = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.PlaneGeometry(w, h)),
          new THREE.LineBasicMaterial({ color: 0xc9a227 })
        );
        edge.rotation.x = -Math.PI / 2;
        edge.position.y = 0.3;
        g.add(edge);
      }
      g.position.set(c.x, y, c.z);
      state.pileGroup.add(g);
    });
  }

  function syncDeck() {
    var el = document.getElementById('drawPile');
    if (!el) return;
    var r = el.getBoundingClientRect();
    if (r.width < 4) return;
    var count = parseInt((el.textContent || '0').replace(/\D/g, ''), 10) || 0;
    var layers = Math.max(1, Math.min(12, Math.ceil(count / 9)));
    var key = [Math.round(r.left), Math.round(r.top), Math.round(r.width), layers].join(':');
    if (key === state.deckKey) return;
    state.deckKey = key;
    clearGroup(state.deckGroup);
    var c = centerOf(r);
    var w = r.width,
      h = r.height;
    var g = new THREE.Group();
    var sh = softShadow(w * 1.6, h * 1.5, 0.8);
    sh.position.set(3, 0.2, 5);
    g.add(sh);
    var thick = layers * 1.4;
    var body = new THREE.Mesh(new THREE.BoxGeometry(w, thick, h), new THREE.MeshLambertMaterial({ color: 0x2b2b2b }));
    body.position.y = thick / 2;
    g.add(body);
    var top = planeCard(backTex(), w, h, 1);
    top.position.y = thick + 0.2;
    g.add(top);
    g.position.set(c.x, 0, c.z);
    state.deckGroup.add(g);
  }

  function sync() {
    if (!state.ready) return;
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
        f.mesh.position.x = f.from.x + (f.to.x - f.from.x) * e;
        f.mesh.position.z = f.from.z + (f.to.z - f.from.z) * e;
        f.mesh.position.y = 4 + Math.sin(e * Math.PI) * 78;
        f.mesh.rotation.x = Math.sin(e * Math.PI) * -0.45;
        f.mesh.rotation.y = f.spin * e;
        f.shadow.position.set(f.mesh.position.x + 6 + (1 - Math.abs(0.5 - e) * 2) * 10, 0.6, f.mesh.position.z + 8 + (1 - Math.abs(0.5 - e) * 2) * 14);
        f.shadow.material.opacity = 0.7 - Math.sin(e * Math.PI) * 0.35;
        if (k >= 1) {
          state.flyGroup.remove(f.mesh);
          state.flyGroup.remove(f.shadow);
          f.mesh.traverse(function (n) { if (n.geometry) n.geometry.dispose(); if (n.material) n.material.dispose(); });
          f.shadow.geometry.dispose();
          f.shadow.material.dispose();
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

  // fromEl → toEl へカードを弧を描いて飛ばす。3Dで処理できたら true を返す。
  function fly(fromEl, toEl, label, cls) {
    if (!init() || !state.ready || !fromEl || !toEl) return false;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    var from = centerOf(fromEl.getBoundingClientRect());
    var to = centerOf(toEl.getBoundingClientRect());
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
      dur: 680,
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

  window.Table3D = { init: init, sync: sync, fly: fly, isOn: function () { return state.ready; } };
})();
