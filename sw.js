// ⚜️ Gold & Silver BeES — Service Worker v1.0
// Background price fetch + Push Notifications

const CACHE_NAME = 'goldbees-v1';
const CHECK_INTERVAL = 60000; // 60 seconds

// ── INSTALL ──
self.addEventListener('install', e => {
  console.log('[SW] Installed');
  self.skipWaiting();
});

// ── ACTIVATE ──
self.addEventListener('activate', e => {
  console.log('[SW] Activated');
  e.waitUntil(clients.claim());
});

// ── FETCH (cache-first for app shell) ──
self.addEventListener('fetch', e => {
  // Only cache same-origin requests
  if (new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ── BACKGROUND SYNC: Price Check ──
self.addEventListener('periodicsync', e => {
  if (e.tag === 'price-check') {
    e.waitUntil(doBgPriceCheck());
  }
});

// ── MESSAGE from main app ──
self.addEventListener('message', e => {
  const { type, payload } = e.data || {};

  if (type === 'SAVE_ALERT_CONFIG') {
    // Store alert config in SW cache storage
    saveAlertConfig(payload);
  }

  if (type === 'START_BG_CHECK') {
    // Start periodic background check (every ~60s via setInterval workaround)
    startBgLoop();
  }

  if (type === 'STOP_BG_CHECK') {
    stopBgLoop();
  }

  if (type === 'TEST_NOTIFICATION') {
    showNotif({
      title: '⚜️ BeES — Test Notification',
      body: '✅ Notifications kaam kar rahi hain! Buy/Sell alert milega.',
      tag: 'test',
      icon: '/goldbees-pwa/icon-192.png',
      badge: '/goldbees-pwa/icon-192.png',
      data: { type: 'test' }
    });
  }
});

// ── NOTIFICATION CLICK ──
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cls => {
      if (cls.length > 0) {
        cls[0].focus();
        cls[0].postMessage({ type: 'ALERT_CLICKED', payload: data });
      } else {
        clients.openWindow('/');
      }
    })
  );
});

// ── PUSH (from server, future use) ──
self.addEventListener('push', e => {
  if (!e.data) return;
  try {
    const d = e.data.json();
    showNotif(d);
  } catch (_) {}
});

// ────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────

let bgLoopTimer = null;

function startBgLoop() {
  if (bgLoopTimer) return; // already running
  console.log('[SW] Background price loop started');
  bgLoopTimer = setInterval(doBgPriceCheck, CHECK_INTERVAL);
}

function stopBgLoop() {
  if (bgLoopTimer) { clearInterval(bgLoopTimer); bgLoopTimer = null; }
  console.log('[SW] Background price loop stopped');
}

async function saveAlertConfig(config) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const resp = new Response(JSON.stringify(config));
    await cache.put('/_sw_alert_config', resp);
    console.log('[SW] Alert config saved:', config);
  } catch (e) { console.warn('[SW] saveAlertConfig error:', e); }
}

async function loadAlertConfig() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const resp = await cache.match('/_sw_alert_config');
    if (!resp) return null;
    return await resp.json();
  } catch (e) { return null; }
}

async function doBgPriceCheck() {
  const config = await loadAlertConfig();
  if (!config) return;

  const { buyPct, sellPct, holdings, alerted } = config;
  if (!buyPct || !sellPct) return;

  // Fetch both ETFs
  const results = await Promise.allSettled([
    fetchPrice('GOLDBEES.NS'),
    fetchPrice('SILVERBEES.NS')
  ]);

  const prices = {
    G: results[0].status === 'fulfilled' ? results[0].value : null,
    S: results[1].status === 'fulfilled' ? results[1].value : null,
  };

  const ETF_NAMES = { G: 'Gold BeES 🥇', S: 'Silver BeES 🥈' };

  for (const k of ['G', 'S']) {
    const pd = prices[k]; if (!pd) continue;
    const p = pd.price;
    const hold = (holdings && holdings[k]) || [];
    const sorted = [...hold].sort((a, b) => (a.buyPrice || a.price) - (b.buyPrice || b.price));
    const lot1Price = sorted.length ? (sorted[0].buyPrice || sorted[0].price) : null;
    const ref = lot1Price || p;
    const bt = ref * (1 - buyPct / 100);
    const sv = ref * (1 + sellPct / 100);
    const tu = hold.reduce((s, h) => s + h.units, 0);

    const alertedState = (alerted && alerted[k]) || { buy: false, sell: false };

    if (p <= bt && !alertedState.buy) {
      const buyUnits = calcBuyUnits(config, k, p);
      const amt = (buyUnits * p).toFixed(0);
      const nextLot = sorted.length + 1;

      showNotif({
        title: `🟢 BUY NOW — ${ETF_NAMES[k]}`,
        body: `Price ₹${p.toFixed(2)} ≤ Target ₹${bt.toFixed(2)} · Lot ${nextLot} · ${buyUnits} Share · ₹${Number(amt).toLocaleString('en-IN')}`,
        tag: `buy-${k}`,
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        vibrate: [200, 100, 200, 100, 400],
        data: { type: 'buy', etf: k, price: p }
      });

      // Update alerted state back
      if (config.alerted) config.alerted[k] = { buy: true, sell: false };
      await saveAlertConfig(config);

    } else if (p >= sv && tu > 0 && !alertedState.sell) {
      const avg = tu > 0 ? hold.reduce((s, h) => s + (h.buyPrice || h.price) * h.units, 0) / tu : 0;
      const sellU = sorted.length ? sorted[0].units : 0;
      const profit = avg > 0 ? ((p - avg) * tu).toFixed(2) : '—';

      showNotif({
        title: `🔴 SELL NOW — ${ETF_NAMES[k]}`,
        body: `Price ₹${p.toFixed(2)} ≥ Target ₹${sv.toFixed(2)} · Lot 1 · ${sellU} Share · Profit: +₹${profit}`,
        tag: `sell-${k}`,
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        vibrate: [400, 100, 400],
        data: { type: 'sell', etf: k, price: p }
      });

      if (config.alerted) config.alerted[k] = { buy: false, sell: true };
      await saveAlertConfig(config);

    } else if (p > bt && p < sv) {
      // Reset alerted state
      if (config.alerted) config.alerted[k] = { buy: false, sell: false };
    }
  }
}

function calcBuyUnits(config, k, price) {
  const total = parseFloat(config.total) || 100000;
  const parts = parseInt(config.parts) || 2;
  const orders = parseInt(k === 'G' ? config.gord : config.sord) || 20;
  const perOrder = total / parts / orders;
  const baseUnits = Math.max(1, Math.floor(perOrder / price));
  const mult = parseFloat(config.mult) || 1.25;
  const hold = (config.holdings && config.holdings[k]) || [];
  if (hold.length > 0 && mult > 1) {
    const sorted = [...hold].sort((a, b) => (a.buyPrice || a.price) - (b.buyPrice || b.price));
    return Math.max(1, Math.round(sorted[0].units * mult));
  }
  return baseUnits;
}

async function fetchPrice(sym) {
  const proxies = [
    u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  ];
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d&_=${Date.now()}`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d&_=${Date.now()}`,
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(sym)}&_=${Date.now()}`,
  ];

  for (const px of proxies) {
    for (const yu of urls) {
      try {
        const r = await fetch(px(yu), { signal: AbortSignal.timeout(8000) });
        if (!r.ok) continue;
        const raw = await r.json();
        const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const res = j?.chart?.result?.[0];
        if (res) {
          const price = res.meta?.regularMarketPrice || res.meta?.previousClose;
          const prev = res.meta?.chartPreviousClose || res.meta?.previousClose || price;
          if (price && price > 0) return { price, prev };
        }
        const q = j?.quoteResponse?.result?.[0];
        if (q?.regularMarketPrice) return { price: q.regularMarketPrice, prev: q.regularMarketPreviousClose || q.regularMarketPrice };
      } catch (_) {}
    }
  }
  return null;
}

function showNotif({ title, body, tag, icon, badge, vibrate, data }) {
  return self.registration.showNotification(title, {
    body,
    tag: tag || 'goldbees',
    icon: icon || 'icon-192.png',
    badge: badge || 'icon-192.png',
    vibrate: vibrate || [200, 100, 200],
    requireInteraction: true,
    data: data || {}
  });
}
