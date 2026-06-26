const SPORT_KEYS = {
  baseball: ["baseball_mlb"],
  soccer: ["soccer_usa_mls", "soccer_epl"]
};

export async function fetchPregameOdds({ apiKey, sports = ["baseball", "soccer"], regions = "us" }) {
  if (!apiKey) return [];
  const events = [];
  for (const sport of sports) {
    for (const key of SPORT_KEYS[sport] || []) {
      const url = new URL(`https://api.the-odds-api.com/v4/sports/${key}/odds`);
      url.searchParams.set("apiKey", apiKey);
      url.searchParams.set("regions", regions);
      url.searchParams.set("markets", "h2h");
      url.searchParams.set("oddsFormat", "american");
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Odds provider returned ${response.status}`);
      const payload = await response.json();
      events.push(...payload.map((item) => normalizeOddsEvent(item, sport)));
    }
  }
  return events.filter(Boolean);
}

function normalizeOddsEvent(item, sport) {
  const bookmaker = item.bookmakers?.[0];
  const market = bookmaker?.markets?.find((entry) => entry.key === "h2h");
  const outcomes = market?.outcomes || [];
  const away = outcomes.find((outcome) => outcome.name === item.away_team);
  const home = outcomes.find((outcome) => outcome.name === item.home_team);
  const draw = outcomes.find((outcome) => outcome.name?.toLowerCase() === "draw");
  if (!away || !home) return null;
  return {
    id: `odds_${item.id}`,
    week: null,
    sport,
    league: item.sport_title,
    awayTeam: item.away_team,
    homeTeam: item.home_team,
    startsAt: item.commence_time,
    market: "moneyline",
    awayOdds: formatAmerican(away.price),
    homeOdds: formatAmerican(home.price),
    drawOdds: draw ? formatAmerican(draw.price) : undefined,
    status: "open",
    source: bookmaker?.title || "The Odds API"
  };
}

function formatAmerican(price) {
  const value = Number(price);
  return value > 0 ? `+${value}` : String(value);
}
