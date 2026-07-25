// Deepsmoke — DOM panels: PACK & RIG, TUB'S FORGE, chest, oven, Bub's camp board.
// All item grids share ONE drag-cursor: click picks up a stack, click places/merges/swaps.
import { TRACKS, ORE_KEYS, ORE_INFO, canAfford, buy, gear, saveProfile, CAMP_PROJECTS } from './upgrades.js';
import { ITEMS, RECIPES, canCraft, craft, OVEN_RECIPES, canSmelt, smelt } from './inventory.js';

const TIER_COLORS = ['#b8c0cc', '#b87333', '#9aa2ae', '#e3e8f0', '#ffd873'];
const OK = '#9fdc8f', BAD = '#ff9d8f';

export function createUI(root, audio) {
  const layer = document.createElement('div');
  layer.id = 'ui-layer';
  layer.style.cssText = 'position:absolute;inset:0;z-index:30;display:none;pointer-events:auto;';
  root.appendChild(layer);

  let open = false, onCloseCb = null;

  // ---------- shared drag cursor ----------
  let cursor = null;    // {id,n} | null — the stack stuck to the pointer
  let cursorBag = null; // bag that gets the cursor back when the panel closes
  let iconOf = null;    // current panel's iconURL fn
  let gridDefs = [], renderCur = null, onGridChange = null;

  const cursorEl = document.createElement('div');
  cursorEl.style.cssText = 'position:fixed;z-index:60;pointer-events:none;display:none;width:34px;height:34px;transform:translate(-50%,-50%)';
  cursorEl.innerHTML = '<img style="width:100%;height:100%;image-rendering:pixelated" alt="">' +
    '<span style="position:absolute;right:-2px;bottom:-4px;font-weight:900;font-size:13px;color:#fff;text-shadow:2px 2px 0 #000;font-family:var(--ui-font)"></span>';
  document.body.appendChild(cursorEl);
  window.addEventListener('pointermove', e => {
    cursorEl.style.left = e.clientX + 'px';
    cursorEl.style.top = e.clientY + 'px';
  });

  function updateCursor() {
    if (cursor && iconOf) {
      cursorEl.style.display = 'block';
      cursorEl.children[0].src = iconOf(cursor.id);
      cursorEl.children[1].textContent = cursor.n > 1 ? cursor.n : '';
    } else cursorEl.style.display = 'none';
  }

  function close() {
    if (!open) return;
    if (cursor && cursorBag) cursorBag.add(cursor.id, cursor.n); // never eat items
    cursor = null; cursorBag = null;
    updateCursor();
    open = false;
    layer.style.display = 'none';
    layer.innerHTML = '';
    gridDefs = []; renderCur = null; onGridChange = null; iconOf = null;
    if (onCloseCb) { const f = onCloseCb; onCloseCb = null; f(); }
  }

  window.addEventListener('keydown', e => {
    if (!open) return;
    if (e.code === 'Escape' || e.code === 'KeyI' || e.code === 'Tab') { e.preventDefault(); close(); }
  });

  function shell(title, sub, inner) {
    layer.innerHTML = `
      <div class="w-full h-full flex items-center justify-center p-3" style="background:rgba(8,14,38,.78)">
        <div class="w-full max-w-2xl pixel-panel overflow-hidden flex flex-col" style="max-height:92%">
          <div class="px-5 py-3 flex items-center justify-between shrink-0" style="background:#9c9c9c;border-bottom:3px solid #000;box-shadow:inset 4px 4px 0 rgba(255,255,255,.5), inset -4px -4px 0 rgba(0,0,0,.35)">
            <div>
              <div class="font-black tracking-widest text-lg" style="color:#fff;text-shadow:2px 2px 0 #000">${title}</div>
              <div class="text-xs font-bold" style="color:#e6e6e6;text-shadow:1px 1px 0 #000">${sub}</div>
            </div>
            <button id="ui-close" class="btn-cobalt px-4 py-1.5 font-black">CLOSE</button>
          </div>
          <div class="p-4 overflow-y-auto">${inner}</div>
        </div>
      </div>`;
    layer.style.display = 'block';
    open = true;
    layer.querySelector('#ui-close').addEventListener('click', () => { audio.play('click'); close(); });
  }

  const oreChip = (k, n) =>
    `<span class="inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono font-bold text-sm" style="background:rgba(0,0,0,.35);color:${ORE_INFO[k].color}">&#9670; ${n}</span>`;

  const costChips = (bag, cost) => Object.keys(cost).map(k =>
    `<span style="color:${bag.count(k) >= cost[k] ? OK : BAD};font-weight:700">${cost[k]}&times; ${ITEMS[k].name}</span>`).join(' &middot; ');

  // ---------- item grids ----------
  const CS = window.innerWidth < 480 ? 32 : 40; // cell px
  const CELL = `width:${CS}px;height:${CS}px;background:rgba(45,45,45,.92);border:2px solid #000;` +
    'box-shadow:inset -2px -2px 0 rgba(0,0,0,.5), inset 2px 2px 0 rgba(255,255,255,.25);' +
    'position:relative;image-rendering:pixelated;cursor:pointer;padding:0;border-radius:0';

  function gridHTML(gi) {
    const def = gridDefs[gi];
    let h = `<div style="display:grid;grid-template-columns:repeat(${def.cols},${CS}px);gap:3px;justify-content:start">`;
    for (let i = 0; i < def.count; i++) {
      const idx = def.start + i;
      const s = def.inv.slots[idx];
      const sel = def.showSel && def.inv.sel === idx ? 'border-color:#ffd873;' : '';
      h += `<button data-g="${gi}" data-i="${idx}" style="${CELL};${sel}">` +
        (s ? `<img src="${iconOf(s.id)}" style="width:100%;height:100%;image-rendering:pixelated;pointer-events:none" alt="">` +
          (s.n > 1 ? `<span style="position:absolute;right:1px;bottom:0;font-size:12px;font-weight:900;pointer-events:none">${s.n}</span>` : '')
          : '') +
        '</button>';
    }
    return h + '</div>';
  }

  function cellClick(def, idx) {
    const slots = def.inv.slots;
    const s = slots[idx];
    if (!cursor) {
      if (!s) return;
      cursor = s; slots[idx] = null;                           // pick up all
    } else if (!s) {
      slots[idx] = cursor; cursor = null;                      // place all
    } else if (s.id === cursor.id) {
      const t = Math.min(cursor.n, ITEMS[s.id].stack - s.n);   // merge
      s.n += t; cursor.n -= t;
      if (cursor.n <= 0) cursor = null;
    } else {
      slots[idx] = cursor; cursor = s;                         // swap
    }
    def.inv.rev++;
    audio.play('click');
    updateCursor();
    if (onGridChange) onGridChange();
    if (renderCur) renderCur();
  }

  function wireGrids() {
    layer.querySelectorAll('[data-g]').forEach(el =>
      el.addEventListener('click', () => cellClick(gridDefs[+el.dataset.g], +el.dataset.i)));
  }

  // ---------- paper doll ----------
  function drawDoll(cv, p) {
    const g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    g.imageSmoothingEnabled = false;
    const drillC = TIER_COLORS[p.drill];
    const plateC = [null, '#b87333', '#9aa2ae'][p.plate];
    const tanks = p.tank === 0 ? [[88, 24]] : p.tank === 1 ? [[68, 20], [112, 20]] : [[62, 26], [112, 26]];
    for (const [tx, tw] of tanks) {
      g.fillStyle = '#C4934A'; g.fillRect(tx, 70, tw, 34);
      g.fillStyle = p.tank === 2 ? '#ffd873' : '#8B6914'; g.fillRect(tx, 70, tw, 6);
    }
    g.fillStyle = '#22367a';
    g.fillRect(78, 176, 16, 38); g.fillRect(106, 176, 16, 38);
    g.fillStyle = '#8B6914'; g.fillRect(74, 210, 24, 12); g.fillRect(102, 210, 24, 12);
    g.fillStyle = '#2a4ba0'; g.fillRect(66, 96, 68, 82);
    if (plateC) {
      g.fillStyle = plateC;
      g.fillRect(58, 96, 20, 22); g.fillRect(122, 96, 20, 22);
      g.fillRect(74, 120, 52, 28);
      g.fillStyle = 'rgba(0,0,0,.2)'; g.fillRect(74, 142, 52, 6);
    }
    g.fillStyle = '#C4934A'; g.fillRect(66, 90, 68, 8);
    g.fillStyle = '#2a4ba0';
    g.fillRect(46, 100, 16, 50);
    g.fillRect(138, 100, 16, 42);
    g.fillStyle = '#8B6914'; g.fillRect(132, 142, 26, 16);
    g.fillStyle = drillC;
    g.beginPath(); g.moveTo(134, 158); g.lineTo(156, 158); g.lineTo(145, 194); g.closePath(); g.fill();
    g.fillStyle = 'rgba(0,0,0,.25)';
    g.fillRect(136, 164, 16, 3); g.fillRect(139, 174, 11, 3);
    g.fillStyle = '#6fbf4a'; g.fillRect(70, 34, 60, 54);
    g.fillRect(54, 46, 16, 18); g.fillRect(130, 46, 16, 18);
    g.fillStyle = '#C4934A'; g.fillRect(70, 44, 60, 10);
    g.fillStyle = '#9aa2ae'; g.fillRect(78, 42, 16, 14); g.fillRect(106, 42, 16, 14);
    g.fillStyle = '#dff3ff'; g.fillRect(80, 44, 6, 6); g.fillRect(108, 44, 6, 6);
    g.fillStyle = '#2a1c05'; g.fillRect(84, 72, 32, 7);
    g.fillStyle = '#fff'; g.fillRect(88, 72, 5, 5); g.fillRect(104, 72, 5, 5);
  }

  // ---------- PACK & RIG: doll + gear + ore, bag grids, crafting ----------
  function openInventory(ctx) {
    onCloseCb = ctx.onClose || null;
    iconOf = ctx.iconURL;
    cursorBag = ctx.bag;
    onGridChange = null;
    const p = ctx.profile, bag = ctx.bag;
    function render() {
      gridDefs = [
        { inv: bag, start: 0, count: 9, cols: 9, showSel: true },
        { inv: bag, start: 9, count: 27, cols: 9 },
      ];
      const gr = gear(p);
      const slot = (label, name, color) => `
        <div class="flex items-center gap-2 px-3 py-1.5" style="background:rgba(0,0,0,.28);border:2px solid #000">
          <span class="text-[10px] font-black tracking-widest w-11 shrink-0" style="color:#ffd873">${label}</span>
          <span class="font-bold text-sm" style="color:${color || '#fff'}">${name}</span>
        </div>`;
      const craftRows = RECIPES.map((r, i) => {
        const ok = canCraft(bag, r, ctx.nearBench);
        return `
        <div class="flex items-center gap-2 px-2 py-1.5" style="background:rgba(0,0,0,.28);border:2px solid #000">
          <img src="${iconOf(r.out)}" style="width:26px;height:26px;image-rendering:pixelated" alt="">
          <div class="flex-1 min-w-0">
            <div class="font-bold text-sm leading-tight">${ITEMS[r.out].name}${r.n > 1 ? ` &times;${r.n}` : ''}${r.bench && !ctx.nearBench ? ` <span style="color:${BAD};font-size:10px">— needs bench</span>` : ''}</div>
            <div class="text-xs leading-tight">${costChips(bag, r.cost)}</div>
          </div>
          <button data-craft="${i}" class="px-3 py-1 font-black text-xs shrink-0 ${ok ? 'btn-brass' : ''}"
            style="${ok ? '' : 'background:#4a4a4a;border:2px solid #2c2c2c;color:#9c9c9c;cursor:not-allowed'}">CRAFT</button>
        </div>`;
      }).join('');
      shell('PACK &amp; RIG', 'Your goblin, your bag, your bench — forged gear persists between digs', `
        <div class="flex flex-col md:flex-row gap-4">
          <div class="flex flex-col gap-2 shrink-0" style="max-width:210px">
            <div class="flex flex-col items-center gap-1">
              <canvas id="ui-doll" width="200" height="230" style="image-rendering:pixelated;width:150px;height:172px"></canvas>
              <div class="text-xs font-black tracking-widest" style="color:#D4B483">YOU, THE GOBLIN</div>
            </div>
            ${slot('TOOL', gr.drill.name, TIER_COLORS[p.drill])}
            ${slot('BODY', gr.plate.name)}
            ${slot('BACK', gr.tank.name)}
            <div class="text-[11px] font-black tracking-widest mt-1" style="color:#ffd873">CARRIED — vacuum banks these at camp</div>
            <div class="flex flex-wrap gap-2 items-center">
              ${ORE_KEYS.map(k => oreChip(k, ctx.player.inv.ores[k])).join('')}
              <span class="inline-flex items-center gap-1 px-2 py-0.5 font-mono font-bold text-sm" style="background:rgba(0,0,0,.35);color:#ffd873">&#9873; ${ctx.player.cans} cans</span>
            </div>
            <div class="text-[11px] font-black tracking-widest mt-1" style="color:#ffd873">HQ VAULT</div>
            <div class="flex flex-wrap gap-2">${ORE_KEYS.map(k => oreChip(k, p.bank[k] || 0)).join('')}</div>
          </div>
          <div class="flex-1 flex flex-col gap-2 min-w-0">
            <div class="text-[11px] font-black tracking-widest">HOTBAR — 1-9 / wheel picks yer hand</div>
            ${gridHTML(0)}
            <div class="text-[11px] font-black tracking-widest mt-1">BAG</div>
            ${gridHTML(1)}
            <div class="text-[11px] font-black tracking-widest mt-2">CRAFT${ctx.nearBench ? ` <span style="color:${OK}">— bench in reach</span>` : ''}</div>
            <div class="flex flex-col gap-1.5">${craftRows}</div>
          </div>
        </div>`);
      drawDoll(layer.querySelector('#ui-doll'), p);
      wireGrids();
      layer.querySelectorAll('[data-craft]').forEach(b => b.addEventListener('click', () => {
        const r = RECIPES[+b.dataset.craft];
        if (canCraft(bag, r, ctx.nearBench)) { craft(bag, r); audio.play('powerup'); render(); }
        else audio.play('hit');
      }));
    }
    renderCur = render;
    render();
  }

  // ---------- CHEST: 18 shared slots + your bag ----------
  function openChest(ctx) {
    onCloseCb = ctx.onClose || null;
    iconOf = ctx.iconURL;
    cursorBag = ctx.bag;
    onGridChange = ctx.onChange || null;
    function render() {
      gridDefs = [
        { inv: ctx.chest, start: 0, count: ctx.chest.slots.length, cols: 9 },
        { inv: ctx.bag, start: 0, count: 9, cols: 9, showSel: true },
        { inv: ctx.bag, start: 9, count: 27, cols: 9 },
      ];
      shell(ctx.title || 'CHEST', 'Click a stack to grab it, click a slot to drop it', `
        <div class="flex flex-col gap-2">
          <div class="text-[11px] font-black tracking-widest">CHEST</div>
          ${gridHTML(0)}
          <div class="text-[11px] font-black tracking-widest mt-2">HOTBAR</div>
          ${gridHTML(1)}
          <div class="text-[11px] font-black tracking-widest mt-1">BAG</div>
          ${gridHTML(2)}
        </div>`);
      wireGrids();
    }
    renderCur = render;
    render();
  }

  // ---------- STEAM HAULER: segment carts + cargo loading ----------
  function openHauler(ctx) {
    onCloseCb = ctx.onClose || null;
    iconOf = ctx.iconURL;
    cursorBag = ctx.bag;
    onGridChange = ctx.onChange || null;
    const hauler = ctx.hauler;
    function ensureSlots() {
      const need = hauler.carts * 9;
      while (hauler.slots.length < need) hauler.slots.push(null);
      if (hauler.slots.length > need) hauler.slots.length = need;
    }
    function render() {
      ensureSlots();
      const track = ctx.getTrackInfo ? ctx.getTrackInfo() : { connected: 0, routeLen: 0, minRoute: 0, ready: false };
      gridDefs = [
        { inv: hauler, start: 0, count: hauler.slots.length, cols: 9 },
        { inv: ctx.bag, start: 0, count: 9, cols: 9, showSel: true },
        { inv: ctx.bag, start: 9, count: 27, cols: 9 },
      ];
      const segLeft = Math.max(0, hauler.maxCarts - hauler.carts);
      const hasCargo = hauler.slots.some(Boolean);
      const canBuild = !hauler.built && !hauler.inTransit && ctx.bag.count('steam_hauler') > 0;
      const canAdd = hauler.built && !hauler.inTransit && segLeft > 0 && ctx.bag.count('cargo_cart') > 0;
      const canSend = hauler.built && !hauler.inTransit && hasCargo && track.ready;
      shell('STEAM HAULER', 'Commission the engine, lay track from the dock, then dispatch loaded carts to camp.', `
        <div class="flex flex-wrap items-center gap-2 mb-2">
          <span class="px-2 py-1 font-black text-xs" style="background:rgba(0,0,0,.28);border:2px solid #000">${hauler.built ? 'ENGINE: READY' : 'ENGINE: NOT BUILT'}</span>
          <span class="px-2 py-1 font-black text-xs" style="background:rgba(0,0,0,.28);border:2px solid #000">CARTS: ${hauler.carts}/${hauler.maxCarts}</span>
          <span class="px-2 py-1 font-black text-xs" style="background:rgba(0,0,0,.28);border:2px solid #000">SLOTS: ${hauler.slots.length}</span>
          <span class="px-2 py-1 font-black text-xs" style="background:rgba(0,0,0,.28);border:2px solid #000">${hauler.inTransit ? 'STATUS: RUNNING' : 'STATUS: DOCKED'}</span>
          <span class="px-2 py-1 font-black text-xs" style="background:rgba(0,0,0,.28);border:2px solid #000">TRACK: ${track.routeLen}/${track.minRoute}</span>
        </div>
        <div class="flex gap-2 flex-wrap mb-2">
          <button id="haul-build" class="${canBuild ? 'btn-brass' : ''} px-3 py-1.5 font-black text-xs"
            style="${canBuild ? '' : 'background:#4a4a4a;border:2px solid #2c2c2c;color:#9c9c9c;cursor:not-allowed'}">COMMISSION STEAM HAULER (1)</button>
          <button id="haul-add" class="${canAdd ? 'btn-brass' : ''} px-3 py-1.5 font-black text-xs"
            style="${canAdd ? '' : 'background:#4a4a4a;border:2px solid #2c2c2c;color:#9c9c9c;cursor:not-allowed'}">ADD CART SEGMENT (1)</button>
          <button id="haul-send" class="${canSend ? 'btn-cobalt' : ''} px-3 py-1.5 font-black text-xs"
            style="${canSend ? '' : 'background:#4a4a4a;border:2px solid #2c2c2c;color:#9c9c9c;cursor:not-allowed'}">DISPATCH TO CAMP</button>
          <span class="text-xs font-bold self-center">Need <b>steam hauler</b> to commission, <b>cargo cart</b> to extend, and ${track.minRoute} connected <b>hauler tracks</b>.</span>
        </div>
        <div class="text-[11px] font-black tracking-widest">HAULER CARGO</div>
        ${gridHTML(0)}
        <div class="text-[11px] font-black tracking-widest mt-2">HOTBAR</div>
        ${gridHTML(1)}
        <div class="text-[11px] font-black tracking-widest mt-1">BAG</div>
        ${gridHTML(2)}
      `);
      wireGrids();
      const buildBtn = layer.querySelector('#haul-build');
      if (buildBtn) buildBtn.addEventListener('click', () => {
        if (ctx.onBuild && ctx.onBuild()) { audio.play('powerup'); render(); }
        else audio.play('hit');
      });
      layer.querySelector('#haul-add').addEventListener('click', () => {
        if (ctx.onAddCart && ctx.onAddCart()) { audio.play('powerup'); render(); }
        else audio.play('hit');
      });
      layer.querySelector('#haul-send').addEventListener('click', () => {
        if (ctx.onDispatch && ctx.onDispatch()) { audio.play('success'); close(); }
        else audio.play('hit');
      });
    }
    renderCur = render;
    render();
  }

  // ---------- OVEN: smelt glass + refine ingots ----------
  function openOven(ctx) {
    onCloseCb = ctx.onClose || null;
    iconOf = ctx.iconURL;
    cursorBag = ctx.bag;
    onGridChange = null;
    const bag = ctx.bag, ores = ctx.player.inv.ores;
    function render() {
      gridDefs = [];
      const rows = OVEN_RECIPES.map((r, i) => {
        const ok = canSmelt(bag, ores, r);
        const oreStr = r.ore ? Object.keys(r.ore).map(k =>
          `<span style="color:${(ores[k] || 0) >= r.ore[k] ? ORE_INFO[k].color : BAD};font-weight:700">&#9670;${r.ore[k]} ${ORE_INFO[k].name} ore</span>`).join(' &middot; ') : '';
        return `
        <div class="flex items-center gap-2 px-2 py-1.5" style="background:rgba(0,0,0,.28);border:2px solid #000">
          <img src="${iconOf(r.out)}" style="width:26px;height:26px;image-rendering:pixelated" alt="">
          <div class="flex-1 min-w-0">
            <div class="font-bold text-sm leading-tight">${ITEMS[r.out].name}${r.n > 1 ? ` &times;${r.n}` : ''}</div>
            <div class="text-xs leading-tight">${[costChips(bag, r.cost), oreStr].filter(Boolean).join(' &middot; ')}</div>
          </div>
          <button data-smelt="${i}" class="px-3 py-1 font-black text-xs shrink-0 ${ok ? 'btn-brass' : ''}"
            style="${ok ? '' : 'background:#4a4a4a;border:2px solid #2c2c2c;color:#9c9c9c;cursor:not-allowed'}">SMELT</button>
        </div>`;
      }).join('');
      shell('OVEN', 'Logs feed the firebox — glass from sand, ingots from carried ore. Ingots bank DOUBLE at HQ!', `
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <span class="text-[11px] font-black tracking-widest">CARRIED ORE</span>
          ${ORE_KEYS.map(k => oreChip(k, ores[k] || 0)).join('')}
        </div>
        <div class="flex flex-col gap-1.5">${rows}</div>`);
      layer.querySelectorAll('[data-smelt]').forEach(b => b.addEventListener('click', () => {
        const r = OVEN_RECIPES[+b.dataset.smelt];
        if (canSmelt(bag, ores, r)) { smelt(bag, ores, r); audio.play('powerup'); render(); }
        else audio.play('hit');
      }));
    }
    renderCur = render;
    render();
  }

  // ---------- BUB'S CAMP BOARD: per-project builds (mats from BAG) + refuel service ----------
  function openCamp(ctx) {
    onCloseCb = ctx.onClose || null;
    iconOf = ctx.iconURL;
    cursorBag = ctx.bag;
    onGridChange = null;
    const p = ctx.profile, bag = ctx.bag;
    function render() {
      gridDefs = [];
      const rows = CAMP_PROJECTS.map(pr => {
        const built = !!(p.projects && p.projects[pr.id]);
        const mats = Object.keys(pr.mats).map(k =>
          `<span style="color:${bag.count(k) >= pr.mats[k] ? OK : BAD};font-weight:700">${pr.mats[k]}&times; ${ITEMS[k].name}</span>`).join(' &middot; ');
        return `
        <div class="flex items-center gap-3 px-3 py-2" style="background:rgba(0,0,0,.28);border:2px solid #000">
          <div class="flex-1 min-w-0">
            <div class="font-bold text-sm">${pr.name}${built ? ` <span class="text-[10px] font-black tracking-widest px-1.5 py-0.5 ml-1" style="background:#3f7a2e;color:#fff;border:2px solid #000">BUILT</span>` : ''}</div>
            <div class="text-xs">${pr.desc}</div>
            ${built ? '' : `<div class="text-xs mt-1">Bag: ${mats}</div>`}
          </div>
          ${built ? '' : `<button data-build="${pr.id}" class="btn-brass px-4 py-1.5 font-black text-xs shrink-0">BUILD</button>`}
        </div>`;
      }).join('');
      shell("BUB'S CAMP BOARD", '&ldquo;Haul the mats in yer bag, boss — we build it by hand, proper goblin work.&rdquo;', `
        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-1.5">${rows}</div>
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-[11px] font-black tracking-widest">HQ VAULT</span>
            ${ORE_KEYS.map(k => oreChip(k, p.bank[k] || 0)).join('')}
          </div>
          <button id="camp-fuel" class="btn-cobalt px-5 py-2 font-black self-start">TOP OFF BOILERS — bank ore &amp; ingots</button>
        </div>`);
      layer.querySelectorAll('[data-build]').forEach(b => b.addEventListener('click', () => {
        if (ctx.onBuild(b.dataset.build)) { audio.play('powerup'); render(); }
        else audio.play('hit');
      }));
      layer.querySelector('#camp-fuel').addEventListener('click', () => { close(); ctx.onRefuel(); });
    }
    renderCur = render;
    render();
  }

  // ---------- TUB'S FORGE ----------
  function openShop(ctx) {
    onCloseCb = ctx.onClose || null;
    onGridChange = null;
    const p = ctx.profile;
    // Tub takes stock: carried ore goes straight to the vault (existing behavior — keep)
    let banked = 0;
    for (const k of ORE_KEYS) { banked += ctx.player.inv.ores[k]; p.bank[k] = (p.bank[k] || 0) + ctx.player.inv.ores[k]; ctx.player.inv.ores[k] = 0; }
    if (banked > 0) saveProfile(p);

    function render() {
      gridDefs = [];
      const rows = Object.keys(TRACKS).map(tk => {
        const tr = TRACKS[tk];
        const cur = tr.tiers[p[tk]], next = tr.tiers[p[tk] + 1];
        const costStr = next ? ORE_KEYS.filter(k => next.cost[k]).map(k => `<span style="color:${ORE_INFO[k].color}">&#9670;${next.cost[k]}</span>`).join(' ') : '';
        const afford = next && canAfford(p, next.cost);
        return `
        <div class="rounded-xl p-3 mb-2 flex items-center gap-3" style="background:rgba(0,0,0,.28);border:2px solid #000">
          <div class="flex-1 min-w-0">
            <div class="text-[10px] font-black tracking-widest" style="color:#ffd873">${tr.label}</div>
            <div class="font-bold text-sm">${cur.name} <span class="text-xs opacity-70">— equipped</span></div>
            ${next
              ? `<div class="text-xs mt-1">NEXT: <b>${next.name}</b> · ${next.desc} <span class="font-mono ml-1 font-bold">${costStr}</span></div>`
              : `<div class="text-xs mt-1 font-bold" style="color:#ffd873">MAXED OUT</div>`}
          </div>
          ${next ? `<button data-buy="${tk}" class="rounded-lg px-4 py-2 font-black shrink-0 ${afford ? 'btn-brass' : ''}"
            style="${afford ? '' : 'background:#4a4a4a;border:2px solid #2c2c2c;color:#9c9c9c;cursor:not-allowed'}">FORGE</button>` : ''}
        </div>`;
      }).join('');
      shell("TUB'S FORGE", banked > 0 ? `&ldquo;Fine haul! ${banked} ore into the vault.&rdquo;` : '&ldquo;Bring ol&rsquo; Tub yer ores, I&rsquo;ll make &rsquo;em sing.&rdquo;', `
        <div class="mb-3 flex flex-wrap items-center gap-2 font-bold text-sm">
          <span class="text-[11px] font-black tracking-widest" style="color:#ffd873">VAULT</span>
          ${ORE_KEYS.map(k => oreChip(k, p.bank[k] || 0)).join('')}
        </div>
        ${rows}
        <div class="text-xs" style="color:#e6e6e6">Forged gear is permanent — it stays with you between digs.</div>`);
      layer.querySelectorAll('[data-buy]').forEach(b => b.addEventListener('click', () => {
        if (buy(p, b.dataset.buy)) {
          audio.play('powerup');
          if (ctx.onChange) ctx.onChange();
          banked = 0;
          render();
        } else audio.play('hit');
      }));
    }
    renderCur = render;
    render();
  }

  return { openInventory, openShop, openChest, openHauler, openOven, openCamp, close, get open() { return open; } };
}
