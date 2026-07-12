module.exports = function (app) {
  app.get("/search/meme", async (req, res) => {
    const { q, offset } = req.query;
    if (!q) return res.status(400).json({ status: false, error: "Parameter q wajib diisi" });

    try {
      const response = await fetch("https://findthatmeme.com/api/v1/search", {
        method: "POST",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/json",
          "X-CSRF-Validation-Header": "true",
        },
        body: JSON.stringify({ search: q, offset: Number(offset) || 0 }),
      });

      if (!response.ok) {
        return res.status(502).json({ status: false, error: `Gagal mengambil data, status: ${response.status}` });
      }

      const data = await response.json();
      const result = (Array.isArray(data) ? data : []).map((meme) => ({
        source_site: meme.source_site || null,
        type: meme.type || null,
        image_url: meme.image_url || null,
        source_url: meme.source_page_url || null,
        transcription: meme.transcription || null,
      }));

      res.json({ status: true, result });
    } catch (error) {
      res.status(500).json({ status: false, error: error.message });
    }
  });
};
