// Holt die offiziellen Netflix-Top-10 für Deutschland (top10.netflix.com, wöchentlich)
// und ergänzt jeden Titel mit Poster, Hintergrund und Beschreibung von TMDB.
// Läuft täglich als GitHub-Job und schreibt netflix-de.json neben die Trailer-Seite.
// Aufruf:  TMDB_TOKEN=... node netflix-top10.mjs [lokale.tsv] [ausgabe.json]
import fs from "node:fs";

const TSV_URL = "https://www.netflix.com/tudum/top10/data/all-weeks-countries.tsv";
const OUT = process.argv[3] || "netflix-de.json";
const TOKEN = process.env.TMDB_TOKEN;
if (!TOKEN) { console.error("TMDB_TOKEN fehlt"); process.exit(1); }

async function tmdb(path, lang) {
  const r = await fetch("https://api.themoviedb.org/3" + path + (path.includes("?") ? "&" : "?") + "language=" + (lang || "de-DE"),
    { headers: { Authorization: "Bearer " + TOKEN, accept: "application/json" } });
  if (!r.ok) throw new Error("TMDB " + r.status + " " + path);
  return r.json();
}
const norm = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[’'"“”:!?.,–—-]/g, " ").replace(/\s+/g, " ").trim();

async function onNetflixDE(type, id) {
  try {
    const p = await tmdb(`/${type}/${id}/watch/providers`);
    return ((p.results && p.results.DE && p.results.DE.flatrate) || []).some(x => x.provider_id === 8);
  } catch (e) { return false; }
}

/* Passenden TMDB-Eintrag finden.
   Vorrang: erwartete Art (Film/Serie) mit exaktem Titel und laut TMDB auf Netflix DE;
   bei Neueinsteigern sonst der jüngste exakte Treffer (TMDB kennt die Netflix-Verfügbarkeit oft erst Tage später). */
async function match(title, prefer, weeks) {
  const other = prefer === "tv" ? "movie" : "tv", n = norm(title), cand = [];
  const fresh = d => d && (Date.now() - Date.parse(d)) < 400 * 86400000;
  for (const type of [prefer, other]) {
    const res = (await tmdb(`/search/${type}?query=${encodeURIComponent(title)}`, "en-US")).results || [];
    res.slice(0, 5).forEach((x, i) => {
      const date = x.release_date || x.first_air_date || "";
      cand.push({ type, x, i, date, pref: type === prefer, exact: [x.title, x.name, x.original_title, x.original_name].some(t => norm(t) === n) });
    });
  }
  const isNew = weeks <= 3;
  const tiers = [
    c => c.pref && c.exact,
    c => !c.pref && c.exact,
    c => c.pref && c.i < 2
  ];
  for (const tier of tiers) {
    const list = cand.filter(tier);
    if (!list.length) continue;
    for (const c of list.slice(0, 4)) if (await onNetflixDE(c.type, c.x.id)) return c;
    if (tier === tiers[2]) break;                       // Ähnliche Titel nur, wenn Netflix sie bestätigt
    if (isNew) { const nw = list.filter(c => fresh(c.date)).sort((a, b) => b.date.localeCompare(a.date)); if (nw.length) return nw[0]; continue; }
    return list[0];
  }
  return null;                                          // lieber eine Textkarte als ein falsches Poster
}

const raw = process.argv[2] ? fs.readFileSync(process.argv[2], "utf8") : await (await fetch(TSV_URL)).text();
const rows = raw.split("\n").slice(1).map(l => l.split("\t")).filter(c => c[1] === "DE");
if (!rows.length) { console.error("Keine Daten für Deutschland"); process.exit(1); }
const week = rows.map(c => c[2]).sort().pop();
const cur = rows.filter(c => c[2] === week);

const out = { source: "Netflix Top 10, Deutschland", week, updated: new Date().toISOString(), movie: [], tv: [] };
for (const [cat, key] of [["Films", "movie"], ["TV", "tv"]]) {
  const list = cur.filter(c => c[3] === cat).sort((a, b) => a[4] - b[4]);
  for (const c of list) {
    const rank = +c[4], title = c[5], weeks = +c[7];
    let m = null;
    try { m = await match(title, key, weeks); } catch (e) { console.error(e.message); }
    let x = m && m.x;
    if (x) { try { const de = await tmdb(`/${m.type}/${x.id}`); x = Object.assign({}, x, { title: de.title, name: de.name, overview: de.overview || x.overview, poster_path: de.poster_path || x.poster_path, backdrop_path: de.backdrop_path || x.backdrop_path, genre_ids: (de.genres || []).map(g => g.id) }); } catch (e) {} }
    out[key].push(x ? {
      id: x.id, type: m.type, title: x.title || x.name || title, date: x.release_date || x.first_air_date || "", rank, weeks,
      vote: x.vote_average, genres: x.genre_ids || [], overview: x.overview || "", backdrop: x.backdrop_path || "", poster: x.poster_path || "", prov: 8
    } : { id: 0, type: key, title, date: "", rank, weeks, vote: 0, genres: [], overview: "", backdrop: "", poster: "", prov: 8 });
    console.log(key, rank, title, "→", x ? (x.title || x.name) + " (" + m.type + " " + x.id + ")" : "kein Treffer");
  }
}
fs.writeFileSync(OUT, JSON.stringify(out));
console.log("Woche", week, "geschrieben nach", OUT);
