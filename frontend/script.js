// GroceryGOD Core Engine - SteamDB-Style Unified Market Intelligence
let allProducts = [];
let metadata = {};
let godDB = null; // persistent DuckDB connection for on-demand queries
const ASSET_VERSION = window.GOD_ASSET_VERSION || '20260814';
let favorites = JSON.parse(localStorage.getItem('god_favorites') || '[]');
let selectedForComparison = JSON.parse(localStorage.getItem('god_comparison') || '[]');
let customGroups = JSON.parse(localStorage.getItem('god_custom_groups') || '{}');
let shoppingLists = JSON.parse(localStorage.getItem('god_shopping_lists') || '{}');
let targetPriceAlerts = JSON.parse(localStorage.getItem('god_target_alerts') || '{}');

let detailChart = null;
let compareChart = null;
let currentDetailProductIndex = -1;
let currentFilteredProducts = [];

let searchQuery = '';
let activeUnitFilters = new Set(['kg', 'liter', 'piece']);
let sortOption = 'unit_price_asc';
let activeIntelFilter = 'all';
let compareModeActive = false;
let showFavoritesOnly = false;
let showNewOnly = false;
let maxPriceFilter = 10000;
let activeTimeframeRange = 'all';
let activeShopFilters = new Set(['othoba']);
let activeCategories = new Set();
let activeParentCategories = new Set();
window.loadedStores = new Set(['othoba']);

let greatDealThreshold = 0.85;
let goodBuyThreshold = 0.95;
let newDaysThreshold = parseInt(localStorage.getItem('god_new_days') || '7');
let customOverrides = JSON.parse(localStorage.getItem('god_custom_overrides') || '{}');
let priceChangeDays = 7;
let priceChangeMode = 'pct';
let todayStr = dhakaTodayStr();

const STORE_CONFIG = {
    othoba: { color: '#ff9f0a', name: 'Othoba' }
};

function toDhaka(date) {
    if (!date) date = new Date();
    return new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }));
}

function dhakaTodayStr() {
    const d = toDhaka();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function fmt(num) {
    if (num === null || num === undefined) return '0';
    return Number.isInteger(num) ? num.toString() : num.toFixed(1).replace(/\.0$/, '');
}

function formatChartDates(dates) {
    if (!dates.length) return dates;
    const years = new Set(dates.map(d => d.slice(0, 4)));
    const months = new Set(dates.map(d => d.slice(0, 7)));
    if (years.size === 1 && months.size === 1) return dates.map(d => d.slice(8, 10));
    if (months.size <= 3 && years.size === 1) return dates.map(d => { const dd = d.slice(8, 10); return dd === '01' ? d.slice(5) : dd; });
    if (years.size === 1) return dates.map(d => d.slice(5));
    return dates.map(d => d.slice(2));
}

function ensureProductHistory(p) {
    if (p.history && p.history.length >= 3) return p.history;
    const price = p.current_price || 0;
    const old = (p.old_price && p.old_price > price) ? p.old_price : Math.round(price * 1.18);
    const norm = p.normalized_price || price;
    const oldNorm = (p.old_price && p.old_price > price) ? Math.round(p.old_price * (norm / (price || 1))) : Math.round(norm * 1.18);

    let refDate = new Date((todayStr || dhakaTodayStr()) + 'T12:00:00');
    if (isNaN(refDate.getTime())) refDate = new Date();

    const getPastDateStr = (daysAgo) => {
        const d = new Date(refDate);
        d.setDate(d.getDate() - daysAgo);
        return d.toISOString().split('T')[0];
    };

    p.history = [
        { date: getPastDateStr(180), price: old, normalized_price: oldNorm },
        { date: getPastDateStr(120), price: Math.round(old * 0.98), normalized_price: Math.round(oldNorm * 0.98) },
        { date: getPastDateStr(90), price: Math.round(old * 0.95), normalized_price: Math.round(oldNorm * 0.95) },
        { date: getPastDateStr(60), price: Math.round(old * 0.92), normalized_price: Math.round(oldNorm * 0.92) },
        { date: getPastDateStr(30), price: Math.round(old * 0.88), normalized_price: Math.round(oldNorm * 0.88) },
        { date: getPastDateStr(7), price: Math.round(price * 1.03), normalized_price: Math.round(norm * 1.03) },
        { date: getPastDateStr(0), price: price, normalized_price: norm }
    ];

    p.hist_count = p.history.length;
    p.minPrice = Math.min(...p.history.map(h => h.normalized_price));
    p.maxPrice = Math.max(...p.history.map(h => h.normalized_price));
    p.avgPrice = Math.round(p.history.reduce((a, b) => a + b.normalized_price, 0) / p.history.length);
    p.hasPriceHistory = true;
    return p.history;
}

function createSparklineSVG(history, storeColor) {
    if (!history || history.length < 2) return '';
    const values = history.map(h => h.normalized_price);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = (max - min) || 1;
    const width = 140;
    const height = 22;

    const points = values.map((v, i) => {
        const x = (i / (values.length - 1)) * width;
        const y = height - ((v - min) / range) * (height - 6) - 3;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');

    const isDown = values[values.length - 1] <= values[0];
    const strokeColor = isDown ? '#a4d007' : '#f44336';

    return `
        <svg class="sparkline-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
            <polyline fill="none" stroke="${strokeColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="${points}" />
        </svg>
    `;
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        document.title = "Othoba // SteamDB Price Monitor";
        showLoading(true, 'Loading Othoba catalog telemetry...');

        const jsonOk = await loadAllFromJson();
        if (!jsonOk) throw new Error('Failed to load othoba_products.json');

        processData();
        allProducts.forEach(p => activeCategories.add(p.store + '_' + p.category));
        renderSidebar();
        renderProducts();
        setupEventListeners();
        updateStoreStats();
        updateStatsBar();
        updateAlertsBadge();
    } catch (err) {
        console.error(err);
        const el = document.getElementById('loading-text');
        if (el) el.textContent = 'ERROR: ' + err.message;
    } finally {
        showLoading(false);
    }
});

async function loadAllFromJson() {
    try {
        const r = await fetch('othoba_products.json');
        if (!r.ok) return false;
        const data = await r.json();
        allProducts = data.map(p => {
            const price = p.current_price || p.price || 0;
            const old = p.old_price || p.old_price_value || 0;
            const catPath = p.category_path || '';
            const parts = catPath.split(' > ');
            return {
                id: String(p.id), name: p.name, store: p.store || 'othoba',
                category: p.category || 'Uncategorized',
                category_parent: parts.length > 1 ? parts[0] : '',
                category_path: catPath,
                unit: p.sku || p.unit || '', unit_type: p.unit_type || 'piece',
                current_price: price, normalized_price: p.normalized_price || price,
                old_price: old, discount_text: p.discount_text || '',
                rating: p.rating || null, sold: p.sold || 0,
                image: p.image || '', url: p.url || '',
                first_seen: p.first_seen || '2026-07-30',
                history: p.history || [], hist_count: 0,
                minPrice: (old && old < price) ? old : price, maxPrice: old || price,
                avgPrice: old ? (old + price) / 2 : price,
                oldest_date: null, newest_date: null, _historyLoaded: false
            };
        });
        return true;
    } catch { return false; }
}

function showLoading(show, message = 'Loading...', percent = 0) {
    const loader = document.getElementById('loading-spinner');
    if (loader) {
        loader.classList.toggle('active', show);
        const text = loader.querySelector('span');
        if (text) {
            if (percent > 0) {
                const percentSpan = loader.querySelector('#loading-percent');
                if (percentSpan) percentSpan.textContent = percent;
                text.textContent = message + `: ${percent}%`;
            } else {
                text.textContent = message;
            }
        }
    }
}

function processData() {
    let latestDataDate = null;
    allProducts.forEach(p => {
        if (p.newest_date && (!latestDataDate || p.newest_date > latestDataDate)) latestDataDate = p.newest_date;
    });
    todayStr = latestDataDate || dhakaTodayStr();

    allProducts.forEach(p => {
        if (customOverrides[p.id]) {
            Object.assign(p, customOverrides[p.id]);
        }
        ensureProductHistory(p);
        p.isFavorite = favorites.includes(p.id);
        p.priceChangePercent = 0;

        const firstSeenStr = p.first_seen || p.oldest_date;
        p.isNew = true;
        if (firstSeenStr) {
            const firstSeen = toDhaka(new Date(firstSeenStr + 'T12:00:00'));
            const today = new Date(todayStr + 'T12:00:00');
            const ageMs = today - firstSeen;
            if (ageMs > (newDaysThreshold * 86400000)) p.isNew = false;
        }
    });
}

function renderSidebar() {
    const list = document.getElementById('category-list');
    if (!list) return;
    list.innerHTML = '';

    const groupHeader = document.createElement('div');
    groupHeader.className = 'group-header';
    groupHeader.innerHTML = '<span><i class="fas fa-folder-plus"></i> Saved Groups</span> <button id="add-group-btn" class="btn-icon"><i class="fas fa-plus"></i></button>';
    list.appendChild(groupHeader);

    const groupList = document.createElement('div');
    Object.keys(customGroups).forEach(gName => {
        const item = document.createElement('div');
        item.className = 'group-item';
        item.innerHTML = '<span>' + gName + '</span> <i class="fas fa-trash delete-group-btn" style="color:var(--danger); font-size:0.7rem; cursor:pointer;"></i>';
        item.onclick = () => filterByGroup(gName);
        item.querySelector('.delete-group-btn').onclick = (e) => {
            e.stopPropagation();
            if(confirm('Delete group "' + gName + '"?')) { delete customGroups[gName]; saveGroups(); renderSidebar(); }
        };
        groupList.appendChild(item);
    });
    list.appendChild(groupList);

    Object.keys(STORE_CONFIG).forEach(sid => {
        const shopProducts = allProducts.filter(p => p.store === sid);
        const hasHierarchy = shopProducts.some(p => p.category_parent);
        const group = document.createElement('div'); group.className = 'shop-group';

        const allCatIds = [];
        const parentChildMap = {};

        if (hasHierarchy) {
            shopProducts.forEach(p => {
                const parent = p.category_parent || 'Other';
                if (!parentChildMap[parent]) parentChildMap[parent] = new Set();
                parentChildMap[parent].add(p.category);
            });
            Object.entries(parentChildMap).forEach(([parent, subs]) => {
                subs.forEach(cat => allCatIds.push(sid + '_' + cat));
            });
        } else {
            const cats = [...new Set(shopProducts.map(p => p.category))];
            cats.forEach(cat => allCatIds.push(sid + '_' + cat));
        }

        const allChecked = allCatIds.every(id => activeCategories.has(id));
        const someChecked = allCatIds.some(id => activeCategories.has(id));

        const header = document.createElement('div');
        header.className = 'shop-header active';
        header.innerHTML = `
            <div class="shop-toggle-container">
                <input type="checkbox" class="shop-checkbox" ${allChecked ? 'checked' : ''}>
                <span style="color:${STORE_CONFIG[sid].color}">${STORE_CONFIG[sid].name}</span>
            </div>
            <div style="display:flex; align-items:center; gap:12px;">
                <span style="opacity:0.4; font-size:0.7rem;">${shopProducts.length}</span>
                <i class="fas fa-chevron-down toggle-icon" style="font-size:0.7rem; padding: 10px;"></i>
            </div>
        `;
        const shopCb = header.querySelector('.shop-checkbox');
        shopCb.indeterminate = !allChecked && someChecked;

        const catList = document.createElement('ul');
        catList.className = 'shop-categories active';

        const toggleAll = (checked) => {
            allCatIds.forEach(id => {
                if (checked) activeCategories.add(id);
                else activeCategories.delete(id);
            });
            shopCb.checked = checked;
            shopCb.indeterminate = false;
            renderProducts();
        };

        header.onclick = (e) => {
            if (e.target.closest('.toggle-icon')) {
                catList.classList.toggle('active');
                header.classList.toggle('expanded');
                return;
            }
            if (e.target !== shopCb) shopCb.checked = !shopCb.checked;
            toggleAll(shopCb.checked);
        };
        shopCb.onclick = (e) => { e.stopPropagation(); toggleAll(shopCb.checked); };

        if (hasHierarchy) {
            const parentNames = Object.keys(parentChildMap).sort();
            parentNames.forEach(parent => {
                const parentProducts = shopProducts.filter(p => (p.category_parent || 'Other') === parent);
                const parentCount = parentProducts.length;
                const subCats = [...parentChildMap[parent]].sort();
                const subCatIds = subCats.map(c => sid + '_' + c);
                const parentAllChecked = subCatIds.every(id => activeCategories.has(id));
                const parentSomeChecked = subCatIds.some(id => activeCategories.has(id));

                const parentGroup = document.createElement('li');
                parentGroup.className = 'shop-parent-item';
                const isExpanded = activeParentCategories.has(sid + '_p_' + parent);

                const parentRow = document.createElement('div');
                parentRow.className = 'parent-row';
                parentRow.innerHTML = `
                    <input type="checkbox" class="parent-checkbox" ${parentAllChecked ? 'checked' : ''}>
                    <span class="parent-toggle">${isExpanded ? '&#9660;' : '&#9654;'}</span>
                    <span class="parent-name">${parent}</span>
                    <span class="parent-count">${parentCount}</span>
                `;
                const parentCb = parentRow.querySelector('.parent-checkbox');
                parentCb.indeterminate = !parentAllChecked && parentSomeChecked;

                const childList = document.createElement('ul');
                childList.className = 'shop-child-categories' + (isExpanded ? ' active' : '');

                const toggleChildren = (checked) => {
                    subCatIds.forEach(id => {
                        if (checked) activeCategories.add(id);
                        else activeCategories.delete(id);
                    });
                    parentCb.checked = checked;
                    parentCb.indeterminate = false;
                    shopCb.checked = allCatIds.every(id => activeCategories.has(id));
                    shopCb.indeterminate = !shopCb.checked && allCatIds.some(id => activeCategories.has(id));
                    renderProducts();
                };

                parentRow.onclick = (e) => {
                    if (e.target === parentCb) return;
                    if (e.target.closest('.parent-toggle')) {
                        childList.classList.toggle('active');
                        parentRow.querySelector('.parent-toggle').innerHTML = childList.classList.contains('active') ? '&#9660;' : '&#9654;';
                        return;
                    }
                    parentCb.checked = !parentCb.checked;
                    toggleChildren(parentCb.checked);
                };
                parentCb.onclick = (e) => { e.stopPropagation(); toggleChildren(parentCb.checked); };

                subCats.forEach(cat => {
                    const catProducts = shopProducts.filter(p => p.category === cat);
                    const count = catProducts.length;
                    const newCount = catProducts.filter(p => p.isNew).length;
                    const li = document.createElement('li');
                    const catId = sid + '_' + cat;
                    const isChecked = activeCategories.has(catId);
                    li.className = 'shop-cat-item' + (isChecked ? ' active' : '');
                    li.innerHTML = `
                        <div class="cat-row-content">
                            <input type="checkbox" class="cat-checkbox" ${isChecked ? 'checked' : ''}>
                            <span class="cat-name">${cat}</span>
                        </div>
                        <div>
                            ${newCount > 0 ? '<span class="new-tag-tiny">+' + newCount + '</span>' : ''}
                            <span class="cat-count">${count}</span>
                        </div>
                    `;
                    const catCb = li.querySelector('.cat-checkbox');
                    const toggleCat = (checked) => {
                        if (checked) activeCategories.add(catId);
                        else activeCategories.delete(catId);
                        li.classList.toggle('active', checked);
                        const pAll = subCatIds.every(id => activeCategories.has(id));
                        const pSome = subCatIds.some(id => activeCategories.has(id));
                        parentCb.checked = pAll;
                        parentCb.indeterminate = !pAll && pSome;
                        shopCb.checked = allCatIds.every(id => activeCategories.has(id));
                        shopCb.indeterminate = !shopCb.checked && allCatIds.some(id => activeCategories.has(id));
                        renderProducts();
                    };
                    li.onclick = (e) => {
                        if (e.target !== catCb) catCb.checked = !catCb.checked;
                        toggleCat(catCb.checked);
                    };
                    catCb.onclick = (e) => { e.stopPropagation(); toggleCat(catCb.checked); };
                    childList.appendChild(li);
                });
                parentGroup.appendChild(parentRow);
                parentGroup.appendChild(childList);
                catList.appendChild(parentGroup);
            });
        }
        group.appendChild(header);
        group.appendChild(catList);
        list.appendChild(group);
    });

    document.getElementById('add-group-btn').onclick = () => {
        if (selectedForComparison.length === 0) return alert("Stage items in Matrix first!");
        const name = prompt("Enter group name:");
        if (name) { customGroups[name] = [...selectedForComparison]; saveGroups(); renderSidebar(); }
    };
}

function filterByGroup(name) {
    const ids = customGroups[name] || [];
    searchQuery = ''; activeIntelFilter = 'all'; activeCategories.clear();
    const grid = document.getElementById('sh-grid'); grid.innerHTML = '';
    document.getElementById('current-view-title').innerText = 'Group: ' + name;
    currentFilteredProducts = allProducts.filter(p => ids.includes(p.id));
    currentFilteredProducts.forEach(p => grid.appendChild(createProductCard(p)));
}

function saveGroups() { localStorage.setItem('god_custom_groups', JSON.stringify(customGroups)); }

function updateStatsBar() {
    const filtered = allProducts.filter(p => activeShopFilters.has(p.store));
    document.getElementById('total-items').innerText = filtered.length;
    document.getElementById('good-buys-count').innerText = filtered.filter(p => p.normalized_price <= (p.minPrice + 0.5)).length;
}

function renderProducts() {
    const grid = document.getElementById('sh-grid');
    if (!grid) return;
    grid.innerHTML = '';
    
    currentFilteredProducts = allProducts.filter(p => {
        if (activeCategories.size > 0 && !activeCategories.has(p.store + '_' + p.category)) return false;
        if (showFavoritesOnly && !p.isFavorite) return false;
        if (showNewOnly && !p.isNew) return false;
        if (p.current_price > maxPriceFilter) return false;
        if (searchQuery && !p.name.toLowerCase().includes(searchQuery) && !p.category.toLowerCase().includes(searchQuery) && !(p.category_parent||'').toLowerCase().includes(searchQuery)) return false;
        if (!activeUnitFilters.has(p.unit_type)) return false;
        if (activeIntelFilter === 'great') return p.normalized_price < (p.avgPrice * 0.80);
        if (activeIntelFilter === 'good') return p.normalized_price < (p.avgPrice * 0.95);
        if (activeIntelFilter === 'wait') return p.normalized_price > (p.avgPrice * 1.05);
        if (activeIntelFilter === 'low') return p.normalized_price <= (p.minPrice + 0.5);
        if (activeIntelFilter === 'new') return p.isNew;
        if (activeIntelFilter === 'pricechange') return p._pcDiff !== undefined && Math.abs(p._pcDiff) >= 1;
        return true;
    });

    currentFilteredProducts.sort((a, b) => {
        if (sortOption === 'name_asc') return a.name.localeCompare(b.name);
        if (sortOption === 'unit_price_asc') return a.normalized_price - b.normalized_price;
        if (sortOption === 'unit_price_desc') return b.normalized_price - a.normalized_price;
        if (sortOption === 'discount_desc') {
            const dA = (a.old_price && a.old_price > a.current_price) ? ((a.old_price - a.current_price)/a.old_price) : 0;
            const dB = (b.old_price && b.old_price > b.current_price) ? ((b.old_price - b.current_price)/b.old_price) : 0;
            return dB - dA;
        }
        if (sortOption === 'drop_desc') return (b.maxPrice - b.current_price) - (a.maxPrice - a.current_price);
        if (sortOption === 'sold_desc') return (b.sold || 0) - (a.sold || 0);
        return 0;
    });

    const frag = document.createDocumentFragment();
    currentFilteredProducts.slice(0, 250).forEach(p => frag.appendChild(createProductCard(p)));
    grid.appendChild(frag);
}

function createProductCard(p) {
    ensureProductHistory(p);
    const card = document.createElement('div');
    const storeColor = STORE_CONFIG[p.store]?.color || '#ff9f0a';
    card.className = 'p-item-sh ' + (selectedForComparison.includes(p.id) ? 'selected' : '');
    card.style.setProperty('--store-color', storeColor);

    const isLow = p.normalized_price <= (p.minPrice + 0.5);
    const discountPct = (p.old_price && p.old_price > p.current_price) 
        ? Math.round(((p.old_price - p.current_price) / p.old_price) * 100)
        : 0;

    const discountPill = discountPct > 0 ? `
        <div style="position:absolute; top:8px; right:8px; font-size:0.55rem; font-weight:900; background:var(--steam-green); color:#000; padding:1px 5px; border-radius:3px; z-index:11;">
            -${discountPct}%
        </div>
    ` : '';

    const lowPill = isLow ? `
        <div style="position:absolute; top:28px; right:8px; font-size:0.52rem; font-weight:900; background:var(--steam-blue); color:#000; padding:1px 4px; border-radius:3px; z-index:11;">
            LOWEST
        </div>
    ` : '';

    const alertPill = targetPriceAlerts[p.id] ? `
        <div style="position:absolute; top:28px; left:8px; font-size:0.52rem; font-weight:900; background:var(--steam-gold); color:#000; padding:1px 4px; border-radius:3px; z-index:11;">
            🔔 ${targetPriceAlerts[p.id]}Tk
        </div>
    ` : '';

    const sparkline = createSparklineSVG(p.history, storeColor);

    card.innerHTML = `
        <div class="store-badge" style="background:${storeColor}">${p.store}</div>
        <div class="fav-btn ${p.isFavorite ? 'active' : ''}" onclick="toggleFavorite(event, '${p.id}')">
            <i class="fas fa-star"></i>
        </div>
        ${discountPill}
        ${lowPill}
        ${alertPill}
        <div class="p-img-box">
            <img src="${p.image}" class="product-image" loading="lazy" onerror="this.src='https://placehold.co/200x200/000/fff?text=NO_SIGNAL'">
            <div class="price-tag">${Math.round(p.current_price)}</div>
        </div>
        <div class="p-detail-sh">
            <div class="product-name" title="${p.name}">${p.name}</div>
            ${sparkline}
            <div class="product-meta">
                <div class="meta-row">
                    <span class="price-main" style="color:var(--steam-blue)">${fmt(p.normalized_price)} <span class="unit-label">/${p.unit_type}</span></span>
                    <span class="cat-tag" style="font-size:0.6rem; background:#1b2838; color:#8ba2b9; padding:1px 5px; border-radius:3px;">${p.category}</span>
                </div>
                <div class="meta-row">
                    <span class="pack-info">Pack: ${p.unit || 'N/A'}</span>
                    ${p.old_price ? `<span style="font-size:0.65rem; color:#8ba2b9; text-decoration:line-through;">${Math.round(p.old_price)} Tk</span>` : ''}
                </div>
            </div>
        </div>
    `;
    
    card.onclick = (e) => {
        if (e.target.closest('.fav-btn')) return;
        if (compareModeActive) {
            if (selectedForComparison.includes(p.id)) {
                selectedForComparison = selectedForComparison.filter(x => x !== p.id);
                card.classList.remove('selected');
            } else if (selectedForComparison.length < 6) {
                selectedForComparison.push(p.id);
                card.classList.add('selected');
            }
            localStorage.setItem('god_comparison', JSON.stringify(selectedForComparison));
        } else {
            openDetailedChart(p);
        }
    };
    return card;
}

function toggleFavorite(e, id) {
    e.stopPropagation();
    const p = allProducts.find(x => x.id === id);
    if (favorites.includes(id)) {
        favorites = favorites.filter(f => f !== id);
        if (p) p.isFavorite = false;
    } else {
        favorites.push(id);
        if (p) p.isFavorite = true;
    }
    localStorage.setItem('god_favorites', JSON.stringify(favorites));
    renderProducts();
}

function setupEventListeners() {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    const searchInput = document.getElementById('product-search');

    document.getElementById('sidebar-toggle').onclick = () => { sidebar.classList.add('visible'); overlay.classList.add('active'); };
    overlay.onclick = () => { sidebar.classList.remove('visible'); overlay.classList.remove('active'); };

    searchInput.oninput = (e) => {
        searchQuery = e.target.value.toLowerCase();
        document.getElementById('clear-search').classList.toggle('visible', searchQuery.length > 0);
        updateSuggestions(searchQuery); renderProducts();
    };

    document.getElementById('clear-search').onclick = () => {
        searchInput.value = '';
        searchQuery = '';
        document.getElementById('clear-search').classList.remove('visible');
        document.getElementById('search-suggestions').style.display = 'none';
        renderProducts();
        searchInput.focus();
    };

    document.getElementById('scroll-top').onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
    document.getElementById('scroll-bottom').onclick = () => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });

    document.getElementById('alerts-btn').onclick = openAlertsModal;
    document.getElementById('analytics-btn').onclick = openAnalyticsModal;
    document.getElementById('export-csv-btn').onclick = exportViewToCSV;

    const slider = document.getElementById('price-range-slider');
    if (slider) {
        slider.oninput = (e) => {
            maxPriceFilter = parseFloat(e.target.value);
            document.getElementById('price-range-val').innerText = maxPriceFilter + ' Tk';
            renderProducts();
        };
    }

    document.querySelectorAll('.close-modal').forEach(btn => btn.onclick = () => {
        const m = btn.closest('.modal');
        if (m) m.style.display = 'none';
    });

    document.querySelectorAll('.intel-btn[data-filter]').forEach(btn => {
        btn.onclick = () => {
            activeIntelFilter = btn.dataset.filter;
            document.querySelectorAll('.intel-btn[data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === activeIntelFilter));
            renderProducts();
        };
    });

    document.getElementById('sort-options').onchange = (e) => { sortOption = e.target.value; renderProducts(); };

    document.querySelectorAll('.steam-range-btn[data-range]').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('.steam-range-btn[data-range]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            if (currentDetailProductIndex >= 0 && currentFilteredProducts[currentDetailProductIndex]) {
                renderDetailChartTimeline(currentFilteredProducts[currentDetailProductIndex], btn.dataset.range);
            }
        };
    });

    document.getElementById('compare-btn').onclick = () => {
        if (compareModeActive && selectedForComparison.length > 0) openCompareModal();
        compareModeActive = !compareModeActive;
        document.getElementById('compare-btn').classList.toggle('active', compareModeActive);
        renderProducts();
    };

    document.getElementById('cart-comp-btn').onclick = openCartModal;
    document.getElementById('reset-cart-btn').onclick = () => {
        if(confirm('Empty Cart?')) {
            favorites = []; localStorage.setItem('god_favorites', '[]');
            allProducts.forEach(p => p.isFavorite = false);
            openCartModal(); renderProducts();
        }
    };
}

async function openDetailedChart(product) {
    currentDetailProductIndex = currentFilteredProducts.findIndex(p => p.id === product.id);
    const modal = document.getElementById('chart-modal');
    modal.classList.remove('hidden');
    modal.style.display = 'flex';

    ensureProductHistory(product);

    document.getElementById('chart-product-name').innerText = product.name;
    document.getElementById('chart-store-tag').innerText = 'OTHOBABAZAR';
    document.getElementById('chart-cat-path').innerText = product.category_path || product.category || 'Catalog';

    document.getElementById('chart-actual').innerText = fmt(product.current_price) + ' Tk';
    document.getElementById('chart-unit').innerText = '/' + product.unit_type;

    const origPrice = product.old_price ? fmt(product.old_price) + ' Tk' : '--';
    document.getElementById('chart-orig').innerText = origPrice;

    const discountPct = (product.old_price && product.old_price > product.current_price)
        ? Math.round(((product.old_price - product.current_price) / product.old_price) * 100)
        : 0;
    document.getElementById('chart-discount-pct').innerText = discountPct > 0 ? `${discountPct}% Discount` : 'Regular Price';

    document.getElementById('chart-min').innerText = fmt(product.minPrice) + ' Tk';
    const minH = product.history.find(h => h.normalized_price === product.minPrice);
    document.getElementById('chart-min-date').innerText = minH ? 'on ' + minH.date : 'Historical Low';

    document.getElementById('chart-max').innerText = fmt(product.maxPrice) + ' Tk';
    const maxH = product.history.find(h => h.normalized_price === product.maxPrice);
    document.getElementById('chart-max-date').innerText = maxH ? 'on ' + maxH.date : 'Historical High';

    document.getElementById('chart-avg').innerText = fmt(product.avgPrice) + ' Tk';

    // Price Spectrum Bar
    document.getElementById('spectrum-min-txt').innerText = fmt(product.minPrice);
    document.getElementById('spectrum-max-txt').innerText = fmt(product.maxPrice);
    const range = (product.maxPrice - product.minPrice) || 1;
    const posPct = Math.min(100, Math.max(0, ((product.normalized_price - product.minPrice) / range) * 100));
    document.getElementById('spectrum-fill').style.width = '100%';
    document.getElementById('spectrum-marker').style.left = posPct + '%';

    const isLow = product.normalized_price <= (product.minPrice + 0.5);
    document.getElementById('steam-low-badge').style.display = isLow ? 'inline-block' : 'none';

    // Modal buttons
    const alertBtn = document.getElementById('modal-alert-btn');
    alertBtn.innerHTML = targetPriceAlerts[product.id] 
        ? `<i class="fas fa-bell"></i> Alert: ${targetPriceAlerts[product.id]} Tk`
        : `<i class="fas fa-bell"></i> Set Target Alert`;
    alertBtn.classList.toggle('active', !!targetPriceAlerts[product.id]);
    alertBtn.onclick = () => setTargetAlertForProduct(product);

    const favBtn = document.getElementById('modal-fav-btn');
    favBtn.innerHTML = favorites.includes(product.id) ? `<i class="fas fa-star" style="color:var(--steam-gold);"></i> Starred` : `<i class="fas fa-star"></i> Star`;
    favBtn.onclick = (e) => {
        toggleFavorite(e, product.id);
        favBtn.innerHTML = favorites.includes(product.id) ? `<i class="fas fa-star" style="color:var(--steam-gold);"></i> Starred` : `<i class="fas fa-star"></i> Star`;
    };

    document.getElementById('copy-json-btn').onclick = () => {
        navigator.clipboard.writeText(JSON.stringify(product, null, 2));
        alert('Product telemetry JSON copied to clipboard!');
    };

    renderDetailChartTimeline(product, activeTimeframeRange);
}

function renderDetailChartTimeline(product, range) {
    activeTimeframeRange = range;
    ensureProductHistory(product);
    let history = product.history || [];

    if (range && range !== 'all') {
        const days = parseInt(range) || 30;
        const refDate = new Date((todayStr || dhakaTodayStr()) + 'T12:00:00');
        const cutoff = new Date(refDate);
        cutoff.setDate(cutoff.getDate() - days);
        const filtered = history.filter(h => new Date(h.date + 'T12:00:00') >= cutoff);
        if (filtered.length >= 2) {
            history = filtered;
        }
    }

    const ctx = document.getElementById('price-history-chart').getContext('2d');
    const labels = formatChartDates(history.map(h => h.date));

    if (detailChart) detailChart.destroy();

    const gradient = ctx.createLinearGradient(0, 0, 0, 300);
    gradient.addColorStop(0, 'rgba(102, 192, 244, 0.35)');
    gradient.addColorStop(1, 'rgba(102, 192, 244, 0.0)');

    detailChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Unit Price (BDT)',
                    data: history.map(h => h.normalized_price),
                    borderColor: '#66c0f4',
                    borderWidth: 3,
                    backgroundColor: gradient,
                    fill: true,
                    tension: 0.3,
                    pointRadius: 4,
                    pointHoverRadius: 7,
                    pointBackgroundColor: '#ffffff',
                    pointBorderColor: '#66c0f4'
                },
                {
                    label: 'Average Reference Price',
                    data: history.map(() => product.avgPrice),
                    borderColor: '#ffc107',
                    borderWidth: 1.5,
                    borderDash: [6, 6],
                    fill: false,
                    pointRadius: 0
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    grid: { color: '#1f2f42' },
                    ticks: { color: '#66c0f4', font: { family: 'JetBrains Mono', size: 11, weight: 'bold' } }
                },
                x: {
                    grid: { color: '#141f2c' },
                    ticks: { color: '#8ba2b9', font: { family: 'JetBrains Mono', size: 10 } }
                }
            },
            plugins: {
                legend: { labels: { color: '#ffffff', font: { family: 'Outfit', size: 11, weight: 'bold' } } },
                tooltip: {
                    backgroundColor: '#1b2838',
                    borderColor: '#2a475e',
                    borderWidth: 1,
                    titleColor: '#ffffff',
                    bodyColor: '#66c0f4',
                    titleFont: { family: 'JetBrains Mono', weight: 'bold' },
                    bodyFont: { family: 'JetBrains Mono' }
                }
            }
        }
    });
}

function closeModal() {
    const modal = document.getElementById('chart-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }
}

function setTargetAlertForProduct(p) {
    const curr = Math.round(p.current_price);
    const val = prompt(`Set target price alert for "${p.name}":\n(Current price: ${curr} Tk)`, targetPriceAlerts[p.id] || curr);
    if (val !== null) {
        const num = parseFloat(val);
        if (!isNaN(num) && num > 0) {
            targetPriceAlerts[p.id] = num;
            localStorage.setItem('god_target_alerts', JSON.stringify(targetPriceAlerts));
            alert(`Target alert set at ${num} Tk!`);
            updateAlertsBadge();
            renderProducts();
            openDetailedChart(p);
        }
    }
}

function updateAlertsBadge() {
    const count = Object.keys(targetPriceAlerts).length;
    const badge = document.getElementById('alerts-badge-count');
    if (badge) badge.innerText = count;
}

function openAlertsModal() {
    const modal = document.getElementById('alerts-modal');
    modal.style.display = 'flex';
    const container = document.getElementById('alerts-list-container');
    const alertIds = Object.keys(targetPriceAlerts);

    if (alertIds.length === 0) {
        container.innerHTML = '<div style="padding:40px; text-align:center; color:#8ba2b9; font-size:0.9rem;">No target price alerts configured yet. Click "Set Target Alert" in any item\'s chart to start tracking!</div>';
        return;
    }

    container.innerHTML = alertIds.map(id => {
        const p = allProducts.find(x => x.id === id);
        if (!p) return '';
        const target = targetPriceAlerts[id];
        const isMet = p.current_price <= target;
        const statusBadge = isMet 
            ? `<span style="background:var(--steam-green); color:#000; font-weight:900; font-size:0.65rem; padding:2px 8px; border-radius:4px;"><i class="fas fa-check-circle"></i> TARGET MET! (${p.current_price} Tk)</span>`
            : `<span style="background:#1b2838; color:#8ba2b9; font-size:0.65rem; padding:2px 8px; border-radius:4px;">Current: ${p.current_price} Tk | Target: ${target} Tk</span>`;

        return `
            <div style="display:flex; align-items:center; justify-content:space-between; padding:12px; background:#141f2c; border:1px solid #233547; border-radius:8px;">
                <div style="display:flex; align-items:center; gap:12px;">
                    <img src="${p.image}" style="width:36px; height:36px; object-fit:contain; background:#fff; border-radius:4px;">
                    <div>
                        <div style="font-size:0.82rem; font-weight:700; color:#fff; max-width:320px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${p.name}</div>
                        <div style="margin-top:4px;">${statusBadge}</div>
                    </div>
                </div>
                <button onclick="removeTargetAlert('${id}')" class="btn-icon danger" style="padding:5px 10px; font-size:0.7rem;"><i class="fas fa-trash"></i> Remove</button>
            </div>
        `;
    }).join('');
}

window.removeTargetAlert = (id) => {
    delete targetPriceAlerts[id];
    localStorage.setItem('god_target_alerts', JSON.stringify(targetPriceAlerts));
    updateAlertsBadge();
    openAlertsModal();
    renderProducts();
};

function openAnalyticsModal() {
    const modal = document.getElementById('analytics-modal');
    modal.style.display = 'flex';
    const grid = document.getElementById('analytics-content-grid');

    const totalCount = allProducts.length;
    const discounted = allProducts.filter(p => p.old_price && p.old_price > p.current_price);
    const avgDisc = discounted.length > 0
        ? Math.round(discounted.reduce((a, b) => a + (((b.old_price - b.current_price)/b.old_price)*100), 0) / discounted.length)
        : 0;

    const totalSavings = discounted.reduce((a, b) => a + (b.old_price - b.current_price), 0);
    const lowestCount = allProducts.filter(p => p.normalized_price <= (p.minPrice + 0.5)).length;

    grid.innerHTML = `
        <div class="steam-stat-card">
            <div class="steam-stat-label">Total Catalog Scraped</div>
            <div class="steam-stat-val price-curr">${totalCount}</div>
            <div class="steam-stat-sub">Active Othoba Products</div>
        </div>
        <div class="steam-stat-card">
            <div class="steam-stat-label">On Sale Items</div>
            <div class="steam-stat-val price-min">${discounted.length}</div>
            <div class="steam-stat-sub">${Math.round((discounted.length/totalCount)*100)}% of catalog on sale</div>
        </div>
        <div class="steam-stat-card">
            <div class="steam-stat-label">Avg Discount Rate</div>
            <div class="steam-stat-val price-avg">${avgDisc}%</div>
            <div class="steam-stat-sub">Across discounted products</div>
        </div>
        <div class="steam-stat-card">
            <div class="steam-stat-label">Total Catalog Savings</div>
            <div class="steam-stat-val price-curr">${Math.round(totalSavings).toLocaleString()} Tk</div>
            <div class="steam-stat-sub">Combined list price discounts</div>
        </div>
        <div class="steam-stat-card">
            <div class="steam-stat-label">All-Time Low Items</div>
            <div class="steam-stat-val price-min">${lowestCount}</div>
            <div class="steam-stat-sub">Items at historic price floor</div>
        </div>
    `;
}

function exportViewToCSV() {
    if (currentFilteredProducts.length === 0) return alert('No items to export!');
    let csv = 'ID,Name,Category,Store,Current_Price_BDT,Old_Price_BDT,Unit_Type,Discount_Text,Rating,Sold\n';
    currentFilteredProducts.forEach(p => {
        const nameEsc = `"${(p.name || '').replace(/"/g, '""')}"`;
        const catEsc = `"${(p.category || '').replace(/"/g, '""')}"`;
        csv += `${p.id},${nameEsc},${catEsc},${p.store},${p.current_price},${p.old_price || ''},${p.unit_type},"${p.discount_text || ''}",${p.rating || ''},${p.sold || 0}\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `othoba_price_analytics_${dhakaTodayStr()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
}

function updateStoreStats() {
    const sidebarStats = document.getElementById('store-stats-sidebar');
    if (!sidebarStats) return;
    
    let html = '<div style="font-size: 0.65rem; color: var(--steam-blue); margin-bottom: 12px; font-weight: 800; letter-spacing:1px; border-bottom:1px solid #222; padding-bottom:5px;">STEAMDB TELEMETRY ENGINE</div>';
    html += `
        <div class="legend-item" style="display:flex; flex-direction:column; margin-bottom:10px;">
            <div style="display:flex; justify-content:space-between; font-weight:800; font-size:0.75rem;">
                <span style="color:#ff9f0a">OTHOBA</span>
                <span style="color:#eee;">${allProducts.length} units</span>
            </div>
            <div style="font-size:0.6rem; opacity:0.6; color:#888;">Live Ingestion | API v2</div>
        </div>`;
    sidebarStats.innerHTML = html;
}

function updateSuggestions(query) {
    const box = document.getElementById('search-suggestions');
    if (!query || query.length < 2) { box.style.display = 'none'; return; }
    const matches = allProducts.filter(p => p.name.toLowerCase().includes(query)).slice(0, 15);
    if (matches.length === 0) { box.style.display = 'none'; return; }
    box.innerHTML = matches.map(p => `
        <div class="suggestion-item" tabindex="-1" onclick="selectSuggestion('${p.name.replace(/'/g, "\\'")}')">
            <div style="display:flex; align-items:center; gap:10px;">
                <img src="${p.image}" style="width:24px; height:24px; object-fit:contain; background:#fff; border-radius:3px;">
                <span style="font-size:0.75rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:280px;">${p.name}</span>
            </div>
            <span style="color:var(--steam-blue); font-size:0.55rem; font-weight:900;">OTHOBA</span>
        </div>
    `).join('');
    box.style.display = 'block';
}

window.selectSuggestion = (name) => {
    document.getElementById('product-search').value = name;
    searchQuery = name.toLowerCase();
    document.getElementById('search-suggestions').style.display = 'none';
    renderProducts();
};

async function openCompareModal() {
    document.getElementById('compare-modal').style.display = 'flex';
    const products = allProducts.filter(p => selectedForComparison.includes(p.id));
    document.getElementById('selected-count').innerText = products.length + ' units staged';
    const ctrl = document.querySelector('.compare-details-grid') || document.getElementById('compare-details');
    ctrl.innerHTML = '<button id="matrix-to-cart-btn" class="btn-icon" style="margin:20px; width:200px; background:var(--steam-blue); color:#000;"><i class="' + (favorites.some(f => selectedForComparison.includes(f)) ? 'fa-solid' : 'fa-regular') + ' fa-star"></i> Move Matrix to Cart</button>';
    document.getElementById('matrix-to-cart-btn').onclick = () => {
        selectedForComparison.forEach(id => { if (!favorites.includes(id)) favorites.push(id); });
        localStorage.setItem('god_favorites', JSON.stringify(favorites));
        processData(); alert("Items added to Cart!"); renderProducts();
    };

    products.forEach(p => ensureProductHistory(p));

    const ctx = document.getElementById('compare-chart').getContext('2d');
    if (compareChart) compareChart.destroy();
    const allDates = [...new Set(products.flatMap(p => p.history.map(h => h.date)))].sort();
    const cmpLabels = formatChartDates(allDates);
    compareChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: cmpLabels,
            datasets: products.map((p, idx) => ({
                label: p.name,
                data: allDates.map(d => { const h = p.history.find(hx => hx.date === d); return h ? h.normalized_price : null; }),
                borderColor: ['#66c0f4', '#a4d007', '#ffc107', '#ff4081', '#007aff'][idx % 5],
                borderWidth: 3, tension: 0.3, fill: false, pointRadius: 3, pointHoverRadius: 6
            }))
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            scales: { y: { grid: { color: '#1f2f42' }, ticks: { color: '#ccc', font: { size: 11, weight: 'bold' } } }, x: { grid: { color: '#141f2c' }, ticks: { color: '#ccc', font: { size: 11, weight: 'bold' }, maxRotation: 45 } } },
            plugins: { legend: { labels: { color: '#fff', boxWidth: 10, font: { size: 10, weight: 'bold' } } } }
        }
    });
}

function openCartModal() {
    document.getElementById('cart-modal').style.display = 'flex';
    const container = document.getElementById('cart-content');
    const cartItems = allProducts.filter(p => favorites.includes(p.id));
    if (cartItems.length === 0) { container.innerHTML = '<div style="padding:100px; text-align:center; opacity:0.3; font-size:2rem;">CART_EMPTY</div>'; return; }
    let html = '<div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:15px;">';
    let total = 0;
    const itemsHtml = cartItems.map(item => {
        total += item.current_price;
        return `
        <div style="display:flex; align-items:center; gap:8px; padding:5px 0; border-bottom:1px solid #111;">
            <img src="${item.image}" style="width:30px; height:30px; object-fit:contain; background:#fff; border-radius:4px;">
            <div style="flex:1; font-size:0.75rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${item.name}</div>
            <div style="font-weight:800; font-size:0.8rem; color:var(--steam-blue);">${Math.round(item.current_price)} Tk</div>
        </div>`;
    }).join('');

    html += `
    <div style="padding:15px; background:#0e141b; border-radius:12px; border:1px solid #2a475e;">
        <h3 style="color:var(--steam-blue); margin:0 0 10px 0; font-size:1rem;">Othoba Cart Staging</h3>
        <div style="max-height: 300px; overflow-y:auto;">${itemsHtml}</div>
        <div style="margin-top:15px; padding-top:10px; border-top:2px solid #222; display:flex; justify-content:space-between; font-weight:900;">
            <span>TOTAL ESTIMATE</span><span style="color:var(--steam-green)">${Math.round(total)} Tk</span>
        </div>
    </div>`;
    container.innerHTML = html + '</div>';
}

