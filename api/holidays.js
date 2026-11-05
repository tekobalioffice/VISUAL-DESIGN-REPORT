// Vercel function: national holiday list for the web app (no secrets, cached at the edge for 12 hours).
const { getHolidays, storyTask } = require('../lib/holidays');

module.exports = async (req, res) => {
  try {
    const h = await getHolidays();
    for (const x of h.tasks) x.doc = storyTask(x);
    res.setHeader('Cache-Control', 's-maxage=43200, stale-while-revalidate=86400');
    res.status(200).json(h);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};
