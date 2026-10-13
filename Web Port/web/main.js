// Demo scene for the BG software renderer: the CPU engine (WebAssembly) or its WebGPU version.
import { BgEngine } from './bg-engine.js';
import { GpuRenderer } from './gpu-renderer.js';
import { plane, box, sphere, torus, cylinder, merge, textures } from './scene.js';

const $ = (id) => document.getElementById(id);
// A canvas can only ever have one kind of context, so each renderer gets its own canvas.
const cpuCanvas = $('view');
const gpuCanvas = $('viewGpu');
const ctx = cpuCanvas.getContext('2d', { alpha: false });
const ui = {
  renderer: $('renderer'), cpuOnly: document.querySelectorAll('.cpu-only'),
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

// Geometry and textures are generated once and then handed to whichever renderer
// (CPU or GPU) is active, so both draw exactly the same scene.
function sceneAssets() {
  const tex = Object.fromEntries(Object.entries(textures).map(([name, make]) => [name, make()]));
  const meshes = {
    ground: [plane(240, 240, 48, 48, 60), { texture: 'grass', isStatic: true }],
    plaza: [plane(30, 30, 12, 12, 4), { texture: 'checker', spec: 0.55, isStatic: true }],
    pillar: [box(1.6, 7, 1.6), { texture: 'bricks' }],
    chrome: [sphere(1, 32, 20), { spec: 0.92, met: 1 }],
    glossy: [sphere(1, 24, 16), { spec: 0.75 }],
    ring: [torus(1.6, 0.4, 36, 14), { texture: 'wood', spec: 0.6, met: 0.5 }],
    crate: [box(1, 1, 1), { texture: 'wood' }],
    tree: [merge(
      { mesh: cylinder(0.25, 0.2, 1.5, 8) },
      { mesh: cylinder(1.4, 0, 3, 10), offset: [0, 1.2, 0] },
      { mesh: cylinder(1.0, 0, 2.2, 10), offset: [0, 2.6, 0] },
    ), { texture: 'leaves' }],
    soldier: [merge(
      { mesh: box(0.6, 0.8, 0.35), offset: [0, 0.9, 0] },
      { mesh: box(0.22, 0.5, 0.22), offset: [-0.15, 0.25, 0] },
      { mesh: box(0.22, 0.5, 0.22), offset: [0.15, 0.25, 0] },
      { mesh: sphere(0.2, 8, 6), offset: [0, 1.5, 0] },
    ), { spec: 0.3 }],
  };
  // Same random debug-triangle colors for both renderers.
  for (const [mesh, opts] of Object.values(meshes)) {
    opts.faceColors = new Uint8Array(mesh.tris.length / 3 * 4).map((_, i) => (i % 4 === 3 ? 255 : Math.random() * 256));
  }
  return { tex, meshes };
}

function buildScene(engine, assets) {
  const tex = {};
  for (const [name, t] of Object.entries(assets.tex)) tex[name] = engine.addTexture(t.rgba, t.width, t.height);
  const meshes = {};
  for (const [name, [mesh, opts]] of Object.entries(assets.meshes)) {
    meshes[name] = engine.addMesh(mesh, { ...opts, texture: opts.texture ? tex[opts.texture] : 0 });
  }

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

let drag = null;
for (const canvas of [cpuCanvas, gpuCanvas]) {
  canvas.addEventListener('click', () => {
    if (matchMedia('(pointer: fine)').matches) canvas.requestPointerLock?.();
  });
  canvas.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') drag = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    stopAutoCam();
    camera.yaw += (e.clientX - drag.x) * 0.005;
    camera.pitch = Math.max(-1.55, Math.min(1.55, camera.pitch + (e.clientY - drag.y) * 0.005));
    drag = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointerup', () => { drag = null; });
}
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== cpuCanvas && document.pointerLockElement !== gpuCanvas) return;
  stopAutoCam();
  camera.yaw += e.movementX * 0.0025;
  camera.pitch = Math.max(-1.55, Math.min(1.55, camera.pitch + e.movementY * 0.0025));
});
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

// ------------------------------------------------------------------ renderers

const params = new URLSearchParams(location.search);
const assets = sceneAssets();
// name -> { engine, scene, canvas } once loaded (or a promise while loading).
const backends = {};
let active = null;

function showError(message) {
  const box = $('error');
  box.style.display = message ? 'block' : 'none';
  box.textContent = message || '';
}

function resizeActive() {
  if (!active) return;
  const scale = parseFloat(ui.resolution.value);
  const w = Math.max(64, Math.floor(innerWidth * scale));
  const h = Math.max(36, Math.floor(innerHeight * scale));
  if (active.engine.width === w && active.engine.height === h) return;
  active.canvas.width = w;
  active.canvas.height = h;
  active.engine.resize(w, h);
}

async function loadBackend(name) {
  if (name === 'cpu') {
    const engine = await BgEngine.load({ forceSingleThread: params.has('st') });
    return { name, engine, canvas: cpuCanvas, scene: buildScene(engine, assets) };
  }
  const engine = await GpuRenderer.load(gpuCanvas);
  if (!engine) throw new Error('WebGPU is not available in this browser');
  engine.device.lost.then((info) => { if (active?.engine === engine) showError(`WebGPU device lost: ${info.message}`); });
  return { name, engine, canvas: gpuCanvas, scene: buildScene(engine, assets) };
}

async function switchRenderer(name) {
  try {
    backends[name] ??= loadBackend(name);
    const backend = await backends[name];
    if (ui.renderer.value !== name) return; // the user switched again while loading
    active = backend;
    showError('');
  } catch (err) {
    delete backends[name];
    const hint = name === 'cpu'
      ? 'Serve this folder over HTTP (see README) and use a browser with WebAssembly SIMD support.'
      : 'Use a browser with WebGPU (recent Chrome, Edge or Safari; Firefox on some platforms).';
    const message = `Could not start the ${name === 'cpu' ? 'CPU (WebAssembly)' : 'GPU (WebGPU)'} renderer: ${err.message || err}. ${hint}`;
    showError(message);
    console.error(err);
    if (name === 'gpu') {
      const option = ui.renderer.querySelector('option[value=gpu]');
      option.disabled = true;
      option.textContent = 'GPU (WebGPU, not available)';
      // Nothing is running yet (e.g. opened with ?renderer=gpu): fall back to the CPU renderer.
      if (!active) {
        ui.renderer.value = 'cpu';
        await switchRenderer('cpu');
        showError(`${message} Using the CPU renderer instead.`);
        setTimeout(() => { if (active?.name === 'cpu') showError(''); }, 8000);
        return;
      }
    }
    if (active) ui.renderer.value = active.name;
    return;
  }
  cpuCanvas.hidden = name !== 'cpu';
  gpuCanvas.hidden = name !== 'gpu';
  ui.cpuOnly.forEach((el) => { el.classList.toggle('disabled', name !== 'cpu'); });
  if (name === 'cpu') {
    const { engine } = active;
    ui.threads.max = engine.maxThreads;
    if (+ui.threads.value > engine.maxThreads || !ui.threads.dataset.touched) ui.threads.value = engine.maxThreads;
    ui.threadsOut.textContent = ui.threads.value;
  }
  avg = null;
  resizeActive();
  if (params.get('renderer') !== name) {
    params.set('renderer', name);
    history.replaceState(null, '', `?${params}`);
  }
}

// ------------------------------------------------------------------ main loop

let time = 0, last = performance.now(), lastRendered = 0, fps = 0, avg = null;

function statsText(objs) {
  const { engine, name } = active;
  const size = `${engine.width}x${engine.height}, ${objs.length} objects\n`;
  if (name === 'gpu') {
    const info = engine.adapterInfo;
    const adapter = [info.vendor, info.architecture || info.device].filter(Boolean).join(' ') || 'GPU';
    return `<span class="fps">${fps.toFixed(0)} fps</span>\n`
      + 'GPU (WebGPU)\n'
      + `  cpu encode ${avg.encode.toFixed(1)} ms\n`
      + `  gpu ~      ${avg.gpu.toFixed(1)} ms\n`
      + size
      + `${Math.round(avg.triangles)} triangles submitted\n`
      + adapter;
  }
  return `<span class="fps">${fps.toFixed(0)} fps</span>\n`
    + 'CPU (WebAssembly)\n'
    + `render   ${avg.total.toFixed(1)} ms\n`
    + `  clear    ${avg.clear.toFixed(1)}\n`
    + `  raster   ${avg.raster.toFixed(1)}\n`
    + `  lighting ${avg.deferred.toFixed(1)}\n`
    + `  present  ${avg.present.toFixed(1)}\n`
    + size
    + `${Math.round(avg.triangles)} triangles\n`
    + (engine.multithreaded
      ? `${ui.threads.value}/${engine.maxThreads} threads`
      : crossOriginIsolated ? 'single-threaded build' : 'single-threaded build\n(serve with COOP/COEP\n for threads)');
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!active) return;
  if (ui.animate.checked) time += dt;
  updateCamera(dt, now / 1000);

  const { engine, scene } = active;
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
  if (!t) return; // GPU still busy with earlier frames
  const p0 = performance.now();
  engine.present(ctx);
  t.present = performance.now() - p0;
  t.total = (t.clear ?? 0) + (t.raster ?? 0) + (t.deferred ?? 0) + t.present;

  // Smoothed stats.
  const frameTime = Math.min(1, (now - lastRendered) / 1000);
  lastRendered = now;
  fps = fps ? fps * 0.95 + (1 / Math.max(frameTime, 1e-3)) * 0.05 : 60;
  avg = avg ? Object.fromEntries(Object.entries(t).map(([k, v]) => [k, avg[k] * 0.9 + v * 0.1])) : t;
  ui.stats.innerHTML = statsText(objs);
}

function main() {
  ui.threads.addEventListener('input', () => { ui.threadsOut.textContent = ui.threads.value; ui.threads.dataset.touched = '1'; });
  ui.crowd.addEventListener('input', () => { ui.crowdOut.textContent = ui.crowd.value; });
  ui.resolution.addEventListener('change', resizeActive);
  ui.renderer.addEventListener('change', () => switchRenderer(ui.renderer.value));
  addEventListener('resize', resizeActive);

  const gpuOption = ui.renderer.querySelector('option[value=gpu]');
  if (!navigator.gpu) {
    gpuOption.disabled = true;
    gpuOption.textContent += ' (not supported)';
  }
  const wanted = params.get('renderer') === 'gpu' && navigator.gpu ? 'gpu' : 'cpu';
  ui.renderer.value = wanted;
  switchRenderer(wanted);
  requestAnimationFrame(frame);
}

main();
