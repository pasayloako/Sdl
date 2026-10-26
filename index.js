"use strict";

const express = require("express");
const path = require("path");
const { lookup, SpotifyError } = require("./lib/spotify");

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_URL_LENGTH = 500;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// CORS for all /api routes
app.use("/api", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.options("/api/*", (req, res) => res.sendStatus(204));

// -------- /api/lookup --------
app.get("/api/lookup", async (req, res) => {
  const inputUrl = req.query.url;
  const raw = req.query.raw === "1" || req.query.raw === "true";

  if (typeof inputUrl !== "string" || !inputUrl.trim()) {
    return res.status(400).json({ error: "Provide a Spotify URL via ?url=" });
  }
  if (inputUrl.length > MAX_URL_LENGTH) {
    return res.status(400).json({ error: "URL too long." });
  }

  try {
    const { type, result, entity } = await lookup(inputUrl);
    const body = { type, result };
    if (raw) body.raw = entity;
    return res.json(body);
  } catch (err) {
    const status = err instanceof SpotifyError ? err.status : 502;
    console.error("lookup failed:", err?.message || err);
    return res.status(status).json({
      error:
        err instanceof SpotifyError
          ? err.message
          : "Spotify metadata could not be read."
    });
  }
});

// -------- /api/batch --------
app.post("/api/batch", async (req, res) => {
  const urls = Array.isArray(req.body?.urls) ? req.body.urls : [];
  if (!urls.length) {
    return res.status(400).json({ error: "Provide { urls: [...] }" });
  }
  if (urls.length > 20) {
    return res.status(400).json({ error: "Max 20 URLs." });
  }

  const results = await Promise.all(
    urls.map(async (url) => {
      try {
        const { type, result } = await lookup(url);
        return { url, ok: true, type, result };
      } catch (err) {
        return {
          url,
          ok: false,
          status: err instanceof SpotifyError ? err.status : 502,
          error: err?.message || "Lookup failed."
        };
      }
    })
  );

  res.json({ count: results.length, results });
});

// -------- /api (info) --------
app.get("/api", (req, res) => {
  res.json({
    name: "Spotify Metadata Downloader",
    version: "1.0.0",
    endpoints: {
      lookup: "GET /api/lookup?url=<spotify-url>&raw=1",
      batch: "POST /api/batch { urls: [...] }"
    },
    notes: "Metadata only. No audio is downloaded."
  });
});

app.listen(PORT, () => {
  console.log(`▶  Server running: http://localhost:${PORT}`);
});
