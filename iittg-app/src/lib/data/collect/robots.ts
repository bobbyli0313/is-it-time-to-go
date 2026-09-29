/**
 * robots.txt: fetch it, parse it, obey it.
 *
 * The collector asks the endpoint's own policy before every path, and reports a
 * refusal as a *named* failure that quotes the rule. For a website that is what keeps
 * the collector welcome; for an API host it is usually a 404 and a no-op, which is
 * why the contract behind the API — not this file — is what governs the data.
 *
 * Matching follows RFC 9309 / Google's published rules:
 *   - the most specific matching `User-agent` group wins, `*` is the fallback
 *   - `*` matches any run of characters, `$` anchors the end
 *   - the longest matching pattern wins, and `Allow` wins a tie
 *   - `Crawl-delay` is honoured when present (it is non-standard but widely
 *     published, and ignoring a site's stated rate limit is exactly the
 *     behaviour this module is meant to avoid)
 */

import type { FetchFn } from "./types";

export interface RobotsGroup {
  userAgents: string[];
  rules: Array<{ type: "allow" | "disallow"; pattern: string }>;
  crawlDelaySeconds?: number;
}

export interface RobotsFile {
  groups: RobotsGroup[];
  /** Empty when the file could not be read; the gate then fails open, per RFC. */
  fetchedAt: string;
  status: number | null;
}

/**
 * Parses the subset of robots.txt that matters here.
 *
 * Unknown directives are ignored rather than rejected: real files contain
 * `Sitemap`, `Host`, `Clean-param` and vendor extensions, and a parser that
 * refuses them would fail on most of the sites this app talks to.
 */
export function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  /** A `User-agent` line after rules starts a NEW group, not an addition. */
  let acceptingAgents = true;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;

    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      if (!acceptingAgents || current === null) {
        current = { userAgents: [], rules: [] };
        groups.push(current);
        acceptingAgents = true;
      }
      current.userAgents.push(value.toLowerCase());
      continue;
    }

    if (current === null) continue;

    if (field === "disallow" || field === "allow") {
      acceptingAgents = false;
      // "Disallow:" with an empty value means "nothing is disallowed".
      if (value === "" && field === "disallow") continue;
      current.rules.push({ type: field, pattern: value });
      continue;
    }

    if (field === "crawl-delay") {
      acceptingAgents = false;
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds) && seconds >= 0) {
        current.crawlDelaySeconds = seconds;
      }
    }
  }

  return groups;
}

/**
 * Picks the group that applies to `userAgent`.
 *
 * Specificity is by length of the matched product token, which is how the spec's
 * "most specific match" is conventionally implemented.
 */
export function selectGroup(
  groups: RobotsGroup[],
  userAgent: string,
): RobotsGroup | null {
  const product = userAgent.split(/[ /]/)[0].toLowerCase();
  let best: RobotsGroup | null = null;
  let bestScore = -1;

  for (const group of groups) {
    for (const agent of group.userAgents) {
      let score: number;
      if (agent === "*") score = 0;
      else if (product.includes(agent)) score = agent.length;
      else continue;
      if (score > bestScore) {
        best = group;
        bestScore = score;
      }
    }
  }

  return best;
}

/** Converts a robots pattern (`*`, `$`) into an anchored regular expression. */
function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`);
}

/**
 * Longest-match-wins, `Allow` breaks ties — the rule order in the file is
 * explicitly NOT significant, which is the most common way a hand-rolled
 * robots checker gets a site wrong.
 */
export function isAllowed(
  group: RobotsGroup | null,
  pathWithQuery: string,
): { allowed: true } | { allowed: false; rule: string } {
  if (!group) return { allowed: true };

  let winner: { type: "allow" | "disallow"; pattern: string } | null = null;
  let winnerLength = -1;

  for (const rule of group.rules) {
    if (!patternToRegex(rule.pattern).test(pathWithQuery)) continue;
    const length = rule.pattern.replace(/\$$/, "").length;
    if (length > winnerLength) {
      winner = rule;
      winnerLength = length;
    } else if (length === winnerLength && rule.type === "allow" && winner) {
      winner = rule;
    }
  }

  if (!winner || winner.type === "allow") return { allowed: true };
  return { allowed: false, rule: `Disallow: ${winner.pattern}` };
}

/**
 * Per-host robots cache.
 *
 * One fetch per host per run: robots.txt is fetched once, then answers every
 * later path question for that host, including the crawl delay the collector
 * uses to space its requests.
 */
export class RobotsCache {
  private readonly files = new Map<string, Promise<RobotsFile>>();
  private readonly fetchFn: FetchFn;
  private readonly userAgent: string;
  private readonly log: (message: string) => void;

  constructor(
    fetchFn: FetchFn,
    userAgent: string,
    log: (message: string) => void = () => {},
  ) {
    this.fetchFn = fetchFn;
    this.userAgent = userAgent;
    this.log = log;
  }

  async load(origin: string): Promise<RobotsFile> {
    const cached = this.files.get(origin);
    if (cached) return cached;

    const pending = this.fetchRobots(origin);
    this.files.set(origin, pending);
    return pending;
  }

  private async fetchRobots(origin: string): Promise<RobotsFile> {
    const url = `${origin}/robots.txt`;
    try {
      const response = await this.fetchFn({ url });
      // A missing robots.txt means no restrictions (RFC 9309 §2.3.1.3). A 5xx
      // means "unknown" and the spec says to treat it as no restrictions too;
      // the caller sees the status and can choose to be stricter.
      if (response.status >= 400) {
        return { groups: [], fetchedAt: new Date().toISOString(), status: response.status };
      }
      return {
        groups: parseRobots(response.body),
        fetchedAt: new Date().toISOString(),
        status: response.status,
      };
    } catch (error) {
      this.log(`robots.txt unavailable for ${origin}: ${String(error)}`);
      return { groups: [], fetchedAt: new Date().toISOString(), status: null };
    }
  }

  /** The gate adapters receive: an allow/deny answer plus the rule that decided it. */
  gate(): {
    check(url: string): Promise<{ allowed: true } | { allowed: false; rule: string }>;
    crawlDelayMs(origin: string): Promise<number | null>;
  } {
    return {
      check: async (url: string) => {
        const parsed = new URL(url);
        const file = await this.load(parsed.origin);
        const group = selectGroup(file.groups, this.userAgent);
        return isAllowed(group, `${parsed.pathname}${parsed.search}`);
      },
      crawlDelayMs: async (url: string) => {
        const parsed = new URL(url);
        const file = await this.load(parsed.origin);
        const group = selectGroup(file.groups, this.userAgent);
        return group?.crawlDelaySeconds !== undefined
          ? group.crawlDelaySeconds * 1000
          : null;
      },
    };
  }
}
