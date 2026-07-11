const BASE_URL = "https://spotisaver.net";
const LANG = "en";
const FILENAME_TAG = "KYZENID";
const MAX_DOWNLOAD_RETRY = 3;
const RETRY_DELAYS = [2000, 3000, 4000];
const ua = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanInput(input) {
  return String(input || "")
    .trim()
    .replace(/%0A/gi, "")
    .replace(/%0D/gi, "")
    .replace(/\r|\n/g, "");
}

function randomIp() {
  return [
    Math.floor(Math.random() * 223) + 1,
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
  ].join(".");
}

function jsonBase64(data) {
  return Buffer.from(JSON.stringify(data)).toString("base64");
}

function parseSpotify(input) {
  const cleaned = cleanInput(input);
  const url = new URL(cleaned);
  const parts = url.pathname.split("/").filter(Boolean);

  return {
    raw: cleaned,
    type: parts[0] || "track",
    id: parts[1] || cleaned,
  };
}

function safeName(name) {
  return String(name || "spotify-audio.mp3")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function getFilenameFromDisposition(disposition) {
  if (!disposition) return null;

  const utf = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf?.[1]) return decodeURIComponent(utf[1].replace(/^"|"$/g, ""));

  const normal = disposition.match(/filename="([^"]+)"/i);
  if (normal?.[1]) return normal[1];

  return null;
}

function parseMaybeJson(buffer, contentType) {
  const text = buffer.toString("utf8");
  let json = null;

  if (contentType.includes("application/json") || text.trim().startsWith("{") || text.trim().startsWith("[")) {
    try {
      json = JSON.parse(text);
    } catch {}
  }

  return { text, json };
}

module.exports = function (app) {
  function makeCookieJar() {
    const store = {
      "_s-uid": `v_${Math.random().toString(16).slice(2, 16)}.${Math.floor(Math.random() * 100000000)}`,
      lang: LANG,
    };

    return {
      header() {
        return Object.entries(store)
          .filter(([, v]) => v !== undefined && v !== null && String(v).length)
          .map(([k, v]) => `${k}=${v}`)
          .join("; ");
      },
      save(headers) {
        const raw =
          typeof headers.getSetCookie === "function"
            ? headers.getSetCookie()
            : headers.get("set-cookie")
            ? headers.get("set-cookie").split(/,(?=\s*[^;,=\s]+=[^;,]+)/g)
            : [];

        for (const item of raw) {
          const part = item.split(";")[0];
          const i = part.indexOf("=");
          if (i > -1) store[part.slice(0, i)] = part.slice(i + 1);
        }
      },
    };
  }

  async function warmup(parsed, jar) {
    const urls = [`${BASE_URL}/en1`, `${BASE_URL}/en/${parsed.type}/${parsed.id}/`];

    for (const url of urls) {
      const res = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(60000),
        headers: {
          "user-agent": ua,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
          cookie: jar.header(),
        },
      }).catch(() => null);

      if (res) {
        jar.save(res.headers);
        await res.arrayBuffer().catch(() => null);
      }
    }
  }

  async function requestJson(url, jar, extraHeaders = {}, referer = `${BASE_URL}/en1`) {
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(60000),
      headers: {
        "user-agent": ua,
        accept: "application/json",
        "sec-ch-ua-platform": '"Android"',
        "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
        "sec-ch-ua-mobile": "?1",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        referer,
        "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
        cookie: jar.header(),
        priority: "u=1, i",
        ...extraHeaders,
      },
    });

    jar.save(res.headers);

    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}

    return { code: res.status, ok: res.ok, contentType: res.headers.get("content-type") || "", text, data };
  }

  async function requestDownloadOnce(url, body, jar, referer) {
    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(120000),
      headers: {
        "user-agent": ua,
        "sec-ch-ua-platform": '"Android"',
        "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
        "sec-ch-ua-mobile": "?1",
        "content-type": "application/json",
        accept: "*/*",
        origin: BASE_URL,
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        referer,
        "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
        cookie: jar.header(),
        priority: "u=1, i",
      },
      body: JSON.stringify(body),
    });

    jar.save(res.headers);

    const contentType = res.headers.get("content-type") || "";
    const disposition = res.headers.get("content-disposition") || "";
    const buffer = Buffer.from(await res.arrayBuffer());
    const parsed = parseMaybeJson(buffer, contentType);

    return { code: res.status, ok: res.ok, contentType, disposition, buffer, text: parsed.text, json: parsed.json };
  }

  async function requestDownload(url, body, jar, referer) {
    const attempts = [];

    for (let attempt = 1; attempt <= MAX_DOWNLOAD_RETRY; attempt++) {
      const dl = await requestDownloadOnce(url, body, jar, referer);

      const errorText = dl.json?.error || dl.text.slice(0, 200);
      const noSlots = dl.json?.error === "No available slots" || dl.text.includes("No available slots");

      attempts.push({
        attempt,
        code: dl.code,
        contentType: dl.contentType,
        error: dl.contentType.includes("audio") ? null : errorText,
        retry: noSlots && attempt < MAX_DOWNLOAD_RETRY,
      });

      if (dl.ok && dl.contentType.includes("audio")) {
        return { ...dl, ok: true, attempts };
      }

      if (!noSlots || attempt >= MAX_DOWNLOAD_RETRY) {
        return { ...dl, ok: false, attempts };
      }

      await sleep(RETRY_DELAYS[attempt - 1] || 25000);
    }

    return {
      code: 500,
      ok: false,
      contentType: "application/json",
      disposition: "",
      buffer: Buffer.from(JSON.stringify({ error: "Max retry reached" })),
      text: JSON.stringify({ error: "Max retry reached" }),
      json: { error: "Max retry reached" },
      attempts,
    };
  }

  async function getSignature(action, ctxPayload, jar, referer) {
    const ctx = jsonBase64(ctxPayload);
    const url = `${BASE_URL}/api/get_signature.php?action=${encodeURIComponent(action)}&ctx=${encodeURIComponent(ctx)}`;
    return await requestJson(url, jar, {}, referer);
  }

  app.get("/download/spotify", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ status: false, error: "Parameter url wajib diisi" });

    let parsed;
    try {
      parsed = parseSpotify(url);
    } catch {
      return res.status(400).json({ status: false, error: "URL Spotify tidak valid" });
    }

    const jar = makeCookieJar();
    const pageReferer = `${BASE_URL}/en/${parsed.type}/${parsed.id}/`;
    const autoIp = randomIp();

    try {
      await warmup(parsed, jar);

      const playlistSig = await getSignature("get_playlist", { id: parsed.id, type: parsed.type, lang: LANG }, jar, pageReferer);
      if (!playlistSig.ok || !playlistSig.data?.success || !playlistSig.data?.token || !playlistSig.data?.exp) {
        return res.status(502).json({
          status: false,
          step: "playlist_signature",
          error: playlistSig.data || playlistSig.text.slice(0, 500),
        });
      }

      const playlistUrl = `${BASE_URL}/api/get_playlist.php?id=${encodeURIComponent(parsed.id)}&type=${encodeURIComponent(
        parsed.type
      )}&lang=${encodeURIComponent(LANG)}`;

      const playlist = await requestJson(
        playlistUrl,
        jar,
        { "x-pe": String(playlistSig.data.exp), "x-pt": String(playlistSig.data.token) },
        pageReferer
      );

      if (!playlist.ok || !playlist.data?.tracks?.length) {
        return res.status(502).json({ status: false, step: "playlist", error: playlist.data || playlist.text.slice(0, 500) });
      }

      const info = playlist.data.playlist_info || {};
      const track = playlist.data.tracks[0];
      const realTrackId = track.id || parsed.id;
      const realReferer = `${BASE_URL}/en/track/${realTrackId}/`;

      const downloadCtx = {
        lang: LANG,
        id: String(realTrackId),
        name: String(track.name || ""),
        duration_ms: String(track.duration_ms || ""),
      };

      const downloadSig = await getSignature("download_track", downloadCtx, jar, realReferer);
      if (!downloadSig.ok || !downloadSig.data?.success || !downloadSig.data?.token || !downloadSig.data?.exp) {
        return res.status(502).json({
          status: false,
          step: "download_signature",
          error: downloadSig.data || downloadSig.text.slice(0, 500),
        });
      }

      const sigPayload = jsonBase64({ token: String(downloadSig.data.token), exp: String(downloadSig.data.exp) });
      const dlUrl = `${BASE_URL}/api/download_track.php?sig=${encodeURIComponent(sigPayload)}`;

      const body = {
        track,
        download_dir: "downloads",
        filename_tag: FILENAME_TAG,
        user_ip: autoIp,
        is_premium: false,
        lang: LANG,
      };

      const dl = await requestDownload(dlUrl, body, jar, realReferer);

      if (!dl.ok || !dl.contentType.includes("audio")) {
        const raw = dl.text || dl.buffer.toString("utf8");
        return res.status(502).json({
          status: false,
          step: "download",
          contentType: dl.contentType,
          error: dl.json || raw.slice(0, 500),
          attempts: dl.attempts || [],
        });
      }

      const headerName = getFilenameFromDisposition(dl.disposition);
      const filename = safeName(
        headerName ||
          `${(track.artists || []).join(", ") || info.owner || "Spotify"} - ${track.name || info.name || realTrackId} (${FILENAME_TAG}).mp3`
      );

      res.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Content-Length": dl.buffer.length,
        "Content-Disposition": `attachment; filename="${filename}"`,
      });
      res.end(dl.buffer);
    } catch (error) {
      res.status(500).json({ status: false, error: error.message });
    }
  });
};
