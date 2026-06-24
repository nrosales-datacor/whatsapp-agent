// Genera los íconos PWA del panel SIN dependencias (solo node: zlib/fs).
// Dibuja una burbuja de chat blanca (con cola y tres puntos) sobre el verde de la
// marca, a 4x supersampling para bordes suaves, y exporta PNGs a src/panel/icons/.
//   node scripts/genIcons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../src/panel/icons/", import.meta.url));
mkdirSync(OUT, { recursive: true });

// Colores de marca (mismos tokens del panel).
const VERDE = [0x0b, 0x6b, 0x5e];
const BLANCO = [0xff, 0xff, 0xff];
const SS = 4; // supersampling para antialias

// ── CRC32 (para los chunks PNG) ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // resto (compresión/filtro/entrelazado) en 0
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filtro None por fila
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// ── Dibujo (en un lienzo de NxN, coords normalizadas 0..1) ──
function dentroRoundRect(x, y, rx, ry, rw, rh, r) {
  if (x < rx || x > rx + rw || y < ry || y > ry + rh) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + rw - r);
  const cy = Math.min(Math.max(y, ry + r), ry + rh - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function dentroTriangulo(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}
function colorEn(u, v) {
  // u,v en 0..1. Burbuja de chat blanca + cola + 3 puntos verdes.
  const bub = dentroRoundRect(u, v, 0.27, 0.29, 0.46, 0.32, 0.1);
  const cola = dentroTriangulo(u, v, 0.37, 0.585, 0.37, 0.74, 0.52, 0.6);
  if (bub || cola) {
    // tres puntos (typing) en verde, centrados en la burbuja
    for (const dx of [0.4, 0.5, 0.6]) {
      if ((u - dx) ** 2 + (v - 0.45) ** 2 <= 0.036 ** 2) return VERDE;
    }
    return BLANCO;
  }
  return VERDE; // fondo a sangre (sirve también como maskable)
}

function generar(size) {
  const N = size * SS;
  const hi = new Float64Array(N * N * 3);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const c = colorEn((x + 0.5) / N, (y + 0.5) / N);
      const i = (y * N + x) * 3;
      hi[i] = c[0]; hi[i + 1] = c[1]; hi[i + 2] = c[2];
    }
  }
  // Downsample por promedio de bloques SSxSS → antialias.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * N + (x * SS + sx)) * 3;
          r += hi[i]; g += hi[i + 1]; b += hi[i + 2];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }
  return encodePNG(size, size, out);
}

for (const size of [192, 512, 180]) {
  const png = generar(size);
  writeFileSync(new URL(`./icon-${size}.png`, "file://" + OUT.replace(/\\/g, "/")), png);
  console.log(`icon-${size}.png  (${png.length} bytes)`);
}
console.log("Listo → src/panel/icons/");
