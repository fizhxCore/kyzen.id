const { createCanvas, loadImage, GlobalFonts } = require("@napi-rs/canvas");
const { writeFile, mkdir, readFile } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const ASSETS_DIR = path.join(os.tmpdir(), "kyzen-fakenotifwa-assets");
const FONTS_DIR = path.join(ASSETS_DIR, "fonts");

const APPLE_EMOJI_JSON_URL = "https://media.githubusercontent.com/media/Ditzzx-vibecoder/entahlah/main/emoji-apple.json";
const APPLE_EMOJI_JSON_LOCAL = path.join(FONTS_DIR, "emoji-apple-image.json");

const FONTS = [
  { url: "https://uploader.zenzxz.dpdns.org/uploads/1783935033044.ttf", name: "RobotoBold", file: "RobotoBold.ttf" },
  { url: "https://uploader.zenzxz.dpdns.org/uploads/1783935096347.ttf", name: "RobotoRegular", file: "RobotoRegular.ttf" },
  { url: "https://uploader.zenzxz.dpdns.org/uploads/1783935155987.ttf", name: "SanFrancisco", file: "SanFrancisco.ttf" },
];

const BG_URL = "https://uploader.zenzxz.dpdns.org/uploads/1783938224798.png";
const WA_ICON_URL = "https://uploader.zenzxz.dpdns.org/uploads/1783937277449.jpeg";

const EMOJI_REGEX =
  /(\p{Emoji_Modifier_Base}\p{Emoji_Modifier}|\p{Emoji_Presentation}\uFE0F?|\p{Emoji}\uFE0F|[\u{1F1E0}-\u{1F1FF}]{2}|\p{Extended_Pictographic}\uFE0F?)/gu;

let fontsReady = false;
let appleEmojiMap = null;
const emojiImageCache = new Map();

async function getbuffer(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Fetch failed ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function loadAssets() {
  await mkdir(FONTS_DIR, { recursive: true });
  if (fontsReady) return;

  for (const font of FONTS) {
    const fontPath = path.join(FONTS_DIR, font.file);
    if (!existsSync(fontPath)) await writeFile(fontPath, await getbuffer(font.url));
    GlobalFonts.registerFromPath(fontPath, font.name);
  }
  fontsReady = true;
}

function drawCircleImg(ctx, img, x, y, size) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(img, x, y, size, size);
  ctx.restore();
}

function emojiToUnicode(emoji) {
  return [...emoji].map((c) => c.codePointAt(0).toString(16).padStart(4, "0")).join("-");
}

async function loadAppleEmojiMap() {
  if (appleEmojiMap) return appleEmojiMap;
  await mkdir(FONTS_DIR, { recursive: true });
  if (!existsSync(APPLE_EMOJI_JSON_LOCAL)) {
    await writeFile(APPLE_EMOJI_JSON_LOCAL, await getbuffer(APPLE_EMOJI_JSON_URL));
  }
  appleEmojiMap = JSON.parse(await readFile(APPLE_EMOJI_JSON_LOCAL, "utf-8"));
  return appleEmojiMap;
}

async function getEmojiImage(emoji) {
  if (emojiImageCache.has(emoji)) return emojiImageCache.get(emoji);
  const map = await loadAppleEmojiMap();
  const base = emojiToUnicode(emoji);
  const variants = [
    base,
    base.replace(/-fe0f/gi, ""),
    `${base.replace(/-fe0f/gi, "")}-fe0f`,
    base.toUpperCase(),
    base.replace(/-fe0f/gi, "").toUpperCase(),
    `${base.replace(/-fe0f/gi, "").toUpperCase()}-FE0F`,
  ];
  let b64 = null;
  for (const v of variants) {
    if (map[v]) {
      b64 = map[v];
      break;
    }
  }
  if (!b64) return null;
  const img = await loadImage(Buffer.from(b64, "base64"));
  emojiImageCache.set(emoji, img);
  return img;
}

async function drawAppleEmoji(ctx, emoji, x, y, size) {
  const img = await getEmojiImage(emoji);
  if (!img) {
    ctx.fillText(emoji, x, y);
    return;
  }
  ctx.drawImage(img, x - size / 2, y - size / 2, size, size);
}

async function drawTextWithEmojis(ctx, text, x, y, fontSize, fontString) {
  ctx.font = fontString;
  const parts = text.split(EMOJI_REGEX);
  let currentX = x;
  for (const part of parts) {
    if (!part) continue;
    EMOJI_REGEX.lastIndex = 0;
    if (EMOJI_REGEX.test(part)) {
      const emojiSize = fontSize * 1.05;
      const emojiCX = currentX + emojiSize / 2;
      const emojiCY = y + fontSize / 2;
      await drawAppleEmoji(ctx, part, emojiCX, emojiCY, emojiSize);
      currentX += emojiSize;
    } else {
      ctx.fillText(part, currentX, y);
      currentX += ctx.measureText(part).width;
    }
    EMOJI_REGEX.lastIndex = 0;
  }
}

async function fakenotifwa({ ppurl, username, chat, tanggal, jam }) {
  await loadAssets();
  await loadAppleEmojiMap();

  const [bgBuffer, ppBuffer, waIconBuffer] = await Promise.all([
    getbuffer(BG_URL),
    getbuffer(ppurl),
    getbuffer(WA_ICON_URL),
  ]);

  const bg = await loadImage(bgBuffer);
  const ppImg = await loadImage(ppBuffer);
  const waImg = await loadImage(waIconBuffer);

  const canvas = createCanvas(bg.width, bg.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bg, 0, 0, bg.width, bg.height);

  ctx.font = '36px "SanFrancisco", sans-serif';
  ctx.fillStyle = "#C5C5C5";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(tanggal, bg.width / 2, 120);

  ctx.font = '160px "SanFrancisco", sans-serif';
  ctx.fillText(jam, bg.width / 2, 170);

  const ppSize = 77, ppX = 39, ppY = 909;
  drawCircleImg(ctx, ppImg, ppX, ppY, ppSize);

  const waIconSize = 24;
  drawCircleImg(ctx, waImg, ppX + ppSize - waIconSize + 2, ppY + ppSize - waIconSize + 2, waIconSize);

  ctx.fillStyle = "#FFFFFF";
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  await drawTextWithEmojis(ctx, username, 135, 913, 26, "bold 26px Roboto, sans-serif");
  await drawTextWithEmojis(ctx, chat, 135, 952, 22, "22px Roboto, sans-serif");

  return canvas.encode("png");
}

module.exports = function (app) {
  app.get("/image/fakenotifwa", async (req, res) => {
    const { ppUrl, username, chat, tanggal, jam } = req.query;

    if (!ppUrl) return res.status(400).json({ status: false, error: "Parameter ppUrl wajib diisi" });
    if (!username) return res.status(400).json({ status: false, error: "Parameter username wajib diisi" });
    if (!chat) return res.status(400).json({ status: false, error: "Parameter chat wajib diisi" });

    try {
      const buffer = await fakenotifwa({
        ppurl: ppUrl,
        username,
        chat,
        tanggal: tanggal || new Date().toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long" }),
        jam: jam || new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }),
      });

      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": buffer.length });
      res.end(buffer);
    } catch (error) {
      res.status(500).json({ status: false, error: error.message });
    }
  });
};
