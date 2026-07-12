const axios = require("axios");
const cheerio = require("cheerio");

module.exports = function (app) {
  app.get("/search/stickerpack", async (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ status: false, error: "Parameter q wajib diisi" });

    try {
      const { data } = await axios.get(`https://getstickerpack.com/stickers?query=${encodeURIComponent(q)}`, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });

      const $ = cheerio.load(data);
      const result = [];

      $("a.js-sticker-pack-link").each((_, el) => {
        const card = $(el);
        result.push({
          title: card.find(".title").text().trim(),
          author: card.find(".username").text().trim(),
          thumbnail: card.find("img").attr("src") || null,
          url: card.attr("href") || null,
          slug: card.attr("data-slug") || null,
        });
      });

      res.json({ status: true, result });
    } catch (error) {
      res.status(500).json({ status: false, error: error.message });
    }
  });
};
