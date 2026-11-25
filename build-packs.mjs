// Noor Quran pack builder — runs on GitHub Actions (Node 20+).
// Downloads Quran text, translations, word-by-word meanings and reciter timings
// from Quran.com and writes them as Noor Quran pack files.
//   dist/    -> uploaded to the "packs" release (the app downloads from here)
//   bundle/  -> copied inside the APK (works offline from first launch)
import fs from "node:fs/promises";

const API = process.env.NQ_API || "https://api.quran.com/api/v4";
const QDC = process.env.NQ_QDC || "https://api.qurancdn.com/api/qdc";
const CFG = JSON.parse(await fs.readFile(process.env.NQ_CONFIG || "packs-config.json", "utf8"));
const OUT = "dist", BUNDLE = "bundle";
await fs.mkdir(OUT, { recursive: true });
await fs.mkdir(BUNDLE, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url) {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "NoorQuranPackBuilder/1.0" } });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
      console.warn("HTTP", r.status, url);
    } catch (e) { console.warn("retry", url, e.message); }
    await sleep(1500 * (i + 1));
  }
  throw new Error("Failed: " + url);
}
async function pool(items, n, fn) {
  const res = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); }
  }));
  return res;
}
const clean = h => String(h || "").replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const today = new Date().toISOString().slice(0, 10);
const catalog = { app: "noor-quran", version: 2, generated: today, packs: [] };

async function writePack(manifest, data) {
  const txt = JSON.stringify({ manifest: { ...manifest, version: today }, data });
  await fs.writeFile(`${OUT}/${manifest.id}.json`, txt);
  if ((CFG.bundleInApp || []).includes(manifest.id)) await fs.writeFile(`${BUNDLE}/${manifest.id}.json`, txt);
  const { id, type, name, lang, author, reciter, style, words, audioBytes, script } = manifest;
  catalog.packs.push({ id, type, name, lang, author, reciter, style, words, audioBytes, script, bytes: Buffer.byteLength(txt), bundled: (CFG.bundleInApp || []).includes(id) });
  console.log("pack", id, (Buffer.byteLength(txt) / 1048576).toFixed(2) + " MB");
}

// ---------- chapters ----------
const chapters = (await get(`${API}/chapters?language=en`)).chapters;
let taNames = {};
try { (await get(`${API}/chapters?language=ta`)).chapters.forEach(c => taNames[c.id] = c.translated_name?.name); } catch (e) {}
const chIds = chapters.map(c => c.id);

// ---------- translations metadata ----------
const trMeta = {};
((await get(`${API}/resources/translations`))?.translations || []).forEach(t => trMeta[t.id] = t);
const trIds = (CFG.translations || []).filter(id => { if (!trMeta[id]) console.warn("translation id not found:", id); return trMeta[id]; });

// ---------- verse passes (one per word-by-word language; English pass also carries core text + translations) ----------
const wbwLangs = [...new Set(["en", ...(CFG.wordByWord || [])])];
const core = { chapters: [], verses: {} };
const trData = Object.fromEntries(trIds.map(id => [id, {}]));
const wbwData = {}, tlData = {}, indopak = {}, tajweed = {};

for (const L of wbwLangs) {
  wbwData[L] = {};
  console.log("verses pass:", L);
  await pool(chIds, 6, async ch => {
    let page = 1, total = 1;
    do {
      const tr = L === "en" && trIds.length ? `&translations=${trIds.join(",")}` : "";
      const d = await get(`${API}/verses/by_chapter/${ch}?language=${L}&words=true&word_fields=${L === "en" ? "text_uthmani,text_indopak,text_uthmani_tajweed,line_number,page_number,code_v1" : "text_uthmani"}&per_page=50&page=${page}${tr}`);
      for (const v of d.verses || []) {
        const words = (v.words || []).filter(w => w.char_type_name === "word");
        wbwData[L][v.verse_key] = words.map(w => w.translation?.text || "");
        if (L === "en") {
          tlData[v.verse_key] = words.map(w => w.transliteration?.text || "");
          indopak[v.verse_key] = words.map(w => w.text_indopak || w.text_uthmani);
          tajweed[v.verse_key] = words.map(w => w.text_uthmani_tajweed || w.text_uthmani);
          const pos = words.map(w => w.position);
          const item = { k: v.verse_key, w: words.map(w => w.text_uthmani), j: v.juz_number, pg: v.page_number, hz: v.hizb_number };
          const lns = words.map(w => w.line_number || 0); if (lns.some(Boolean)) item.ln = lns;
          const wps = words.map(w => w.page_number || v.page_number); if (wps.some(p => p !== v.page_number)) item.wp = wps;
          const c1 = words.map(w => w.code_v1 || ""); if (c1.some(Boolean)) item.c1 = c1;
          const endW = (v.words || []).find(w => w.char_type_name === "end");
          if (endW && endW.code_v1) { item.ce = endW.code_v1; item.el = endW.line_number || 0; if ((endW.page_number || v.page_number) !== (wps[wps.length - 1] || v.page_number)) item.ep = endW.page_number; }
          if (v.sajdah_number) item.sj = 1;
          if (pos.some((p, i) => p !== i + 1)) item.p = pos;
          (core.verses[ch] ||= []).push(item);
          for (const t of v.translations || []) if (trData[t.resource_id]) trData[t.resource_id][v.verse_key] = clean(t.text);
        }
      }
      total = d.pagination?.total_pages || 1; page++;
    } while (page <= total);
  });
}
for (const ch of chIds) core.verses[ch].sort((a, b) => +a.k.split(":")[1] - +b.k.split(":")[1]);
core.chapters = chapters.map(c => ({ id: c.id, n: c.name_simple, a: c.name_arabic, t: c.translated_name?.name || "", ta: taNames[c.id] || "", vc: c.verses_count, rp: c.revelation_place, bism: c.bismillah_pre !== false && c.id !== 1 && c.id !== 9 }));
const totalVerses = Object.values(core.verses).reduce((s, a) => s + a.length, 0);
console.log("core verses:", totalVerses);
if (totalVerses < 6236 && !process.env.NQ_API) throw new Error("Incomplete Quran text: " + totalVerses);
await fs.writeFile(`${BUNDLE}/core.json`, JSON.stringify(core));

// ---------- translation packs ----------
for (const id of trIds) {
  const m = trMeta[id];
  await writePack({ id: "tr-" + id, type: "translation", resource: id, name: m.name, author: m.author_name, lang: String(m.language_name).toLowerCase() }, trData[id]);
}
// ---------- word-by-word packs ----------
const LN = { ta: "tamil", en: "english", ur: "urdu", ml: "malayalam" };
for (const L of CFG.wordByWord || []) {
  const data = { m: wbwData[L] };
  if (L === "en") data.tl = tlData;
  await writePack({ id: "wbw-" + L, type: "wbw", name: "Word by word · " + (LN[L] || L), lang: LN[L] || L, wl: L }, data);
}

// ---------- script packs ----------
await writePack({ id: "script-tajweed", type: "script", name: "Tajweed colour (Uthmani)", lang: "arabic", script: "tajweed" }, tajweed);
await writePack({ id: "script-indopak", type: "script", name: "IndoPak script", lang: "arabic", script: "indopak" }, indopak);

// ---------- tafsir packs ----------
const tfMeta = {};
((await get(`${API}/resources/tafsirs`))?.tafsirs || []).forEach(t => tfMeta[t.id] = t);
const tafsirText = h => String(h || "")
  .replace(/<h\d[^>]*>/gi, "\n## ").replace(/<\/h\d>/gi, "\n")
  .replace(/<br\s*\/?>/gi, "\n").replace(/<\/?p[^>]*>/gi, "\n")
  .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
for (const id of CFG.tafsirs || []) {
  const m = tfMeta[id]; if (!m) { console.warn("tafsir id not found:", id); continue; }
  const data = {}; let prevKey = null, prevText = null;
  const perCh = await pool(chIds, 4, async ch => {
    const out = []; let page = 1, total = 1;
    do {
      const d = await get(`${API}/tafsirs/${id}/by_chapter/${ch}?per_page=50&page=${page}`);
      for (const t of d?.tafsirs || []) out.push([t.verse_key, tafsirText(t.text)]);
      total = d?.pagination?.total_pages || 1; page++;
    } while (page <= total);
    return out.sort((a, b) => +a[0].split(":")[1] - +b[0].split(":")[1]);
  });
  for (const list of perCh) for (const [k, txt] of list) {
    if (!txt) continue;
    if (txt === prevText) data[k] = "@" + prevKey; else { data[k] = txt; prevKey = k; prevText = txt; }
  }
  await writePack({ id: "tf-" + id, type: "tafsir", resource: id, name: m.name, author: m.author_name, lang: String(m.language_name).toLowerCase() }, data);
}

// ---------- reciter timing packs ----------
const reciters = (await get(`${QDC}/audio/reciters?locale=en`))?.reciters || [];
const wanted = CFG.reciters === "all" ? reciters : reciters.filter(r => (CFG.reciters || []).includes(r.id));
const order = {}; for (const ch of chIds) core.verses[ch].forEach((v, i) => order[v.k] = i);
for (const r of wanted) {
  const surahs = {}; let audioBytes = 0, wordsOk = false;
  await pool(chIds, 8, async ch => {
    const d = await get(`${QDC}/audio/reciters/${r.id}/audio_files?chapter=${ch}&segments=true`);
    const f = d?.audio_files?.[0]; if (!f) return;
    audioBytes += f.file_size || 0;
    const v = new Array(core.verses[ch].length).fill(null);
    for (const t of f.verse_timings || []) {
      if (!(t.verse_key in order)) continue;
      const segs = (t.segments || []).filter(s => Array.isArray(s) && s.length >= 3).map(s => [s[0], s[s.length - 2], s[s.length - 1]]);
      if (segs.some(s => s[0] === 0)) segs.forEach(s => s[0]++);
      if (segs.length) wordsOk = true;
      v[order[t.verse_key]] = [t.timestamp_from, t.timestamp_to, segs];
    }
    surahs[ch] = { u: f.audio_url, b: f.file_size || 0, v };
  });
  if (!Object.keys(surahs).length) { console.warn("no audio for reciter", r.id); continue; }
  const name = r.translated_name?.name || r.name;
  await writePack({ id: "tm-" + r.id, type: "timing", reciter: r.id, name, style: r.style?.name || "", words: wordsOk, audioBytes }, { surahs });
}

await fs.writeFile(`${OUT}/catalog.json`, JSON.stringify(catalog));
await fs.writeFile(`${BUNDLE}/catalog.json`, JSON.stringify(catalog));
console.log("done:", catalog.packs.length, "packs");
