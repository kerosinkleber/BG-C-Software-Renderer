// Thin JavaScript wrapper around the WebAssembly build of the BG raster engine.
//
// Conventions match the Unity version: left-handed coordinates, +Y up, +Z forward,
// quaternions as (x, y, z, w), colors as 0..1 floats.

const OBJECT_STRIDE = 52;      // sizeof(BgTrans): position(3f) scale(4f) rotation(4f) meshindex(i32) tint(4 x u8)
const POINT_LIGHT_STRIDE = 32; // sizeof(PointLight): color(4f) position(3f) range(f)

export class BgEngine {
  /**
   * Loads the engine. Uses the multithreaded build when the page is cross-origin isolated
   * (needed for SharedArrayBuffer), otherwise the single-threaded build.
   */
  static async load({ baseUrl = new URL('./dist/', import.meta.url), forceSingleThread = false } = {}) {
    const multithreaded = !forceSingleThread && globalThis.crossOriginIsolated === true;
    const file = multithreaded ? 'raster-mt.js' : 'raster-st.js';
    const { default: createRasterEngine } = await import(new URL(file, baseUrl).href);
    const module = await createRasterEngine();
    return new BgEngine(module, multithreaded);
  }

  constructor(module, multithreaded) {
    this.m = module;
    this.multithreaded = multithreaded;
    this.maxThreads = multithreaded ? module._bg_init_threads(navigator.hardwareConcurrency || 4) : 1;
    this.textures = [];
    this.meshCount = 0;
    this.objectCapacity = 0;
    this.objectPtr = 0;
    this.pointLightCount = 0;
    this.width = 0;
    this.height = 0;

    // Texture 0 is the blank texture: meshes using it are drawn with their object tint.
    this.addTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  }

  get heap() { return this.m.HEAPU8; }

  /** Copies a typed array into a new malloc'd block. Caller frees. */
  _alloc(typed) {
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    const ptr = this.m._malloc(Math.max(4, bytes.length));
    this.heap.set(bytes, ptr);
    return ptr;
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    this.m._bg_resize(width, height);
  }

  /** rgba: Uint8Array/Uint8ClampedArray of width*height*4 bytes. Returns the texture index. */
  addTexture(rgba, width, height) {
    const ptr = this._alloc(rgba);
    this.m._AddTexture(ptr, width * height);
    this.m._free(ptr);
    this.textures.push({ width, height });
    return this.textures.length - 1;
  }

  /**
   * Adds a mesh and returns its index.
   * mesh: { verts: Float32Array(xyz), norms: Float32Array(xyz), uvs: Float32Array(uv), tris: Int32Array }
   * Front faces are clockwise seen from the front (Unity winding).
   * spec: smoothness 0..0.99, met: metalness 0..1 (quantized to quarters), both drive the
   * reflections of the deferred lighting pass.
   */
  addMesh(mesh, { texture = 0, spec = 0, met = 0, isStatic = false, useAlpha = false, faceColors = null } = {}) {
    const vcount = mesh.verts.length / 3;
    const tcount = mesh.tris.length;
    const faceCount = tcount / 3;

    const faces = new Float32Array(faceCount * 3);
    const v = mesh.verts;
    for (let f = 0; f < faceCount; f++) {
      const a = mesh.tris[f * 3] * 3, b = mesh.tris[f * 3 + 1] * 3, c = mesh.tris[f * 3 + 2] * 3;
      const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
      const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const len = Math.hypot(nx, ny, nz) || 1;
      faces[f * 3] = nx / len; faces[f * 3 + 1] = ny / len; faces[f * 3 + 2] = nz / len;
    }

    // Per-triangle colors are used by the "debug triangles" view.
    if (!faceColors) {
      faceColors = new Uint8Array(faceCount * 4);
      for (let i = 0; i < faceCount; i++) {
        faceColors[i * 4] = Math.random() * 256;
        faceColors[i * 4 + 1] = Math.random() * 256;
        faceColors[i * 4 + 2] = Math.random() * 256;
        faceColors[i * 4 + 3] = 255;
      }
    }

    const tex = this.textures[texture];
    const ptrs = [mesh.verts, mesh.norms, faces, mesh.uvs, faceColors, mesh.tris].map((a) => this._alloc(a));
    this.m._AddMesh(...ptrs, vcount, tcount, texture, tex.width, tex.height, 1, 0, spec, met, isStatic, useAlpha);
    ptrs.forEach((p) => this.m._free(p));
    return this.meshCount++;
  }

  /** Returns typed-array views on the engine's object buffer for `count` objects. */
  objects(count) {
    if (count > this.objectCapacity) {
      this.objectCapacity = Math.max(count, this.objectCapacity * 2, 64);
      this.objectPtr = this.m._bg_object_buffer(this.objectCapacity);
    }
    this.objectCount = count;
    const buffer = this.heap.buffer;
    return {
      count,
      f32: new Float32Array(buffer, this.objectPtr, (count * OBJECT_STRIDE) / 4),
      i32: new Int32Array(buffer, this.objectPtr, (count * OBJECT_STRIDE) / 4),
      u8: new Uint8Array(buffer, this.objectPtr, count * OBJECT_STRIDE),
    };
  }

  /** Writes one object. obj: { mesh, position:[x,y,z], scale:[x,y,z], radius, rotation:[x,y,z,w], tint:[r,g,b] (0..255) } */
  static writeObject(view, index, obj) {
    const f = index * 13;
    const p = obj.position, s = obj.scale || [1, 1, 1], q = obj.rotation || [0, 0, 0, 1], t = obj.tint || [255, 255, 255];
    view.f32[f] = p[0]; view.f32[f + 1] = p[1]; view.f32[f + 2] = p[2];
    view.f32[f + 3] = s[0]; view.f32[f + 4] = s[1]; view.f32[f + 5] = s[2]; view.f32[f + 6] = obj.radius ?? 2;
    view.f32[f + 7] = q[0]; view.f32[f + 8] = q[1]; view.f32[f + 9] = q[2]; view.f32[f + 10] = q[3];
    view.i32[f + 11] = obj.mesh;
    const b = index * OBJECT_STRIDE + 48;
    view.u8[b] = t[0]; view.u8[b + 1] = t[1]; view.u8[b + 2] = t[2]; view.u8[b + 3] = 255;
  }

  /** camera: { position, forward, up, right, fov (vertical, degrees) } */
  setCamera({ position, forward, up, right, fov }) {
    const tanFovHalf = Math.tan((fov * Math.PI) / 360);
    this.m._bg_set_camera(...forward, ...position, ...up, ...right, this.width / this.height, tanFovHalf);
  }

  /** lights: [{ color:[r,g,b] (0..1, pre-multiplied by intensity), position:[x,y,z], range }] */
  setPointLights(lights) {
    const ptr = this.m._bg_point_light_buffer(lights.length);
    const f = new Float32Array(this.heap.buffer, ptr, Math.max(1, lights.length) * (POINT_LIGHT_STRIDE / 4));
    lights.forEach((l, i) => {
      f.set([l.color[0], l.color[1], l.color[2], 1, l.position[0], l.position[1], l.position[2], l.range], i * 8);
    });
    this.pointLightCount = lights.length;
  }

  /**
   * env: { sunDir (towards the sun), sunColor, sunIntensity, ambient, groundAmbient, sky, horizon, fogColor, fogDistance }
   */
  setLighting(env, usePointLights = true) {
    this.env = env;
    this.m._bg_set_lighting(
      ...env.sunDir, ...env.sunColor, env.sunIntensity,
      ...env.ambient, ...env.groundAmbient, ...env.sky, ...env.horizon,
      ...env.fogColor, env.fogDistance, usePointLights ? this.pointLightCount : 0);
  }

  /**
   * Renders one frame (same order as BgCamera.cs: clear, rasterize, lighting, deferred).
   * Returns timings in ms and the triangle count.
   */
  render({ threads = this.maxThreads, simd = true, lighting = 'deferred', debugTriangles = false, usePointLights = true } = {}) {
    const m = this.m;
    const env = this.env;
    const t0 = performance.now();
    m._bg_clear(threads, ...env.sky.map((c) => c * 255), ...env.horizon.map((c) => c * 255));
    const t1 = performance.now();
    m._bg_render(threads, this.objectCount || 0, debugTriangles, simd && !debugTriangles, lighting === 'vertex');
    const t2 = performance.now();
    this.setLighting(env, usePointLights);
    if (lighting === 'deferred' && !debugTriangles) m._bg_deferred(threads);
    const t3 = performance.now();
    const stats = new Int32Array(this.heap.buffer, m._bg_stats(), 4);
    return { clear: t1 - t0, raster: t2 - t1, deferred: t3 - t2, triangles: stats[1] };
  }

  /** Copies the finished frame into a canvas 2D context. */
  present(ctx) {
    if (!this.imageData || this.imageData.width !== this.width || this.imageData.height !== this.height) {
      this.imageData = new ImageData(this.width, this.height);
    }
    const ptr = this.m._bg_present();
    this.imageData.data.set(this.heap.subarray(ptr, ptr + this.width * this.height * 4));
    ctx.putImageData(this.imageData, 0, 0);
  }
}
