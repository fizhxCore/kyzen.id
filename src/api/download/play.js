const yts = require("yt-search");
const { Innertube } = require("youtubei.js");

function safeName(name) {
  return String(name || "audio")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
}

let ytClient = null;
async function getClient() {
  if (!ytClient) ytClient = await Innertube.create({ generate_session_locally: true });
  return ytClient;
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
      const yt = await getClient();
      const info = await yt.getBasicInfo(video.videoId, "ANDROID");

      const format = info.chooseFormat({ type: "audio", quality: "best" });
      if (!format) {
        return res.status(502).json({ status: false, error: "Format audio tidak ditemukan untuk video ini" });
      }

      const stream = await yt.download(video.videoId, { type: "audio", quality: "best" });
      const filename = safeName(video.title) + ".m4a";

      res.writeHead(200, {
        "Content-Type": format.mime_type?.split(";")[0] || "audio/mp4",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Video-Title": encodeURIComponent(video.title),
        "X-Video-Url": video.url,
        "X-Video-Duration": video.timestamp || "",
      });

      const nodeStream = require("node:stream").Readable.fromWeb(stream);
      nodeStream.on("error", (err) => {
        if (!res.headersSent) res.status(500).json({ status: false, error: err.message });
        else res.end();
      });
      nodeStream.pipe(res);
    } catch (error) {
      res.status(500).json({ status: false, error: error.message });
    }
  });
};
