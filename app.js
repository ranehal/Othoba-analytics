(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const IMG = "https://sl-dev-s3.s3.amazonaws.com";
  const IMRS = "https://imrs.cartup.com/api/v1/image-resize";
  const PALETTE = ["#2dd4bf", "#60a5fa", "#f59e0b", "#a78bfa", "#fb7185", "#34d399", "#fbbf24", "#22d3ee", "#f472b6", "#a3e635"];
  const BATCH = 48;

  const money = (n) => (Math.round(n) || 0).toLocaleString("en-IN");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const imgPath = (img) => (img.startsWith("http") ? img : img.includes("/") ? `${IMG}/${img}` : `${IMG}/product/${img}`);
  const thumb = (img, w = 360) => (img ? `${IMRS}?imageUrl=${encodeURIComponent(imgPath(img))}&width=${w}` : "");
  const fmtDate = (d) => { const t = new Date(d + "T00:00:00Z"); return t.toLocaleDateString("en-US", { month: "short", day: "numeric" }); };

  let products = [], meta = {}, history = {}, byId = new Map();
  let sections = [], topCounts = [], subCounts = [], subsByTop = {};
  let NOW = Date.now();

  const state = { sec: null, t: null, sc: null, q: "", sort: "smart", disc: 0, stock: true, lows: false, maxP: 100000 };
  let filtered = [], rendered = 0;
  let compareSet = new Set();
  let alerts = [];
  let curPoints = [], histIds = [], histIdx = 0, curRange = 90;

  const toast = (msg) => {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(t._tm);
    t._tm = setTimeout(() => { t.hidden = true; }, 2600);
  };

  const fetchData = async (u) => { const r = await fetch(u, { cache: "no-cache" }); if (!r.ok) throw new Error(`${u} → ${r.status}`); return r.json(); };

  const histCache = new Map();
  const parseHistory = (id) => {
    if (histCache.has(id)) return histCache.get(id);
    const s = history[id];
    if (!s) return [];
    const out = s.split(",").map((pair) => { const [d, p] = pair.split(":"); return { d, t: +new Date(d + "T00:00:00Z"), p: +p }; }).sort((a, b) => a.t - b.t);
    histCache.set(id, out);
    return out;
  };
  const chCache = new Map();
  const changeSince = (x, days) => {
    const key = `${x.i}:${days}`;
    if (chCache.has(key)) return chCache.get(key);
    const h = parseHistory(x.i);
    let val = null;
    if (h.length) {
      const cutoff = NOW - days * 864e5;
      let base = h[0].p;
      for (const pt of h) if (pt.t <= cutoff) base = pt.p; else break;
      val = base ? ((x.p - base) / base) * 100 : null;
    }
    chCache.set(key, val);
    return val;
  };

  const isLow = (x) => { const h = parseHistory(x.i); return h.length > 0 && x.p <= Math.min(...h.map((p) => p.p)); };

  const smartScore = (x) => {
    let s = 0;
    if (x.st) s += 500;
    s += Math.min(x.d, 70) * 5;
    s += Math.min(x.rt, 5) * 60;
    s += Math.min(x.rc, 500);
    const ch = changeSince(x, 30);
    if (ch != null && ch < 0) s += Math.min(-ch, 400);
    return s;
  };

  function compute() {
    const q = state.q.trim().toLowerCase();
    let list = products.filter((x) => {
      if (state.sec && !(x.sec && x.sec.includes(state.sec))) return false;
      if (state.t && x.t !== state.t) return false;
      if (state.sc && x.sc !== state.sc) return false;
      if (state.maxP && x.p > state.maxP) return false;
      if (x.d < state.disc) return false;
      if (state.stock && !x.st) return false;
      if (state.lows && !isLow(x)) return false;
      if (q && !(`${x.n} ${x.t || ""} ${x.sc || ""}`.toLowerCase().includes(q))) return false;
      return true;
    });
    const cmp = {
      smart: (a, b) => smartScore(b) - smartScore(a),
      discount: (a, b) => b.d - a.d || b.rc - a.rc,
      drop: (a, b) => (changeSince(b, 30) ?? 0) - (changeSince(a, 30) ?? 0),
      priceAsc: (a, b) => a.p - b.p,
      priceDesc: (a, b) => b.p - a.p,
      rating: (a, b) => b.rc - a.rc || b.rt - a.rt,
      name: (a, b) => a.n.localeCompare(b.n),
    }[state.sort] || ((a, b) => 0);
    return list.sort(cmp);
  }

  function spark(id) {
    const pts = parseHistory(id).slice(-20);
    if (pts.length < 2) return "";
    const W = 100, H = 32, l = 2, r = 2, t = 3, b = 3;
    const mn = Math.min(...pts.map((p) => p.p)), mx = Math.max(...pts.map((p) => p.p));
    const span = (mx - mn) || 1;
    let d = "";
    pts.forEach((p, i) => {
      const x = l + (W - l - r) * (i / (pts.length - 1));
      const y = t + (H - t - b) * (1 - (p.p - mn) / span);
      d += `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    });
    const area = d + ` L${(W - r).toFixed(1)} ${H - b} L${l} ${H - b} Z`;
    return `<svg class="sparkline" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path class="area" d="${area}"/><path d="${d}"/></svg>`;
  }

  function cardHTML(x) {
    const on = compareSet.has(x.i);
    const badges = [];
    if (x.d >= 5) badges.push(`<span class="badge badge-disc">-${x.d}%</span>`);
    if (!x.st) badges.push(`<span class="badge badge-out">Out of stock</span>`);
    else if (x.fs) badges.push(`<span class="badge badge-free">FREE SHIP</span>`);
    if (isLow(x)) badges.push(`<span class="badge badge-free">ALL-TIME LOW</span>`);
    const stars = x.rt > 0
      ? `<div class="rating"><span class="stars">${"★".repeat(Math.max(0, Math.min(5, Math.round(x.rt))))}${"☆".repeat(Math.max(0, 5 - Math.round(x.rt)))}</span>${x.rt.toFixed(1)} (${(x.rc || 0).toLocaleString()})</div>`
      : `<div class="rating">—</div>`;
    return `<article class="card ${x.st ? "" : "out"}" data-id="${x.i}">
      <div class="thumb">
        <img loading="lazy" src="${thumb(x.img)}" alt="${esc(x.n)}" onerror="this.onerror=null;this.src='${esc(imgPath(x.img))}'">
        ${badges.join("")}
        <button class="compare-btn ${on ? "is-on" : ""}" data-compare="${x.i}" title="Add to compare">${on ? "✓" : "＋"}</button>
      </div>
      <div class="card-body">
        <div class="card-cat">${esc(x.t || x.sc || "")}</div>
        <div class="card-name" title="${esc(x.n)}">${esc(x.n)}</div>
        ${stars}
        ${spark(x.i)}
        <div class="price-row"><span class="price-now">৳${money(x.p)}</span>${x.m > x.p ? `<span class="price-mrp">৳${money(x.m)}</span><span class="price-off">${x.d}%</span>` : ""}</div>
        <div class="card-actions"><button data-hist="${x.i}">History</button><button class="primary" data-compare="${x.i}">Compare</button></div>
      </div>
    </article>`;
  }

  function applyFilters() {
    filtered = compute();
    rendered = 0;
    $("grid").innerHTML = "";
    $("resultCount").textContent = `${filtered.length.toLocaleString()} products`;
    const name = state.sec ? (sections.find((s) => s.id === state.sec) || {}).name : state.t || state.sc || null;
    $("listTitle").textContent = state.sec ? `⚡ ${name || "Section"}` : name ? name : "All products";
    $("emptyState").hidden = filtered.length > 0;
    buildRail();
    buildStrip();
    renderMore();
  }

  function renderMore() {
    const slice = filtered.slice(rendered, rendered + BATCH);
    $("grid").insertAdjacentHTML("beforeend", slice.map(cardHTML).join(""));
    rendered += slice.length;
    $("sentinel").style.display = rendered < filtered.length ? "grid" : "none";
  }

  // ---------- rail + strip ----------
  function buildRail() {
    const secBtn = (s) => `<button class="rail-btn ${state.sec === s.id ? "is-active" : ""}" data-sec="${s.id}"><span class="ico">${s.type === "flash" ? "⚡" : "▤"}</span>${esc(s.name)}<b>${s.count}</b></button>`;
    const catBtn = ([n, c]) => `<button class="rail-btn ${state.t === n && !state.sec ? "is-active" : ""}" data-t="${esc(n)}"><span class="ico">▸</span>${esc(n)}<b>${c}</b></button>`;
    const all = `<div class="rail-group"><div class="rail-label">Browse</div><button class="rail-btn ${!state.sec && !state.t ? "is-active" : ""}" data-all="1"><span class="ico">▦</span>All products<b>${products.length.toLocaleString()}</b></button></div>`;
    const secs = sections.length ? `<div class="rail-group"><div class="rail-label">Deals & Sections</div>${sections.map(secBtn).join("")}</div>` : "";
    const cats = `<div class="rail-group"><div class="rail-label">Categories</div>${topCounts.map(catBtn).join("")}</div>`;
    $("railNav").innerHTML = all + secs + cats;
  }

  function buildStrip() {
    if (!sections.length) { $("sectionStrip").style.display = "none"; return; }
    $("sectionStrip").innerHTML = sections.map((s) => {
      const bg = s.image
        ? `style="background-image:url('${esc(s.image)}')"`
        : `style="background:linear-gradient(135deg,#1a2742,#0e1628)"`;
      return `<button class="sec-card ${s.type === "flash" ? "flash" : ""} ${state.sec === s.id ? "is-active" : ""}" data-sec="${s.id}">
        <div class="sec-bg" ${bg}></div>
        <div class="sec-body"><h3>${esc(s.name)}</h3><small>${s.type === "flash" ? "Flash sale" : "Campaign"}</small></div>
        <span class="count"><b>${s.count.toLocaleString()}</b> items</span>
      </button>`;
    }).join("");
  }

  // ---------- selects ----------
  function buildSelects() {
    $("topSelect").innerHTML = '<option value="">All categories</option>' + topCounts.map(([n, c]) => `<option value="${esc(n)}" ${state.t === n ? "selected" : ""}>${esc(n)} (${c})</option>`).join("");
    buildSub();
  }

  function buildSub() {
    const subs = state.t ? subCounts.filter(([n]) => subsByTop[state.t] && subsByTop[state.t].includes(n)) : subCounts;
    $("subSelect").innerHTML = '<option value="">All subcategories</option>' + subs.map(([n, c]) => `<option value="${esc(n)}" ${state.sc === n ? "selected" : ""}>${esc(n)} (${c})</option>`).join("");
  }

  // ---------- history chart ----------
  function histScale(points) {
    const prices = points.map((p) => p.p);
    let mn = Math.min(...prices), mx = Math.max(...prices);
    if (mn === mx) { mx += 1; mn -= 1; }
    mn -= (mx - mn) * 0.05; mx += (mx - mn) * 0.05;
    return { mn, mx };
  }

  function buildChartSVG(points) {
    const n = points.length;
    const W = 1000, H = 470, l = 60, r = 20, t = 20, b = 42;
    const iw = W - l - r, ih = H - t - b;
    const { mn, mx } = histScale(points);
    const xs = (i) => l + iw * (i / (n - 1));
    const ys = (v) => t + ih * (1 - (v - mn) / (mx - mn));
    let line = "", area = "";
    points.forEach((p, i) => {
      const X = xs(i).toFixed(1), Y = ys(p.p).toFixed(1);
      line += `${i ? "L" : "M"}${X} ${Y}`;
      area += `${i ? "L" : "M"}${X} ${Y}`;
    });
    area += ` L${xs(n - 1).toFixed(1)} ${ys(mn).toFixed(1)} L${xs(0).toFixed(1)} ${ys(mn).toFixed(1)} Z`;
    let grid = "";
    const ticks = 5;
    for (let k = 0; k <= ticks; k++) {
      const v = mn + ((mx - mn) * k) / ticks, Y = ys(v).toFixed(1);
      grid += `<line class="grid-line" x1="${l}" y1="${Y}" x2="${W - r}" y2="${Y}"/><text class="axis-text" x="${l - 8}" y="${+Y + 4}" text-anchor="end">৳${money(Math.round(v))}</text>`;
    }
    let xlab = "";
    const xlabs = 6;
    for (let k = 0; k < xlabs; k++) {
      const i = Math.round((k * (n - 1)) / (xlabs - 1));
      xlab += `<text class="axis-text" x="${xs(i).toFixed(1)}" y="${H - b + 22}" text-anchor="middle">${fmtDate(points[i].d)}</text>`;
    }
    const avg = points.reduce((a, b) => a + b.p, 0) / n;
    const low = points.reduce((a, b) => (b.p < a.p ? b : a));
    const last = points[n - 1];
    const lowIdx = points.indexOf(low);
    return `<defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2dd4bf" stop-opacity=".35"/><stop offset="1" stop-color="#2dd4bf" stop-opacity="0"/></linearGradient></defs>
      ${grid}
      <path class="chart-area" d="${area}"/>
      <line class="avg-line" x1="${l}" y1="${ys(avg).toFixed(1)}" x2="${W - r}" y2="${ys(avg).toFixed(1)}"/>
      <path class="chart-line" d="${line}"/>
      <circle class="alltime-point" cx="${xs(lowIdx).toFixed(1)}" cy="${ys(low.p).toFixed(1)}" r="5"/>
      <circle class="last-point" cx="${xs(n - 1).toFixed(1)}" cy="${ys(last.p).toFixed(1)}" r="6"/>
      <line id="crossX" class="cross-line" x1="0" y1="${t}" x2="0" y2="${H - b}" visibility="hidden"/>
      <circle id="hoverDot" class="hover-dot" cx="0" cy="0" r="5" visibility="hidden"/>
      ${xlab}`;
  }

  function renderHistory() {
    const id = histIds[histIdx];
    const pr = byId.get(Number(id));
    if (!pr) { $("historyModal").close(); return; }
    $("historyName").textContent = pr.n;
    $("historyMeta").textContent = `${pr.t || ""} · ${pr.st ? "in stock" : "out of stock"}`;
    $("historyCurrent").textContent = `৳${money(pr.p)}`;
    curPoints = parseHistory(id).filter((pt) => curRange === 0 || NOW - pt.t <= curRange * 864e5);
    const n = curPoints.length;
    $("historyChart").innerHTML = n >= 2 ? buildChartSVG(curPoints) : "";
    $("historyChart").style.display = n >= 2 ? "block" : "none";
    $("historyStats").innerHTML = n >= 2 ? renderHistStats(curPoints) : `<div class="hstat" style="grid-column:1/-1"><small>History</small><b>${n ? `${n} day${n > 1 ? "s" : ""}` : "Not tracked yet"}</b></div>`;
    $("historyEvents").innerHTML = renderHistEvents(curPoints);
    $("historyPrev").disabled = histIdx <= 0;
    $("historyNext").disabled = histIdx >= histIds.length - 1;
  }

  function renderHistStats(points) {
    const prices = points.map((p) => p.p);
    const min = Math.min(...prices), max = Math.max(...prices);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const cur = prices[prices.length - 1], first = prices[0];
    const ch = first ? ((cur - first) / first) * 100 : 0;
    const cls = ch < -0.01 ? "down" : ch > 0.01 ? "up" : "";
    const rangeTxt = curRange ? `${curRange}D` : "All time";
    return `<div class="hstat"><small>Avg (${rangeTxt})</small><b>৳${money(avg)}</b></div>
      <div class="hstat"><small>Low</small><b>৳${money(min)}</b></div>
      <div class="hstat"><small>High</small><b>৳${money(max)}</b></div>
      <div class="hstat"><small>Window change</small><b class="${cls}">${ch >= 0 ? "+" : ""}${ch.toFixed(1)}%</b></div>`;
  }

  function renderHistEvents(points) {
    if (points.length < 2) return "";
    const ev = [];
    for (let i = 1; i < points.length; i++) {
      const ch = ((points[i].p - points[i - 1].p) / points[i - 1].p) * 100;
      if (Math.abs(ch) >= 0.5) ev.push({ d1: points[i - 1].d, d2: points[i].d, ch });
    }
    if (!ev.length) return "<h4>Notable moves</h4><div class='hist-event'>No significant moves</div>";
    ev.sort((a, b) => Math.abs(b.ch) - Math.abs(a.ch));
    return `<h4>Notable moves</h4>` + ev.slice(0, 6).map((e) => `<div class="hist-event"><span>${fmtDate(e.d1)} → ${fmtDate(e.d2)}</span><b class="${e.ch < 0 ? "down" : "up"}">${e.ch >= 0 ? "+" : ""}${e.ch.toFixed(1)}%</b></div>`).join("");
  }

  function openHistory(id) {
    histIds = filtered.map((x) => String(x.i));
    histIdx = histIds.indexOf(String(id));
    if (histIdx < 0) { toast("Product not in current view"); return; }
    renderHistory();
    $("historyModal").showModal();
  }

  // ---------- compare ----------
  function toggleCompare(id) {
    if (compareSet.has(id)) compareSet.delete(id); else compareSet.add(id);
    localStorage.setItem("cartup.compare", JSON.stringify([...compareSet]));
    $("compareCount").textContent = compareSet.size;
    document.querySelectorAll("[data-compare]").forEach((b) => {
      const on = compareSet.has(Number(b.dataset.compare));
      b.classList.toggle("is-on", on);
      b.textContent = on ? "✓" : "＋";
    });
    if ($("compareModal").open) renderCompare();
  }

  function renderCompare() {
    const ids = [...compareSet];
    const wrap = $("compareContent");
    if (!ids.length) { wrap.innerHTML = '<p class="empty">Add products with the ＋ button on any card to compare price trends.</p>'; return; }
    const prods = ids.map((id) => byId.get(id)).filter(Boolean);
    const dateSet = new Set();
    prods.forEach((pr) => parseHistory(pr.i).forEach((pt) => dateSet.add(pt.d)));
    const dates = [...dateSet].sort();
    const series = prods.map((pr) => {
      const map = new Map(parseHistory(pr.i).map((pt) => [pt.d, pt.p]));
      let base = null;
      for (const d of dates) if (map.has(d)) { base = map.get(d); break; }
      if (base == null) base = pr.p;
      return { pr, base, pts: dates.map((d) => { const v = map.get(d); return v == null ? null : ((v - base) / base) * 100; }) };
    });
    const W = 1000, H = 400, l = 58, r = 18, t = 20, b = 40;
    const iw = W - l - r, ih = H - t - b;
    const all = series.flatMap((s) => s.pts.filter((v) => v != null));
    let mn = all.length ? Math.min(...all) : 0, mx = all.length ? Math.max(...all) : 0;
    const pad = Math.max((mx - mn) * 0.12, 0.5); mn -= pad; mx += pad;
    const xs = (i) => l + iw * (dates.length > 1 ? i / (dates.length - 1) : 0);
    const ys = (v) => t + ih * (1 - (v - mn) / (mx - mn));
    let grid = "";
    const ticks = 5;
    for (let k = 0; k <= ticks; k++) {
      const v = mn + ((mx - mn) * k) / ticks, Y = ys(v).toFixed(1);
      grid += `<line class="grid-line" x1="${l}" y1="${Y}" x2="${W - r}" y2="${Y}"/><text class="axis-text" x="${l - 8}" y="${+Y + 4}" text-anchor="end">${v >= 0 ? "+" : ""}${v.toFixed(1)}%</text>`;
    }
    let xlab = "";
    const xlabs = 6;
    for (let k = 0; k < xlabs; k++) {
      const i = Math.round((k * (dates.length - 1)) / (xlabs - 1));
      xlab += `<text class="axis-text" x="${xs(i).toFixed(1)}" y="${H - b + 22}" text-anchor="middle">${fmtDate(dates[i])}</text>`;
    }
    let lines = "";
    series.forEach((s, si) => {
      let d = "";
      for (let i = 0; i < dates.length; i++) {
        const v = s.pts[i];
        if (v == null) continue;
        d += `${d ? "L" : "M"}${xs(i).toFixed(1)} ${ys(v).toFixed(1)}`;
      }
      if (d) lines += `<path class="chart-line" d="${d}" style="stroke:${PALETTE[si % PALETTE.length]}"/>`;
    });
    wrap.innerHTML = `<div class="compare-chart-wrap"><svg id="compareChart" viewBox="0 0 1000 400" preserveAspectRatio="none">${grid}${lines}${xlab}</svg></div>
      <div class="compare-legend">${series.map((s, si) => `<span><i style="background:${PALETTE[si % PALETTE.length]}"></i>${esc(s.pr.n)}</span>`).join("")}</div>
      <div class="compare-cards">${series.map((s, si) => {
        const last = s.pts[s.pts.length - 1];
        const ch = last == null ? "—" : `${last >= 0 ? "+" : ""}${last.toFixed(1)}%`;
        const span = curRange ? `${curRange}D` : "all";
        return `<div class="ccard"><img src="${thumb(s.pr.img, 120)}" alt="" onerror="this.style.visibility='hidden'"><h4>${esc(s.pr.n)}</h4>
          <div class="row"><span>Now</span><b>৳${money(s.pr.p)}</b></div>
          <div class="row"><span>Change (${span})</span><b>${ch}</b></div>
          <button class="ghost tiny" data-rm="${s.pr.i}">Remove</button></div>`;
      }).join("")}</div>`;
  }

  // ---------- analytics ----------
  const kpi = (label, val, cls) => `<div class="kpi"><small>${esc(label)}</small><b class="${cls || ""}">${val}</b></div>`;
  const anRow = (x, extra, note) => `<div class="an-row"><img src="${thumb(x.img, 120)}" alt="" onerror="this.style.visibility='hidden'"><div class="an-name"><b title="${esc(x.n)}">${esc(x.n)}</b><small>${esc(x.t || "")}</small></div><div class="an-val"><b>৳${money(x.p)}</b><small>${esc(extra || "")}</small></div></div>`;

  function renderAnalytics() {
    const withH = products.filter((x) => parseHistory(x.i).length >= 2);
    const movers = withH.map((x) => {
      const h = parseHistory(x.i);
      const ch = ((h[h.length - 1].p - h[0].p) / h[0].p) * 100;
      return { x, ch };
    });
    const droppers = [...movers].sort((a, b) => a.ch - b.ch).slice(0, 10);
    const risers = [...movers].sort((a, b) => b.ch - a.ch).slice(0, 10);
    const lows = products.filter(isLow).length;
    const avgDisc = products.reduce((a, b) => a + b.d, 0) / (products.length || 1);
    const sorted = [...products].map((x) => x.p).sort((a, b) => a - b);
    const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    const rated = products.filter((x) => x.rt);
    const avgRat = rated.length ? rated.reduce((a, b) => a + b.rt, 0) / rated.length : 0;
    const topDisc = [...products].sort((a, b) => b.d - a.d).slice(0, 10);
    const catMap = new Map();
    products.forEach((x) => catMap.set(x.t || "Other", (catMap.get(x.t || "Other") || 0) + 1));
    const cats = [...catMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    const maxCat = cats[0] ? cats[0][1] : 1;
    const dayCount = new Set(Object.values(history).flatMap((s) => s.split(",").map((p) => p.split(":")[0]))).size;
    const anMeta = $("analyticsMeta");
    anMeta.textContent = `Snapshot ${new Date(meta.lastUpdated).toLocaleString()} · ${meta.stats.requests ?? "-"} API calls · scope ${meta.scope}`;
    $("analyticsContent").innerHTML = `
      <div class="kpi-row">
        ${kpi("Products tracked", products.length.toLocaleString())}
        ${kpi("Avg discount", avgDisc.toFixed(1) + "%")}
        ${kpi("Median price", "৳" + money(med))}
        ${kpi("Avg rating", avgRat.toFixed(2))}
        ${kpi("All-time lows", lows, "warn")}
        ${kpi("Days of history", dayCount)}
      </div>
      <div class="an-block"><h3>📉 Biggest drops</h3><div class="an-grid">${droppers.map((m) => anRow(m.x, `${m.ch.toFixed(1)}%`)).join("") || '<p class="empty">Not enough history yet.</p>'}</div></div>
      <div class="an-block"><h3>📈 Biggest rises</h3><div class="an-grid">${risers.map((m) => anRow(m.x, `+${m.ch.toFixed(1)}%`)).join("") || '<p class="empty">Not enough history yet.</p>'}</div></div>
      <div class="an-block"><h3>🏷 Deepest discounts</h3><div class="an-grid">${topDisc.map((x) => anRow(x, `${x.d}% off`)).join("")}</div></div>
      <div class="an-block"><h3>🗂 Category distribution</h3><div class="bar-chart">${cats.map(([n, c]) => `<div class="bar-row"><span title="${esc(n)}">${esc(n)}</span><div class="track"><div class="fill" style="width:${((c / maxCat) * 100).toFixed(1)}%"></div></div><div class="val">${c.toLocaleString()}</div></div>`).join("")}</div></div>`;
  }

  // ---------- alerts ----------
  function saveAlerts() { localStorage.setItem("cartup.alerts", JSON.stringify(alerts)); }

  function renderAlerts() {
    const list = $("alertsList");
    if (!alerts.length) { list.innerHTML = '<p class="empty">No price targets yet. Search a product above to add one — you\'ll be pinged when it crosses 90% of today\'s price.</p>'; $("alertCount").textContent = 0; return; }
    list.innerHTML = alerts.map((a) => {
      const pr = byId.get(Number(a.id));
      const cur = pr ? pr.p : null;
      const hit = cur != null && cur <= a.target;
      return `<div class="alert-item ${hit ? "hit" : ""}">
        <img src="${thumb(a.img, 120)}" alt="" onerror="this.style.visibility='hidden'">
        <div class="a-name"><b>${esc(a.name)}</b><small>target ৳${money(a.target)}</small></div>
        <div class="a-target"><b>${cur == null ? "—" : hit ? "TARGET HIT" : "৳" + money(cur)}</b></div>
        <button data-del="${a.id}" title="Remove">×</button>
      </div>`;
    }).join("");
    const hits = alerts.filter((a) => { const pr = byId.get(Number(a.id)); return pr && pr.p <= a.target; }).length;
    $("alertCount").textContent = hits;
  }

  function addAlert(pr) {
    if (alerts.some((a) => a.id === pr.i)) { toast("Already on your watchlist"); return; }
    alerts.push({ id: pr.i, name: pr.n, img: pr.img, target: Math.round(pr.p * 0.9) });
    saveAlerts();
    renderAlerts();
    toast(`Alert set — you'll be pinged at ৳${money(Math.round(pr.p * 0.9))}`);
  }

  // ---------- export ----------
  function exportCSV() {
    if (!filtered.length) { toast("Nothing to export with current filters"); return; }
    const rows = [["id", "name", "top", "sub", "price", "mrp", "discount%", "rating", "ratingCount", "inStock", "freeShip", "section"].join(",")];
    filtered.forEach((x) => rows.push([x.i, `"${x.n.replace(/"/g, '""')}"`, `"${x.t || ""}"`, `"${x.sc || ""}"`, x.p, x.m, x.d, x.rt, x.rc, x.st ? "1" : "0", x.fs ? "1" : "0", (x.sec || []).join(";")].join(",")));
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `cartup-${meta.day || "export"}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`Exported ${filtered.length.toLocaleString()} products`);
  }

  // ---------- topbar ----------
  function buildTopbar() {
    const chip = (l, v, cls) => `<span class="chip">${esc(l)} <b class="${cls || ""}">${v}</b></span>`;
    $("statChips").innerHTML = [
      chip("Products", products.length.toLocaleString()),
      chip("New today", (meta.stats.newToday ?? 0).toLocaleString(), "up"),
      chip("Changed", (meta.stats.changedToday ?? 0).toLocaleString(), "warn"),
      chip("Sections", sections.length),
      chip("Categories", meta.stats.categories ?? topCounts.length),
      chip("Requests", meta.stats.requests ?? "-"),
    ].join("");
    $("lastUpdated").textContent = "Updated " + new Date(meta.lastUpdated).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) + ` · scope ${meta.scope}`;
    $("compareCount").textContent = compareSet.size;
    renderAlerts();
  }

  // ---------- events ----------
  function bindEvents() {
    $("railToggle").addEventListener("click", () => $("rail").classList.toggle("open"));
    $("railNav").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-sec],button[data-t],button[data-all]");
      if (!b) return;
      $("rail").classList.remove("open");
      if (b.dataset.sec) { state.sec = state.sec === b.dataset.sec ? null : b.dataset.sec; state.t = null; state.sc = null; $("topSelect").value = ""; }
      else if (b.dataset.t) { state.t = state.t === b.dataset.t ? null : b.dataset.t; state.sec = null; state.sc = null; $("topSelect").value = state.t || ""; }
      else { state.sec = state.t = state.sc = null; $("topSelect").value = ""; }
      buildSub();
      applyFilters();
    });
    $("sectionStrip").addEventListener("click", (e) => {
      const b = e.target.closest("[data-sec]");
      if (!b) return;
      state.sec = state.sec === b.dataset.sec ? null : b.dataset.sec;
      state.t = state.sc = null;
      $("topSelect").value = "";
      buildSub();
      applyFilters();
    });
    $("searchInput").addEventListener("input", () => { clearTimeout($("searchInput")._t); $("searchInput")._t = setTimeout(() => { state.q = $("searchInput").value; applyFilters(); }, 200); });
    $("topSelect").addEventListener("change", () => { state.t = $("topSelect").value || null; state.sc = null; buildSub(); applyFilters(); });
    $("subSelect").addEventListener("change", () => { state.sc = $("subSelect").value || null; applyFilters(); });
    $("sortSelect").addEventListener("change", () => { state.sort = $("sortSelect").value; applyFilters(); });
    $("discountSelect").addEventListener("change", () => { state.disc = +$("discountSelect").value; applyFilters(); });
    $("stockOnly").addEventListener("change", () => { state.stock = $("stockOnly").checked; applyFilters(); });
    $("lowsOnly").addEventListener("change", () => { state.lows = $("lowsOnly").checked; applyFilters(); });
    let maxT;
    $("maxPrice").addEventListener("input", () => { $("maxPriceLabel").textContent = "৳" + money(+$("maxPrice").value); clearTimeout(maxT); maxT = setTimeout(() => { state.maxP = +$("maxPrice").value; applyFilters(); }, 150); });
    $("clearBtn").addEventListener("click", () => {
      state.sec = state.t = state.sc = null;
      state.q = ""; state.sort = "smart"; state.disc = 0; state.stock = true; state.lows = false; state.maxP = 100000;
      $("searchInput").value = ""; $("sortSelect").value = "smart"; $("discountSelect").value = "0";
      $("stockOnly").checked = true; $("lowsOnly").checked = false; $("maxPrice").value = 100000;
      $("maxPriceLabel").textContent = "৳10,000";
      buildSelects();
      applyFilters();
    });

    $("grid").addEventListener("click", (e) => {
      const hb = e.target.closest("[data-hist]");
      if (hb) { openHistory(hb.dataset.hist); return; }
      const cb = e.target.closest("[data-compare]");
      if (cb) { toggleCompare(Number(cb.dataset.compare)); return; }
      const card = e.target.closest(".card");
      if (card && card.dataset.id && !e.target.closest("button")) openHistory(card.dataset.id);
    });

    const io = new IntersectionObserver((en) => { if (en[0].isIntersecting && rendered < filtered.length) renderMore(); }, { rootMargin: "600px" });
    io.observe($("sentinel"));

    $("rangeSwitch").addEventListener("click", (e) => {
      const b = e.target.closest("[data-range]");
      if (!b) return;
      curRange = +b.dataset.range;
      document.querySelectorAll("#rangeSwitch button").forEach((x) => x.classList.toggle("is-active", x === b));
      renderHistory();
    });

    const cw = $("chartWrap");
    cw.addEventListener("mousemove", (e) => {
      if (curPoints.length < 2) return;
      const rect = cw.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      const idx = Math.max(0, Math.min(curPoints.length - 1, Math.round(ratio * (curPoints.length - 1))));
      const pt = curPoints[idx];
      const W = 1000, l = 60, r = 20, t = 20, H = 470, b = 42;
      const xs = l + (W - l - r) * (idx / (curPoints.length - 1));
      const { mn, mx } = histScale(curPoints);
      const ys = t + (H - t - b) * (1 - (pt.p - mn) / (mx - mn));
      const c = cw.querySelector("#crossX"), dot = cw.querySelector("#hoverDot");
      if (c) { c.setAttribute("x1", xs); c.setAttribute("x2", xs); c.setAttribute("visibility", "visible"); }
      if (dot) { dot.setAttribute("cx", xs); dot.setAttribute("cy", ys); dot.setAttribute("visibility", "visible"); }
      const prev = idx > 0 ? curPoints[idx - 1].p : null;
      const tip = $("chartTip");
      tip.innerHTML = `<b>৳${money(pt.p)}</b><br><small>${fmtDate(pt.d)}${prev ? ` · ${((pt.p - prev) / prev * 100).toFixed(1)}%` : ""}</small>`;
      tip.hidden = false;
      tip.style.left = Math.min(rect.width - 150, Math.max(8, e.clientX - rect.left + 16)) + "px";
      tip.style.top = Math.max(6, e.clientY - rect.top - 52) + "px";
    });
    cw.addEventListener("mouseleave", () => {
      $("chartTip").hidden = true;
      const c = cw.querySelector("#crossX"), dot = cw.querySelector("#hoverDot");
      if (c) c.setAttribute("visibility", "hidden");
      if (dot) dot.setAttribute("visibility", "hidden");
    });

    $("historyPrev").addEventListener("click", () => { if (histIdx > 0) { histIdx--; renderHistory(); } });
    $("historyNext").addEventListener("click", () => { if (histIdx < histIds.length - 1) { histIdx++; renderHistory(); } });

    $("compareBtn").addEventListener("click", () => { renderCompare(); $("compareModal").showModal(); });
    $("analyticsBtn").addEventListener("click", () => { renderAnalytics(); $("analyticsModal").showModal(); });
    $("alertsBtn").addEventListener("click", () => { renderAlerts(); $("alertsModal").showModal(); });
    $("exportBtn").addEventListener("click", exportCSV);

    $("compareContent").addEventListener("click", (e) => {
      const b = e.target.closest("[data-rm]");
      if (b) { toggleCompare(Number(b.dataset.rm)); renderCompare(); }
    });

    $("alertAddBtn").addEventListener("click", () => {
      const q = $("alertInput").value.trim().toLowerCase();
      if (!q) { toast("Type a product name first"); return; }
      const m = products.filter((x) => x.n.toLowerCase().includes(q));
      if (!m.length) { toast("No matching product"); return; }
      addAlert(m[0]);
      $("alertInput").value = "";
    });
    $("alertInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("alertAddBtn").click(); });
    $("alertsList").addEventListener("click", (e) => {
      const b = e.target.closest("[data-del]");
      if (!b) return;
      alerts = alerts.filter((a) => a.id !== +b.dataset.del);
      saveAlerts();
      renderAlerts();
    });

    document.querySelectorAll(".dialog").forEach((d) => {
      d.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => d.close()));
      d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
    });
  }

  // ---------- init ----------
  async function init() {
    try {
      [products, meta, history] = await Promise.all([fetchData("data/products.json"), fetchData("data/meta.json"), fetchData("data/history.json")]);
    } catch (err) {
      $("grid").innerHTML = `<p class="empty">Failed to load data. Run the scraper first.<br><small>${esc(String(err))}</small></p>`;
      $("sentinel").style.display = "none";
      return;
    }
    products = Array.isArray(products) ? products : (products.products || []);
    NOW = new Date(meta.lastUpdated).getTime();
    sections = meta.sections || [];
    products.forEach((x) => byId.set(x.i, x));
    const tMap = new Map(), scMap = new Map(), scByT = {};
    products.forEach((x) => {
      const t = x.t || "Other";
      tMap.set(t, (tMap.get(t) || 0) + 1);
      const sc = x.sc || "Other";
      scMap.set(sc, (scMap.get(sc) || 0) + 1);
      (scByT[t] = scByT[t] || new Set()).add(sc);
    });
    topCounts = [...tMap.entries()].sort((a, b) => b[1] - a[1]);
    subCounts = [...scMap.entries()].sort((a, b) => b[1] - a[1]);
    subsByTop = Object.fromEntries(Object.entries(scByT).map(([k, v]) => [k, [...v]]));
    sections = sections.filter((s) => s.productIds && s.productIds.length).map((s) => ({ ...s, count: s.count ?? s.productIds.length }));
    try { compareSet = new Set(JSON.parse(localStorage.getItem("cartup.compare") || "[]").map(Number)); } catch { compareSet = new Set(); }
    try { alerts = JSON.parse(localStorage.getItem("cartup.alerts") || "[]"); } catch { alerts = []; }
    bindEvents();
    buildSelects();
    buildTopbar();
    applyFilters();
  }

  init();
})();
