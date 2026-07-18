const { createCanvas, loadImage, GlobalFonts } = require("@napi-rs/canvas");
const { writeFile, mkdir } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const ASSETS_DIR = path.join(os.tmpdir(), "kyzen-wq-assets");
const FONTS_DIR = path.join(ASSETS_DIR, "fonts");
const BG_LOCAL = path.join(ASSETS_DIR, "template_wdws.png");
const BG_URL = "https://raw.githubusercontent.com/ryyntwx/allimagerin/refs/heads/main/wdws.png";
const FONT_URL = "https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuFuYAZ9hiJ-Ek-_EeA.woff2";
const FONT_LOCAL = path.join(FONTS_DIR, "Inter-Bold.ttf");

let assetsReady = false;
let bgImageCache = null;

async function download(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Fetch failed ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function prepareAssets() {
  await mkdir(FONTS_DIR, { recursive: true });

  if (!assetsReady) {
    if (!existsSync(FONT_LOCAL)) await writeFile(FONT_LOCAL, await download(FONT_URL));
    GlobalFonts.registerFromPath(FONT_LOCAL, "InterBoldMeme");
    assetsReady = true;
  }

  if (!bgImageCache) {
    if (!existsSync(BG_LOCAL)) await writeFile(BG_LOCAL, await download(BG_URL));
    bgImageCache = await loadImage(BG_LOCAL);
  }
}

function getWrappedLines(ctx, textStr, maxWidth) {
  const words = textStr.split(/\s+/);
  const resLines = [];
  let currentLine = "";

  for (let i = 0; i < words.length; i++) {
    if (!words[i]) continue;
    const testLine = currentLine + words[i] + " ";
    const metrics = ctx.measureText(testLine.trim());

    if (metrics.width > maxWidth && i > 0) {
      resLines.push(currentLine.trim());
      currentLine = words[i] + " ";
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine.trim()) resLines.push(currentLine.trim());
  return resLines;
}

async function createWqImage(text) {
  await prepareAssets();

  const bgImg = bgImageCache;
  const canvas = createCanvas(bgImg.width, bgImg.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bgImg, 0, 0, canvas.width, canvas.height);

  const x = 127, y = 406, w = 450, h = 601;
  let fSize = 150;
  const lHeight = 1.3;
  const rawText = text.trim();

  ctx.fillStyle = "#1c1d21";
  ctx.textBaseline = "top";
  ctx.font = `700 ${fSize}px InterBoldMeme`;
  let lines = getWrappedLines(ctx, rawText, w);

  let totalTextHeight = lines.length * (fSize * lHeight);
  while (totalTextHeight > h && fSize > 24) {
    fSize -= 4;
    ctx.font = `700 ${fSize}px InterBoldMeme`;
    lines = getWrappedLines(ctx, rawText, w);
    totalTextHeight = lines.length * (fSize * lHeight);
  }

  let startY = y;
  if (totalTextHeight < h) startY = y + (h - totalTextHeight) / 2;

  const wordCount = rawText.split(/\s+/).filter((w) => w.length > 0).length;

  lines.forEach((line, index) => {
    const currentY = startY + index * (fSize * lHeight);
    if (currentY + fSize <= y + h) {
      if (wordCount === 1) {
        ctx.textAlign = "center";
        ctx.fillText(line, x + w / 2, currentY);
      } else {
        ctx.textAlign = "left";
        ctx.fillText(line, x, currentY);
      }
    }
  });

  return canvas.encode("png");
}

module.exports = function (app) {
  app.get("/image/wq", async (req, res) => {
    const { text } = req.query;
    if (!text) return res.status(400).json({ status: false, error: "Parameter text wajib diisi" });

    try {
      const buffer = await createWqImage(text);
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": buffer.length });
      res.end(buffer);
    } catch (error) {
      res.status(500).json({ status: false, error: error.message });
    }
  });
};
