import https from "https";

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const YOUTUBE_API_BASE = "www.googleapis.com";

export interface YouTubeVideo {
  videoId: string;
  title: string;
  thumbnail: string;
  duration: string;
  channelTitle: string;
  publishedAt: string;
}

interface YouTubeSearchItem {
  id: { videoId: string };
  snippet: {
    title: string;
    thumbnails: { default?: { url: string }; medium?: { url: string }; high?: { url: string } };
    channelTitle: string;
    publishedAt: string;
  };
}

interface YouTubeVideoDetails {
  id: string;
  contentDetails: { duration: string };
}

type RankedVideo = YouTubeVideo & { __score: number; __idx: number };

const TITLE_STRONG_KEYWORDS = [
  "karaoke version",
  "lyric video",
  "with lyrics",
  "minus one",
  "노래방",
] as const;

const TITLE_MEDIUM_KEYWORDS = [
  "karaoke",
  "lyrics",
  "instrumental",
  "no vocals",
  "가사",
] as const;

const CHANNEL_KEYWORDS = [
  "official karaoke",
  "karaoke",
  "lyrics",
  "노래방",
] as const;

function parseDuration(isoDuration: string): string {
  const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return "0:00";
  const hours = parseInt(match[1] || "0");
  const minutes = parseInt(match[2] || "0");
  const seconds = parseInt(match[3] || "0");
  if (hours > 0) return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function includesAny(text: string, keywords: readonly string[]): boolean {
  return keywords.some((k) => text.includes(k));
}

function scoreSingingReadiness(video: YouTubeVideo): number {
  const title = video.title.toLowerCase();
  const channel = video.channelTitle.toLowerCase();
  let score = 0;

  // Strong title phrases usually indicate karaoke-ready assets.
  if (includesAny(title, TITLE_STRONG_KEYWORDS)) score += 12;

  // Medium title phrases still correlate with sing-along usability.
  if (includesAny(title, TITLE_MEDIUM_KEYWORDS)) score += 7;

  // Channel hints are useful but weaker than explicit title hints.
  if (includesAny(channel, CHANNEL_KEYWORDS)) score += 5;

  // Extra boost when both title and channel look karaoke/lyrics-focused.
  if (score >= 12 && includesAny(channel, CHANNEL_KEYWORDS)) score += 3;

  return score;
}

function makeRequest<T>(path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: YOUTUBE_API_BASE,
      path,
      method: "GET",
      headers: { Accept: "application/json" },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.error) reject(new Error(json.error.message || "YouTube API error"));
          else resolve(json);
        } catch (e) { reject(new Error("Failed to parse response")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Request timeout")); });
    req.end();
  });
}

export async function searchYouTube(query: string): Promise<YouTubeVideo[]> {
  if (!YOUTUBE_API_KEY) {
    console.warn("YOUTUBE_API_KEY not set, returning mock data");
    return getMockResults(query);
  }
  try {
    const searchPath = `/youtube/v3/search?part=snippet&type=video&maxResults=10&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}`;
    const searchData = await makeRequest<{ items: YouTubeSearchItem[] }>(searchPath);
    if (!searchData.items?.length) return [];
    const videoIds = searchData.items.map((item) => item.id.videoId).join(",");
    const detailsPath = `/youtube/v3/videos?part=contentDetails&id=${videoIds}&key=${YOUTUBE_API_KEY}`;
    const detailsData = await makeRequest<{ items: YouTubeVideoDetails[] }>(detailsPath);
    const durationMap = new Map<string, string>();
    detailsData.items?.forEach((item) => durationMap.set(item.id, parseDuration(item.contentDetails.duration)));
    const mapped = searchData.items.map((item) => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      thumbnail: item.snippet.thumbnails.medium?.url || item.snippet.thumbnails.default?.url || "",
      duration: durationMap.get(item.id.videoId) || "0:00",
      channelTitle: item.snippet.channelTitle,
      publishedAt: item.snippet.publishedAt,
    }));

    // Reorder by lightweight singing-readiness score without dropping any result.
    const ranked: RankedVideo[] = mapped.map((v, idx) => ({
      ...v,
      __score: scoreSingingReadiness(v),
      __idx: idx,
    }));

    ranked.sort((a, b) => {
      if (b.__score !== a.__score) return b.__score - a.__score;
      return a.__idx - b.__idx; // preserve API relevance order when score ties
    });

    return ranked.map(({ __score: _score, __idx: _idx, ...video }) => video);
  } catch (error) {
    console.error("YouTube API error:", error);
    return getMockResults(query);
  }
}

function getMockResults(query: string): YouTubeVideo[] {
  return [
    { videoId: "mock1", title: `${query} - Official Music Video`, thumbnail: "https://i.ytimg.com/vi/mock1/mqdefault.jpg", duration: "4:32", channelTitle: "Official Artist Channel", publishedAt: new Date().toISOString() },
    { videoId: "mock2", title: `${query} (Lyrics)`, thumbnail: "https://i.ytimg.com/vi/mock2/mqdefault.jpg", duration: "4:15", channelTitle: "Lyrics Channel", publishedAt: new Date().toISOString() },
    { videoId: "mock3", title: `${query} - Live Performance`, thumbnail: "https://i.ytimg.com/vi/mock3/mqdefault.jpg", duration: "5:20", channelTitle: "Live Music", publishedAt: new Date().toISOString() },
    { videoId: "mock4", title: `${query} (Karaoke Version)`, thumbnail: "https://i.ytimg.com/vi/mock4/mqdefault.jpg", duration: "4:45", channelTitle: "Karaoke Hits", publishedAt: new Date().toISOString() },
    { videoId: "mock5", title: `${query} - Acoustic Cover`, thumbnail: "https://i.ytimg.com/vi/mock5/mqdefault.jpg", duration: "3:55", channelTitle: "Acoustic Sessions", publishedAt: new Date().toISOString() },
  ];
}
