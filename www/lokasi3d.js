/* Lokasi3D — peta gudang 3D untuk tab "Lokasi".
 *
 * Modul mandiri (tidak menyentuh state aplikasi). Bergantung pada global THREE
 * (vendor/three.min.js). Ditulis ES5 supaya aman di WebView Android lama.
 *
 *   Lokasi3D.parseLokasi('A-03-2')  -> { zona:'A', rak:3, level:2, pos:0, label:'A-03-2' }
 *   Lokasi3D.layout(items)          -> posisi 3D tiap card (murni data, bisa dites di Node)
 *   Lokasi3D.create(container, opts)-> instance renderer
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- Parser
  // Format kode lokasi:  ZONA-RAK-LEVEL[-POSISI]
  //   "A-03-2"  = zona A, rak 3, level (susun) 2 dari bawah
  //   "A3-2", "A 3 2", "a.3.2", "RAK A-3-2" juga dikenali.
  // Level default 1 (paling bawah). Teks tanpa angka (mis. "GUDANG DEPAN")
  // dianggap satu zona dengan rak 1 level 1.
  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function parseLokasi(text) {
    var raw = String(text == null ? '' : text).trim();
    if (!raw) return null;
    var norm = raw.toUpperCase()
      .replace(/([A-Z])(\d)/g, '$1-$2')
      .replace(/(\d)([A-Z])/g, '$1-$2');
    var tokens = norm.split(/[\s\-._\/,]+/).filter(Boolean);
    var words = [], nums = [];
    tokens.forEach(function (t) {
      if (/^\d+$/.test(t)) nums.push(parseInt(t, 10));
      else if (t !== 'RAK' && t !== 'ZONA') words.push(t);
    });
    if (!words.length && !nums.length) return null;
    var zona = words.length ? words.join(' ') : 'A';
    var rak = nums.length ? nums[0] : 1;
    var level = nums.length > 1 ? Math.max(1, nums[1]) : 1;
    var pos = nums.length > 2 ? nums[2] : 0;
    return {
      zona: zona, rak: rak, level: level, pos: pos,
      label: nums.length ? zona + '-' + pad2(rak) + '-' + level : zona,
      rackLabel: nums.length ? zona + '-' + pad2(rak) : zona
    };
  }

  // ---------------------------------------------------------------- Layout
  var RACK_W = 3.0, RACK_D = 1.3, RACK_GAP = 0.7, AISLE = 3.2;
  var LEVEL_H = 1.4, SHELF_T = 0.06;
  var BOX_W = 0.5, BOX_H = 0.36, BOX_PITCH = 0.55;
  var COLS = 5, ROWS = 2;

  // items: [{ nama, lokasi, ... }]. Item tanpa lokasi valid dilewati.
  function layout(items) {
    var zonesMap = {}, placedItems = [];
    (items || []).forEach(function (it) {
      var p = parseLokasi(it.lokasi);
      if (!p) return;
      var z = zonesMap[p.zona] || (zonesMap[p.zona] = { name: p.zona, racks: {} });
      var r = z.racks[p.rak] || (z.racks[p.rak] = { zona: p.zona, rak: p.rak, label: p.rackLabel, levels: {} });
      (r.levels[p.level] || (r.levels[p.level] = [])).push({ item: it, parsed: p });
    });

    var zoneNames = Object.keys(zonesMap).sort(function (a, b) { return a.localeCompare(b, 'id', { numeric: true }); });
    var maxLevel = 3;
    zoneNames.forEach(function (zn) {
      Object.keys(zonesMap[zn].racks).forEach(function (rk) {
        Object.keys(zonesMap[zn].racks[rk].levels).forEach(function (lv) {
          if (+lv > maxLevel) maxLevel = +lv;
        });
      });
    });

    var zones = [], racks = [];
    var bounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
    var first = true;
    function grow(x0, x1, z0, z1) {
      if (first) { bounds.minX = x0; bounds.maxX = x1; bounds.minZ = z0; bounds.maxZ = z1; first = false; return; }
      bounds.minX = Math.min(bounds.minX, x0); bounds.maxX = Math.max(bounds.maxX, x1);
      bounds.minZ = Math.min(bounds.minZ, z0); bounds.maxZ = Math.max(bounds.maxZ, z1);
    }

    zoneNames.forEach(function (zn, zi) {
      var zdef = zonesMap[zn];
      var rz = zi * (RACK_D + AISLE);
      var rackNums = Object.keys(zdef.racks).map(Number).sort(function (a, b) { return a - b; });
      var zone = { name: zn, z: rz, x0: 0, x1: 0, racks: [] };
      rackNums.forEach(function (rn, ri) {
        var rdef = zdef.racks[rn];
        var rx = ri * (RACK_W + RACK_GAP);
        var rack = { zona: zn, rak: rn, label: rdef.label, x: rx, z: rz, cards: [] };
        Object.keys(rdef.levels).map(Number).forEach(function (lv) {
          var list = rdef.levels[lv].slice().sort(function (a, b) {
            return (a.parsed.pos - b.parsed.pos) || String(a.item.nama).localeCompare(String(b.item.nama), 'id', { numeric: true });
          });
          var shelfTop = (lv - 1) * LEVEL_H + SHELF_T;
          list.forEach(function (e, i) {
            var perTier = COLS * ROWS;
            var tier = Math.floor(i / perTier);
            var inTier = i % perTier;
            var col = inTier % COLS, row = Math.floor(inTier / COLS);
            var c = {
              item: e.item, parsed: e.parsed, rack: rack,
              x: rx - RACK_W / 2 + 0.35 + col * BOX_PITCH,
              y: shelfTop + tier * BOX_H + BOX_H / 2,
              z: rz - RACK_D / 2 + 0.4 + row * BOX_PITCH
            };
            rack.cards.push(c);
            placedItems.push(c);
          });
        });
        zone.racks.push(rack);
        racks.push(rack);
        grow(rx - RACK_W / 2, rx + RACK_W / 2, rz - RACK_D / 2, rz + RACK_D / 2);
      });
      if (zone.racks.length) {
        zone.x0 = zone.racks[0].x - RACK_W / 2;
        zone.x1 = zone.racks[zone.racks.length - 1].x + RACK_W / 2;
      }
      zones.push(zone);
    });

    return { zones: zones, racks: racks, placed: placedItems, maxLevel: maxLevel, bounds: bounds,
             dims: { RACK_W: RACK_W, RACK_D: RACK_D, LEVEL_H: LEVEL_H, SHELF_T: SHELF_T, BOX_W: BOX_W, BOX_H: BOX_H } };
  }

  // ------------------------------------------------------------- Renderer
  var COLORS = {
    bg: 0x0d0f12,
    frame: 0x2f9fb3,
    shelf: 0x3a4350,
    floor: 0x11151a,
    zoneFloor: 0x171c23,
    ok: 0x39c91a,
    low: 0xffb020,
    out: 0xff4d5e,
    none: 0x6b7683,
    sel: 0x00e5ff
  };

  function makeLabel(THREE, text, opts) {
    opts = opts || {};
    var size = opts.size || 64;
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d');
    var font = 'bold ' + size + 'px "Space Mono", "Courier New", monospace';
    ctx.font = font;
    var w = Math.ceil(ctx.measureText(text).width) + 24;
    var h = size + 20;
    canvas.width = w; canvas.height = h;
    ctx = canvas.getContext('2d');
    ctx.font = font;
    ctx.textBaseline = 'middle';
    if (opts.bg) {
      ctx.fillStyle = opts.bg;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.fillStyle = opts.color || '#e7ecf0';
    ctx.fillText(text, 12, h / 2 + 2);
    var tex = new THREE.CanvasTexture(canvas);
    var mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    var spr = new THREE.Sprite(mat);
    var worldH = opts.worldH || 0.55;
    spr.scale.set(worldH * w / h, worldH, 1);
    return spr;
  }

  function create(container, opts) {
    opts = opts || {};
    var THREE = global.THREE;
    if (!THREE) throw new Error('Three.js belum termuat.');

    var renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch (e) {
      throw new Error('WebGL tidak didukung di perangkat ini.');
    }
    renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
    renderer.setClearColor(COLORS.bg, 1);
    var el = renderer.domElement;
    el.style.display = 'block';
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.touchAction = 'none';
    container.appendChild(el);

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400);
    scene.add(new THREE.AmbientLight(0xffffff, 0.62));
    var sun = new THREE.DirectionalLight(0xffffff, 0.75);
    sun.position.set(8, 16, 10);
    scene.add(sun);
    var fill = new THREE.DirectionalLight(0x88ccff, 0.25);
    fill.position.set(-10, 6, -8);
    scene.add(fill);

    // ---- bahan bersama (status warna)
    function lam(color, extra) {
      return new THREE.MeshLambertMaterial(Object.assign({ color: color }, extra || {}));
    }
    var baseMat = { ok: lam(COLORS.ok), low: lam(COLORS.low), out: lam(COLORS.out), none: lam(COLORS.none) };
    var dimMat = {};
    Object.keys(baseMat).forEach(function (k) {
      dimMat[k] = lam(COLORS[k], { transparent: true, opacity: 0.13, depthWrite: false });
    });
    var selMat = lam(COLORS.sel, { emissive: 0x007c8c });
    var frameMat = lam(COLORS.frame);
    var shelfMat = lam(COLORS.shelf);
    var floorMat = lam(COLORS.floor);
    var zoneFloorMat = lam(COLORS.zoneFloor);

    // ---- state
    var world = null;          // THREE.Group isi gudang (dibuang & dibuat ulang tiap setData)
    var cardMeshes = [];
    var disposables = [];
    var selected = null;
    var filterQ = '';
    var data = null;

    var view = { target: new THREE.Vector3(0, 1, 0), yaw: 0.6, pitch: 0.7, dist: 18 };
    var goal = null;           // animasi kamera {target, dist, yaw, pitch}
    var homeView = null;
    var dirty = true, raf = 0, running = false;
    var W = 0, H = 0, pendingFit = false;

    function statusOf(item) {
      if (opts.statusOf) return opts.statusOf(item) || 'none';
      return 'none';
    }
    function matches(item) {
      if (!filterQ) return true;
      return String(item.nama).toLowerCase().indexOf(filterQ) > -1 ||
             String(item.lokasi || '').toLowerCase().indexOf(filterQ) > -1;
    }
    // Saat ada pencarian / card terpilih, rak dibuat nyaris transparan supaya card
    // di susun bawah tidak terhalang rak lain ("x-ray").
    function applyXray() {
      var on = !!(filterQ || selected || view.pitch > 1.25);
      [frameMat, shelfMat].forEach(function (m) {
        if (m.transparent === on) return;
        m.transparent = on;
        m.opacity = on ? 0.14 : 1;
        m.depthWrite = !on;
        m.needsUpdate = true;
      });
    }
    function applyMaterial(mesh) {
      if (mesh === selected) { mesh.material = selMat; return; }
      var st = mesh.userData.status;
      mesh.material = matches(mesh.userData.item) ? baseMat[st] : dimMat[st];
    }

    // ---- bangun scene dari data
    function clearWorld() {
      if (world) scene.remove(world);
      disposables.forEach(function (d) { if (d && d.dispose) d.dispose(); });
      disposables = [];
      cardMeshes = [];
      selected = null;
      world = null;
    }
    function track(o) { disposables.push(o); return o; }

    function setData(items) {
      clearWorld();
      data = layout(items);
      world = new THREE.Group();
      scene.add(world);

      var b = data.bounds, hasAny = data.racks.length > 0;
      var cx = hasAny ? (b.minX + b.maxX) / 2 : 0;
      var cz = hasAny ? (b.minZ + b.maxZ) / 2 : 0;
      var spanX = hasAny ? (b.maxX - b.minX) : 8;
      var spanZ = hasAny ? (b.maxZ - b.minZ) : 8;
      var rackH = data.maxLevel * LEVEL_H + 0.1;

      // lantai besar + grid
      var fw = Math.max(spanX, 10) + 24, fd = Math.max(spanZ, 10) + 24;
      var floorGeo = track(new THREE.PlaneGeometry(fw, fd));
      var floor = new THREE.Mesh(floorGeo, floorMat);
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(cx, -0.02, cz);
      world.add(floor);
      var grid = new THREE.GridHelper(Math.max(fw, fd), Math.round(Math.max(fw, fd) / 2), 0x232a33, 0x1a2027);
      grid.position.set(cx, -0.01, cz);
      track(grid.geometry); track(grid.material);
      world.add(grid);

      // satu geometri dipakai ulang oleh semua rak/card
      var postGeo = track(new THREE.BoxGeometry(0.08, rackH, 0.08));
      var shelfGeo = track(new THREE.BoxGeometry(RACK_W, SHELF_T, RACK_D));
      var boxGeo = track(new THREE.BoxGeometry(BOX_W, BOX_H, BOX_W));

      data.zones.forEach(function (zone) {
        // alas zona
        var zw = zone.x1 - zone.x0 + 1.2, zd = RACK_D + 1.4;
        var zg = track(new THREE.PlaneGeometry(zw, zd));
        var zf = new THREE.Mesh(zg, zoneFloorMat);
        zf.rotation.x = -Math.PI / 2;
        zf.position.set((zone.x0 + zone.x1) / 2, 0, zone.z);
        world.add(zf);

        var zl = makeLabel(THREE, 'ZONA ' + zone.name, { color: '#39ff14', size: 72, worldH: 0.95 });
        track(zl.material.map); track(zl.material);
        zl.position.set(zone.x0 - 0.2 + zl.scale.x / 2, rackH + 1.1, zone.z);
        world.add(zl);
      });

      data.racks.forEach(function (rack) {
        var px = [-RACK_W / 2 + 0.04, RACK_W / 2 - 0.04], pz = [-RACK_D / 2 + 0.04, RACK_D / 2 - 0.04];
        px.forEach(function (dx) {
          pz.forEach(function (dz) {
            var p = new THREE.Mesh(postGeo, frameMat);
            p.position.set(rack.x + dx, rackH / 2, rack.z + dz);
            world.add(p);
          });
        });
        for (var l = 0; l <= data.maxLevel; l++) {
          var s = new THREE.Mesh(shelfGeo, shelfMat);
          s.position.set(rack.x, l * LEVEL_H + SHELF_T / 2, rack.z);
          world.add(s);
        }
        var rl = makeLabel(THREE, rack.label, { color: '#00e5ff', size: 56, worldH: 0.5 });
        track(rl.material.map); track(rl.material);
        rl.position.set(rack.x, rackH + 0.45, rack.z);
        world.add(rl);
      });

      data.placed.forEach(function (c) {
        var m = new THREE.Mesh(boxGeo, baseMat.none);
        m.position.set(c.x, c.y, c.z);
        m.userData = { item: c.item, parsed: c.parsed, status: statusOf(c.item) };
        cardMeshes.push(m);
        applyMaterial(m);
        world.add(m);
      });

      // kamera default
      var span = Math.max(spanX, spanZ, 6);
      scene.fog = new THREE.Fog(COLORS.bg, span * 2.2 + 20, span * 6 + 80);
      homeView = {
        target: new THREE.Vector3(cx, rackH * 0.35, cz),
        radius: 0.43 * Math.sqrt(spanX * spanX + spanZ * spanZ + rackH * rackH) + 1.2,
        dist: 18, yaw: 0.55, pitch: 0.62
      };
      pendingFit = true;
      resetView(true);
      dirty = true;
      return { placed: data.placed.length, racks: data.racks.length, zones: data.zones.length };
    }

    // ---- kamera
    function clampView() {
      view.pitch = Math.max(0.1, Math.min(1.5, view.pitch));
      view.dist = Math.max(3, Math.min(160, view.dist));
    }
    function updateCamera() {
      clampView();
      var cp = Math.cos(view.pitch);
      camera.position.set(
        view.target.x + view.dist * Math.sin(view.yaw) * cp,
        view.target.y + view.dist * Math.sin(view.pitch),
        view.target.z + view.dist * Math.cos(view.yaw) * cp
      );
      camera.lookAt(view.target);
    }
    function flyTo(g) { goal = g; dirty = true; }
    // Jarak kamera supaya seluruh gudang (bola pembatas) muat, memperhitungkan layar potret.
    function fitDist() {
      var vf = camera.fov * Math.PI / 180;
      var hf = 2 * Math.atan(Math.tan(vf / 2) * Math.max(camera.aspect, 0.2));
      return homeView.radius / Math.sin(Math.min(vf, hf) / 2);
    }
    function resetView(instant) {
      if (!homeView) return;
      homeView.dist = Math.max(8, fitDist());
      if (instant) {
        view.target.copy(homeView.target); view.dist = homeView.dist;
        view.yaw = homeView.yaw; view.pitch = homeView.pitch; goal = null;
      } else {
        flyTo({ target: homeView.target.clone(), dist: homeView.dist, yaw: homeView.yaw, pitch: homeView.pitch });
      }
      dirty = true;
    }
    function topView() {
      if (!homeView) return;
      homeView.dist = Math.max(8, fitDist());
      flyTo({ target: homeView.target.clone(), dist: homeView.dist * 1.15, yaw: 0, pitch: 1.5 });
    }
    function stepGoal() {
      if (!goal) return;
      var k = 0.16;
      view.target.lerp(goal.target, k);
      view.dist += (goal.dist - view.dist) * k;
      view.pitch += (goal.pitch - view.pitch) * k;
      // yaw lewat jalur terpendek
      var dy = goal.yaw - view.yaw;
      while (dy > Math.PI) dy -= 2 * Math.PI;
      while (dy < -Math.PI) dy += 2 * Math.PI;
      view.yaw += dy * k;
      if (view.target.distanceTo(goal.target) < 0.02 && Math.abs(goal.dist - view.dist) < 0.05 &&
          Math.abs(goal.pitch - view.pitch) < 0.005 && Math.abs(dy) < 0.005) goal = null;
      dirty = true;
    }
    function focusMesh(mesh) {
      if (!mesh) return;
      flyTo({ target: mesh.position.clone(), dist: 8, yaw: view.yaw, pitch: Math.max(Math.min(view.pitch, 0.9), 0.45) });
    }

    // ---- seleksi / filter
    function setSelected(mesh, silent) {
      var prev = selected;
      selected = mesh || null;
      if (prev) applyMaterial(prev);
      if (selected) applyMaterial(selected);
      applyXray();
      dirty = true;
      if (!silent && opts.onSelect) opts.onSelect(selected ? selected.userData.item : null, selected ? selected.userData.parsed : null);
    }
    function selectByName(nama, fly) {
      var t = String(nama).trim().toLowerCase();
      for (var i = 0; i < cardMeshes.length; i++) {
        if (String(cardMeshes[i].userData.item.nama).trim().toLowerCase() === t) {
          setSelected(cardMeshes[i]);
          if (fly) focusMesh(cardMeshes[i]);
          return true;
        }
      }
      return false;
    }
    // Mengembalikan jumlah card yang cocok. Kalau ada yang cocok, kamera terbang ke yang pertama.
    function setFilter(q) {
      filterQ = String(q || '').trim().toLowerCase();
      var first = null, n = 0;
      cardMeshes.forEach(function (m) {
        applyMaterial(m);
        if (matches(m.userData.item)) { n++; if (!first) first = m; }
      });
      applyXray();
      dirty = true;
      if (filterQ && first) focusMesh(first);
      return filterQ ? n : cardMeshes.length;
    }
    function refreshStatus() {
      cardMeshes.forEach(function (m) { m.userData.status = statusOf(m.userData.item); applyMaterial(m); });
      dirty = true;
    }

    // ---- input sentuh/mouse
    var pointers = {}, nPtr = 0, tapStart = null, lastPinch = 0, lastMid = null;
    var raycaster = new THREE.Raycaster();
    var ndc = new THREE.Vector2();

    function pick(clientX, clientY) {
      var r = el.getBoundingClientRect();
      ndc.x = ((clientX - r.left) / r.width) * 2 - 1;
      ndc.y = -((clientY - r.top) / r.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      var hits = raycaster.intersectObjects(cardMeshes, false);
      for (var i = 0; i < hits.length; i++) {
        // card yang diredupkan oleh filter tidak bisa dipilih
        if (matches(hits[i].object.userData.item)) return hits[i].object;
      }
      return null;
    }
    function pan(dx, dy) {
      var s = view.dist * 0.0016;
      var rx = Math.cos(view.yaw), rz = -Math.sin(view.yaw);        // kanan kamera di bidang tanah
      var fx = -Math.sin(view.yaw), fz = -Math.cos(view.yaw);       // maju kamera di bidang tanah
      view.target.x += (-dx * rx + dy * fx) * s;
      view.target.z += (-dx * rz + dy * fz) * s;
    }
    el.addEventListener('pointerdown', function (e) {
      try { el.setPointerCapture(e.pointerId); } catch (x) { /* abaikan */ }
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      nPtr = Object.keys(pointers).length;
      goal = null;
      if (nPtr === 1) tapStart = { x: e.clientX, y: e.clientY, t: Date.now(), moved: 0 };
      else { tapStart = null; lastPinch = 0; lastMid = null; }
    });
    el.addEventListener('pointermove', function (e) {
      var p = pointers[e.pointerId];
      if (!p) return;
      var dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (nPtr === 1) {
        if (tapStart) tapStart.moved += Math.abs(dx) + Math.abs(dy);
        view.yaw -= dx * 0.0065;
        view.pitch += dy * 0.0055;
      } else if (nPtr >= 2) {
        var ids = Object.keys(pointers), a = pointers[ids[0]], b = pointers[ids[1]];
        var d = Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
        var mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (lastPinch) view.dist *= lastPinch / Math.max(d, 1);
        if (lastMid) pan(mid.x - lastMid.x, mid.y - lastMid.y);
        lastPinch = d; lastMid = mid;
      }
      dirty = true;
    });
    function endPointer(e) {
      if (!pointers[e.pointerId]) return;
      var wasTap = nPtr === 1 && tapStart && tapStart.moved < 8 && (Date.now() - tapStart.t) < 450;
      delete pointers[e.pointerId];
      nPtr = Object.keys(pointers).length;
      lastPinch = 0; lastMid = null;
      if (e.type === 'pointerup' && wasTap) setSelected(pick(e.clientX, e.clientY));
      if (nPtr === 0) tapStart = null;
    }
    el.addEventListener('pointerup', endPointer);
    el.addEventListener('pointercancel', endPointer);
    el.addEventListener('wheel', function (e) {
      e.preventDefault();
      view.dist *= e.deltaY > 0 ? 1.1 : 0.9;
      goal = null; dirty = true;
    }, { passive: false });

    // ---- loop
    function fit() {
      var w = container.clientWidth, h = container.clientHeight;
      if (w === W && h === H) return w > 0 && h > 0;
      W = w; H = h;
      if (w > 0 && h > 0) {
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        if (pendingFit && homeView) { resetView(true); pendingFit = false; }
        dirty = true;
      }
      return w > 0 && h > 0;
    }
    function tick() {
      raf = 0;
      if (!running) return;
      if (fit()) {
        stepGoal();
        if (dirty) {
          updateCamera();
          applyXray();
          renderer.render(scene, camera);
          dirty = false;
        }
      }
      raf = global.requestAnimationFrame(tick);
    }
    function start() {
      if (running) return;
      running = true; dirty = true; W = H = 0;
      raf = global.requestAnimationFrame(tick);
    }
    function stop() {
      running = false;
      if (raf) { global.cancelAnimationFrame(raf); raf = 0; }
    }
    function dispose() {
      stop();
      clearWorld();
      renderer.dispose();
      if (el.parentNode) el.parentNode.removeChild(el);
    }

    return {
      setData: setData, setFilter: setFilter, refreshStatus: refreshStatus,
      selectByName: selectByName, clearSelection: function () { setSelected(null, true); },
      resetView: function () { resetView(false); }, topView: topView,
      start: start, stop: stop, dispose: dispose,
      get count() { return cardMeshes.length; }
    };
  }

  global.Lokasi3D = { parseLokasi: parseLokasi, layout: layout, create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.Lokasi3D;
})(typeof window !== 'undefined' ? window : globalThis);
