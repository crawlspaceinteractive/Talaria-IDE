// Deepsmoke — DOM hotbar: 9 bag slots stacked vertically down the RIGHT edge (keeps Grub's meter clear);
// select via click/tap, 1-9 keys, or wheel (player.js).
export function createHotbar(root, iconURL) {
  const touch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const size = window.innerHeight < 480 || touch ? 34 : 44;
  const bar = document.createElement('div');
  // touch: tuck below the PACK button, clear of the right-side action cluster; desktop: vertically centered
  bar.style.cssText = touch
    ? 'position:absolute;right:74px;top:74px;display:none;flex-direction:column;gap:3px;z-index:15;pointer-events:auto'
    : 'position:absolute;right:10px;top:50%;transform:translateY(-50%);display:none;flex-direction:column;gap:4px;z-index:15;pointer-events:auto';
  const cells = [];
  let inv = null, lastRev = -1;

  for (let i = 0; i < 9; i++) {
    const c = document.createElement('div');
    c.style.cssText = `width:${size}px;height:${size}px;background:rgba(60,60,60,.85);border:2px solid #000;` +
      'box-shadow:inset -2px -2px 0 rgba(0,0,0,.5), inset 2px 2px 0 rgba(255,255,255,.3);position:relative;image-rendering:pixelated';
    c.innerHTML = '<img style="width:100%;height:100%;image-rendering:pixelated;display:none" alt="">' +
      '<span style="position:absolute;right:1px;bottom:0;font-weight:900;font-size:12px;color:#fff;text-shadow:2px 2px 0 #000"></span>' +
      `<span style="position:absolute;left:2px;top:0;font-size:9px;color:#fff;text-shadow:1px 1px 0 #000;opacity:.7">${i + 1}</span>`;
    c.addEventListener('pointerdown', e => {
      e.preventDefault();
      if (inv) { inv.sel = i; inv.rev++; }
    });
    bar.appendChild(c);
    cells.push(c);
  }
  root.appendChild(bar);

  function render(force) {
    if (!inv) return;
    if (!force && inv.rev === lastRev) return;
    lastRev = inv.rev;
    for (let i = 0; i < 9; i++) {
      const s = inv.slots[i];
      const img = cells[i].children[0], n = cells[i].children[1];
      if (s) {
        img.style.display = 'block';
        img.src = iconURL(s.id);
        n.textContent = s.n > 1 ? s.n : '';
      } else {
        img.style.display = 'none';
        n.textContent = '';
      }
      cells[i].style.borderColor = inv.sel === i ? '#ffd873' : '#000';
    }
  }

  return {
    setInv(v) { inv = v; lastRev = -1; render(true); },
    render,
    show(v) { bar.style.display = v ? 'flex' : 'none'; },
  };
}
