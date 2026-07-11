const axios = require("axios");
const { createCanvas, loadImage, GlobalFonts } = require("@napi-rs/canvas");
const { writeFile, mkdir, readFile } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const ASSET_DIR = path.join(os.tmpdir(), "kyzen-waquote-assets");
const FONT_DIR = path.join(ASSET_DIR, "fonts");

const FONT_MEDIUM_URL = "https://cdn.jsdelivr.net/gh/Ditzzx-vibecoder/Assets@main/Font/Inter-Medium.otf";
const FONT_REGULAR_URL = "https://cdn.jsdelivr.net/gh/Ditzzx-vibecoder/Assets@main/Font/interregular.ttf";
const APPLE_EMOJI_JSON_URL = "https://media.githubusercontent.com/media/Ditzzx-vibecoder/entahlah/main/emoji-apple.json";
const BACKGROUND_DARK_URL = "https://cdn.jsdelivr.net/gh/Ditzzx-vibecoder/Assets@main/Image/hoh.jpeg";
const BACKGROUND_LIGHT_URL = "https://cdn.jsdelivr.net/gh/Ditzzx-vibecoder/Assets@main/Font/sisis.jpeg";

const APPLE_EMOJI_JSON_LOCAL = path.join(FONT_DIR, "emoji-apple-image.json");
const FONT_MEDIUM_LOCAL = path.join(FONT_DIR, "Inter-Medium.otf");
const FONT_REGULAR_LOCAL = path.join(FONT_DIR, "Inter-Regular.ttf");
const BACKGROUND_DARK_LOCAL = path.join(ASSET_DIR, "wab.jpeg");
const BACKGROUND_LIGHT_LOCAL = path.join(ASSET_DIR, "sisis.jpeg");

const THEMES = {
  dark: { bubble: "#242625", text: "#f1f3f5", phone: "#7a8285", time: "#aeb4b8" },
  light: { bubble: "#ffffff", text: "#2f3032", phone: "#767a7b", time: "#767a7b" },
};

const USERNAME_COLORS_DARK = ["#25d366", "#53bdeb", "#ffb02e", "#ff6b81", "#b197fc", "#63e6be", "#ffd43b", "#74c0fc", "#f783ac", "#69db7c"];
const USERNAME_COLORS_LIGHT = ["#1fa855", "#1070e0", "#d97706", "#dc2626", "#9333ea", "#db2777", "#0d9488", "#b45309"];

const EMOJI_REGEX =
  /(\p{Emoji_Modifier_Base}\p{Emoji_Modifier}|\p{Emoji_Presentation}\uFE0F?|\p{Emoji}\uFE0F|[\u{1F1E0}-\u{1F1FF}]{2}|\p{Extended_Pictographic}\uFE0F?)/gu;

let fontsReady = false;
let appleEmojiMap = null;
const emojiImageCache = new Map();
const backgroundImageCache = { dark: null, light: null };

async function downloadFile(url) {
  const res = await axios.get(url, { responseType: "arraybuffer", headers: { "User-Agent": "Mozilla/5.0" }, maxRedirects: 5 });
  return Buffer.from(res.data);
}

async function ensureFile(url, localPath) {
  if (!existsSync(localPath)) {
    await writeFile(localPath, await downloadFile(url));
  }
}

async function loadFonts() {
  if (fontsReady) return;
  await mkdir(FONT_DIR, { recursive: true });
  await ensureFile(FONT_MEDIUM_URL, FONT_MEDIUM_LOCAL);
  await ensureFile(FONT_REGULAR_URL, FONT_REGULAR_LOCAL);
  GlobalFonts.registerFromPath(FONT_MEDIUM_LOCAL, "WAQuoteInterMedium");
  GlobalFonts.registerFromPath(FONT_REGULAR_LOCAL, "WAQuoteInterRegular");
  fontsReady = true;
}

async function loadBackground(mode) {
  if (backgroundImageCache[mode]) return backgroundImageCache[mode];
  await mkdir(ASSET_DIR, { recursive: true });
  const url = mode === "light" ? BACKGROUND_LIGHT_URL : BACKGROUND_DARK_URL;
  const localPath = mode === "light" ? BACKGROUND_LIGHT_LOCAL : BACKGROUND_DARK_LOCAL;
  await ensureFile(url, localPath);
  backgroundImageCache[mode] = await loadImage(await readFile(localPath));
  return backgroundImageCache[mode];
}

function randomUsernameColor(mode) {
  const colors = mode === "light" ? USERNAME_COLORS_LIGHT : USERNAME_COLORS_DARK;
  return colors[Math.floor(Math.random() * colors.length)];
}

function emojiToUnicode(emoji) {
  return [...emoji].map((v) => v.codePointAt(0).toString(16).padStart(4, "0")).join("-");
}

async function loadAppleEmojiMap() {
  if (appleEmojiMap) return appleEmojiMap;
  await mkdir(FONT_DIR, { recursive: true });
  if (!existsSync(APPLE_EMOJI_JSON_LOCAL)) {
    await writeFile(APPLE_EMOJI_JSON_LOCAL, await downloadFile(APPLE_EMOJI_JSON_URL));
  }
  const raw = await readFile(APPLE_EMOJI_JSON_LOCAL, "utf-8");
  appleEmojiMap = JSON.parse(raw);
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
  for (const variant of variants) {
    if (map[variant]) {
      b64 = map[variant];
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
  const parts = String(text).split(EMOJI_REGEX);
  let width = 0;
  for (const part of parts) {
    if (!part) continue;
    EMOJI_REGEX.lastIndex = 0;
    if (EMOJI_REGEX.test(part)) {
      width += fontSize * 1.05;
    } else {
      width += ctx.measureText(part).width;
    }
    EMOJI_REGEX.lastIndex = 0;
  }
  return width;
}

async function drawTextWithEmojis(ctx, text, x, y, fontSize) {
  const parts = String(text).split(EMOJI_REGEX);
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

function drawBackgroundCover(ctx, img, canvasW, canvasH) {
  const imgAspect = img.width / img.height;
  const canvasAspect = canvasW / canvasH;
  let sx = 0,
    sy = 0,
    sw = img.width,
    sh = img.height;
  if (imgAspect > canvasAspect) {
    sw = img.height * canvasAspect;
    sx = (img.width - sw) / 2;
  } else {
    sh = img.width / canvasAspect;
    sy = (img.height - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvasW, canvasH);
}

function bubblePath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + 26);
  ctx.quadraticCurveTo(x - 4, y + 10, x - 18, y + 4);
  ctx.quadraticCurveTo(x - 22, y + 2, x - 20, y);
  ctx.quadraticCurveTo(x - 10, y, x + r, y);
  ctx.closePath();
}

function drawCircleImage(ctx, img, x, y, size) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(img, x, y, size, size);
  ctx.restore();
}

function imageAreaPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function wrapTextFullWidth(ctx, text, maxWidth, fontSize) {
  const words = String(text).split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    if (word.includes("\n")) {
      const parts = word.split("\n");
      for (let i = 0; i < parts.length; i++) {
        const test = current ? `${current} ${parts[i]}` : parts[i];
        if (measureTextCustom(ctx, test, fontSize) > maxWidth && current) {
          lines.push(current);
          current = parts[i];
        } else {
          current = test;
        }
        if (i < parts.length - 1) {
          lines.push(current);
          current = "";
        }
      }
      continue;
    }
    const test = current ? `${current} ${word}` : word;
    if (measureTextCustom(ctx, test, fontSize) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

async function createQuoteBuffer(data) {
  await loadFonts();
  await loadAppleEmojiMap();

  const currentMode = data.mode === "light" ? "light" : "dark";
  const themeColors = THEMES[currentMode];

  if (!data.username) throw new Error("Parameter username wajib diisi");
  if (!data.phone) throw new Error("Parameter phone wajib diisi");
  if (!data.ppUrl) throw new Error("Parameter ppUrl wajib diisi");

  const hasImage = Boolean(data.imgUrl);
  const hasTag = Boolean(data.tag);
  if (!data.text && !hasImage) throw new Error("Parameter text atau imgUrl wajib diisi salah satu");

  const width = 1024;
  const usernameSize = 31,
    phoneSize = 29,
    tagSize = 29,
    textSize = 40,
    timeSize = 29;
  const usernameFont = `${usernameSize}px WAQuoteInterMedium`;
  const phoneFont = `${phoneSize}px WAQuoteInterRegular`;
  const tagFont = `${tagSize}px WAQuoteInterRegular`;
  const textFont = `${textSize}px WAQuoteInterRegular`;
  const timeFont = `${timeSize}px WAQuoteInterRegular`;

  const bubbleX = 108,
    bubbleY = 60,
    bubbleRadius = 24,
    paddingX = 38,
    paddingRight = 36,
    lineHeight = 56;
  const avatarSize = 72,
    avatarX = 12,
    avatarY = bubbleY;

  const time = new Date()
    .toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false })
    .replace(":", ".");

  const measureCanvas = createCanvas(10, 10);
  const mctx = measureCanvas.getContext("2d");

  mctx.font = usernameFont;
  const usernameWidth = measureTextCustom(mctx, data.username, usernameSize);
  mctx.font = phoneFont;
  const phoneWidth = measureTextCustom(mctx, data.phone, phoneSize);
  mctx.font = tagFont;
  const tagWidth = hasTag ? measureTextCustom(mctx, data.tag, tagSize) : 0;
  mctx.font = timeFont;
  const timeWidth = mctx.measureText(time).width;

  const headerGap = 40;
  const minHeaderWidth = usernameWidth + headerGap + phoneWidth + paddingX + paddingRight;
  const minTagWidth = hasTag ? tagWidth + paddingX + paddingRight : 0;

  const maxBubbleW = width - bubbleX - 24;
  const textRightLimit = bubbleX + maxBubbleW - paddingRight - 18;
  const contentX = bubbleX + paddingX - 5;
  const textMaxWidth = Math.max(260, textRightLimit - contentX);

  mctx.font = textFont;
  const lines = data.text ? wrapTextFullWidth(mctx, data.text, textMaxWidth, textSize) : [];
  const hasCaption = lines.length > 0;

  let bubbleWidth = maxBubbleW;
  if (!hasImage) {
    let maxLineWidth = 0;
    for (const line of lines) {
      const w = measureTextCustom(mctx, line, textSize);
      if (w > maxLineWidth) maxLineWidth = w;
    }
    let neededTextWidth = maxLineWidth + paddingX + paddingRight + 25;
    if (lines.length === 1) neededTextWidth += timeWidth + 15;
    bubbleWidth = Math.max(neededTextWidth, minHeaderWidth, minTagWidth);
    if (bubbleWidth > maxBubbleW) bubbleWidth = maxBubbleW;
  }

  const phoneX = bubbleX + bubbleWidth - phoneWidth - paddingRight;
  const timeX = bubbleX + bubbleWidth - 20;

  let avatar;
  try {
    avatar = await loadImage(await downloadFile(data.ppUrl));
  } catch {
    avatar = await loadImage(await downloadFile("https://telegra.ph/file/320b066dc81928b782c7b.png"));
  }

  const background = await loadBackground(currentMode);

  let mainImage = null;
  let imageAreaX = bubbleX + 8;
  let imageAreaW = bubbleWidth - 16;
  let imageDrawH = 0;

  if (hasImage) {
    const imgBuf = await downloadFile(data.imgUrl);
    mainImage = await loadImage(imgBuf);
    const imgAspect = mainImage.width / mainImage.height;
    imageDrawH = Math.round(imageAreaW / imgAspect);
  }

  let headerY, tagY, headerBlockH;
  if (hasTag) {
    headerY = bubbleY + 52;
    tagY = headerY + 43;
    headerBlockH = 130;
  } else {
    headerBlockH = 76;
    headerY = bubbleY + 34;
  }

  const imageTopGap = 0;
  const imageBottomGap = hasImage ? (hasCaption ? 20 : 8) : 0;
  const imageBlockH = hasImage ? imageTopGap + imageDrawH + imageBottomGap : 0;
  const textBlockH = lines.length * lineHeight;
  const timeRowH = !hasImage && hasCaption ? 26 : 0;
  const bottomPad = hasImage ? (hasCaption ? 20 : 8) : 0;

  const bubbleHeight = Math.max(100, headerBlockH + imageBlockH + textBlockH + timeRowH + bottomPad);
  const imageY = bubbleY + headerBlockH + imageTopGap;
  const textStartY = hasImage
    ? imageY + imageDrawH + imageBottomGap + lineHeight / 2 - 6
    : bubbleY + headerBlockH + textSize / 2 + 2;
  const height = Math.round(bubbleY + bubbleHeight + 70);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);

  drawBackgroundCover(ctx, background, width, height);

  ctx.fillStyle = themeColors.bubble;
  bubblePath(ctx, bubbleX, bubbleY, bubbleWidth, bubbleHeight, bubbleRadius);
  ctx.fill();

  drawCircleImage(ctx, avatar, avatarX, avatarY, avatarSize);

  ctx.textAlign = "left";
  ctx.textBaseline = hasTag ? "alphabetic" : "middle";

  ctx.font = usernameFont;
  ctx.fillStyle = randomUsernameColor(currentMode);
  await drawTextWithEmojis(ctx, data.username, contentX, headerY, usernameSize);

  ctx.font = phoneFont;
  ctx.fillStyle = themeColors.phone;
  await drawTextWithEmojis(ctx, data.phone, phoneX, headerY, phoneSize);

  if (hasTag) {
    ctx.textBaseline = "alphabetic";
    ctx.font = tagFont;
    ctx.fillStyle = themeColors.phone;
    await drawTextWithEmojis(ctx, data.tag, contentX, tagY, tagSize);
  }

  if (hasImage && mainImage) {
    ctx.save();
    imageAreaPath(ctx, imageAreaX, imageY, imageAreaW, imageDrawH, 20);
    ctx.clip();
    ctx.drawImage(mainImage, imageAreaX, imageY, imageAreaW, imageDrawH);
    ctx.restore();
  }

  ctx.font = textFont;
  ctx.fillStyle = themeColors.text;
  ctx.textBaseline = "middle";
  for (let i = 0; i < lines.length; i++) {
    await drawTextWithEmojis(ctx, lines[i], contentX, textStartY + i * lineHeight, textSize);
  }

  ctx.font = timeFont;
  ctx.textBaseline = "alphabetic";

  if (hasImage && !hasCaption) {
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "right";
    const imgTimeX = imageAreaX + imageAreaW - 20;
    const imgTimeY = imageY + imageDrawH - 18;
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
    ctx.shadowBlur = 4;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    ctx.fillText(time, imgTimeX, imgTimeY);
    ctx.restore();
  } else {
    ctx.fillStyle = themeColors.time;
    ctx.textAlign = "right";
    const timeYOffset = !hasImage ? 13 : 16;
    const timeY = bubbleY + bubbleHeight - timeYOffset;
    ctx.fillText(time, timeX, timeY);
  }

  return canvas.encode("png");
}

module.exports = function (app) {
  app.get("/image/waquote", async (req, res) => {
    const { username, phone, tag, text, imgUrl, ppUrl, mode } = req.query;

    try {
      const buffer = await createQuoteBuffer({ username, phone, tag, text, imgUrl, ppUrl, mode });
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": buffer.length });
      res.end(buffer);
    } catch (error) {
      res.status(400).json({ status: false, error: error.message });
    }
  });
};
