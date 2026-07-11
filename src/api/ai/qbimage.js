const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
const crypto = require("node:crypto");

const BASE = "https://quillbot.com";
const CATEGORY = "Auto";
const PROMPT_ID = "image/generate-image";
const UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36";

function uuid() {
  return crypto.randomUUID();
}

function hex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

function sentryHeaders() {
  const traceId = hex(16);
  const spanId = hex(8);
  const sampleRand = Math.random();

  return {
    baggage: `sentry-environment=prod,sentry-release=v42.51.6,sentry-public_key=5743ef12f4887fc460c7968ebb2de54d,sentry-trace_id=${traceId},sentry-sampled=false,sentry-sample_rand=${sampleRand},sentry-sample_rate=0.01`,
    "sentry-trace": `${traceId}-${spanId}-0`,
  };
}

async function generateImage(prompt, aspectRatio = "1:1") {
  const jar = new CookieJar();
  const client = wrapper(axios.create({ jar, withCredentials: true, decompress: true, validateStatus: () => true, timeout: 120000 }));

  const setCookie = async (name, value) => {
    await jar.setCookie(`${name}=${value}; Path=/; Domain=quillbot.com; Secure; SameSite=None`, BASE);
  };

  await setCookie("qbDeviceId", uuid());
  await setCookie("ajs_anonymous_id", uuid());
  await setCookie("anonID", hex(8));
  await setCookie("authenticated", "false");
  await setCookie("premium", "false");
  await setCookie("acceptedPremiumModesTnc", "false");
  await setCookie("qdid", hex(16));

  await client.get(BASE, {
    headers: {
      "sec-ch-ua": `"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"`,
      "sec-ch-ua-mobile": "?1",
      "sec-ch-ua-platform": `"Android"`,
      "upgrade-insecure-requests": "1",
      "user-agent": UA,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      "sec-fetch-site": "none",
      "sec-fetch-mode": "navigate",
      "sec-fetch-user": "?1",
      "sec-fetch-dest": "document",
      "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });

  const res = await client.post(
    `${BASE}/api/raven/generate/image`,
    { prompt, category: CATEGORY, aspectRatio, promptId: PROMPT_ID },
    {
      headers: {
        "sec-ch-ua-platform": `"Android"`,
        "platform-type": "webapp",
        "qb-product": "IMAGE-GENERATOR",
        "sec-ch-ua": `"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"`,
        "sec-ch-ua-mobile": "?1",
        useridtoken: "empty-token",
        "user-agent": UA,
        accept: "application/json, text/plain, */*",
        "webapp-version": "42.51.6",
        "content-type": "application/json",
        origin: BASE,
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        referer: `${BASE}/ai-image-generator/i/${uuid()}`,
        "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
        ...sentryHeaders(),
      },
    }
  );

  const urls = (res.data?.data?.images || []).map((v) => v.downloadUrl).filter(Boolean);

  return { ok: res.status >= 200 && res.status < 300 && urls.length > 0, status: res.status, urls };
}

module.exports = function (app) {
  app.get("/ai/qbimage", async (req, res) => {
    const { prompt, ratio } = req.query;
    if (!prompt) return res.status(400).json({ status: false, error: "Parameter prompt wajib diisi" });

    const aspectRatio = ["1:1", "16:9", "9:16", "4:3", "3:4"].includes(ratio) ? ratio : "1:1";

    try {
      const result = await generateImage(prompt, aspectRatio);

      if (!result.ok) {
        return res.status(502).json({ status: false, error: "Gagal generate gambar dari sumber", code: result.status });
      }

      res.json({ status: true, prompt, result: result.urls.length === 1 ? result.urls[0] : result.urls });
    } catch (error) {
      res.status(500).json({ status: false, error: error.message });
    }
  });
};
