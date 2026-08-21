"""
Othoba Analytics — Master Dual-Source Orchestrator (Web Playwright + App Mobile API)
Runs both scrapers in parallel, syncs SQLite database, and exports chunked frontend datasets.
"""
import os
import sys
import json
import sqlite3
import subprocess
import threading
import re
from datetime import datetime, timezone, timedelta
from collections import defaultdict

DHAKA_TZ = timezone(timedelta(hours=6))
DIR_PATH = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(DIR_PATH, "frontend")
os.makedirs(FRONTEND_DIR, exist_ok=True)

_print_lock = threading.Lock()

def _run_script_live(script_path, cwd):
    if not os.path.exists(script_path):
        print(f"[Orchestrator] Warning: {script_path} not found.")
        return
    print(f"[Orchestrator] Running {os.path.basename(script_path)} live...")
    try:
        proc = subprocess.Popen([sys.executable, "-u", script_path], cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        for line in proc.stdout:
            with _print_lock:
                sys.stdout.write(line)
                sys.stdout.flush()
        proc.wait(timeout=1800)
    except Exception as e:
        print(f"[Orchestrator] Error running {os.path.basename(script_path)}: {e}")

def export_frontend_chunks():
    print("\n[Othoba-analytics] Exporting database & app data to frontend chunked datasets...")
    db_path = os.path.join(DIR_PATH, "othoba_tracker.db")
    if not os.path.exists(db_path):
        db_path = os.path.join(DIR_PATH, "backend", "othoba_tracker.db")
    
    if not os.path.exists(db_path):
        print("[Othoba-analytics] Error: othoba_tracker.db not found for export.")
        return 0

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    cursor.execute("SELECT product_id, timestamp, price_amount, is_out_of_stock FROM price_history ORDER BY timestamp ASC")
    hist_by_pid = defaultdict(list)
    for r in cursor.fetchall():
        d_str = str(r['timestamp'])[:10]
        p_val = float(r['price_amount'] or 0)
        oos = bool(r['is_out_of_stock']) if 'is_out_of_stock' in r.keys() else (p_val <= 0)
        hist_by_pid[r['product_id']].append({
            'date': d_str,
            'price': p_val if not oos else -1.0,
            'normalized_price': p_val if not oos else -1.0
        })

    existing_meta = {}
    manifest_path = os.path.join(FRONTEND_DIR, "othoba_manifest.json")
    if os.path.exists(manifest_path):
        try:
            with open(manifest_path, "r", encoding="utf-8") as mf:
                manifest_obj = json.load(mf)
                for part in manifest_obj.get("parts", []):
                    ppath = os.path.join(FRONTEND_DIR, part)
                    if os.path.exists(ppath):
                        with open(ppath, "r", encoding="utf-8") as pf:
                            for item in json.load(pf):
                                clean_id = str(item.get("id", "")).replace("ot_", "")
                                existing_meta[clean_id] = item
        except Exception as e:
            print(f"[Othoba-analytics] Notice reading existing chunks: {e}")

    cursor.execute("SELECT id, name, sku, vendor_name, category_name, image_url, extracted_unit_type, extracted_unit_value FROM products")
    db_prods = cursor.fetchall()
    all_merged = []
    seen_pids = set()
    today_dhaka = datetime.now(DHAKA_TZ).strftime("%Y-%m-%d")

    for row in db_prods:
        pid = str(row['id'])
        clean_id = pid.replace('ot_', '')
        seen_pids.add(clean_id)
        name = row['name'] or ''
        cat = row['category_name'] or 'General'
        img = row['image_url'] or ''
        sku = row['sku'] or 'N/A'
        ut = row['extracted_unit_type'] or 'piece'
        
        h_list = hist_by_pid.get(pid, []) or hist_by_pid.get(clean_id, [])
        unique_h = {h['date']: h for h in h_list if h.get('date')}
        
        app_meta = existing_meta.get(clean_id, {})
        if app_meta.get('history'):
            for ah in app_meta['history']:
                if ah.get('date') and ah['date'] not in unique_h:
                    unique_h[ah['date']] = ah
                    
        sorted_h = sorted(unique_h.values(), key=lambda x: x['date'])
        curr_p = sorted_h[-1]['price'] if sorted_h else (app_meta.get('current_price') or 0)
        norm_p = sorted_h[-1]['normalized_price'] if sorted_h else (app_meta.get('normalized_price') or curr_p)
        valid_prices = [h['price'] for h in sorted_h if h['price'] > 0]
        
        first_seen = sorted_h[0]['date'] if sorted_h else today_dhaka
        last_seen = sorted_h[-1]['date'] if sorted_h else today_dhaka
        
        all_merged.append({
            'id': f'ot_{clean_id}',
            'name': name or app_meta.get('name', 'Product'),
            'store': 'othoba',
            'category': cat,
            'category_path': app_meta.get('category_path', cat),
            'unit': sku,
            'unit_type': ut,
            'current_price': curr_p,
            'normalized_price': norm_p,
            'image': img or app_meta.get('image', ''),
            'url': app_meta.get('url', f'https://othoba.com/p/{clean_id}'),
            'first_seen': first_seen,
            'last_seen': last_seen,
            'in_stock': curr_p > 0,
            'is_out_of_stock': curr_p <= 0,
            'old_price': app_meta.get('old_price'),
            'discount_text': app_meta.get('discount_text', ''),
            'rating': app_meta.get('rating'),
            'sold': app_meta.get('sold', 0),
            'history': sorted_h,
            'hist_count': len(sorted_h),
            'min_price': min(valid_prices) if valid_prices else curr_p,
            'max_price': max(valid_prices) if valid_prices else curr_p,
            'avg_price': round(sum(valid_prices)/len(valid_prices), 2) if valid_prices else curr_p
        })

    for clean_id, app_meta in existing_meta.items():
        if clean_id not in seen_pids:
            all_merged.append(app_meta)

    conn.close()

    # Split into safe chunks
    CHUNK_SIZE = 40000
    chunks = [all_merged[i:i + CHUNK_SIZE] for i in range(0, len(all_merged), CHUNK_SIZE)]
    manifest_parts = []

    for idx, chunk in enumerate(chunks, 1):
        chunk_filename = f"othoba_products_part{idx}.json"
        chunk_path = os.path.join(FRONTEND_DIR, chunk_filename)
        with open(chunk_path, "w", encoding="utf-8") as f:
            json.dump(chunk, f, separators=(',', ':'), ensure_ascii=False)
        mb = os.path.getsize(chunk_path) / 1024 / 1024
        manifest_parts.append(chunk_filename)
        print(f"  [Frontend Chunk] {chunk_filename}: {len(chunk)} items ({mb:.2f} MB)")

    manifest = {
        "total_items": len(all_merged),
        "parts": manifest_parts,
        "generated_at": today_dhaka
    }
    with open(os.path.join(FRONTEND_DIR, "othoba_manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    return len(all_merged)

def main():
    print("=" * 60)
    print("OTHOBA ANALYTICS // Master Multi-Source Orchestrator")
    print("=" * 60)
    web_script = os.path.join(DIR_PATH, "scraper_web.py")
    app_script = os.path.join(DIR_PATH, "scraper_app.py")

    t_web = threading.Thread(target=_run_script_live, args=(web_script, DIR_PATH), daemon=True)
    t_app = threading.Thread(target=_run_script_live, args=(app_script, DIR_PATH), daemon=True)

    t_web.start()
    t_app.start()

    t_web.join()
    t_app.join()

    total_prods = export_frontend_chunks()

    log_file = os.path.join(DIR_PATH, "last_run_log.txt")
    with open(log_file, "w", encoding="utf-8") as lf:
        lf.write(f"Othoba Scraper Complete\nTotal Products: {total_prods}\nUpdated at: {datetime.now(DHAKA_TZ).strftime('%Y-%m-%d %H:%M:%S DHAKA')}\n")
    print(f"\n[DONE] Othoba Analytics scrape & export completed successfully ({total_prods} products).")

if __name__ == "__main__":
    main()
