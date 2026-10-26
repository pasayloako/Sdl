"use strict";

const SUPPORTED_TYPES = [
  "track",
  "album",
  "playlist",
  "artist",
  "episode",
  "show"
];

const URL_PATTERN = new RegExp(
  "^https?://open\\.spotify\\.com/(?:intl-[a-zA-Z-]+/)?(" +
    SUPPORTED_TYPES.join("|") +
    ")/([A-Za-z0-9]{22})(?:[/?#].*)?$",
  "i"
);

const URI_PATTERN = new RegExp(
  "^spotify:(" + SUPPORTED_TYPES.join("|") + "):([A-Za-z0-9]{22})$",
  "i"
);

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const cache = new Map();

class SpotifyError extends Error {
  constructor(message, { status = 502, code = "UPSTREAM" } = {}) {
    super(message);
    this.name = "SpotifyError";
    this.status = status;
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Input parsing                                                       */
/* ------------------------------------------------------------------ */

function parseSpotifyInput(input) {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (!value) return null;

  const uriMatch = URI_PATTERN.exec(value);
  if (uriMatch) {
    return { type: uriMatch[1].toLowerCase(), id: uriMatch[2] };
  }

  const urlMatch = URL_PATTERN.exec(value);
  if (urlMatch) {
    return { type: urlMatch[1].toLowerCase(), id: urlMatch[2] };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Fetching + state decoding                                           */
/* ------------------------------------------------------------------ */

function parseInitialState(html) {
  const match =
    /<script[^>]*\bid=["']initialState["'][^>]*>([\s\S]*?)<\/script>/i.exec(
      html
    );

  if (!match) {
    throw new SpotifyError(
      "Spotify metadata was not present in the page.",
      { status: 502, code: "NO_STATE" }
    );
  }

  const payload = match[1].trim();
  const candidates = new Set([payload]);

  try {
    candidates.add(decodeURIComponent(payload));
  } catch {
    /* ignore malformed escapes */
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && parsed.entities) {
        return parsed;
      }
    } catch {
      /* not plain JSON */
    }

    try {
      const cleaned = candidate.replace(/\s+/g, "");
      const decoded = Buffer.from(cleaned, "base64").toString("utf8");
      const parsed = JSON.parse(decoded);
      if (parsed && typeof parsed === "object" && parsed.entities) {
        return parsed;
      }
    } catch {
      /* not base64 JSON */
    }
  }

  throw new SpotifyError("Spotify metadata could not be decoded.", {
    status: 502,
    code: "BAD_STATE"
  });
}

// Node 18.17+ has AbortSignal.timeout, older Node 18 does not.
function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

async function fetchEntity(type, id, { timeoutMs = 10000, retries = 1 } = {}) {
  const cacheKey = `${type}:${id}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  const url = `https://open.spotify.com/${type}/${id}`;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const page = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": "en-US,en;q=0.9",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Cache-Control": "no-cache"
        },
        signal: timeoutSignal(timeoutMs)
      });

      if (page.status === 404) {
        throw new SpotifyError("Spotify item was not found.", {
          status: 404,
          code: "NOT_FOUND"
        });
      }

      if (!page.ok) {
        throw new SpotifyError(`Spotify returned HTTP ${page.status}.`, {
          status: 502,
          code: "UPSTREAM"
        });
      }

      const html = await page.text();
      const state = parseInitialState(html);
      const entity = state.entities?.items?.[`spotify:${type}:${id}`];

      if (!entity) {
        throw new SpotifyError(
          "Spotify metadata did not include the requested item.",
          { status: 502, code: "MISSING_ENTITY" }
        );
      }

      if (cache.size >= CACHE_MAX_ENTRIES) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey !== undefined) cache.delete(oldestKey);
      }
      cache.set(cacheKey, { value: entity, at: Date.now() });

      return entity;
    } catch (error) {
      lastError = error;
      if (error?.code === "NOT_FOUND") break;
      if (attempt === retries) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }

  if (lastError instanceof SpotifyError) throw lastError;

  if (lastError?.name === "TimeoutError" || lastError?.name === "AbortError") {
    throw new SpotifyError("Spotify did not respond in time.", {
      status: 504,
      code: "TIMEOUT"
    });
  }

  throw new SpotifyError("Spotify metadata could not be read.", {
    status: 502,
    code: "UPSTREAM"
  });
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function pickArtwork(...candidates) {
  for (const candidate of candidates) {
    const sources = candidate?.sources;
    if (!Array.isArray(sources) || sources.length === 0) continue;

    const sorted = [...sources]
      .filter((source) => source && typeof source.url === "string" && source.url)
      .sort((a, b) => (b.width || 0) - (a.width || 0));

    if (sorted.length) return sorted[0].url;
  }
  return "";
}

function formatDate(date) {
  if (!date || !date.year) return "";
  return `${date.year}-${String(date.month || 1).padStart(2, "0")}-${String(
    date.day || 1
  ).padStart(2, "0")}`;
}

function durationOf(duration) {
  const ms =
    typeof duration === "number"
      ? duration
      : duration && typeof duration.totalMilliseconds === "number"
        ? duration.totalMilliseconds
        : null;
  return ms !== null && Number.isFinite(ms) ? Math.round(ms) : null;
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return "";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(
      seconds
    ).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function artistNames(collection) {
  const items = Array.isArray(collection?.items) ? collection.items : [];
  return items.map((item) => item?.profile?.name).filter(Boolean);
}

function isExplicit(entity) {
  return (entity?.contentRating?.label || "").toUpperCase() === "EXPLICIT";
}

/* ------------------------------------------------------------------ */
/* Metadata builders                                                   */
/* ------------------------------------------------------------------ */

function getTrackMetadata(entity) {
  const primary = artistNames(entity.firstArtist);
  const featured = artistNames(entity.otherArtists);
  const artists = [...primary, ...featured];
  const album = entity.albumOfTrack || {};
  const durationMs = durationOf(entity.duration);

  return {
    title: entity.name || "",
    artist: artists.join(", "),
    artists,
    album: album.name || "",
    albumId: album.id || "",
    year: formatDate(album.date),
    releaseDate: formatDate(album.date),
    id: entity.id || "",
    uri: entity.uri || "",
    albumCoverURL: pickArtwork(album.coverArt, entity.visuals?.avatarImage),
    trackNumber: entity.trackNumber ?? null,
    discNumber: entity.discNumber ?? null,
    durationMs,
    duration: formatDuration(durationMs),
    explicit: isExplicit(entity),
    playcount: typeof entity.playcount === "number" ? entity.playcount : null
  };
}

function getAlbumMetadata(entity) {
  const artists = artistNames(entity.artists);
  const artist = artists.join(", ");
  const albumCoverURL = pickArtwork(entity.coverArt);
  const releaseDate = formatDate(entity.date);

  const tracks = (entity.tracksV2?.items || [])
    .map((item) => item?.track)
    .filter((track) => track && track.name)
    .map((track) => {
      const trackArtists = artistNames(track.artists);
      const names = trackArtists.length ? trackArtists : artists;
      const trackDuration = durationOf(track.duration);

      return {
        title: track.name,
        artist: names.join(", "),
        artists: names,
        album: entity.name || "",
        year: releaseDate,
        id: track.id || "",
        trackNumber: track.trackNumber ?? null,
        discNumber: track.discNumber ?? null,
        durationMs: trackDuration,
        duration: formatDuration(trackDuration),
        explicit: isExplicit(track),
        albumCoverURL
      };
    });

  const summed = tracks.reduce((sum, track) => sum + (track.durationMs || 0), 0);
  const durationMs = durationOf(entity.duration) ?? (summed || null);

  return {
    name: entity.name || "",
    artist,
    artists,
    year: releaseDate,
    releaseDate,
    id: entity.id || "",
    uri: entity.uri || "",
    label: entity.label || "",
    copyrights: (entity.copyrights || [])
      .map((entry) => entry?.text)
      .filter(Boolean),
    trackCount: entity.tracksV2?.totalCount ?? tracks.length,
    durationMs,
    duration: formatDuration(durationMs),
    tracks,
    albumCoverURL
  };
}

function getPlaylistMetadata(entity) {
  const images = Array.isArray(entity.images?.items) ? entity.images.items : [];
  const playlistCoverURL = pickArtwork(...images);

  const tracks = (entity.content?.items || [])
    .map((item) => {
      const track = item?.itemV2?.data;
      if (!track || !track.name) return null;

      const artists = artistNames(track.artists);
      const album = track.albumOfTrack || {};
      const trackDuration = durationOf(track.duration);
      const addedAt = item?.addedAt?.isoString || "";

      return {
        title: track.name,
        artist: artists.join(", "),
        artists,
        album: album.name || "",
        year: formatDate(album.date),
        id: track.id || "",
        trackNumber: track.trackNumber ?? null,
        discNumber: track.discNumber ?? null,
        durationMs: trackDuration,
        duration: formatDuration(trackDuration),
        explicit: isExplicit(track),
        albumCoverURL: pickArtwork(album.coverArt),
        addedAt
      };
    })
    .filter(Boolean);

  const owner = entity.ownerV2?.data || {};
  const summed = tracks.reduce((sum, track) => sum + (track.durationMs || 0), 0);

  return {
    name: entity.name || "",
    owner: owner.name || "",
    ownerId: owner.uri ? owner.uri.split(":").pop() : owner.id || "",
    description: entity.description || "",
    followerCount: entity.followers ?? 0,
    trackCount: entity.content?.totalCount ?? tracks.length,
    durationMs: summed || null,
    duration: formatDuration(summed || null),
    tracks,
    playlistCoverURL
  };
}

function getArtistMetadata(entity) {
  const profile = entity.profile || {};
  const stats = entity.stats || {};
  const discography = entity.discography || {};
  const avatarImage = entity.visuals?.avatarImage || profile.image;

  const topTracks = (discography.topTracks?.items || [])
    .map((item) => item?.track)
    .filter((track) => track && track.name)
    .map((track) => {
      const durationMs = durationOf(track.duration);
      return {
        title: track.name,
        id: track.id || "",
        album: track.albumOfTrack?.name || "",
        albumCoverURL: pickArtwork(track.albumOfTrack?.coverArt),
        durationMs,
        duration: formatDuration(durationMs),
        playcount: typeof track.playcount === "number" ? track.playcount : null
      };
    });

  return {
    name: entity.name || profile.name || "",
    id: entity.id || "",
    uri: entity.uri || "",
    verified: Boolean(profile.verified),
    biography: profile.biography?.text || "",
    avatarURL: pickArtwork(avatarImage),
    followerCount: stats.followers ?? null,
    monthlyListeners: stats.monthlyListeners ?? null,
    worldRank: stats.worldRank ?? null,
    topTracks
  };
}

function getEpisodeMetadata(entity) {
  const show = entity.podcastV2?.data || entity.show || {};
  const durationMs = durationOf(entity.duration);

  return {
    title: entity.name || "",
    description: entity.description || "",
    id: entity.id || "",
    uri: entity.uri || "",
    show: show.name || "",
    showId: show.id || "",
    releaseDate: formatDate(entity.releaseDate),
    durationMs,
    duration: formatDuration(durationMs),
    explicit: isExplicit(entity),
    episodeCoverURL: pickArtwork(entity.coverArt, show.coverArt),
    audioPreviewURL: entity.audioPreview?.url || "",
    playcount: typeof entity.playcount === "number" ? entity.playcount : null
  };
}

function getShowMetadata(entity) {
  return {
    name: entity.name || "",
    publisher: entity.publisher?.name || "",
    description: entity.description || "",
    id: entity.id || "",
    uri: entity.uri || "",
    showCoverURL: pickArtwork(entity.coverArt),
    explicit: isExplicit(entity),
    episodeCount: entity.episodesV2?.totalCount ?? null
  };
}

const METADATA_BUILDERS = {
  track: getTrackMetadata,
  album: getAlbumMetadata,
  playlist: getPlaylistMetadata,
  artist: getArtistMetadata,
  episode: getEpisodeMetadata,
  show: getShowMetadata
};

function buildMetadata(type, entity) {
  const builder = METADATA_BUILDERS[type];
  if (!builder) {
    throw new SpotifyError(`Unsupported Spotify type: ${type}.`, {
      status: 400,
      code: "UNSUPPORTED_TYPE"
    });
  }
  return builder(entity);
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

async function lookup(input, options = {}) {
  const parsed = parseSpotifyInput(input);

  if (!parsed) {
    throw new SpotifyError(
      "Use a Spotify track, album, playlist, artist, episode, or show link.",
      { status: 400, code: "INVALID_URL" }
    );
  }

  const entity = await fetchEntity(parsed.type, parsed.id, options);
  const result = buildMetadata(parsed.type, entity);

  return { type: parsed.type, id: parsed.id, result, entity };
}

module.exports = {
  SUPPORTED_TYPES,
  SpotifyError,
  parseSpotifyInput,
  lookup,
  buildMetadata
};
