const yts = require("yt-search");
const ytdl = require("@distube/ytdl-core");

function safeName(name) {
  return String(name || "audio")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
}

async function searchVideo(query) {
  const search = await yts(query);
  const video = search.videos?.[0];
  if (!video) throw new Error("Lagu tidak ditemukan");
  return video;
}

module.exports = function (app) {
  app.get("/download/play", async (req, res) => {
    const { query } = req.query;
    if (!query) return res.status(400).json({ status: false, error: "Parameter query wajib diisi" });

    try {
      const video = await searchVideo(query);
      const info = await ytdl.getInfo(video.url);
      const audioFormat = ytdl.chooseFormat(info.formats, { quality: "highestaudio", filter: "audioonly" });

      if (!audioFormat) {
        return res.status(502).json({ status: false, error: "Format audio tidak ditemukan untuk video ini" });
      }

      const filename = safeName(video.title) + ".m4a";

      res.writeHead(200, {
        "Content-Type": audioFormat.mimeType?.split(";")[0] || "audio/mp4",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Video-Title": encodeURIComponent(video.title),
        "X-Video-Url": video.url,
        "X-Video-Duration": video.timestamp || "",
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
