const { createCanvas, loadImage, GlobalFonts } = require("@napi-rs/canvas");
const { writeFile, mkdir } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const ASSETS_DIR = path.join(os.tmpdir(), "kyzen-jarvismeme-assets");
const BG_URL = "https://cdn.jsdelivr.net/gh/Ditzzx-vibecoder/Assets@main/Image/jarvismeme.png";
const FONT_URL = "https://cdn.jsdelivr.net/gh/adrienverge/copr-some-nice-fonts@master/ArialBd.ttf";
const CANVAS_SIZE = { width: 735, height: 678 };

const BG_LOCAL = path.join(ASSETS_DIR, "jarvismeme.png");
const FONT_LOCAL = path.join(ASSETS_DIR, "ArialBd.ttf");

let assetsReady = false;
let bgImageCache = null;

async function download(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } });
  if (!res.ok) throw new Error(`Fetch failed ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function prepareAssets() {
  await mkdir(ASSETS_DIR, { recursive: true });

  if (!assetsReady) {
    if (!existsSync(FONT_LOCAL)) await writeFile(FONT_LOCAL, await download(FONT_URL));
    GlobalFonts.registerFromPath(FONT_LOCAL, "ARIALBD");
    assetsReady = true;
  }

  if (!bgImageCache) {
    if (!existsSync(BG_LOCAL)) await writeFile(BG_LOCAL, await download(BG_URL));
    bgImageCache = await loadImage(BG_LOCAL);
  }
}

function drawTextInSafeZone(ctx, text, zone, initialFontSize, align) {
  let fontSize = initialFontSize;
  let lines = [];
  let lh = fontSize * 1.2;

  while (fontSize > 10) {
    lh = fontSize * 1.2;
    ctx.font = `500 ${fontSize}px ARIALBD, sans-serif`;
    lines = [];
    let fits = true;

    const paragraphs = text.split("\n");
    for (const p of paragraphs) {
      let cur = "";
      const words = p.split(" ");

      for (const w of words) {
        const t = cur ? cur + " " + w : w;
        if (ctx.measureText(t).width > zone.w) {
          if (cur) {
            lines.push(cur);
            cur = w;
            if (ctx.measureText(w).width > zone.w) {
              fits = false;
              break;
            }
          } else {
            fits = false;
            break;
          }
        } else {
          cur = t;
        }
      }
      if (!fits) break;
      lines.push(cur);
    }

    if (fits && lines.length * lh <= zone.h) break;
    fontSize -= 2;
  }

  ctx.font = `500 ${fontSize}px ARIALBD, sans-serif`;
  ctx.fillStyle = "#111111";
  ctx.textBaseline = "middle";
  ctx.textAlign = align;

  const drawX = align === "center" ? zone.x + zone.w / 2 : align === "right" ? zone.x + zone.w : zone.x;

  ctx.save();
  ctx.beginPath();
  ctx.rect(zone.x, zone.y, zone.w, zone.h);
  ctx.clip();

  const startY = zone.y + zone.h / 2 - (lines.length * lh) / 2 + lh / 2;
  lines.forEach((l, i) => ctx.fillText(l, drawX, startY + i * lh));
  ctx.restore();
}

async function drawScene(text) {
  await prepareAssets();

  const canvas = createCanvas(CANVAS_SIZE.width, CANVAS_SIZE.height);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, CANVAS_SIZE.width, CANVAS_SIZE.height);
  ctx.drawImage(bgImageCache, 0, 0, CANVAS_SIZE.width, CANVAS_SIZE.height);

  ctx.save();
  const safeZone = { x: 20, y: 3, w: 695, h: 237 };
  drawTextInSafeZone(ctx, text, safeZone, 100, "center");
  ctx.restore();

  return canvas.encode("png");
}

module.exports = function (app) {
  app.get("/image/jarvismeme", async (req, res) => {
    const { text } = req.query;
    if (!text) return res.status(400).json({ status: false, error: "Parameter text wajib diisi" });

    try {
      const buffer = await drawScene(text);
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": buffer.length });
      res.end(buffer);
    } catch (error) {
      res.status(500).json({ status: false, error: error.message });
    }
  });
};
