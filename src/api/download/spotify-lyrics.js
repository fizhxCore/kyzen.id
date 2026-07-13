async function searchLyrics(trackName, artistName) {
  const params = new URLSearchParams({ track_name: trackName });
  if (artistName) params.set("artist_name", artistName);

  const res = await fetch(`https://lrclib.net/api/search?${params.toString()}`, {
    headers: { "user-agent": "Kyzen.id (https://kyzen-id.vercel.app)" },
  });

  if (!res.ok) throw new Error(`lrclib error, status: ${res.status}`);

  const data = await res.json();
  if (!Array.isArray(data) || !data.length) return null;

  const best = data[0];
  return {
    title: best.trackName,
    artist: best.artistName,
    album: best.albumName || null,
    duration: best.duration || null,
    synced_lyrics: best.syncedLyrics || null,
    plain_lyrics: best.plainLyrics || null,
    instrumental: !!best.instrumental,
  };
}

module.exports = function (app) {
  app.get("/spotify/lyrics", async (req, res) => {
    const { title, artist } = req.query;
    if (!title) return res.status(400).json({ status: false, error: "Parameter title wajib diisi" });

    try {
      const result = await searchLyrics(title, artist);
      if (!result) {
        return res.status(404).json({ status: false, error: "Lirik tidak ditemukan" });
      }
      res.json({ status: true, result });
    } catch (error) {
      res.status(502).json({ status: false, error: error.message });
    }
  });
};
