# BG Software Renderer: Web Port

A standalone browser version of the BG C++ software rasterizer. The engine is compiled to
WebAssembly with Emscripten and draws into a `<canvas>`. It does not need Unity.

The demo also includes a **WebGPU version** of the same renderer. You can switch between the
CPU engine and the GPU version live in the browser tab.

This folder is self-contained and does not change the Unity project or the original C++
source. `engine/MainEngine.cpp` is a copy of
`C++ Source Project/Project1/Project1/MainEngine.cpp`, and every change is marked with a
`WEB PORT` comment.

## Run the demo

The prebuilt engine is in `web/dist`, so you don't need Emscripten to try it:

```bash
cd "Web Port/web"
python3 serve.py          # then open http://localhost:8000
```

`serve.py` is a small static server that sends the `Cross-Origin-Opener-Policy` and
`Cross-Origin-Embedder-Policy` headers. Browsers only allow `SharedArrayBuffer`, and so the
multithreaded engine, on pages with those headers. Other static hosts work too, for example
GitHub Pages, but without those headers the demo falls back to the single-threaded build. You
can force the single-threaded build with `?st` in the URL.

Controls: click the view, then use the mouse to look, WASD to move, Q/E or Space/Ctrl to go
down/up, Shift to move faster and Esc to release the mouse. On touch screens, drag to look. The
panel controls the renderer (CPU or GPU), resolution, thread count, lighting mode (deferred
per-pixel, per-vertex, unlit), SIMD, point lights, the debug triangle view and the size of the
marching crowd. Threads and SIMD only apply to the CPU renderer.

The **Renderer** setting switches between "CPU (WebAssembly)" and "GPU (WebGPU)" without
reloading. The camera, animation and settings carry over. `?renderer=gpu` in the URL starts on
the GPU. In browsers without WebGPU the GPU option is greyed out, and the demo falls back to
the CPU renderer.

## Build the engine

Install the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html), then:

```bash
source /path/to/emsdk/emsdk_env.sh
cd "Web Port"
./build.sh
```

This writes `web/dist/raster-mt.{js,wasm}` (multithreaded) and `web/dist/raster-st.{js,wasm}`
(single-threaded).

## Layout

| Path | What it is |
| --- | --- |
| `engine/MainEngine.cpp` | The engine, ported (see changes below) |
| `engine/ThreadPool.h` | Persistent worker pool used instead of per-call `std::thread`s |
| `engine/WebApi.cpp` | JS-friendly C API: owns the frame buffers, flattens struct parameters, converts the frame for the canvas |
| `build.sh` | Emscripten build for both variants |
| `web/bg-engine.js` | JavaScript wrapper (`BgEngine`): load, add meshes/textures, set camera/lighting, render, present |
| `web/gpu-renderer.js` | WebGPU version of the renderer (`GpuRenderer`), with the same API as `BgEngine` |
| `web/scene.js` | Procedural meshes (plane, box, sphere, torus, cylinder/cone) and textures |
| `web/main.js`, `web/index.html` | The demo |
| `web/serve.py` | Local server with COOP/COEP headers |

## Changes to the engine

- `__declspec(dllexport)` maps to `EMSCRIPTEN_KEEPALIVE`, and `std::floorf` becomes `floorf`
  (the original was MSVC-only). The unused `<execution>` include is removed.
- **SIMD:** the AVX/AVX2 intrinsics are kept. Emscripten translates them to 128-bit WebAssembly
  SIMD (`-msimd128 -mavx2`). Emscripten's `_mm_cvtps_epi32`/`_mm_cvttps_epi32` are scalar
  loops, which made the SIMD path slower than the scalar one. Those two conversions are now
  overridden with native WASM SIMD conversions.
- **Threads:** `Clear`, `Differed` and `RenderObjectsPooled` used to create new `std::thread`s on
  every call. In the browser each thread is a Web Worker, so they now run on a persistent pool
  (`ThreadPool.h`). Work distribution is unchanged.
- **Sky gradient:** `Clear` now also fills the last `Width % 8` pixels of each row.

`WebApi.cpp` also adds one row of padding to the frame buffers, because the rasterizer can write
one pixel past the end of a scanline.

## GPU (WebGPU) renderer

`web/gpu-renderer.js` reproduces the engine's pipeline on the GPU, using the GPU's hardware
rasterizer:

| CPU engine | WebGPU version |
| --- | --- |
| Per-vertex scale, `rotateq`, translation and projection | Vertex shader, using the same quaternion formula. Objects are drawn with one instanced draw call per mesh |
| Scanline rasterizer, barycentrics, depth buffer | GPU hardware, with a reversed-Z depth buffer |
| Color buffer with the specular/metal code in alpha, plus normal buffer | Two render targets with the same encoding |
| `Clear` sky gradient and `Differed` lighting | One full-screen shader, ported line by line: sun, sky/ground ambient, point lights, fog and sky reflections |
| Vertex lighting, unlit and debug-triangle modes | Same modes, with the same per-triangle debug colors |

Both renderers get the same meshes and textures, so the images match closely. Small
differences remain. The GPU clips triangles properly at the near plane, where the CPU engine
moves vertices onto it. The GPU keeps normals as floats instead of 8 bits, and it uses the
hardware's pixel coverage rules. The GPU stats show the CPU time spent recording commands and
an approximate GPU time. The triangle count is triangles submitted, before back-face culling.

## Using the engine in your own page

```js
import { BgEngine } from './bg-engine.js';

const engine = await BgEngine.load();
engine.resize(640, 360);
const tex = engine.addTexture(rgbaBytes, 128, 128);          // Uint8Array, width*height*4
const mesh = engine.addMesh({ verts, norms, uvs, tris }, { texture: tex, spec: 0.5 });

const objects = engine.objects(1);
BgEngine.writeObject(objects, 0, { mesh, position: [0, 0, 5], radius: 1 });

engine.setCamera({ position: [0, 1, 0], forward: [0, 0, 1], up: [0, 1, 0], right: [1, 0, 0], fov: 60 });
engine.setLighting({ sunDir: [0.4, 0.8, -0.4], sunColor: [1, 1, 1], sunIntensity: 1,
  ambient: [0.4, 0.5, 0.6], groundAmbient: [0.4, 0.4, 0.4], sky: [0.3, 0.45, 0.95],
  horizon: [0.75, 0.8, 1], fogColor: [0.6, 0.67, 0.98], fogDistance: 400 });
engine.render({ lighting: 'deferred' });
engine.present(canvas.getContext('2d'));
```

Conventions match Unity: left-handed coordinates, +Y up, clockwise front faces, quaternions as
(x, y, z, w), and colors as 0..1 floats.

`GpuRenderer` has the same methods. Create it with `await GpuRenderer.load(canvas)`, which
returns `null` without WebGPU, and pass it a canvas that has no other context. `present()` does
nothing for it, because the browser shows the WebGPU canvas automatically.

## Performance notes

These are CPU renderer numbers from headless Chromium on a 4-core cloud VM, at 1280x720 with the
demo scene (about 3,000 objects). They show relative cost only:

| Lighting | SIMD | Threads | Frame (ms) |
| --- | --- | --- | --- |
| deferred | on | 1 | 72 |
| deferred | on | 4 | 26 |
| deferred | off | 4 | 42 |
| per vertex | on | 4 | 17 |

At these settings the deferred lighting pass is the largest cost. That pass is scalar code in
the original engine too. Lower resolutions (the 50% default) or per-vertex lighting run at
60 fps on typical desktop CPUs. The WebGPU version moves all of this work to the GPU. It wasn't
benchmarked here, because the test machine has no GPU (only a software emulation).
