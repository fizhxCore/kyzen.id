const { createCanvas, loadImage, GlobalFonts } = require("@napi-rs/canvas");
const { writeFile, mkdir, readFile } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const ASSETS_DIR = path.join(os.tmpdir(), "kyzen-igqc-assets");
const FONTS_DIR = path.join(ASSETS_DIR, "fonts");

const FONT_URL = "https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfAZ9hiJ-Ek-_EeA.woff2";
const FONT_LOCAL = path.join(FONTS_DIR, "Inter-Regular.ttf");
const BG_URL = "https://cdn.jsdelivr.net/gh/Ditzzx-vibecoder/Assets@main/Image/igqc.png";
const BG_LOCAL = path.join(ASSETS_DIR, "igqc.png");
const APPLE_EMOJI_JSON_URL = "https://media.githubusercontent.com/media/Ditzzx-vibecoder/entahlah/main/emoji-apple.json";
const APPLE_EMOJI_JSON_LOCAL = path.join(FONTS_DIR, "emoji-apple-image.json");

const CANVAS_SIZE = { width: 878, height: 1791 };
const EMOJI_REGEX =
  /(\p{Emoji_Modifier_Base}\p{Emoji_Modifier}|\p{Emoji_Presentation}\uFE0F?|\p{Emoji}\uFE0F|[\u{1F1E0}-\u{1F1FF}]{2}|\p{Extended_Pictographic}\uFE0F?)/gu;

let fontReady = false;
let bgImageCache = null;
let appleEmojiMap = null;
const emojiImageCache = new Map();

async function download(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } });
  if (!res.ok) throw new Error(`Fetch failed ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function prepareAssets() {
  await mkdir(FONTS_DIR, { recursive: true });

  if (!fontReady) {
    if (!existsSync(FONT_LOCAL)) await writeFile(FONT_LOCAL, await download(FONT_URL));
    GlobalFonts.registerFromPath(FONT_LOCAL, "InterRegular");
    fontReady = true;
  }

  if (!bgImageCache) {
    if (!existsSync(BG_LOCAL)) await writeFile(BG_LOCAL, await download(BG_URL));
    bgImageCache = await loadImage(BG_LOCAL);
  }
}

function emojiToUnicode(emoji) {
  return [...emoji].map((c) => c.codePointAt(0).toString(16).padStart(4, "0")).join("-");
}

async function loadAppleEmojiMap() {
  if (appleEmojiMap) return appleEmojiMap;
  await mkdir(FONTS_DIR, { recursive: true });
  if (!existsSync(APPLE_EMOJI_JSON_LOCAL)) {
    await writeFile(APPLE_EMOJI_JSON_LOCAL, await download(APPLE_EMOJI_JSON_URL));
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

function measureTextCustom(ctx, text, fontSize) {
  const parts = text.split(EMOJI_REGEX);
  let totalWidth = 0;
  for (const part of parts) {
    if (!part) continue;
    EMOJI_REGEX.lastIndex = 0;
    if (EMOJI_REGEX.test(part)) totalWidth += fontSize * 1.05;
    else totalWidth += ctx.measureText(part).width;
    EMOJI_REGEX.lastIndex = 0;
  }
  return totalWidth;
}

async function drawTextWithEmojis(ctx, text, x, y, fontSize) {
  const parts = text.split(EMOJI_REGEX);
  let currentX = x;
  for (const part of parts) {
    if (!part) continue;
    EMOJI_REGEX.lastIndex = 0;
    if (EMOJI_REGEX.test(part)) {
      const emojiSize = fontSize * 1.05;
      await drawAppleEmoji(ctx, part, currentX + emojiSize / 2, y, emojiSize);
      currentX += emojiSize;
    } else {
      ctx.fillText(part, currentX, y);
      currentX += ctx.measureText(part).width;
    }
    EMOJI_REGEX.lastIndex = 0;
  }
}

function wrapText(ctx, text, maxWidth, fontSize) {
  ctx.font = `${fontSize}px InterRegular`;
  const words = text.split(" ");
  const lines = [];
  let cur = "";
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word.includes("\n")) {
      const parts = word.split("\n");
      for (let j = 0; j < parts.length; j++) {
        const test = cur + (cur ? " " : "") + parts[j];
        if (measureTextCustom(ctx, test, fontSize) > maxWidth && cur) {
          lines.push(cur);
          cur = parts[j];
        } else {
          cur = test;
        }
        if (j < parts.length - 1) {
          lines.push(cur);
          cur = "";
        }
      }
      continue;
    }
    const test = cur + (cur ? " " : "") + word;
    if (measureTextCustom(ctx, test, fontSize) > maxWidth && i > 0) {
      lines.push(cur);
      cur = word;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

async function drawScene({ txt, imgUrl, menuTimeStr }) {
  await prepareAssets();
  await loadAppleEmojiMap();

  const canvas = createCanvas(CANVAS_SIZE.width, CANVAS_SIZE.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bgImageCache, 0, 0, CANVAS_SIZE.width, CANVAS_SIZE.height);

  const menuBoxTop = 985;
  ctx.fillStyle = "#a1a4a9";
  ctx.font = "20px InterRegular";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(menuTimeStr, 72, menuBoxTop + 35);

  const maxWidthLimit = 530;
  const maxImgWidthLimit = 420;
  const minBubbleWidth = 280;
  const paddingX = 30;
  const paddingY = 22;
  const fixedX = 38;
  const bubbleBottom = menuBoxTop - 20;

  const emCardH = 104;
  const minEmCardY = 60;

  const hasImg = !!imgUrl;
  const hasTxt = !!txt;

  let imgObj = null;
  if (hasImg) {
    imgObj = await loadImage(await download(imgUrl));
  }

  let chatFontSize = 30;
  const minFontSize = 12;
  let imageScale = 1.0;

  let chatLines = [];
  let lineHeight = 0;
  let textBubbleH = 0;
  let imgDrawW = 0;
  let imgDrawH = 0;
  let bubbleW = 0;
  let textBubbleTop = 0;
  let imgBubbleTop = 0;
  let emCardY = 0;
  let topmostY = 0;

  while (chatFontSize >= minFontSize) {
    if (hasImg && hasTxt) {
      ctx.font = `${chatFontSize}px InterRegular`;
      chatLines = wrapText(ctx, txt, maxWidthLimit, chatFontSize);
      lineHeight = chatFontSize + 14;
      textBubbleH = (chatLines.length - 1) * lineHeight + chatFontSize + paddingY * 2;
      textBubbleTop = bubbleBottom - textBubbleH;

      const imgAspect = imgObj.width / imgObj.height;
      let baseImgW = Math.min(Math.max(imgObj.width, minBubbleWidth), maxImgWidthLimit);
      imgDrawW = Math.round(baseImgW * imageScale);
      imgDrawH = Math.round(imgDrawW / imgAspect);

      const bubbleGap = 12;
      imgBubbleTop = textBubbleTop - imgDrawH - bubbleGap;
      topmostY = imgBubbleTop;
    } else if (hasImg) {
      const imgAspect = imgObj.width / imgObj.height;
      let baseImgW = Math.min(Math.max(imgObj.width, minBubbleWidth), maxImgWidthLimit);
      imgDrawW = Math.round(baseImgW * imageScale);
      imgDrawH = Math.round(imgDrawW / imgAspect);
      imgBubbleTop = bubbleBottom - imgDrawH;
      topmostY = imgBubbleTop;
    } else {
      ctx.font = `${chatFontSize}px InterRegular`;
      chatLines = wrapText(ctx, txt, maxWidthLimit, chatFontSize);
      lineHeight = chatFontSize + 14;
      textBubbleH = (chatLines.length - 1) * lineHeight + chatFontSize + paddingY * 2;
      textBubbleTop = bubbleBottom - textBubbleH;
      topmostY = textBubbleTop;
    }

    emCardY = topmostY - emCardH - 20;
    if (emCardY >= minEmCardY) break;

    if (hasTxt) {
      chatFontSize -= 1;
    } else if (hasImg) {
      imageScale -= 0.05;
      if (imageScale < 0.3) break;
    }
  }

  if (hasImg) {
    const currentImgTop = hasTxt ? imgBubbleTop : topmostY;
    const radiusImage = 24;

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(fixedX, currentImgTop, imgDrawW, imgDrawH, [radiusImage]);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(imgObj, fixedX, currentImgTop, imgDrawW, imgDrawH);
    ctx.restore();
  }

  if (hasTxt) {
    const currentTextTop = hasImg ? textBubbleTop : topmostY;
    const currentTextHeight = textBubbleH;

    ctx.font = `${chatFontSize}px InterRegular`;
    let longestW = 0;
    chatLines.forEach((l) => {
      const w = measureTextCustom(ctx, l.trim(), chatFontSize);
      if (w > longestW) longestW = w;
    });

    bubbleW = Math.max(longestW + paddingX * 2, 180);

    const rad = 25;
    ctx.fillStyle = "#262628";
    ctx.beginPath();
    ctx.moveTo(fixedX + 8, currentTextTop);
    ctx.lineTo(fixedX + bubbleW - rad, currentTextTop);
    ctx.quadraticCurveTo(fixedX + bubbleW, currentTextTop, fixedX + bubbleW, currentTextTop + rad);
    ctx.lineTo(fixedX + bubbleW, currentTextTop + currentTextHeight - rad);
    ctx.quadraticCurveTo(fixedX + bubbleW, currentTextTop + currentTextHeight, fixedX + bubbleW - rad, currentTextHeight + currentTextTop);
    ctx.lineTo(fixedX + rad, currentTextTop + currentTextHeight);
    ctx.quadraticCurveTo(fixedX, currentTextTop + currentTextHeight, fixedX, currentTextTop + currentTextHeight - rad);
    ctx.lineTo(fixedX, currentTextTop + 8);
    ctx.quadraticCurveTo(fixedX, currentTextTop, fixedX + 8, currentTextTop);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(fixedX + 4, currentTextTop + 20);
    ctx.quadraticCurveTo(fixedX - 10, currentTextTop + 4, fixedX - 16, currentTextTop);
    ctx.quadraticCurveTo(fixedX - 2, currentTextTop, fixedX + 14, currentTextTop + 2);
    ctx.closePath();
    ctx.fill();

    ctx.save();
    ctx.fillStyle = "#eff0f4";
    ctx.font = `${chatFontSize}px InterRegular`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (let i = 0; i < chatLines.length; i++) {
      const lineY = currentTextTop + paddingY + i * lineHeight + chatFontSize / 2;
      await drawTextWithEmojis(ctx, chatLines[i].trim(), fixedX + paddingX, lineY, chatFontSize);
    }
    ctx.restore();
  }

  const emojis = ["❤️", "😂", "😮", "😢", "😡", "👍"];
  const emojiSize = 56;
  const emCardW = 600;
  const emCardX = fixedX - 6;

  ctx.fillStyle = "#222328";
  ctx.beginPath();
  ctx.roundRect(emCardX, emCardY, emCardW, emCardH, [emCardH / 2]);
  ctx.fill();

  const startX = emCardX + 52;
  const spacingX = 80;
  const emojiCY = emCardY + emCardH / 2;

  for (let i = 0; i < Math.min(emojis.length, 6); i++) {
    await drawAppleEmoji(ctx, emojis[i], startX + i * spacingX, emojiCY, emojiSize);
  }

  ctx.fillStyle = "#8e8e93";
  ctx.font = "42px InterRegular";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("+", startX + 6 * spacingX - 2, emCardY + emCardH / 2 - 2);

  return canvas.encode("png");
}

module.exports = function (app) {
  app.get("/image/igqc", async (req, res) => {
    const { txt, imgUrl, time } = req.query;

    if (!txt && !imgUrl) {
      return res.status(400).json({ status: false, error: "Parameter txt atau imgUrl wajib diisi salah satu" });
    }

    try {
      const buffer = await drawScene({
        txt: txt || "",
        imgUrl: imgUrl || "",
        menuTimeStr: time || "SEN 12.00",
      });

      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": buffer.length });
      res.end(buffer);
    } catch (error) {
      res.status(500).json({ status: false, error: error.message });
    }
  });
};
