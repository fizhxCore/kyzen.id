const axios = require("axios");
const yts = require("yt-search");
const ytdl = require("@distube/ytdl-core");

function safeName(name) {
  return String(name || "audio")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
}

async function getSpotifyMeta(url) {
  // Endpoint oEmbed resmi Spotify, publik & tanpa API key/cloudflare-challenge
  const { data } = await axios.get("https://open.spotify.com/oembed", {
    params: { url },
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  if (!data?.title) throw new Error("Metadata Spotify tidak ditemukan, pastikan URL track valid");

  // Format title dari Spotify biasanya "Judul Lagu" saja, author_name = nama artis
  return {
    title: data.title,
    artist: data.author_name || "",
    thumbnail: data.thumbnail_url || null,
  };
}

async function findYoutubeMatch(meta) {
  const query = `${meta.title} ${meta.artist}`.trim();
  const search = await yts(query);
  const video = search.videos?.[0];
  if (!video) throw new Error("Lagu yang cocok tidak ditemukan di YouTube");
  return video;
}

module.exports = function (app) {
  app.get("/download/spotify", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ status: false, error: "Parameter url wajib diisi" });
    if (!/open\.spotify\.com\/(intl-[a-z]+\/)?track\//i.test(url)) {
      return res.status(400).json({ status: false, error: "URL harus berupa link track Spotify" });
    }

    try {
      const meta = await getSpotifyMeta(url);
      const video = await findYoutubeMatch(meta);

      const filename = safeName(`${meta.artist} - ${meta.title}`.trim() || video.title) + ".m4a";

      const info = await ytdl.getInfo(video.url);
      const audioFormat = ytdl.chooseFormat(info.formats, { quality: "highestaudio", filter: "audioonly" });

      if (!audioFormat) {
        return res.status(502).json({ status: false, error: "Format audio tidak ditemukan untuk video ini" });
      }

      res.writeHead(200, {
        "Content-Type": audioFormat.mimeType?.split(";")[0] || "audio/mp4",
        "Content-Disposition": `attachment; filename="${filename}"`,
      });

      const stream = ytdl.downloadFromInfo(info, { format: audioFormat });
      stream.on("error", (err) => {
        if (!res.headersSent) res.status(500).json({ status: false, error: err.message });
        else res.end();
      });
      stream.pipe(res);
    } catch (error) {
      res.status(500).json({ status: false, error: error.message });
    }
  });
};
