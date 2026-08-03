export const BASE = "https://api.cartup.com";
export const IMG = "https://sl-dev-s3.s3.amazonaws.com";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const wrap = (s) => b64(b64(s));

export class Api {
  constructor({ concurrency = 6, delay = 50, quiet = false } = {}) {
    this.token = null;
    this.concurrency = concurrency;
    this.delay = delay;
    this.quiet = quiet;
    this.queue = [];
    this.active = 0;
    this.calls = 0;
    this.fails = 0;
  }

  _log(msg) {
    if (!this.quiet) console.log(msg);
  }

  async _fetch(url) {
    const headers = {
      "user-agent": "Dart/3.11 (dart:io)",
      origin: "cartup-prod",
      isapp: "1",
      "accept-encoding": "gzip",
    };
    if (this.token) headers.sxsrf = this.token;
    let r = await fetch(url, { headers, compress: true });
    if (r.status === 401) {
      const t = r.headers.get("cf-ray-status-id-tn");
      if (t) {
        this.token = wrap(t);
        r = await fetch(url, { headers: { ...headers, sxsrf: this.token }, compress: true });
      }
    }
    return r;
  }

  getJson(path) {
    return new Promise((resolve, reject) => {
      this.queue.push({ path, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      this._work(job).finally(() => {
        this.active--;
        this._pump();
      });
    }
  }

  async _work({ path, resolve, reject }) {
    try {
      const url = path.startsWith("http") ? path : BASE + path;
      const r = await this._fetch(url);
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} ${url}`), { status: r.status });
      this.calls++;
      const j = await r.json().catch(() => null);
      if (j && typeof j === "object" && "success" in j && !j.success)
        throw new Error(`API error ${j.code || ""} ${url}`);
      if (this.delay) await new Promise((res) => setTimeout(res, this.delay));
      resolve(j);
    } catch (e) {
      this.fails++;
      this._log(`  ✗ ${e.message}`);
      reject(e);
    }
  }

  log(label, value) {
    this._log(`  ${label}: ${value}`);
  }

  async paginate({ urlFor, pageInfo, items, maxPages = 100000, concurrency = 3, label = "" }) {
    const first = await this.getJson(urlFor(1));
    const pi = pageInfo(first);
    const total = pi?.totalPageCount ?? 1;
    const all = [...(items(first) || [])];
    const pages = Math.min(total, maxPages);
    let next = 2;
    const fetchPage = async () => {
      while (next <= pages) {
        const p = next++;
        const j = await this.getJson(urlFor(p));
        const arr = items(j);
        if (arr) all.push(...arr);
      }
    };
    const workers = Array.from({ length: Math.min(concurrency, Math.max(0, pages - 1)) }, fetchPage);
    await Promise.all(workers);
    if (label) this.log(label, `${all.length} items / ${pages} pages`);
    return all;
  }
}

export const norm = {
  price: (v) => Math.round(Number(v) || 0),
  stock: (v) => v === true || Number(v) > 0,
};
