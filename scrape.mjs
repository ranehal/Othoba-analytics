import fs from "fs";
import path from "path";
import { Api, BASE, IMG } from "./api.mjs";

const ROOT = import.meta.dirname;
const DATA = path.join(ROOT, "data");
const DAILY = path.join(DATA, "daily");
const STATE = path.join(DATA, "state");

const DAY = new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 10); // Asia/Dhaka day
const ARGS = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v = "true"] = a.split("=");
  return [k.replace(/^--/, ""), v];
}));
const SCOPE = ARGS.scope === "full" ? "full" : "featured";
const QUIET = ARGS.quiet === "true";
const CONCURRENCY = Number(ARGS.concurrency || 6);
// pages per category: featured caps at 5 (≈200 products/category) for a fast daily run;
// full defaults to unlimited (entire shop). Override with --pages=N (0 = unlimited).
const CAT_PAGES = Number(ARGS.pages ?? (SCOPE === "full" ? 0 : 5));

const api = new Api({ concurrency: CONCURRENCY, quiet: QUIET });

const cat = (v) => String(v ?? "").trim();
const num = (v) => Math.round(Number(v) || 0);
const imgOf = (f) => (f ? `${IMG}/${cat(f)}` : "");
const slugOf = (u) => cat(u).split("/").filter(Boolean).pop();

const products = new Map();   // id -> record
const sections = [];          // meta sections
const sectionRefs = {};       // section id -> {productIds:Set}

const readJson = (f, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; }
};
const writeJson = (f, obj) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(obj));
};

function addProduct(rec, secId) {
  const id = rec.i;
  let cur = products.get(id);
  if (!cur) {
    cur = { ...rec, sec: [] };
    products.set(id, cur);
  } else {
    if (rec._cat) { cur.c = rec.c; cur.t = rec.t; cur.sc = rec.sc; }   // category path wins
    if (!cur.n) cur.n = rec.n;
    if (!cur.img) cur.img = rec.img;
    if (!cur.p) { cur.p = rec.p; cur.m = rec.m; cur.d = rec.d; cur.st = rec.st; }
    if (rec.fs) cur.fs = true;
    if (rec.rt > cur.rt) { cur.rt = rec.rt; cur.rc = rec.rc; }
  }
  if (secId && !cur.sec.includes(secId)) cur.sec.push(secId);
}

function pushSection(s) {
  s.productIds = [...new Set(s.productIds.map(Number))];
  s.count = s.productIds.length;
  sections.push(s);
  sectionRefs[s.id] = { productIds: s.productIds };
}

// ---------------------------------------------------------------------------
// 1. Category tree
// ---------------------------------------------------------------------------
async function fetchTree() {
  const j = await api.getJson("/product/api/v1/category/tree-v2");
  const tree = j.data || [];
  const byLink = new Map();
  const leaves = [];
  const metaCats = [];
  const walk = (arr, parent) => {
    for (const n of arr) {
      const node = { id: n.id, name: cat(n.name), slug: cat(n.link), icon: cat(n.icon), parent, children: [] };
      byLink.set(node.slug, node);
      metaCats.push(node);
      if (n.children && n.children.length) walk(n.children, n.id);
      else leaves.push(node);
    }
  };
  walk(tree, 0);
  for (const n of metaCats) if (n.parent) byLink.get(String(n.parent))?.children.push(n.id);
  return { tree, leaves, byLink };
}

// ---------------------------------------------------------------------------
// 2. Home page: channels + mega/offer/pop section slugs
// ---------------------------------------------------------------------------
async function fetchHome() {
  const j = await api.getJson("/product/api/v1/homepage-layouts/get-home-page-temp-data");
  const init = j?.data?.init || {};
  const channels = (init.categories_channels || [])
    .map((c) => ({ name: cat(c.name), slug: slugOf(c.target), image: cat(c.image_url) }))
    .filter((c) => c.slug && c.slug !== "home");
  const collectTargets = (arr) => (arr || [])
    .map((o) => ({ slug: slugOf(o.target), image: cat(o.image_url), text: cat(o.text) }))
    .filter((o) => o.slug);
  return { channels, mega: collectTargets(init.mega_deals), offers: collectTargets(init.offers_channels), pop: collectTargets(init.pop_layers) };
}

// ---------------------------------------------------------------------------
// 3. Flash sale
// ---------------------------------------------------------------------------
async function fetchFlash() {
  const cfg = await api.getJson("/product/api/v1/homepage-layouts/get-flash-sale-layouts-config");
  for (const c of cfg?.data || []) {
    const campaignId = c.campaignId;
    if (!campaignId) continue;
    const all = await api.paginate({
      urlFor: (p) => `/product/api/v1/flash-sales/get-all-product-list?currentPage=${p}&rowsPerPage=20&sorting=0&sns_seed_data=`,
      pageInfo: (j) => j?.data?.pageInfo,
      items: (j) => j?.data?.items || [],
      label: `flash products (${cat(c.title)}#${campaignId})`,
    });
    const home = (await api.getJson(`/product/api/v1/flash-sales/get-homepage-product-list/${campaignId}`))?.data || [];
    const sec = { id: `flash-${campaignId}`, type: "flash", name: cat(c.title) || "Flash Sale", campaignId, image: imgOf(c.bannerFilePath), productIds: [] };
    for (const it of [...all, ...home]) {
      const rec = normalizeFlash(it);
      if (!rec) continue;
      sec.productIds.push(rec.i);
      addProduct({ ...rec, c: "Flash Sale", t: "Flash Sale", sc: "Flash Sale" }, sec.id);
    }
    pushSection(sec);
  }
}

// ---------------------------------------------------------------------------
// 4. Builder (mega) pages
// ---------------------------------------------------------------------------
async function fetchBuilderPage(slug, label) {
  let j;
  try {
    j = await api.getJson(`/product/api/v1/static-builder-pages/sbp/seg/page-builder-details/get-builder-page-details-v2/${slug}`);
  } catch {
    if (!QUIET) console.log(`  skip builder page (not found): ${slug}`);
    return null;
  }
  const d = j?.data;
  if (!d) return null;
  const sec = { id: `mega-${slug}`, type: "mega", name: cat(d.name) || label || cat(d.slug), slug, image: "", productIds: [] };
  const cols = (d.rows || []).flatMap((r) => (r.columns || []));
  const topBanner = cols.find((c) => c.topBanners?.length)?.topBanners?.[0];
  const bcol = cols.find((c) => c.banners?.length)?.banners?.[0];
  sec.image = imgOf(topBanner?.appBannerUrl || topBanner?.desktopBannerUrl || bcol?.bannerFile || d.thumbnail);
  const prodCols = cols.filter((c) => c.contentType === "Product").map((c) => c.id);
  for (const colId of prodCols) {
    const items = await api.paginate({
      urlFor: (p) => `/product/api/v1/static-builder-pages/sbp/seg/page-builder-details/get-static-builder-page-products-info-v2?builder_column_id=${colId}&sns_seed_data=&current_page=${p}&rowsPerPage=20`,
      pageInfo: (j) => j?.data?.pageInfo,
      items: (j) => j?.data?.items || [],
      label: `builder ${slug} col ${colId}`,
    });
    for (const it of items) {
      const rec = normalizeBuilder(it);
      if (!rec) continue;
      sec.productIds.push(rec.i);
      addProduct({ ...rec, c: sec.name, t: sec.name, sc: sec.name }, sec.id);
    }
  }
  pushSection(sec);
  return sec;
}

// ---------------------------------------------------------------------------
// 5. Category products
// ---------------------------------------------------------------------------
async function fetchCategory(node, pathName) {
  const items = await api.paginate({
    urlFor: (p) => `/product/api/v1/product/product-stock/get-category-slug-wise/${node.slug}?currentPage=${p}&statusId=1&rowsPerPage=40`,
    pageInfo: (j) => j?.data?.pageInfo,
    items: (j) => j?.data?.items || [],
    maxPages: CAT_PAGES,
    label: `category ${node.slug} (${pathName})`,
  });
  for (const it of items) {
    const rec = normalizeCategory(it, pathName, node.name);
    if (rec) addProduct(rec);
  }
}

async function fetchPersonalize() {
  const items = await api.paginate({
    urlFor: (p) => `/product/api/v1/personalize-product/get-products?currentPage=${p}&rowsPerPage=50`,
    pageInfo: (j) => j?.data?.pageInfo,
    items: (j) => j?.data?.items || [],
    label: "personalize/recommended",
  });
  for (const it of items) {
    const rec = normalizeCategory(it, "For You", "For You");
    if (rec) addProduct({ ...rec, c: "For You", t: "For You", sc: "For You" });
  }
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------
function normalizeCategory(it, pathName, leafName) {
  const p = num(it.discountedPrice);
  const m = num(it.price);
  const id = it.id ?? it.productId;
  if (!id) return null;
  const st = it.isVariantAvailable === false ? false : (Number(it.currentStockQty) || 0) > 0;
  return {
    i: id,
    n: cat(it.name),
    c: pathName,
    t: pathName.split(" > ")[0],
    sc: leafName,
    img: cat(it.thumbnail),
    p: p || m,
    m,
    d: num(it.discountPercentage),
    st,
    rt: Number(it.ratings) || 0,
    rc: Number(it.totalRating) || 0,
    sl: cat(it.slug),
    fs: !!it.isFreeShippingApplied,
    _cat: true,
  };
}
function normalizeFlash(it) {
  if (!it.productId) return null;
  const p = num(it.discountedPrice);
  const m = num(it.price);
  return {
    i: it.productId,
    n: cat(it.name),
    img: cat(it.productVariantThumbnail || it.thumbnail),
    p: p || m,
    m,
    d: num(it.discountPercentage),
    st: (Number(it.remainingSlotStock) || 0) > 0,
    rt: 0, rc: 0,
    sl: cat(it.slug),
    fs: !!it.isFreeShippingApplied,
  };
}
function normalizeBuilder(it) {
  if (!it.productId) return null;
  const p = num(it.productDiscountedPrice);
  const m = num(it.productPrice);
  return {
    i: it.productId,
    n: cat(it.productName),
    img: cat(it.productThumbnail || it.productVariantThumbnail),
    p: p || m,
    m,
    d: num(it.productDiscountPercentage),
    st: it.productIsVariantAvailable === false ? false : (Number(it.productCurrentStockQty) || 0) > 0,
    rt: Number(it.productAvgRating) || 0,
    rc: Number(it.productTotalRating) || 0,
    sl: cat(it.productSlug),
    fs: !!it.isFreeShippingApplied,
  };
}

// ---------------------------------------------------------------------------
// History / delta bookkeeping
// ---------------------------------------------------------------------------
function updateHistory(history, day, stateMap) {
  for (const [id, [p]] of stateMap) {
    const prev = history[id];
    if (prev) {
      const parts = prev.split(",");
      const [ld, lp] = parts[parts.length - 1].split(":");
      if (ld === day) {
        if (Number(lp) !== p) parts[parts.length - 1] = `${day}:${p}`;
      } else if (Number(lp) !== p) {
        parts.push(`${day}:${p}`);
      }
      history[id] = parts.join(",");
    } else {
      history[id] = `${day}:${p}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`CartUp scraper  ·  scope=${SCOPE}  ·  day=${DAY}  ·  concurrency=${CONCURRENCY}  ·  pages/category=${CAT_PAGES === 0 ? "unlimited" : CAT_PAGES}`);
  const { tree, leaves, byLink } = await fetchTree();
  api.log("category tree", `${tree.length} top-level, ${leaves.length} leaf`);
  const home = await fetchHome();
  api.log("home channels", home.channels.length);
  api.log("mega/offer/pop targets", `${home.mega.length}/${home.offers.length}/${home.pop.length}`);

  await fetchFlash();
  const sectionSlugs = [...new Set([...home.mega, ...home.offers, ...home.pop].map((o) => o.slug))];
  for (const s of sectionSlugs) await fetchBuilderPage(s, home.mega.find((o) => o.slug === s)?.text);
  await fetchPersonalize();

  if (SCOPE === "full") {
    api.log("scope=full", `scraping all ${leaves.length} leaf categories`);
    const withPath = leaves.map((node) => {
      const path = [];
      let cur = node;
      while (cur) { path.unshift(cur.name); cur = byLink.get(String(cur.parent)); }
      return { node, path: path.join(" > ") };
    });
    let idx = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, 4) }, async () => {
      while (idx < withPath.length) {
        const { node, path } = withPath[idx++];
        try { await fetchCategory(node, path); } catch {}
      }
    });
    await Promise.all(workers);
  } else {
    api.log("scope=featured", `scraping ${home.channels.length} curated channels`);
    for (const ch of home.channels) {
      const node = byLink.get(ch.slug) || { name: ch.name, slug: ch.slug };
      try { await fetchCategory(node, ch.name); } catch {}
    }
  }

  const list = [...products.values()].map((r) => { const { _cat, ...rest } = r; return { ...rest, sec: [...r.sec] }; });
  console.log(`\nScraped ${list.length} unique products, ${sections.length} sections, ${api.calls} requests`);

  fs.mkdirSync(DAILY, { recursive: true });
  fs.mkdirSync(STATE, { recursive: true });
  const prevState = readJson(path.join(STATE, "last.json"), {});
  const history = readJson(path.join(DATA, "history.json"), {});
  const stateMap = new Map(list.map((r) => [r.i, [r.p, r.m, r.st ? 1 : 0]]));
  const daily = {};
  let newCount = 0, changedCount = 0;
  for (const [id, vals] of stateMap) {
    const was = prevState[id];
    if (!was) { daily[id] = vals; newCount++; }
    else if (was[0] !== vals[0] || was[1] !== vals[1] || (was[2] ? 1 : 0) !== vals[2]) { daily[id] = vals; changedCount++; }
  }
  updateHistory(history, DAY, stateMap);
  if (Object.keys(daily).length) writeJson(path.join(DAILY, `${DAY}.json`), daily);
  writeJson(path.join(STATE, "last.json"), Object.fromEntries(stateMap));

  const meta = {
    source: BASE,
    scope: SCOPE,
    lastUpdated: new Date().toISOString(),
    day: DAY,
    stats: {
      products: list.length,
      sections: sections.length,
      categories: tree.length,
      newToday: newCount,
      changedToday: changedCount,
      requests: api.calls,
    },
    channels: home.channels,
    sections: sections.map(({ id, type, name, slug, campaignId, image, productIds, count }) => ({ id, type, name, slug, campaignId, image, productIds, count })),
    categories: tree,
  };

  writeJson(path.join(DATA, "products.json"), list);
  writeJson(path.join(DATA, "history.json"), history);
  writeJson(path.join(DATA, "meta.json"), meta);
  console.log(`Wrote data/products.json (${(fs.statSync(path.join(DATA, "products.json")).size / 1e6).toFixed(1)} MB), data/history.json, data/meta.json, data/daily/${DAY}.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
