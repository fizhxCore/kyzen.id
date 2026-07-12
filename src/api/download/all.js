const crypto = require("crypto");
const forge = require("node-forge");
const sharp = require("sharp");
const { createWorker } = require("tesseract.js");

const api = "https://api.snapwc.com";
const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const serverPubPem = `-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvDU+dR2bSews55172x4L\ns/ja+Dxt9ViZcj/nY0YodYo7l4jEKtEiCNV28lpFj3CkP4HKRCjL/jYkQNKGPwVg\ngUCGr/jBF1FpDLsqa0kg+dtfkm5Xm9QAyMBeG/jPdl5BEPOVh33A1UkPO/Xw6kSH\nrfghOUwBMzRBtXeYuJiYs5sKrf+Wy5sv708TI6G4hAPJG/69W4NNFJi/ipBNxntG\ndAoUHpEy4iYsvBgiccE7U0MBDnSHSqBBtIdMMFRHARn/tc+jXaadS0a4YmhTygiN\neAJU4QuqAE25CsvkzIYIVEmlRXVcC0afw76XcwDpKBMVR5bEPzd3tMEfA+R34L1D\nfQIDAQAB\n-----END PUBLIC KEY-----`;
const serverPub = forge.pki.publicKeyFromPem(serverPubPem);

function genClientKeys() {
  const kp = forge.pki.rsa.generateKeyPair({ bits: 512 });
  return { pub: forge.pki.publicKeyToPem(kp.publicKey), priv: kp.privateKey };
}

function encReq(data, clientPubPem) {
  const aesKeyHex = crypto.randomBytes(16).toString("hex");
  const aesKey = crypto.createHash("sha256").update(aesKeyHex).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", aesKey, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return {
    encrypted_key: forge.util.encode64(serverPub.encrypt(aesKeyHex, "RSAES-PKCS1-V1_5")),
    encrypted_data: Buffer.concat([iv, enc]).toString("base64"),
    client_public_key: clientPubPem,
  };
}

function decResp(resp, clientPriv) {
  const aesKeyHex = clientPriv.decrypt(forge.util.decode64(resp.encrypted_key), "RSAES-PKCS1-V1_5");
  const aesKey = crypto.createHash("sha256").update(aesKeyHex).digest();
  const raw = Buffer.from(resp.encrypted_data, "base64");
  const dec = crypto.createDecipheriv("aes-256-cbc", aesKey, raw.slice(0, 16));
  return JSON.parse(Buffer.concat([dec.update(raw.slice(16)), dec.final()]).toString("utf8"));
}

let ocrWorker = null;
async function getOcrWorker() {
  if (!ocrWorker) {
    ocrWorker = await createWorker("eng");
    await ocrWorker.setParameters({
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      tessedit_pageseg_mode: "7",
    });
  }
  return ocrWorker;
}

async function solveCaptcha(imageB64) {
  const raw = Buffer.from(imageB64.replace(/^data:image\/png;base64,/, ""), "base64");
  const processed = await sharp(raw).resize(1200, null, { kernel: "lanczos3" }).grayscale().normalize().toBuffer();

  const worker = await getOcrWorker();
  const attempts = [];
  try {
    const { data } = await worker.recognize(processed);
    attempts.push((data.text || "").trim().replace(/\s+/g, ""));
  } catch (e) {}

  return [...new Set(attempts.filter((x) => x.length === 4))];
}

async function snapwc(url, maxAttempts = 8) {
  const keys = genClientKeys();
  const hBase = {
    "content-type": "application/json",
    "user-agent": ua,
    "x-locale": "en",
    origin: "https://snapwc.com",
    referer: "https://snapwc.com/",
  };

  const init = await fetch(`${api}/api.visitor/init`, { method: "POST", headers: hBase, body: JSON.stringify({}) });
  const jar = init.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const h = { ...hBase, cookie: jar };

  const chk = await (
    await fetch(`${api}/api.captcha/is_required`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ scenario: "parser", data: { url } }),
    })
  ).json();

  if (chk.status) {
    let solved = false;
    for (let i = 0; i < maxAttempts && !solved; i++) {
      const genRes = await fetch(`${api}/api.captcha/generate`, { method: "POST", headers: h, body: JSON.stringify({}) });
      if (genRes.status !== 200) break;
      const gen = await genRes.json();
      const codes = await solveCaptcha(gen.captcha_image);
      for (const code of codes) {
        const v = await fetch(`${api}/api.captcha/verify`, {
          method: "POST",
          headers: h,
          body: JSON.stringify({ captcha_token: gen.captcha_token, captcha_code: code, scenario: "parser", data: { url } }),
        });
        if (v.status === 200) {
          solved = true;
          break;
        }
      }
    }
    if (!solved) return { status: "error", message: "captcha unsolvable after retries" };
  }

  const body = encReq({ url }, keys.pub);
  const res = await fetch(`${api}/api.parser/parse`, { method: "POST", headers: h, body: JSON.stringify(body) });
  const txt = await res.text();
  if (!res.ok) return { status: "error", code: res.status, message: txt.slice(0, 300) };
  const j = JSON.parse(txt);
  const parsed = j.encrypted_data ? decResp(j, keys.priv) : j;

  return {
    status: "success",
    platforms_supported: [
      "youtube", "tiktok", "instagram", "facebook", "twitter", "x",
      "threads", "reddit", "pinterest", "bilibili", "dailymotion", "soundcloud", "ted", "vk",
    ],
    data: parsed,
  };
}

module.exports = function (app) {
  app.get("/download/all", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ status: false, error: "Parameter url wajib diisi" });

    try {
      const result = await snapwc(url);

      if (result.status === "error") {
        return res.status(502).json({ status: false, error: result.message, code: result.code });
      }

      res.json({ status: true, platforms_supported: result.platforms_supported, result: result.data });
    } catch (error) {
      res.status(500).json({ status: false, error: error.message });
    }
  });
};
