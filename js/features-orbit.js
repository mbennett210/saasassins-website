/* ═══════════════════════════════════════════════════════════
   Features page — "Radar" systems orbit.
   Desktop (≥1000px): the CRM core at center with 22 systems on two
   orbit rings, six family headers in-orbit, colored arc bands, radar
   sweep + animated spokes. Mobile: collapses to grouped flip cards.
   Click any card (or the core) to flip it — backs list the software
   each system replaces.
   All markup is generated here from the data below; the only anchor
   in the HTML is <div id="sysOrbit">.
   ═══════════════════════════════════════════════════════════ */
(function () {
  const cv = document.getElementById('sysOrbit');
  if (!cv) return;

  /* ── Data — the 23 systems ── */
  const F = [
    { n: 1, ic: '📇', name: 'CRM — Contacts & Accounts' },
    { n: 2, ic: '📊', name: 'Sales Pipeline' },
    { n: 3, ic: '🔁', name: 'Sales Automation' },
    { n: 4, ic: '💬', name: 'Messaging & SMS' },
    { n: 5, ic: '📅', name: 'Scheduling & Dispatch' },
    { n: 6, ic: '📱', name: 'Field Ops — Crew App' },
    { n: 7, ic: '🛠️', name: 'Work Orders & Assets' },
    { n: 8, ic: '📦', name: 'Inventory & Key Tracking' },
    { n: 9, ic: '🚚', name: 'Purchasing & Supplier Automation' },
    { n: 10, ic: '📣', name: 'Outreach & Reputation' },
    { n: 11, ic: '🧲', name: 'AI Lead Scraper' },
    { n: 12, ic: '📝', name: 'Forms & Lead Capture' },
    { n: 13, ic: '🔎', name: 'SEO & AI Visibility' },
    { n: 14, ic: '🧾', name: 'Invoicing & Quoting' },
    { n: 15, ic: '✍️', name: 'E-Signature & Documents' },
    { n: 16, ic: '🔄', name: 'Accounting Sync' },
    { n: 17, ic: '👥', name: 'Employee Management' },
    { n: 18, ic: '🔍', name: 'Quality Control & Inspections' },
    { n: 19, ic: '🛡️', name: 'Compliance & Verification' },
    { n: 20, ic: '🚪', name: 'Customer Portal & Booking' },
    { n: 21, ic: '📈', name: 'Analytics & Reporting' },
    { n: 22, ic: '🤖', name: 'AI Concierge & Assistant' },
    { n: 23, ic: '🔌', name: 'Integrations & Data Migration' }
  ];

  /* Cross-industry replaced software (common + pricey) — flip-side lists */
  const REPS = {
    1: ['HubSpot', 'Salesforce', 'GoHighLevel', 'Zoho CRM'],
    2: ['Pipedrive', 'Salesforce', 'monday.com'],
    3: ['ActiveCampaign', 'Keap', 'GoHighLevel'],
    4: ['Podium', 'OpenPhone', 'Heymarket'],
    5: ['Jobber', 'Housecall Pro', 'ServiceTitan'],
    6: ['ServiceTitan', 'Jobber', 'CompanyCam'],
    7: ['UpKeep', 'Limble', 'Fiix'],
    8: ['Sortly', 'inFlow', 'KeyTrak'],
    9: ['Procurify', 'Coupa', 'Order.co'],
    10: ['Mailchimp', 'Birdeye', 'NiceJob'],
    11: ['Apollo', 'ZoomInfo', 'Seamless.AI'],
    12: ['Typeform', 'Jotform', 'Gravity Forms'],
    13: ['Semrush', 'Ahrefs', 'SEO agency retainers'],
    14: ['FreshBooks', 'PandaDoc', 'Invoice2go'],
    15: ['DocuSign', 'Adobe Sign', 'PandaDoc'],
    16: ['manual double-entry', 'Zapier glue'],
    17: ['BambooHR', 'QuickBooks Time', 'When I Work'],
    18: ['SafetyCulture', 'Swept', 'GoAudits'],
    19: ['Alloy', 'Onfido', 'manual KYC review'],
    20: ['Calendly', 'Acuity', 'endless phone tag'],
    21: ['Tableau', 'Looker', 'spreadsheet sprawl'],
    22: ['Intercom', 'Drift', 'Tidio'],
    23: ['Zapier', 'Make', 'migration consultants']
  };

  /* Family groups orbiting the core (feature 1 IS the core) */
  const VG = [
    { id: 'grow',    name: 'Get Found & Grow',     color: '#fca5a5', ns: [10, 11, 12, 13] },
    { id: 'sell',    name: 'Sell',                 color: '#ef4444', ns: [2, 3, 4] },
    { id: 'operate', name: 'Run the Work',         color: '#c0c0c0', ns: [5, 6, 7, 8, 9] },
    { id: 'paid',    name: 'Get Paid',             color: '#6b7280', ns: [14, 15, 16] },
    { id: 'team',    name: 'Team & Standards',     color: '#b91c1c', ns: [17, 18, 19] },
    { id: 'cx',      name: 'Customers, Data & AI', color: '#e5e7eb', ns: [20, 21, 22, 23] }
  ];
  const DESC = {
    sell:    'Pipeline, automation & messaging close what the CRM captures.',
    grow:    'Outreach, reviews, SEO/AIO & AI leads keep the core full.',
    operate: 'Scheduling to close-out — crews, assets, supplies & POs.',
    paid:    'Quotes, e-sign, payments & books — cash without the chase.',
    team:    'HR, quality & compliance — your people, on the record.',
    cx:      'Portals, dashboards & AI working your real records.'
  };

  const gById = id => VG.find(g => g.id === id);
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const hexA = (h, a) => { const x = parseInt(h.slice(1), 16); return `rgba(${x >> 16 & 255},${x >> 8 & 255},${x & 255},${a})`; };

  /* ── Build the DOM ── */
  const CORE = `<div class="hub-core"><div class="hub-core-in">
    <div class="hub-core-f">
      <span class="ttl">CRM</span>
      <span class="sub">Contacts · Accounts · Every Interaction</span>
      <span class="tagc">THE CORE — EVERY SYSTEM PLUGS INTO IT</span>
    </div>
    <div class="hub-core-b">
      <span class="nm">CRM — The Core</span>
      <span class="lbl">REPLACES</span>
      <span class="lst">${esc(REPS[1].join(', '))}, and more</span>
      <span class="tg">One database for every person, company, and interaction — the heart of every build.</span>
    </div>
  </div></div>`;
  const card = (n, g) => { const f = F[n - 1];
    return `<div class="hub-card" data-n="${n}" style="--gc:${g.color}"><div class="hub-in">
      <div class="hub-f"><span class="ic">${f.ic}</span><b>${esc(f.name.split(' — ')[0])}</b><span class="fl">CLICK TO FLIP ⟲</span></div>
      <div class="hub-b"><span class="lbl">REPLACES</span><span class="lst">${esc(REPS[n].join(', '))}</span><span class="nm">${esc(f.name.split(' — ')[0])}</span></div>
    </div></div>`; };

  cv.innerHTML = `<svg></svg>` + CORE + VG.map(g =>
    `<div class="arr-g" data-g="${g.id}">
      <div class="arr-lbl" style="color:${g.color}"><i style="background:${g.color}"></i>${esc(g.name)}</div>
      <div class="hub-cards">${g.ns.map(n => card(n, g)).join('')}</div>
    </div>`).join('') + VG.map(g =>
    `<div class="arr-note" data-g="${g.id}"><b style="color:${g.color}">${esc(g.name)}</b><span>${esc(DESC[g.id])}</span></div>`).join('') +
    `<div class="bold-head"><div class="l1">23 SYSTEMS.</div><div class="l2">ONE CORE.</div><div class="l3">CLICK ANY NODE ⟲</div></div>
     <div class="bold-foot">ALL SYSTEMS REPORT TO <b>THE CRM</b></div>`;

  cv.addEventListener('click', e => {
    const core = e.target.closest('.hub-core');
    if (core) { core.classList.toggle('flip'); return; }
    const c = e.target.closest('.hub-card'); if (c) c.classList.toggle('flip');
  });

  /* ── Layout ── */
  const mob = () => window.innerWidth < 1000;
  function clear() {
    cv.style.height = '';
    cv.querySelector('svg').innerHTML = '';
    cv.querySelectorAll('.arr-g,.arr-lbl,.arr-note,.hub-cards,.hub-card,.hub-core').forEach(el => {
      el.style.position = ''; el.style.left = ''; el.style.top = ''; el.style.transform = '';
      el.style.width = ''; el.style.display = ''; el.style.gridTemplateColumns = '';
    });
  }
  function layout() {
    if (mob()) { clear(); return; }
    const W = cv.clientWidth, H = 1230; cv.style.height = H + 'px';
    const cx = W / 2, cy = H / 2;
    const r1x = 310, r1y = 272, r2x = Math.min(560, W / 2 - 130), r2y = 438;
    const SGX = 28, SGY = 56; // petal stagger: alternate outer items on a second sub-ring
    const rx3 = r2x + SGX + 84, ry3 = r2y + SGY + 70;
    const P = (rx, ry, a) => [cx + rx * Math.cos(a * Math.PI / 180), cy + ry * Math.sin(a * Math.PI / 180)];
    const orderIds = ['operate', 'grow', 'paid', 'cx', 'team', 'sell']; // wheel order from top, clockwise
    const inner = [], ring = [];
    orderIds.forEach(id => {
      const g = gById(id);
      cv.querySelector(`.arr-g[data-g="${id}"] .arr-lbl`).style.display = 'none';
      const cards = [...cv.querySelectorAll(`.arr-g[data-g="${id}"] .hub-card`)];
      const kIn = Math.floor(cards.length / 2);
      cards.forEach((el, i) => { if (i < kIn) inner.push({ el, g }); });
      ring.push({ note: true, el: cv.querySelector(`.arr-note[data-g="${id}"]`), g });
      cards.forEach((el, i) => { if (i >= kIn) ring.push({ el, g }); });
    });
    // Place on rings, then a min-translation separation pass so no pair can overlap at any width.
    const items = [];
    inner.forEach((it, i) => {
      const a = -90 + i * (360 / inner.length), [x, y] = P(r1x, r1y, a);
      items.push({ el: it.el, x, y, hw: 75, hh: 59, g: it.g, card: true });
    });
    const step = 360 / ring.length, spans = {}; // 19 outer slots: 6 family headers + 13 cards
    ring.forEach((it, i) => {
      const stag = i % 2;
      const a = -90 + i * step, [x, y] = P(r2x + stag * SGX, r2y + stag * SGY, a);
      if (it.note) { it.el.style.display = 'block'; items.push({ el: it.el, x, y, hw: 75, hh: 28, g: it.g }); }
      else items.push({ el: it.el, x, y, hw: 75, hh: 59, g: it.g, card: true });
      const s = spans[it.g.id] || (spans[it.g.id] = { min: a, max: a, color: it.g.color });
      s.min = Math.min(s.min, a); s.max = Math.max(s.max, a);
    });
    const PAD = 6, CHW = 145 + PAD, CHH = 145 + PAD; // core half-extents (immovable)
    for (let iter = 0; iter < 80; iter++) {
      let moved = false;
      for (const it of items) {
        const ox = (it.hw + CHW) - Math.abs(it.x - cx), oy = (it.hh + CHH) - Math.abs(it.y - cy);
        if (ox > 0 && oy > 0) { moved = true;
          if (ox < oy) it.x += (it.x >= cx ? ox : -ox); else it.y += (it.y >= cy ? oy : -oy); }
      }
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
        const A = items[i], B = items[j];
        const ox = (A.hw + B.hw + PAD) - Math.abs(A.x - B.x);
        const oy = (A.hh + B.hh + PAD) - Math.abs(A.y - B.y);
        if (ox > 0 && oy > 0) { moved = true;
          if (ox < oy) { const s = A.x <= B.x ? 1 : -1; A.x -= s * ox / 2; B.x += s * ox / 2; }
          else         { const s = A.y <= B.y ? 1 : -1; A.y -= s * oy / 2; B.y += s * oy / 2; }
        }
      }
      if (!moved) break;
    }
    const pts = [];
    items.forEach(it => {
      it.x = Math.min(W - it.hw - 8, Math.max(it.hw + 8, it.x));
      it.y = Math.min(H - it.hh - 8, Math.max(it.hh + 8, it.y));
      it.el.style.position = 'absolute';
      if (it.card) it.el.style.width = '150px';
      it.el.style.left = it.x + 'px'; it.el.style.top = it.y + 'px';
      it.el.style.transform = 'translate(-50%,-50%)';
      if (it.card) pts.push({ x: it.x, y: it.y, c: hexA(it.g.color, .42) });
    });
    const svg = cv.querySelector('svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const guides =
      `<ellipse cx="${cx}" cy="${cy}" rx="${r1x}" ry="${r1y}" style="fill:none;stroke:rgba(192,192,192,.1);stroke-dasharray:3 7"/>` +
      `<ellipse cx="${cx}" cy="${cy}" rx="${r2x + SGX / 2}" ry="${r2y + SGY / 2}" style="fill:none;stroke:rgba(192,192,192,.08);stroke-dasharray:3 7"/>`;
    const arcs = Object.values(spans).map(s => {
      const [x1, y1] = P(rx3, ry3, s.min - 6), [x2, y2] = P(rx3, ry3, s.max + 6);
      const d = `M ${x1} ${y1} A ${rx3} ${ry3} 0 0 1 ${x2} ${y2}`;
      return `<path d="${d}" style="stroke:${hexA(s.color, .16)};stroke-width:9"/><path d="${d}" style="stroke:${hexA(s.color, .6)};stroke-width:3"/>`;
    }).join('');
    svg.innerHTML = guides + arcs +
      pts.map(p => `<line x1="${cx}" y1="${cy}" x2="${p.x}" y2="${p.y}" style="stroke:${p.c}"/>`).join('');
  }

  let rzt;
  window.addEventListener('resize', () => { clearTimeout(rzt); rzt = setTimeout(layout, 120); });
  layout();
})();
