function makeCookieJar() {
  const store = {};
  return {
    header() {
      return Object.entries(store)
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

const ua = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36";

let cachedToken = null;
let cachedTokenExp = 0;

async function getAnonymousToken() {
  if (cachedToken && Date.now() < cachedTokenExp - 10000) return cachedToken;

  const jar = makeCookieJar();

  const home = await fetch("https://open.spotify.com/", {
    headers: { "user-agent": ua, accept: "text/html" },
  });
  jar.save(home.headers);
  await home.text();

  const tokenRes = await fetch("https://open.spotify.com/get_access_token?reason=transport&productType=web_player", {
    headers: { "user-agent": ua, accept: "application/json", cookie: jar.header(), referer: "https://open.spotify.com/" },
  });

  if (!tokenRes.ok) throw new Error(`Gagal ambil access token, status: ${tokenRes.status}`);
  const data = await tokenRes.json();
  if (!data.accessToken) throw new Error("Access token tidak ditemukan di response");

  cachedToken = data.accessToken;
  cachedTokenExp = data.accessTokenExpirationTimestampMs || Date.now() + 55 * 60 * 1000;
  return cachedToken;
}

async function searchSpotify(query, limit = 10) {
  const token = await getAnonymousToken();

  const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=${Math.min(Number(limit) || 10, 10)}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, "user-agent": ua, accept: "application/json" },
  });

  if (res.status === 401) {
    cachedToken = null;
    throw new Error("Token expired/invalid, coba lagi");
  }
  if (!res.ok) throw new Error(`Spotify API error, status: ${res.status}`);

  const data = await res.json();
  const items = data.tracks?.items || [];

  return items.map((track) => ({
    title: track.name,
    artists: (track.artists || []).map((a) => a.name).join(", "),
    album: track.album?.name || null,
    cover: track.album?.images?.[0]?.url || null,
    duration_ms: track.duration_ms,
    url: track.external_urls?.spotify || null,
    id: track.id,
  }));
}

module.exports = function (app) {
  app.get("/search/spotify", async (req, res) => {
    const { q, limit } = req.query;
    if (!q) return res.status(400).json({ status: false, error: "Parameter q wajib diisi" });

    try {
      const result = await searchSpotify(q, limit);
      res.json({ status: true, result });
    } catch (error) {
      res.status(502).json({ status: false, error: error.message });
    }
  });
};
