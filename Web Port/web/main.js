// Demo scene for the WebAssembly build of the BG software renderer.
import { BgEngine } from './bg-engine.js';
import { plane, box, sphere, torus, cylinder, merge, textures } from './scene.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const ctx = canvas.getContext('2d', { alpha: false });
const ui = {
  resolution: $('resolution'), threads: $('threads'), threadsOut: $('threadsOut'), lighting: $('lighting'),
  crowd: $('crowd'), crowdOut: $('crowdOut'), simd: $('simd'), pointLights: $('pointLights'),
  debugTris: $('debugTris'), animate: $('animate'), autoCam: $('autoCam'), stats: $('stats'),
};

// ------------------------------------------------------------------ math helpers

function axisAngle(x, y, z, angle) {
  const s = Math.sin(angle / 2);
  return [x * s, y * s, z * s, Math.cos(angle / 2)];
}

function cameraBasis(yaw, pitch) {
  const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
  return {
    forward: [sy * cp, -sp, cy * cp],
    right: [cy, 0, -sy],
    up: [sy * sp, cp, cy * sp],
  };
}

function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

// ------------------------------------------------------------------ scene setup

function buildScene(engine) {
  const tex = {};
  for (const [name, make] of Object.entries(textures)) {
    const t = make();
    tex[name] = engine.addTexture(t.rgba, t.width, t.height);
  }

  const meshes = {
    ground: engine.addMesh(plane(240, 240, 48, 48, 60), { texture: tex.grass, isStatic: true }),
    plaza: engine.addMesh(plane(30, 30, 12, 12, 4), { texture: tex.checker, spec: 0.55, isStatic: true }),
    pillar: engine.addMesh(box(1.6, 7, 1.6), { texture: tex.bricks }),
    chrome: engine.addMesh(sphere(1, 32, 20), { spec: 0.92, met: 1 }),
    glossy: engine.addMesh(sphere(1, 24, 16), { spec: 0.75 }),
    ring: engine.addMesh(torus(1.6, 0.4, 36, 14), { texture: tex.wood, spec: 0.6, met: 0.5 }),
    crate: engine.addMesh(box(1, 1, 1), { texture: tex.wood }),
    tree: engine.addMesh(merge(
      { mesh: cylinder(0.25, 0.2, 1.5, 8) },
      { mesh: cylinder(1.4, 0, 3, 10), offset: [0, 1.2, 0] },
      { mesh: cylinder(1.0, 0, 2.2, 10), offset: [0, 2.6, 0] },
    ), { texture: tex.leaves }),
    soldier: engine.addMesh(merge(
      { mesh: box(0.6, 0.8, 0.35), offset: [0, 0.9, 0] },
      { mesh: box(0.22, 0.5, 0.22), offset: [-0.15, 0.25, 0] },
      { mesh: box(0.22, 0.5, 0.22), offset: [0.15, 0.25, 0] },
      { mesh: sphere(0.2, 8, 6), offset: [0, 1.5, 0] },
    ), { spec: 0.3 }),
  };

  const random = rng(7);
  const trees = [];
  while (trees.length < 180) {
    const x = (random() - 0.5) * 220, z = (random() - 0.5) * 220;
    if (Math.hypot(x, z) < 26) continue;
    const s = 0.8 + random() * 0.8;
    trees.push({ mesh: meshes.tree, position: [x, 0, z], scale: [s, s, s], radius: 5,
      rotation: axisAngle(0, 1, 0, random() * 6.28) });
  }

  const lights = [
    [1.0, 0.35, 0.2], [0.25, 0.6, 1.0], [0.3, 1.0, 0.4], [1.0, 0.85, 0.3],
  ];

  return { meshes, trees, lights };
}

function sceneObjects(scene, time, crowdSize) {
  const { meshes } = scene;
  const objs = [
    { mesh: meshes.ground, position: [0, 0, 0], radius: 200 },
    { mesh: meshes.plaza, position: [0, 0.03, 0], radius: 25 },
    { mesh: meshes.chrome, position: [0, 2.6 + Math.sin(time * 1.3) * 0.4, 0], scale: [2, 2, 2], radius: 1.2 },
    { mesh: meshes.ring, position: [0, 2.6, 0], scale: [1.6, 1.6, 1.6], radius: 2.2,
      rotation: axisAngle(Math.SQRT1_2, 0, Math.SQRT1_2, time * 0.9) },
  ];

  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    objs.push({ mesh: meshes.pillar, position: [Math.cos(a) * 12, 3.5, Math.sin(a) * 12], radius: 4,
      rotation: axisAngle(0, 1, 0, -a) });
    const b = a + Math.PI / 8;
    const hue = [[230, 70, 60], [70, 140, 235], [240, 200, 70], [90, 200, 120]][i % 4];
    objs.push({ mesh: meshes.glossy, position: [Math.cos(b) * 8, 0.8, Math.sin(b) * 8], scale: [0.8, 0.8, 0.8],
      radius: 1.2, tint: hue });
  }

  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + time * 0.25;
    objs.push({ mesh: meshes.crate, position: [Math.cos(a) * 16, 0.5 + Math.abs(Math.sin(time * 2 + i)) * 0.6, Math.sin(a) * 16],
      radius: 1, rotation: axisAngle(0, 1, 0, time + i) });
  }

  objs.push(...scene.trees);

  // Two armies marching back and forth across the field (like the SimpleArmy demo).
  const perArmy = Math.floor(crowdSize / 2);
  const cols = 25;
  for (let army = 0; army < 2; army++) {
    const dir = army === 0 ? 1 : -1;
    const advance = Math.sin(time * 0.3) * 12 * dir;
    for (let i = 0; i < perArmy; i++) {
      const col = i % cols, row = Math.floor(i / cols);
      const x = (col - cols / 2) * 1.6;
      const z = -dir * (40 + row * 1.8) + advance;
      const bob = Math.abs(Math.sin(time * 6 + i * 0.7)) * 0.15;
      objs.push({ mesh: meshes.soldier, position: [x, bob, z], radius: 1.6,
        rotation: axisAngle(0, 1, 0, army === 0 ? 0 : Math.PI),
        tint: army === 0 ? [200, 60, 50] : [60, 90, 210] });
    }
  }
  return objs;
}

function pointLights(scene, time) {
  return scene.lights.map((color, i) => {
    const a = time * 0.7 + (i / scene.lights.length) * Math.PI * 2;
    return { color: color.map((c) => c * 2), position: [Math.cos(a) * 9, 1.6, Math.sin(a) * 9], range: 9 };
  });
}

const environment = {
  sunDir: normalize([0.45, 0.75, -0.35]),
  sunColor: [1, 0.96, 0.88],
  sunIntensity: 1,
  ambient: [0.4, 0.5, 0.6],
  groundAmbient: [0.4, 0.4, 0.4],
  sky: [0.3, 0.45, 0.95],
  horizon: [0.75, 0.8, 1],
  fogColor: [0.3 + (0.75 - 0.3) * 0.65, 0.45 + (0.8 - 0.45) * 0.65, 0.95 + (1 - 0.95) * 0.65],
  fogDistance: 400,
};

function normalize(v) {
  const l = Math.hypot(...v);
  return v.map((c) => c / l);
}

// ------------------------------------------------------------------ input / camera

const camera = { position: [0, 8, -30], yaw: 0, pitch: 0.2, fov: 60 };
const keys = new Set();

function stopAutoCam() { ui.autoCam.checked = false; }

canvas.addEventListener('click', () => {
  if (matchMedia('(pointer: fine)').matches) canvas.requestPointerLock?.();
});
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return;
  stopAutoCam();
  camera.yaw += e.movementX * 0.0025;
  camera.pitch = Math.max(-1.55, Math.min(1.55, camera.pitch + e.movementY * 0.0025));
});
let drag = null;
canvas.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') drag = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  stopAutoCam();
  camera.yaw += (e.clientX - drag.x) * 0.005;
  camera.pitch = Math.max(-1.55, Math.min(1.55, camera.pitch + (e.clientY - drag.y) * 0.005));
  drag = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerup', () => { drag = null; });
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  keys.add(e.code);
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

function updateCamera(dt, time) {
  if (ui.autoCam.checked) {
    const a = time * 0.12;
    camera.position = [Math.sin(a) * 30, 9 + Math.sin(time * 0.3) * 3, -Math.cos(a) * 30];
    const d = normalize(camera.position.map((c, i) => [0, 2, 0][i] - c));
    camera.yaw = Math.atan2(d[0], d[2]);
    camera.pitch = -Math.asin(d[1]);
    return;
  }
  const b = cameraBasis(camera.yaw, camera.pitch);
  const move = [0, 0, 0];
  const add = (v, s) => { for (let i = 0; i < 3; i++) move[i] += v[i] * s; };
  if (keys.has('KeyW')) add(b.forward, 1);
  if (keys.has('KeyS')) add(b.forward, -1);
  if (keys.has('KeyD')) add(b.right, 1);
  if (keys.has('KeyA')) add(b.right, -1);
  if (keys.has('Space') || keys.has('KeyE')) add(b.up, 1);
  if (keys.has('ControlLeft') || keys.has('KeyQ')) add(b.up, -1);
  if (move.some((c) => c !== 0)) stopAutoCam();
  const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 30 : 10) * dt;
  for (let i = 0; i < 3; i++) camera.position[i] += move[i] * speed;
}

// ------------------------------------------------------------------ main loop

function resize(engine) {
  const scale = parseFloat(ui.resolution.value);
  const w = Math.max(64, Math.floor(innerWidth * scale));
  const h = Math.max(36, Math.floor(innerHeight * scale));
  if (w === canvas.width && h === canvas.height && engine.width === w) return;
  canvas.width = w;
  canvas.height = h;
  engine.resize(w, h);
}

async function main() {
  let engine;
  try {
    engine = await BgEngine.load({ forceSingleThread: new URLSearchParams(location.search).has('st') });
  } catch (err) {
    const box = $('error');
    box.style.display = 'block';
    box.textContent = `Could not load the WebAssembly engine: ${err}. Serve this folder over HTTP (see README), `
      + 'and use a browser with WebAssembly SIMD support.';
    ui.stats.textContent = '';
    throw err;
  }

  ui.threads.max = engine.maxThreads;
  ui.threads.value = engine.maxThreads;
  ui.threadsOut.textContent = engine.maxThreads;
  ui.threads.addEventListener('input', () => { ui.threadsOut.textContent = ui.threads.value; });
  ui.crowd.addEventListener('input', () => { ui.crowdOut.textContent = ui.crowd.value; });
  ui.resolution.addEventListener('change', () => resize(engine));
  addEventListener('resize', () => resize(engine));
  resize(engine);

  const scene = buildScene(engine);
  let time = 0, last = performance.now(), fps = 0, avg = null;

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (ui.animate.checked) time += dt;
    updateCamera(dt, now / 1000);

    const objs = sceneObjects(scene, time, parseInt(ui.crowd.value, 10));
    const view = engine.objects(objs.length);
    objs.forEach((o, i) => BgEngine.writeObject(view, i, o));

    const basis = cameraBasis(camera.yaw, camera.pitch);
    engine.setCamera({ position: camera.position, ...basis, fov: camera.fov });
    engine.setPointLights(pointLights(scene, time));
    engine.setLighting(environment, ui.pointLights.checked);

    const t = engine.render({
      threads: parseInt(ui.threads.value, 10),
      simd: ui.simd.checked,
      lighting: ui.lighting.value,
      debugTriangles: ui.debugTris.checked,
      usePointLights: ui.pointLights.checked,
    });
    const p0 = performance.now();
    engine.present(ctx);
    t.present = performance.now() - p0;
    t.total = t.clear + t.raster + t.deferred + t.present;

    // Smoothed stats.
    fps = fps ? fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05 : 60;
    avg = avg ? Object.fromEntries(Object.entries(t).map(([k, v]) => [k, avg[k] * 0.9 + v * 0.1])) : t;
    ui.stats.innerHTML =
      `<span class="fps">${fps.toFixed(0)} fps</span>\n`
      + `render   ${avg.total.toFixed(1)} ms\n`
      + `  clear    ${avg.clear.toFixed(1)}\n`
      + `  raster   ${avg.raster.toFixed(1)}\n`
      + `  lighting ${avg.deferred.toFixed(1)}\n`
      + `  present  ${avg.present.toFixed(1)}\n`
      + `${engine.width}x${engine.height}, ${objs.length} objects\n`
      + `${Math.round(avg.triangles)} triangles\n`
      + (engine.multithreaded
        ? `${ui.threads.value}/${engine.maxThreads} threads`
        : crossOriginIsolated ? 'single-threaded build' : 'single-threaded build\n(serve with COOP/COEP\n for threads)');

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main();
