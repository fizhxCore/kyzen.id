const { createCanvas, loadImage, GlobalFonts } = require("@napi-rs/canvas");
const { writeFile, mkdir } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const ASSETS_DIR = path.join(os.tmpdir(), "kyzen-meme-assets");
const FONTS_DIR = path.join(ASSETS_DIR, "fonts");

const FONTS = [{ family: "ARIAL", url: "https://cdn.jsdelivr.net/gh/wolfsonliu/web_typography/fonts/arial.ttf", localName: "arial.ttf" }];
const BG_URL = "https://imgflip.com/s/meme/Drake-Hotline-Bling.jpg";
const CANVAS_SIZE = { width: 1200, height: 1200 };
const BG_LOCAL = path.join(ASSETS_DIR, "Drake-Hotline-Bling.jpg");

let fontsReady = false;
let bgImageCache = null;

async function download(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } });
  if (!res.ok) throw new Error(`Fetch failed ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function prepareAssets() {
  await mkdir(FONTS_DIR, { recursive: true });

  if (!fontsReady) {
    for (const font of FONTS) {
      const fontLocal = path.join(FONTS_DIR, font.localName);
      if (!existsSync(fontLocal)) await writeFile(fontLocal, await download(font.url));
      GlobalFonts.registerFromPath(fontLocal, font.family);
    }
    fontsReady = true;
  }

  if (!bgImageCache) {
    if (!existsSync(BG_LOCAL)) await writeFile(BG_LOCAL, await download(BG_URL));
    bgImageCache = await loadImage(BG_LOCAL);
  }
}

function drawTextInSafeZone(ctx, text, zone, initialFontSize, fontFamily, align) {
  let fontSize = initialFontSize;
  let lh = fontSize * 1.2;
  let out = [];
  const minSize = 10;

  while (fontSize >= minSize) {
    ctx.font = `400 ${fontSize}px ${fontFamily}`;
    lh = fontSize * 1.2;
    out = [];
    let fitsWidth = true;

    String(text).split("\n").forEach((p) => {
      let cur = "";
      p.split(" ").forEach((w) => {
        const t = cur ? cur + " " + w : w;
        if (ctx.measureText(t).width > zone.w && cur) {
          out.push(cur);
          cur = w;
        } else {
          cur = t;
        }
      });
      out.push(cur);
    });

    for (const line of out) {
      if (ctx.measureText(line).width > zone.w) {
        fitsWidth = false;
        break;
      }
    }

    if (fitsWidth && out.length * lh <= zone.h) break;
    fontSize -= 2;
  }

  if (fontSize < minSize) {
    fontSize = minSize;
    ctx.font = `400 ${fontSize}px ${fontFamily}`;
    lh = fontSize * 1.2;
  }

  const drawX = align === "center" ? zone.x + zone.w / 2 : align === "right" ? zone.x + zone.w : zone.x;

  ctx.save();
  ctx.beginPath();
  ctx.rect(zone.x, zone.y, zone.w, zone.h);
  ctx.clip();

  const startY = zone.y + zone.h / 2 - (out.length * lh) / 2 + lh / 2;
  out.forEach((l, i) => ctx.fillText(l, drawX, startY + i * lh));
  ctx.restore();
}

async function createDrakeMeme(teks1, teks2) {
  await prepareAssets();

  const canvas = createCanvas(CANVAS_SIZE.width, CANVAS_SIZE.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bgImageCache, 0, 0, CANVAS_SIZE.width, CANVAS_SIZE.height);

  ctx.save();
  const safeZone_el1 = { x: 615, y: 22, w: 571, h: 564 };
  ctx.fillStyle = "#111111";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  drawTextInSafeZone(ctx, teks1, safeZone_el1, 110, "ARIAL, sans-serif", "center");
  ctx.restore();

  ctx.save();
  const safeZone_el2 = { x: 615, y: 623, w: 571, h: 561 };
  ctx.fillStyle = "#111111";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  drawTextInSafeZone(ctx, teks2, safeZone_el2, 110, "ARIAL, sans-serif", "center");
  ctx.restore();

  return canvas.encode("png");
}

module.exports = function (app) {
  app.get("/image/drakememe", async (req, res) => {
    const { teks1, teks2 } = req.query;
    if (!teks1 || !teks2) return res.status(400).json({ status: false, error: "Parameter teks1 dan teks2 wajib diisi" });

    try {
      const buffer = await createDrakeMeme(teks1, teks2);
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": buffer.length });
      res.end(buffer);
    } catch (error) {
      res.status(500).json({ status: false, error: error.message });
    }
  });
};
