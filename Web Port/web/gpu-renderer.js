// WebGPU version of the BG renderer.
//
// It reproduces the CPU engine's pipeline with the GPU's hardware rasterizer:
//   geometry pass  - instanced draw per mesh; the vertex shader does the engine's
//                    scale -> quaternion rotation -> translation -> projection, and the
//                    fragment shader writes color (alpha = specular/metal code) and normal,
//                    like RenderObjectsPooled.
//   lighting pass  - full-screen pass with the sky gradient (Clear) and a line-by-line port
//                    of the deferred lighting (Differed): sun, sky/ground ambient, point
//                    lights, fog and sky reflections.
//
// The public API matches BgEngine (bg-engine.js), so the demo can switch between them.

const OBJECT_STRIDE = 52; // same object layout as the CPU engine's BgTrans
const INSTANCE_FLOATS = 16;
const VERTEX_STRIDE = 36; // position(3f) normal(3f) uv(2f) faceColor(4 x u8)
const NEAR = 0.01;        // the CPU engine's near plane

const MODE = { deferred: 0, vertex: 1, none: 2, debug: 3 };

const SHADER = /* wgsl */ `
struct Frame {
  camPos: vec4f, camRight: vec4f, camUp: vec4f, camFwd: vec4f,
  proj: vec4f,      // 1/(tanHalf*aspect), 1/tanHalf, near, mode
  screen: vec4f,    // width, height, tanHalf, aspect
  sunDir: vec4f, sunCol: vec4f,   // sunCol.w = intensity
  ambient: vec4f, groundAmb: vec4f, sky: vec4f, horizon: vec4f,
  fog: vec4f,       // rgb, w = fog distance
  misc: vec4f,      // x = point light count
};
struct Instance { pos: vec4f, scale: vec4f, rot: vec4f, tint: vec4f };
struct Material { specCode: f32, hasTexture: f32, pad0: f32, pad1: f32 };
struct PointLight { color: vec4f, posRange: vec4f };

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> instances: array<Instance>;
@group(1) @binding(0) var tex: texture_2d<f32>;
@group(1) @binding(1) var samp: sampler;
@group(1) @binding(2) var<uniform> M: Material;

// Same formula as the engine's rotateq.
fn rotq(v: vec3f, q: vec4f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

struct VsIn {
  @location(0) pos: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) faceColor: vec4f,
};
struct VsOut {
  @builtin(position) clip: vec4f,
  @location(0) normal: vec3f,
  @location(1) uv: vec2f,
  @location(2) vertexLight: vec3f,
  @location(3) viewZ: f32,
  @location(4) @interpolate(flat) tint: vec4f,
  @location(5) @interpolate(flat) faceColor: vec4f,
};

@vertex fn vsGeometry(in: VsIn, @builtin(instance_index) ii: u32) -> VsOut {
  let inst = instances[ii];
  let world = rotq(in.pos * inst.scale.xyz, inst.rot) + inst.pos.xyz;
  let n = rotq(in.normal, inst.rot);
  let rel = world - F.camPos.xyz;
  let v = vec3f(dot(rel, F.camRight.xyz), dot(rel, F.camUp.xyz), dot(rel, F.camFwd.xyz));

  var out: VsOut;
  // Reversed infinite depth: depth = near / viewZ. Triangles are clipped at the near plane.
  out.clip = vec4f(v.x * F.proj.x, v.y * F.proj.y, F.proj.z, v.z);
  out.normal = n;
  out.uv = in.uv;
  out.viewZ = v.z;
  out.tint = inst.tint;
  out.faceColor = in.faceColor;

  // Per-vertex sun + ambient, as in the engine's vertexLight path.
  let fac = clamp(dot(n, F.sunDir.xyz), 0.0, 1.0);
  out.vertexLight = F.sunCol.rgb * (fac * F.sunCol.w) + mix(F.groundAmb.rgb, F.ambient.rgb, (n.y + 1.0) * 0.5);
  return out;
}

struct GBuffer { @location(0) color: vec4f, @location(1) normal: vec4f };

@fragment fn fsGeometry(in: VsOut) -> GBuffer {
  let texel = textureSample(tex, samp, fract(in.uv)).rgb;
  var albedo = select(in.tint.rgb, texel, M.hasTexture > 0.5);
  let mode = u32(F.proj.w);
  var color = albedo;
  if (mode == 1u) {
    color = min(vec3f(1.0), albedo * in.vertexLight);
    let f = sqrt(min(1.0, in.viewZ / F.fog.w));
    color = min(vec3f(1.0), mix(color, F.fog.rgb, f));
  } else if (mode == 3u) {
    color = in.faceColor.rgb;
  }
  var out: GBuffer;
  out.color = vec4f(color, M.specCode / 255.0);
  out.normal = vec4f(normalize(in.normal), 1.0);
  return out;
}

// ---------------------------------------------------------------- lighting pass

@group(0) @binding(2) var gColor: texture_2d<f32>;
@group(0) @binding(3) var gNormal: texture_2d<f32>;
@group(0) @binding(4) var gDepth: texture_depth_2d;
@group(0) @binding(5) var<storage, read> lights: array<PointLight>;

@vertex fn vsFullscreen(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

// The engine's ScreenToDir: world-space view ray for a pixel.
fn screenToDir(ndc: vec2f) -> vec3f {
  let r = normalize(vec3f(ndc.x * F.screen.w * F.screen.z, ndc.y * F.screen.z, 1.0));
  return F.camRight.xyz * r.x + F.camUp.xyz * r.y + F.camFwd.xyz * r.z;
}

// The engine's GetReflectionColor.
fn reflectionColor(d: vec3f, smoothIn: f32) -> vec3f {
  let s = (1.0 - smoothIn) + 0.001;
  let lrp = clamp(((d.y - 0.1) + s * 0.5) * (1.0 / s), 0.0, 1.0);
  let skgr = mix(F.horizon.rgb, F.sky.rgb, max(0.0, d.y));
  return mix(F.groundAmb.rgb, skgr, lrp);
}

@fragment fn fsLighting(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let px = vec2i(pos.xy);
  let ndc = vec2f(f32(px.x), F.screen.y - 1.0 - f32(px.y)) / F.screen.xy * 2.0 - 1.0;
  let depth = textureLoad(gDepth, px, 0);

  // Background: the sky gradient from Clear (the engine evaluates it once per row).
  if (depth <= 0.0) {
    let dir = screenToDir(vec2f(-1.0, ndc.y));
    let lrp = sqrt(clamp(dir.y * 1.5, 0.0, 1.0));
    return vec4f(mix(F.horizon.rgb, F.sky.rgb, lrp), 1.0);
  }

  let g = textureLoad(gColor, px, 0);
  if (u32(F.proj.w) != 0u) { return vec4f(g.rgb, 1.0); }

  // ---- Differed() ----
  let viewZ = F.proj.z / depth;
  let n = normalize(textureLoad(gNormal, px, 0).xyz);
  let albedo = g.rgb;
  let sunCol = F.sunCol.rgb;
  let sunInt = F.sunCol.w;

  let fac = clamp(dot(n, F.sunDir.xyz), 0.0, 1.0);
  var col = albedo * sunCol * (fac * sunInt);
  col += albedo * mix(F.groundAmb.rgb, F.ambient.rgb, (n.y + 1.0) * 0.5);

  let count = u32(F.misc.x);
  if (count > 0u) {
    // ScreenToWorld with the linear depth.
    let wpos = F.camPos.xyz + (F.camRight.xyz * (ndc.x * F.screen.w * F.screen.z)
      + F.camUp.xyz * (ndc.y * F.screen.z) + F.camFwd.xyz) * viewZ;
    for (var i = 0u; i < count; i++) {
      let l = lights[i];
      let range = l.posRange.w;
      let d = l.posRange.xyz - wpos;
      if (abs(d.x) > range || abs(d.z) > range) { continue; }
      let dist = length(d);
      if (dist > range) { continue; }
      let dfac = (1.0 - dist / range) * max(0.0, dot(n, normalize(d)));
      if (dfac > 0.001) { col += albedo * l.color.rgb * dfac; }
    }
  }

  let fgl = sqrt(min(1.0, viewZ / F.fog.w));
  col = mix(col, F.fog.rgb, fgl);

  // Reflections, driven by the specular/metal code in the color alpha.
  let a = round(g.a * 255.0);
  if (a > 1.0) {
    var dir = screenToDir(ndc);
    let refl = dir - 2.0 * dot(dir, n) * n;
    var met = (a - 0.01) * 0.02;
    var smth = met - floor(met);
    met = min(1.0, met * 0.25);
    var refCol = reflectionColor(refl, smth);
    let weak = pow(smth, 4.0);
    let spc = pow(clamp(dot(refl, F.sunDir.xyz), 0.0, 1.0), max(1.0, 100.0 * weak));
    smth = min(1.0, smth + 0.3);
    let rimout = dot(-dir, n);
    let rim = min(1.0, pow(1.0 - clamp(rimout, 0.0, 1.0) + 0.1, 3.0) + 0.1);
    var mfac = clamp(rim, 0.01, 0.98);
    mfac = mix(mfac, met, met);
    refCol *= mfac;
    refCol += sunCol * (spc * sunInt * 1.5 * (pow(smth, 4.0) + 0.1));
    refCol = mix(refCol, refCol * albedo * 1.1, met);
    col = col * (1.0 - mfac) + refCol;
  }
  return vec4f(min(col, vec3f(1.0)), 1.0);
}
`;

export class GpuRenderer {
  /** Returns null when WebGPU is not available. */
  static async load(canvas) {
    if (!navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return null;
    const device = await adapter.requestDevice();
    return new GpuRenderer(canvas, adapter, device);
  }

  constructor(canvas, adapter, device) {
    this.canvas = canvas;
    this.device = device;
    this.adapterInfo = adapter.info || {};
    this.context = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: 'opaque' });
    this.multithreaded = false;
    this.maxThreads = 1;
    this.textures = [];
    this.meshes = [];
    this.width = 0;
    this.height = 0;
    this.objectData = new ArrayBuffer(0);
    this.objectCount = 0;
    this.lightCount = 0;
    this.gpuTime = 0;
    this.inFlight = 0;
    this.lastTriangles = 0;

    const module = device.createShaderModule({ code: SHADER });
    this.frameBuffer = device.createBuffer({ size: 14 * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.frameData = new Float32Array(14 * 4);
    this.instanceBuffer = null;
    this.lightBuffer = null;
    this.sampler = device.createSampler({
      magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'repeat', addressModeV: 'repeat',
    });

    this.geometryPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module, entryPoint: 'vsGeometry',
        buffers: [{
          arrayStride: VERTEX_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
            { shaderLocation: 2, offset: 24, format: 'float32x2' },
            { shaderLocation: 3, offset: 32, format: 'unorm8x4' },
          ],
        }],
      },
      fragment: { module, entryPoint: 'fsGeometry', targets: [{ format: 'rgba8unorm' }, { format: 'rgba16float' }] },
      // Unity / engine winding: clockwise front faces.
      primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'cw' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    });

    this.lightingPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vsFullscreen' },
      fragment: { module, entryPoint: 'fsLighting', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });

    // Texture 0 is the blank texture: meshes using it are drawn with their object tint.
    this.addTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  }

  resize(width, height) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    for (const t of [this.gColor, this.gNormal, this.gDepth]) t?.destroy();
    this.gColor = this.device.createTexture({ size: [width, height], format: 'rgba8unorm', usage });
    this.gNormal = this.device.createTexture({ size: [width, height], format: 'rgba16float', usage });
    this.gDepth = this.device.createTexture({ size: [width, height], format: 'depth32float', usage });
    this.lightingBindGroup = null;
  }

  addTexture(rgba, width, height) {
    const texture = this.device.createTexture({
      size: [width, height], format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture({ texture }, rgba, { bytesPerRow: width * 4 }, [width, height]);
    this.textures.push(texture);
    return this.textures.length - 1;
  }

  /** Same arguments as BgEngine.addMesh. */
  addMesh(mesh, { texture = 0, spec = 0, met = 0, faceColors = null } = {}) {
    const triCount = mesh.tris.length / 3;
    // Expanded (non-indexed) vertices so each triangle can carry its own debug color.
    const data = new ArrayBuffer(triCount * 3 * VERTEX_STRIDE);
    const f32 = new Float32Array(data);
    const u8 = new Uint8Array(data);
    for (let t = 0; t < triCount; t++) {
      const r = faceColors ? faceColors[t * 4] : Math.random() * 256;
      const g = faceColors ? faceColors[t * 4 + 1] : Math.random() * 256;
      const b = faceColors ? faceColors[t * 4 + 2] : Math.random() * 256;
      for (let k = 0; k < 3; k++) {
        const v = mesh.tris[t * 3 + k];
        const o = (t * 3 + k) * (VERTEX_STRIDE / 4);
        f32.set([mesh.verts[v * 3], mesh.verts[v * 3 + 1], mesh.verts[v * 3 + 2],
          mesh.norms[v * 3], mesh.norms[v * 3 + 1], mesh.norms[v * 3 + 2],
          mesh.uvs[v * 2], mesh.uvs[v * 2 + 1]], o);
        u8.set([r, g, b, 255], o * 4 + 32);
      }
    }
    const vertexBuffer = this.device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(vertexBuffer, 0, data);

    // Specular/metal code exactly as the engine packs it into the color alpha.
    const specByte = (Math.floor(spec * 50) + Math.floor((Math.round(met * 4) / 4) * 200)) & 255;
    const material = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(material, 0, new Float32Array([specByte, texture > 0 ? 1 : 0, 0, 0]));
    const bindGroup = this.device.createBindGroup({
      layout: this.geometryPipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: this.textures[texture].createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: material } },
      ],
    });
    this.meshes.push({ vertexBuffer, vertexCount: triCount * 3, bindGroup });
    return this.meshes.length - 1;
  }

  /** Same object layout as BgEngine.objects, so BgEngine.writeObject works on it. */
  objects(count) {
    if (this.objectData.byteLength < count * OBJECT_STRIDE) {
      this.objectData = new ArrayBuffer(Math.max(count, 64) * 2 * OBJECT_STRIDE);
    }
    this.objectCount = count;
    return {
      count,
      f32: new Float32Array(this.objectData),
      i32: new Int32Array(this.objectData),
      u8: new Uint8Array(this.objectData),
    };
  }

  setCamera({ position, forward, up, right, fov }) {
    const tanHalf = Math.tan((fov * Math.PI) / 360);
    const aspect = this.width / this.height;
    const f = this.frameData;
    f.set([...position, 0, ...right, 0, ...up, 0, ...forward, 0], 0);
    f.set([1 / (tanHalf * aspect), 1 / tanHalf, NEAR, 0, this.width, this.height, tanHalf, aspect], 16);
  }

  setPointLights(lights) {
    const data = new Float32Array(Math.max(1, lights.length) * 8);
    lights.forEach((l, i) => data.set([...l.color, 1, ...l.position, l.range], i * 8));
    if (!this.lightBuffer || this.lightBuffer.size < data.byteLength) {
      this.lightBuffer?.destroy();
      this.lightBuffer = this.device.createBuffer({ size: data.byteLength * 2, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.lightingBindGroup = null;
    }
    this.device.queue.writeBuffer(this.lightBuffer, 0, data);
    this.lightCount = lights.length;
  }

  setLighting(env, usePointLights = true) {
    this.env = env;
    this.usePointLights = usePointLights;
  }

  _uploadInstances() {
    // Group objects by mesh so each mesh is one instanced draw.
    const count = this.objectCount;
    const f32 = new Float32Array(this.objectData);
    const i32 = new Int32Array(this.objectData);
    const u8 = new Uint8Array(this.objectData);
    const perMesh = new Array(this.meshes.length).fill(0);
    for (let o = 0; o < count; o++) {
      const m = i32[o * 13 + 11];
      if (m >= 0 && m < perMesh.length) perMesh[m]++;
    }
    const first = [];
    let total = 0;
    for (let m = 0; m < perMesh.length; m++) { first.push(total); total += perMesh[m]; }
    const cursor = first.slice();
    const data = new Float32Array(Math.max(1, total) * INSTANCE_FLOATS);
    for (let o = 0; o < count; o++) {
      const m = i32[o * 13 + 11];
      if (m < 0 || m >= perMesh.length) continue;
      const s = o * 13, d = cursor[m]++ * INSTANCE_FLOATS, b = o * OBJECT_STRIDE + 48;
      data[d] = f32[s]; data[d + 1] = f32[s + 1]; data[d + 2] = f32[s + 2];
      data[d + 4] = f32[s + 3]; data[d + 5] = f32[s + 4]; data[d + 6] = f32[s + 5]; data[d + 7] = f32[s + 6];
      data[d + 8] = f32[s + 7]; data[d + 9] = f32[s + 8]; data[d + 10] = f32[s + 9]; data[d + 11] = f32[s + 10];
      data[d + 12] = u8[b] / 255; data[d + 13] = u8[b + 1] / 255; data[d + 14] = u8[b + 2] / 255; data[d + 15] = 1;
    }
    if (!this.instanceBuffer || this.instanceBuffer.size < data.byteLength) {
      this.instanceBuffer?.destroy();
      this.instanceBuffer = this.device.createBuffer({ size: data.byteLength * 2, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.geometryBindGroup = null;
    }
    this.device.queue.writeBuffer(this.instanceBuffer, 0, data);
    return { perMesh, first };
  }

  /**
   * Same options as BgEngine.render (threads/simd are ignored). Returns CPU encode time and an
   * approximate GPU time, or null when the frame was skipped because the GPU is still busy.
   */
  render({ lighting = 'deferred', debugTriangles = false, usePointLights = true } = {}) {
    // Don't queue more than two frames: on a slow GPU the queue would otherwise keep
    // growing and the view would lag further and further behind the input.
    if (this.inFlight >= 2) return null;
    const t0 = performance.now();
    const device = this.device;
    const env = this.env;
    const f = this.frameData;
    f[19] = debugTriangles ? MODE.debug : MODE[lighting];
    f.set([...env.sunDir, 0, ...env.sunColor, env.sunIntensity, ...env.ambient, 0, ...env.groundAmbient, 0,
      ...env.sky, 0, ...env.horizon, 0, ...env.fogColor, env.fogDistance,
      usePointLights && !debugTriangles ? this.lightCount : 0, 0, 0, 0], 24);
    device.queue.writeBuffer(this.frameBuffer, 0, f);

    if (!this.lightBuffer) this.setPointLights([]);
    const { perMesh, first } = this._uploadInstances();

    this.geometryBindGroup ??= device.createBindGroup({
      layout: this.geometryPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
        { binding: 1, resource: { buffer: this.instanceBuffer } },
      ],
    });
    this.lightingBindGroup ??= device.createBindGroup({
      layout: this.lightingPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
        { binding: 2, resource: this.gColor.createView() },
        { binding: 3, resource: this.gNormal.createView() },
        { binding: 4, resource: this.gDepth.createView() },
        { binding: 5, resource: { buffer: this.lightBuffer } },
      ],
    });

    const encoder = device.createCommandEncoder();
    const geo = encoder.beginRenderPass({
      colorAttachments: [
        { view: this.gColor.createView(), loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' },
        { view: this.gNormal.createView(), loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' },
      ],
      depthStencilAttachment: { view: this.gDepth.createView(), depthLoadOp: 'clear', depthClearValue: 0, depthStoreOp: 'store' },
    });
    geo.setPipeline(this.geometryPipeline);
    geo.setBindGroup(0, this.geometryBindGroup);
    let triangles = 0;
    this.meshes.forEach((mesh, m) => {
      if (!perMesh[m]) return;
      geo.setBindGroup(1, mesh.bindGroup);
      geo.setVertexBuffer(0, mesh.vertexBuffer);
      geo.draw(mesh.vertexCount, perMesh[m], 0, first[m]);
      triangles += (mesh.vertexCount / 3) * perMesh[m];
    });
    geo.end();

    const light = encoder.beginRenderPass({
      colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }],
    });
    light.setPipeline(this.lightingPipeline);
    light.setBindGroup(0, this.lightingBindGroup);
    light.draw(3);
    light.end();

    device.queue.submit([encoder.finish()]);
    const submitted = performance.now();
    this.inFlight++;
    device.queue.onSubmittedWorkDone().then(() => {
      this.gpuTime = performance.now() - submitted;
      this.inFlight--;
    });
    this.lastTriangles = triangles;
    return { encode: submitted - t0, gpu: this.gpuTime, triangles };
  }

  present() {
    // The canvas is presented by the browser at the end of the frame.
  }
}
