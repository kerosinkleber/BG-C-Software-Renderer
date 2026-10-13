// Procedural meshes and textures for the demo scene (no asset files needed).

function finish(verts, norms, uvs, tris) {
  const mesh = {
    verts: new Float32Array(verts),
    norms: new Float32Array(norms),
    uvs: new Float32Array(uvs),
    tris: new Int32Array(tris),
  };
  fixWinding(mesh);
  return mesh;
}

// The engine culls back faces using the winding order (Unity: clockwise = front).
// Rather than getting every generator's index order right by hand, flip any triangle
// whose geometric normal disagrees with its vertex normals.
function fixWinding(mesh) {
  const { verts: v, norms: n, tris: t } = mesh;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    const fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
    const sx = n[a] + n[b] + n[c], sy = n[a + 1] + n[b + 1] + n[c + 1], sz = n[a + 2] + n[b + 2] + n[c + 2];
    if (fx * sx + fy * sy + fz * sz < 0) {
      const tmp = t[i + 1];
      t[i + 1] = t[i + 2];
      t[i + 2] = tmp;
    }
  }
}

/** Grid on the XZ plane facing +Y. */
export function plane(sizeX, sizeZ, segX, segZ, uvRepeat = 1) {
  const verts = [], norms = [], uvs = [], tris = [];
  for (let z = 0; z <= segZ; z++) {
    for (let x = 0; x <= segX; x++) {
      verts.push((x / segX - 0.5) * sizeX, 0, (z / segZ - 0.5) * sizeZ);
      norms.push(0, 1, 0);
      uvs.push((x / segX) * uvRepeat, (z / segZ) * uvRepeat);
    }
  }
  for (let z = 0; z < segZ; z++) {
    for (let x = 0; x < segX; x++) {
      const i = z * (segX + 1) + x;
      tris.push(i, i + segX + 1, i + 1, i + 1, i + segX + 1, i + segX + 2);
    }
  }
  return finish(verts, norms, uvs, tris);
}

/** Box centered on the origin, flat shaded, 0..1 UVs per face. */
export function box(w = 1, h = 1, d = 1) {
  const verts = [], norms = [], uvs = [], tris = [];
  const faces = [
    [[1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, 0, 1], [-1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [1, 0, 0], [0, 1, 0]],
  ];
  const half = [w / 2, h / 2, d / 2];
  for (const [n, u, v] of faces) {
    const base = verts.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let k = 0; k < 3; k++) verts.push((n[k] + u[k] * su + v[k] * sv) * half[k]);
      norms.push(...n);
      uvs.push((su + 1) / 2, (sv + 1) / 2);
    }
    tris.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return finish(verts, norms, uvs, tris);
}

/** UV sphere. */
export function sphere(radius = 1, segments = 24, rings = 16) {
  const verts = [], norms = [], uvs = [], tris = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    for (let s = 0; s <= segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      const x = Math.sin(phi) * Math.cos(theta), y = Math.cos(phi), z = Math.sin(phi) * Math.sin(theta);
      verts.push(x * radius, y * radius, z * radius);
      norms.push(x, y, z);
      uvs.push(s / segments, 1 - r / rings);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const i = r * (segments + 1) + s, j = i + segments + 1;
      if (r > 0) tris.push(i, j, i + 1);
      if (r < rings - 1) tris.push(i + 1, j, j + 1);
    }
  }
  return finish(verts, norms, uvs, tris);
}

/** Torus around the Y axis. */
export function torus(major = 1, minor = 0.35, segments = 32, sides = 14) {
  const verts = [], norms = [], uvs = [], tris = [];
  for (let s = 0; s <= segments; s++) {
    const u = (s / segments) * Math.PI * 2;
    for (let k = 0; k <= sides; k++) {
      const v = (k / sides) * Math.PI * 2;
      const nx = Math.cos(v) * Math.cos(u), ny = Math.sin(v), nz = Math.cos(v) * Math.sin(u);
      verts.push(Math.cos(u) * major + nx * minor, ny * minor, Math.sin(u) * major + nz * minor);
      norms.push(nx, ny, nz);
      uvs.push((s / segments) * 4, k / sides);
    }
  }
  for (let s = 0; s < segments; s++) {
    for (let k = 0; k < sides; k++) {
      const i = s * (sides + 1) + k, j = i + sides + 1;
      tris.push(i, j, i + 1, i + 1, j, j + 1);
    }
  }
  return finish(verts, norms, uvs, tris);
}

/** Cylinder or cone (topRadius = 0) along +Y from y = 0 to y = height, with caps. */
export function cylinder(bottomRadius, topRadius, height, segments = 16) {
  const verts = [], norms = [], uvs = [], tris = [];
  const slope = (bottomRadius - topRadius) / height;
  for (let s = 0; s <= segments; s++) {
    const a = (s / segments) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
    const len = Math.hypot(1, slope);
    for (const [r, y, v] of [[bottomRadius, 0, 0], [topRadius, height, 1]]) {
      verts.push(c * r, y, sn * r);
      norms.push(c / len, slope / len, sn / len);
      uvs.push(s / segments, v);
    }
  }
  for (let s = 0; s < segments; s++) {
    const i = s * 2;
    tris.push(i, i + 1, i + 2, i + 2, i + 1, i + 3);
  }
  for (const [r, y, ny] of [[bottomRadius, 0, -1], [topRadius, height, 1]]) {
    if (r <= 0) continue;
    const center = verts.length / 3;
    verts.push(0, y, 0); norms.push(0, ny, 0); uvs.push(0.5, 0.5);
    for (let s = 0; s <= segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      verts.push(Math.cos(a) * r, y, Math.sin(a) * r);
      norms.push(0, ny, 0);
      uvs.push(0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
    }
    for (let s = 0; s < segments; s++) tris.push(center, center + 1 + s, center + 2 + s);
  }
  return finish(verts, norms, uvs, tris);
}

/** Concatenates meshes, each with an optional offset. */
export function merge(...parts) {
  const verts = [], norms = [], uvs = [], tris = [];
  for (const { mesh, offset = [0, 0, 0] } of parts) {
    const base = verts.length / 3;
    for (let i = 0; i < mesh.verts.length; i += 3) {
      verts.push(mesh.verts[i] + offset[0], mesh.verts[i + 1] + offset[1], mesh.verts[i + 2] + offset[2]);
    }
    norms.push(...mesh.norms);
    uvs.push(...mesh.uvs);
    for (const t of mesh.tris) tris.push(t + base);
  }
  return finish(verts, norms, uvs, tris);
}

// ---------------------------------------------------------------- textures

function paint(size, draw) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  draw(ctx, size);
  return { rgba: ctx.getImageData(0, 0, size, size).data, width: size, height: size };
}

function noise(ctx, size, amount, count = size * size * 0.6) {
  for (let i = 0; i < count; i++) {
    const v = Math.random() * amount;
    ctx.fillStyle = Math.random() < 0.5 ? `rgba(0,0,0,${v})` : `rgba(255,255,255,${v})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 1, 1);
  }
}

export const textures = {
  grass: () => paint(128, (ctx, s) => {
    ctx.fillStyle = '#5d8a3a';
    ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = '#56813a';
    ctx.fillRect(0, 0, s / 2, s / 2);
    ctx.fillRect(s / 2, s / 2, s / 2, s / 2);
    noise(ctx, s, 0.25);
  }),
  bricks: () => paint(128, (ctx, s) => {
    ctx.fillStyle = '#c9c1b3';
    ctx.fillRect(0, 0, s, s);
    const rows = 8, bw = s / 4, bh = s / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = -1; c < 5; c++) {
        const x = c * bw + (r % 2 ? bw / 2 : 0);
        const shade = 140 + Math.random() * 50;
        ctx.fillStyle = `rgb(${shade + 20},${shade * 0.45},${shade * 0.35})`;
        ctx.fillRect(x + 2, r * bh + 2, bw - 4, bh - 4);
      }
    }
    noise(ctx, s, 0.2);
  }),
  wood: () => paint(128, (ctx, s) => {
    for (let x = 0; x < s; x++) {
      const v = Math.sin(x * 0.35 + Math.sin(x * 0.05) * 4) * 0.5 + 0.5;
      ctx.fillStyle = `rgb(${150 + v * 50},${95 + v * 35},${55 + v * 20})`;
      ctx.fillRect(x, 0, 1, s);
    }
    noise(ctx, s, 0.15);
  }),
  checker: () => paint(64, (ctx, s) => {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        ctx.fillStyle = (x + y) % 2 ? '#f2f2f2' : '#2b2f3a';
        ctx.fillRect((x * s) / 8, (y * s) / 8, s / 8, s / 8);
      }
    }
  }),
  leaves: () => paint(64, (ctx, s) => {
    ctx.fillStyle = '#2f6b2a';
    ctx.fillRect(0, 0, s, s);
    noise(ctx, s, 0.45);
  }),
};
