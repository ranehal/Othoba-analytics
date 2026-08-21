"""Othoba API Scraper v2 — reverse-engineered from HAR capture"""
import json, re, os, sys, time, urllib.request, urllib.error, gzip, ssl
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock

API = 'https://app.othoba.com/api-frontend'
TOKEN = '11CZ+eanknvgRupFlOA0Eg'
HEADERS = {
    'authorization': TOKEN, 'accept': 'application/json',
    'content-type': 'application/json-patch+json', 'accept-encoding': 'gzip'
}
OUT_DIR = os.path.join(os.path.dirname(__file__), 'frontend')
MAX_PAGES = 50
PAGE_SIZE = 20
SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

def parse_price(pp, key):
    v = pp.get(key)
    if not v: return None
    s = str(v).replace(',', '').strip()
    m = re.search(r'[\d.]+', s)
    return float(m.group()) if m else None

def req(path, data=None):
    h = {**HEADERS, 'user-agent': 'okhttp/4.9.3'}
    body = json.dumps(data).encode() if data else None
    r = urllib.request.Request(API + path, data=body, headers=h, method='POST' if data else 'GET')
    with urllib.request.urlopen(r, timeout=20, context=SSL_CTX) as resp:
        raw = resp.read()
        if resp.headers.get('Content-Encoding') == 'gzip' or raw[:2] == b'\x1f\x8b':
            raw = gzip.decompress(raw)
        return json.loads(raw.decode('utf-8'))

def parse_unit(name, price):
    t = name.lower()
    t = re.sub(r'\(?[+\-\u00b1]\d+\s*(gm|g|kg|ml|ltr|l)?\)?', '', t)
    m = re.search(r'(\d+(\.\d+)?)\s*(kg|gm|gram|g)\b', t)
    if m:
        v = float(m.group(1))
        return 'kg', (price / v * 1000) if m.group(3) in ('gm','gram','g') else (price / v if v else price)
    m = re.search(r'(\d+(\.\d+)?)\s*(ltr|liter|l|ml)\b', t)
    if m:
        v = float(m.group(1))
        return 'liter', (price / v * 1000) if m.group(3) == 'ml' else (price / v if v else price)
    if any(x in t for x in ['pc','piece','hali','dozen','pkt','pack','each','bottle','can','box']):
        return 'piece', price
    return 'kg', price

def scrape_category(cat_id, cat_name, parent_name, seen_ids, lock):
    products = []; page = 1; total_pages = 1
    cat_path = f'{parent_name} > {cat_name}' if parent_name else cat_name
    while page <= total_pages:
        body = {"DiscountIds":[0],"FirstItem":0,"HasNextPage":True,"HasPreviousPage":False,
                "IsEmi":0,"IsOthobaCetified":0,"LastItem":0,"ManufacturerIds":[0],"OrderBy":0,
                "PageNumber":page,"PageSize":PAGE_SIZE,"Price":"ea e","RatingFilterIds":[0],
                "SpecificationOptionIds":[0],"TotalItems":0,"TotalPages":0,"VendorIds":[0],
                "view_mode":"exercitation sint"}
        try:
            data = req(f'/Catalog/GetCategoryProducts/{cat_id}', body)
            cm = data.get('catalog_products_model') or data
            pf = cm.get('paging_filtering_model') or cm
            total_pages = min(pf.get('total_pages', 1) or 1, MAX_PAGES)
            for p in cm.get('products', []):
                pid = p.get('id')
                with lock:
                    if pid in seen_ids: continue
                    seen_ids.add(pid)
                pp = p.get('product_price', {})
                img = p.get('default_picture_model', {})
                price = parse_price(pp, 'price') or 0
                ut, np_ = parse_unit(p.get('name',''), price)
                products.append({
                    'id': f'ot_{pid}', 'name': p.get('name',''),
                    'store': 'othoba',
                    'category': cat_name,
                    'category_path': cat_path,
                    'unit': p.get('sku',''), 'unit_type': ut,
                    'current_price': price,
                    'normalized_price': np_,
                    'image': img.get('image_url',''), 'url': '',
                    'first_seen': datetime.now().strftime('%Y-%m-%d'),
                    'old_price': parse_price(pp, 'old_price'),
                    'discount_text': pp.get('discount_display_text') or '',
                    'rating': p.get('review_overview_model',{}).get('rating_value'),
                    'sold': p.get('product_total_sold_quantity_model',{}).get('TotalQuantity',0)
                })
            page += 1
        except Exception as e:
            break
    if products:
        print(f'  [OK] {cat_path:45s} {len(products):4d} products')
        sys.stdout.flush()
    return products

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    print('Othoba API Scraper v2\n')

    print('[1/3] Fetching catalog root...')
    sys.stdout.flush()
    try:
        root = req('/Catalog/GetCatalogRoot')
    except Exception as e:
        print(f'[FAIL] {e}')
        sys.exit(1)

    cats = []
    for top in root:
        subs = top.get('sub_categories', [])
        if subs:
            for sub in subs:
                sid = sub.get('id')
                if sid:
                    cats.append({'id': sid, 'name': sub['name'], 'parent': top['name']})
        else:
            tid = top.get('id')
            if tid:
                cats.append({'id': tid, 'name': top['name'], 'parent': ''})
    print(f'       {len(cats)} leaf categories found\n')

    print('[2/3] Scraping products...')
    sys.stdout.flush()
    all_products = []; seen_ids = set(); lock = Lock()
    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = {ex.submit(scrape_category, c['id'], c['name'], c['parent'], seen_ids, lock): c for c in cats}
        for f in as_completed(futures):
            all_products.extend(f.result())

    print(f'\n       Total unique: {len(all_products)} products\n')

    print('[3/3] Merging price history and saving...')
    if not all_products:
        print('[WARN] No products scraped. Preserving existing datasets to avoid data loss.')
        return

    today = datetime.now().strftime('%Y-%m-%d')
    hist_dir = os.path.join(OUT_DIR, 'history')
    os.makedirs(hist_dir, exist_ok=True)
    
    # Save daily snapshot
    snapshot_path = os.path.join(hist_dir, f'othoba_products_{today}.json')
    with open(snapshot_path, 'w', encoding='utf-8') as f:
        json.dump(all_products, f, indent=2, ensure_ascii=False)
    print(f'       -> Snapshot: {snapshot_path} ({len(all_products)} products)')

    # Load existing master products to accumulate history
    fpath = os.path.join(OUT_DIR, 'othoba_products.json')
    existing_map = {}
    if os.path.exists(fpath):
        try:
            with open(fpath, 'r', encoding='utf-8') as f:
                old_list = json.load(f)
                for item in old_list:
                    if isinstance(item, dict) and 'id' in item:
                        existing_map[item['id']] = item
        except Exception as e:
            print(f'       [WARN] Could not parse existing master: {e}')

    merged_products = []
    scraped_ids = set()

    for p in all_products:
        pid = p['id']
        scraped_ids.add(pid)
        curr_price = p['current_price']
        norm_price = p['normalized_price']
        
        old_item = existing_map.get(pid)
        hist = []
        if old_item and isinstance(old_item.get('history'), list):
            hist = [h for h in old_item['history'] if isinstance(h, dict) and h.get('date') != today]
        
        hist.append({
            'date': today,
            'price': curr_price,
            'normalized_price': norm_price
        })
        
        prices = [h['price'] for h in hist if h.get('price')]
        norm_prices = [h['normalized_price'] for h in hist if h.get('normalized_price')]
        
        p['first_seen'] = old_item.get('first_seen', today) if old_item else today
        p['last_seen'] = today
        p['history'] = hist
        p['hist_count'] = len(hist)
        p['min_price'] = min(prices) if prices else curr_price
        p['max_price'] = max(prices) if prices else curr_price
        p['avg_price'] = round(sum(prices) / len(prices), 2) if prices else curr_price
        merged_products.append(p)

    # Retain products seen in earlier scrapes but missed today
    for pid, old_item in existing_map.items():
        if pid not in scraped_ids:
            merged_products.append(old_item)

    with open(fpath, 'w', encoding='utf-8') as f:
        json.dump(merged_products, f, indent=2, ensure_ascii=False)
    print(f'       -> {fpath} ({len(merged_products)} products)')

    dpath = os.path.join(OUT_DIR, 'othoba_data.js')
    with open(dpath, 'w', encoding='utf-8') as f:
        f.write(f'window.othoba_data = {json.dumps(merged_products, ensure_ascii=False)};')
    print(f'       -> {dpath}')

    prices = [p['current_price'] for p in merged_products if p.get('current_price')]
    discs = sum(1 for p in merged_products if p.get('old_price'))
    print(f'\n       Products: {len(merged_products)}  |  Discounts: {discs}')
    if prices: print(f'       Price: {min(prices):.0f} - {max(prices):.0f} Tk')

if __name__ == '__main__':
    main()
