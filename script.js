const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const DUBAI_TIMEZONE = "Asia/Dubai";

const CHANNEL = {
  name: "Sentinel Desk 24",
  summary: "A live cyber news desk that blends free public feeds into a command-center dashboard and refreshes every hour.",
  reporters: ["Nadia Voss", "Mika Rahman", "Iris Solano", "Theo Mercer", "Leila Noor", "Jonah Vale"]
};

const RSS_FEEDS = [
  {
    name: "BleepingComputer",
    url: "https://www.bleepingcomputer.com/feed/",
    type: "rss",
    tone: "Operations Desk"
  },
  {
    name: "CISA Alerts",
    url: "https://www.cisa.gov/cybersecurity-advisories/alerts.xml",
    type: "rss",
    tone: "Federal Desk"
  },
  {
    name: "Microsoft Security",
    url: "https://api.msrc.microsoft.com/update-guide/rss",
    type: "rss",
    tone: "Patch Desk"
  }
];

const JSON_FEEDS = [
  {
    name: "Reddit r/cybersecurity",
    url: "https://www.reddit.com/r/cybersecurity/new.json?limit=12",
    type: "reddit",
    tone: "Community Desk"
  },
  {
    name: "Reddit r/netsec",
    url: "https://www.reddit.com/r/netsec/new.json?limit=12",
    type: "reddit",
    tone: "Research Desk"
  }
];

const FALLBACK_STORIES = [
  {
    title: "Live feed unavailable: check your connection or CORS proxy status",
    link: "#",
    description: "The dashboard uses free public feeds and a public proxy to read RSS in the browser. If those sources are blocked, the page cannot refresh live headlines.",
    publishedAt: new Date().toISOString(),
    sourceName: "Dashboard Notice",
    desk: "Status Desk"
  }
];

let refreshTimer = null;
let countdownTimer = null;
let lastRefreshAt = null;
let sourceStatuses = [];

const keywordGroups = {
  attack: ["attack", "ransomware", "malware", "phishing", "breach", "botnet", "spyware", "backdoor", "exploit", "zero-day", "wiper", "hijack", "stolen", "compromise", "outage"],
  response: ["patch", "fix", "fixed", "mitigation", "mitigate", "guidance", "warning", "warns", "advisory", "recovery", "recover", "restored", "restores", "reopens", "charged", "arrest", "seized", "takedown", "disrupt", "disrupted"],
  vulnerability: ["cve", "vulnerability", "kev", "security update", "patch tuesday", "critical flaw"],
  government: ["cisa", "fbi", "government", "agency", "federal"]
};

function proxiedUrl(url) {
  return `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: DUBAI_TIMEZONE
  }).format(value);
}

function formatDay(value) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeZone: DUBAI_TIMEZONE
  }).format(value);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toDate(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function isSameDubaiDay(left, right) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: DUBAI_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return fmt.format(left) === fmt.format(right);
}

function includesKeyword(text, group) {
  const source = text.toLowerCase();
  return keywordGroups[group].some((keyword) => source.includes(keyword));
}

function inferSeverity(item) {
  const text = `${item.title} ${item.description}`.toLowerCase();
  if (text.includes("critical") || text.includes("zero-day") || text.includes("ransomware")) {
    return "Critical";
  }
  if (includesKeyword(text, "attack") || includesKeyword(text, "vulnerability")) {
    return "High";
  }
  return "Medium";
}

function inferDesk(item) {
  const text = `${item.title} ${item.description}`.toLowerCase();
  if (includesKeyword(text, "government")) {
    return "Federal Desk";
  }
  if (includesKeyword(text, "response")) {
    return "Response Desk";
  }
  if (includesKeyword(text, "vulnerability")) {
    return "Patch Desk";
  }
  if (text.includes("reddit")) {
    return "Community Desk";
  }
  return item.desk || "Threat Desk";
}

function pickReporter(seed) {
  let total = 0;
  for (const char of seed) {
    total += char.charCodeAt(0);
  }
  return CHANNEL.reporters[total % CHANNEL.reporters.length];
}

function dedupeStories(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.title.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function fetchRssFeed(feed) {
  const response = await fetch(proxiedUrl(feed.url));
  if (!response.ok) {
    throw new Error(`Feed error ${response.status}`);
  }

  const xmlText = await response.text();
  const documentXml = new DOMParser().parseFromString(xmlText, "text/xml");
  const items = Array.from(documentXml.querySelectorAll("item"));

  return items.slice(0, 16).map((item) => ({
    title: normalizeText(item.querySelector("title")?.textContent),
    link: normalizeText(item.querySelector("link")?.textContent),
    description: normalizeText(item.querySelector("description")?.textContent),
    publishedAt: toDate(
      item.querySelector("pubDate")?.textContent ||
      item.querySelector("dc\\:date")?.textContent ||
      item.querySelector("published")?.textContent
    ).toISOString(),
    sourceName: feed.name,
    desk: feed.tone
  })).filter((item) => item.title && item.link);
}

async function fetchRedditFeed(feed) {
  const response = await fetch(proxiedUrl(feed.url));
  if (!response.ok) {
    throw new Error(`Feed error ${response.status}`);
  }

  const payload = JSON.parse(await response.text());
  const children = payload?.data?.children ?? [];

  return children.slice(0, 12).map(({ data }) => ({
    title: normalizeText(data.title),
    link: `https://www.reddit.com${data.permalink}`,
    description: normalizeText(data.selftext || `Community post score ${data.score} in ${feed.name}.`),
    publishedAt: new Date(data.created_utc * 1000).toISOString(),
    sourceName: feed.name,
    desk: feed.tone
  })).filter((item) => item.title && item.link);
}

async function collectStories() {
  const feedJobs = [
    ...RSS_FEEDS.map((feed) => ({ feed, loader: fetchRssFeed })),
    ...JSON_FEEDS.map((feed) => ({ feed, loader: fetchRedditFeed }))
  ];

  const results = await Promise.allSettled(
    feedJobs.map(async ({ feed, loader }) => ({
      feed,
      items: await loader(feed)
    }))
  );

  sourceStatuses = results.map((result, index) => {
    const source = feedJobs[index].feed.name;
    return {
      source,
      ok: result.status === "fulfilled",
      count: result.status === "fulfilled" ? result.value.items.length : 0,
      message: result.status === "fulfilled" ? "Live" : "Unavailable"
    };
  });

  const items = results
    .filter((result) => result.status === "fulfilled")
    .flatMap((result) => result.value.items);

  const sorted = dedupeStories(items).sort((left, right) => {
    return new Date(right.publishedAt).getTime() - new Date(left.publishedAt).getTime();
  });

  return sorted.length ? sorted : FALLBACK_STORIES;
}

function renderHeader() {
  document.getElementById("channel-name").textContent = CHANNEL.name;
  document.getElementById("channel-summary").textContent = CHANNEL.summary;
  document.getElementById("lead-reporter").textContent = CHANNEL.reporters[0];
  document.getElementById("live-date").textContent = formatDay(new Date());
}

function renderMetrics(stories) {
  const attackCount = stories.filter((item) => includesKeyword(`${item.title} ${item.description}`, "attack")).length;
  const todayCount = stories.filter((item) => isSameDubaiDay(new Date(item.publishedAt), new Date())).length;
  const responseCount = stories.filter((item) => includesKeyword(`${item.title} ${item.description}`, "response")).length;
  const liveSources = sourceStatuses.filter((item) => item.ok).length;

  const metrics = [
    {
      kicker: "Stories loaded",
      value: String(stories.length),
      detail: "Combined from free public cybersecurity feeds and community sources.",
      tone: "signal"
    },
    {
      kicker: "Attack-related items",
      value: String(attackCount),
      detail: "Headlines with attack, breach, ransomware, phishing, exploit, or malware signals.",
      tone: "alert"
    },
    {
      kicker: "Published today",
      value: String(todayCount),
      detail: "Stories dated today in the Asia/Dubai timezone view.",
      tone: "warn"
    },
    {
      kicker: "Sources online",
      value: `${liveSources}/${sourceStatuses.length}`,
      detail: "Feed health across public sources powering the dashboard.",
      tone: "signal"
    }
  ];

  const container = document.getElementById("metrics");
  container.innerHTML = metrics.map((metric) => `
    <article class="metric-card metric-tone-${metric.tone}">
      <p class="section-kicker">${escapeHtml(metric.kicker)}</p>
      <strong class="metric-value">${escapeHtml(metric.value)}</strong>
      <p>${escapeHtml(metric.detail)}</p>
    </article>
  `).join("");

  document.getElementById("channel-status").textContent = responseCount > 0 ? "Feeds active" : "Monitoring";
}

function renderOngoingAttacks(stories) {
  const attackStories = stories
    .filter((item) => includesKeyword(`${item.title} ${item.description}`, "attack"))
    .slice(0, 6);

  const container = document.getElementById("ongoing-attacks");
  if (!attackStories.length) {
    container.innerHTML = '<div class="empty-state">No attack-tagged stories are available right now from the connected free feeds.</div>';
    return;
  }

  container.innerHTML = attackStories.map((item) => `
    <article class="story">
      <div class="story-meta">
        <span>${escapeHtml(inferDesk(item))}</span>
        <span>${escapeHtml(inferSeverity(item))}</span>
      </div>
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.description || "Open the source for the full incident summary.")}</p>
      <div class="story-footer">
        <span>${escapeHtml(formatDateTime(new Date(item.publishedAt)))}</span>
        <a href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer">${escapeHtml(item.sourceName)}</a>
      </div>
    </article>
  `).join("");
}

function renderTodayAttacks(stories) {
  const todayItems = stories
    .filter((item) => isSameDubaiDay(new Date(item.publishedAt), new Date()))
    .filter((item) => includesKeyword(`${item.title} ${item.description}`, "attack"))
    .slice(0, 5);

  const container = document.getElementById("today-attacks");
  if (!todayItems.length) {
    container.innerHTML = '<div class="empty-state">No attack-specific stories have been published yet today in the connected feeds.</div>';
    return;
  }

  container.innerHTML = todayItems.map((item) => `
    <article class="timeline-item">
      <span class="timeline-date">${escapeHtml(formatDateTime(new Date(item.publishedAt)))}</span>
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.description || "Open the linked report for full details.")}</p>
      <div class="story-footer">
        <span></span>
        <a href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer">${escapeHtml(item.sourceName)}</a>
      </div>
    </article>
  `).join("");
}

function renderNews(stories) {
  const latest = stories.slice(0, 6);
  const container = document.getElementById("news-rundown");

  container.innerHTML = latest.map((item) => `
    <article class="news-card">
      <span class="news-strip">${escapeHtml(inferDesk(item))}</span>
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.description || "Open the article for the full report.")}</p>
      <div class="news-footer">
        <span>Reporter: ${escapeHtml(pickReporter(item.title))}</span>
        <a href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer">${escapeHtml(item.sourceName)}</a>
      </div>
    </article>
  `).join("");
}

function renderResponses(stories) {
  const items = stories
    .filter((item) => includesKeyword(`${item.title} ${item.description}`, "response"))
    .slice(0, 4);

  const container = document.getElementById("defender-actions");
  if (!items.length) {
    container.innerHTML = '<div class="empty-state">No clear response or recovery items are available right now from the live sources.</div>';
    return;
  }

  container.innerHTML = items.map((item) => `
    <article class="response-item">
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.description || "This item suggests an active defensive action, patch, or disruption update.")}</p>
      <ul>
        <li>Source: ${escapeHtml(item.sourceName)}</li>
        <li>Reporter: ${escapeHtml(pickReporter(item.title))}</li>
        <li>Published: ${escapeHtml(formatDateTime(new Date(item.publishedAt)))}</li>
      </ul>
    </article>
  `).join("");
}

function renderSources() {
  const container = document.getElementById("sources");
  container.innerHTML = sourceStatuses.map((source) => `
    <article class="source-item">
      <span class="source-domain">${escapeHtml(source.source)}</span>
      <h3>${source.ok ? "Feed connected" : "Feed unavailable"}</h3>
      <p>${escapeHtml(source.message)}. ${escapeHtml(source.count)} items returned on the most recent refresh.</p>
      <footer>
        <span>${source.ok ? "Using live feed data" : "Check again on the next refresh"}</span>
        <span>${source.ok ? "Online" : "Offline"}</span>
      </footer>
    </article>
  `).join("");
}

function updateRefreshClock() {
  if (!lastRefreshAt) {
    return;
  }

  const nextRefreshAt = new Date(lastRefreshAt.getTime() + REFRESH_INTERVAL_MS);
  const diffMs = nextRefreshAt.getTime() - Date.now();
  const nextNode = document.getElementById("next-refresh");

  if (diffMs <= 0) {
    nextNode.textContent = "Refreshing soon";
    return;
  }

  const minutes = Math.ceil(diffMs / 60000);
  if (minutes >= 60) {
    nextNode.textContent = "In 1 hour";
    return;
  }

  nextNode.textContent = `In ${minutes} min`;
}

async function refreshDashboard() {
  const refreshButton = document.getElementById("refresh-button");
  refreshButton.disabled = true;
  refreshButton.textContent = "Refreshing...";

  try {
    const stories = await collectStories();
    lastRefreshAt = new Date();
    document.getElementById("last-refresh").textContent = formatDateTime(lastRefreshAt);

    renderMetrics(stories);
    renderOngoingAttacks(stories);
    renderTodayAttacks(stories);
    renderNews(stories);
    renderResponses(stories);
    renderSources();
    updateRefreshClock();
  } catch (error) {
    sourceStatuses = [{ source: "Dashboard", ok: false, count: 0, message: "Refresh failed" }];
    renderMetrics(FALLBACK_STORIES);
    renderOngoingAttacks(FALLBACK_STORIES);
    renderTodayAttacks(FALLBACK_STORIES);
    renderNews(FALLBACK_STORIES);
    renderResponses(FALLBACK_STORIES);
    renderSources();
    document.getElementById("last-refresh").textContent = "Refresh failed";
    document.getElementById("next-refresh").textContent = "Retry on next interval";
    document.getElementById("channel-status").textContent = "Feed issue";
    console.error(error);
  } finally {
    refreshButton.disabled = false;
    refreshButton.textContent = "Refresh now";
  }
}

function startAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  if (countdownTimer) {
    clearInterval(countdownTimer);
  }

  refreshTimer = setInterval(refreshDashboard, REFRESH_INTERVAL_MS);
  countdownTimer = setInterval(updateRefreshClock, 60000);
}

function init() {
  renderHeader();
  document.getElementById("refresh-button").addEventListener("click", refreshDashboard);
  refreshDashboard();
  startAutoRefresh();
}

init();
