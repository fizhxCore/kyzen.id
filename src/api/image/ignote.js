const { createCanvas, loadImage, GlobalFonts } = require("@napi-rs/canvas");
const { writeFile, mkdir } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const ASSETS_DIR = path.join(os.tmpdir(), "kyzen-ignote-assets");
const FONTS_DIR = path.join(ASSETS_DIR, "fonts");
const BG_LOCAL = path.join(ASSETS_DIR, "template.png");

const BG_URL = "https://raw.githubusercontent.com/ryyntwx/allimagerin/refs/heads/main/bf3903f6-ae57-4d75-96a4-5c2e00c441c1.png";
const DEFAULT_AVATAR = "https://i.ibb.co/4pDNDk1/avatar.png";

const INTER_FONTS = [
  { url: "https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuI6fAZ9hiJ-Ek-_EeA.woff2", file: "Inter-Medium.ttf" },
  { url: "https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuFuYAZ9hiJ-Ek-_EeA.woff2", file: "Inter-SemiBold.ttf" },
];

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
    for (const font of INTER_FONTS) {
      const fontPath = path.join(FONTS_DIR, font.file);
      if (!existsSync(fontPath)) await writeFile(fontPath, await download(font.url));
      GlobalFonts.registerFromPath(fontPath, "InterCustom");
    }
    assetsReady = true;
  }

  if (!bgImageCache) {
    if (!existsSync(BG_LOCAL)) await writeFile(BG_LOCAL, await download(BG_URL));
    bgImageCache = await loadImage(BG_LOCAL);
  }
}

async function createNoteImage({ username, noteText, timeStr, ppUrl }) {
  await prepareAssets();

  let ppBuffer;
  try {
    ppBuffer = await download(ppUrl);
  } catch {
    ppBuffer = await download(DEFAULT_AVATAR);
  }

  const canvas = createCanvas(1080, 1920);
  const ctx = canvas.getContext("2d");

  ctx.drawImage(bgImageCache, 0, 0, 1080, 1920);
  const ppImg = await loadImage(ppBuffer);

  const ppX = 310, ppY = 779, ppRadius = 75;
  const userX = 534, userY = 624, userSize = 36;
  const cardX = 384, cardY = 777, baseTextSize = 40;
  const msgX = 78, msgY = 1011, msgSize = 46;
  const fontName = "InterCustom";

  ctx.save();
  ctx.beginPath();
  ctx.arc(ppX, ppY, ppRadius, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(ppImg, ppX - ppRadius, ppY - ppRadius, ppRadius * 2, ppRadius * 2);
  ctx.restore();

  ctx.fillStyle = "#ffffff";
  ctx.font = `600 ${userSize}px ${fontName}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`${username}  ·  ${timeStr}`, userX, userY);

  let displayNoteText = noteText;
  const words = displayNoteText.trim().split(/\s+/).filter(Boolean);
  if (words.length > 7) displayNoteText = "max";

  ctx.font = `500 ${baseTextSize}px ${fontName}`;
  const textMetrics = ctx.measureText(displayNoteText).width;
  const paddingX = 32;
  const paddingY = 20;
  const bubbleW = textMetrics + paddingX * 2;
  const bubbleH = baseTextSize + paddingY * 2;
  const radius = bubbleH / 2;

  ctx.fillStyle = "#434954";
  ctx.beginPath();
  ctx.roundRect(cardX, cardY - bubbleH / 2, bubbleW, bubbleH, radius);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cardX - 6, cardY + 2, 14, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(displayNoteText, cardX + paddingX, cardY);

  ctx.fillStyle = "#727272";
  ctx.font = `500 ${msgSize}px ${fontName}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(`Message ${username}`, msgX, msgY);

  return canvas.encode("png");
}

module.exports = function (app) {
  app.get("/image/ignote", async (req, res) => {
    const { username, text, time, ppUrl } = req.query;

    if (!username) return res.status(400).json({ status: false, error: "Parameter username wajib diisi" });
    if (!text) return res.status(400).json({ status: false, error: "Parameter text wajib diisi (maks 7 kata)" });

    try {
      const buffer = await createNoteImage({
        username,
        noteText: text,
        timeStr: time || "3m",
        ppUrl: ppUrl || DEFAULT_AVATAR,
      });

      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": buffer.length });
      res.end(buffer);
    } catch (error) {
      res.status(500).json({ status: false, error: error.message });
    }
  });
};
