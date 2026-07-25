// Procedural Minecraft-style pixel textures — bright & cheery palette.
import * as THREE from 'three';

const PAL = {
  brownDark: '#8B6914', brown: '#C4934A', sand: '#D4B483',
  cobalt: '#1E3A8A', sky: '#60A5FA',
};

function tex(draw) {
  const c = document.createElement('canvas');
  c.width = 32; c.height = 32;
  const g = c.getContext('2d');
  draw(g);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function noiseFill(g, base, variants, density = 0.5) {
  g.fillStyle = base; g.fillRect(0, 0, 32, 32);
  for (let y = 0; y < 32; y += 2) for (let x = 0; x < 32; x += 2) {
    if (Math.random() < density) {
      g.fillStyle = variants[(Math.random() * variants.length) | 0];
      g.fillRect(x, y, 2, 2);
    }
  }
}

export function makeTextures() {
  const T = {};

  T.dirt = tex(g => {
    noiseFill(g, PAL.brown, ['#b5813a', '#d0a25c', '#a2762f', '#c99a52'], 0.65);
    g.fillStyle = 'rgba(139,105,20,.5)';
    for (let i = 0; i < 10; i++) g.fillRect((Math.random()*30)|0, (Math.random()*30)|0, 3, 2);
  });

  T.sand = tex(g => {
    noiseFill(g, PAL.sand, ['#e3c896', '#c9a86f', '#eed9ac', '#d9bd8b'], 0.6);
    g.fillStyle = '#f4e4bd';
    for (let i = 0; i < 8; i++) g.fillRect((Math.random()*30)|0, (Math.random()*30)|0, 2, 1);
  });

  T.rock = tex(g => {
    noiseFill(g, '#7d7466', ['#8d8474', '#6e6558', '#948b7a', '#7a7163'], 0.6);
    // ore veins (amber + cobalt)
    g.fillStyle = PAL.brown;
    g.fillRect(4, 6, 3, 2); g.fillRect(7, 8, 2, 2); g.fillRect(20, 22, 3, 2);
    g.fillStyle = PAL.sky;
    g.fillRect(24, 6, 2, 2); g.fillRect(12, 24, 2, 2);
    // cracks
    g.strokeStyle = 'rgba(40,35,28,.7)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(2, 28); g.lineTo(10, 20); g.lineTo(14, 22); g.stroke();
  });

  T.brick = tex(g => {
    noiseFill(g, '#6b6156', ['#7a7064', '#5e554b', '#847a6d'], 0.5);
    // brick mortar
    g.strokeStyle = '#4a4239'; g.lineWidth = 1;
    for (let y = 0; y <= 32; y += 8) { g.beginPath(); g.moveTo(0, y+.5); g.lineTo(32, y+.5); g.stroke(); }
    for (let r = 0; r < 4; r++) { const off = r % 2 ? 8 : 0;
      for (let x = off; x <= 32; x += 16) { g.beginPath(); g.moveTo(x+.5, r*8); g.lineTo(x+.5, r*8+8); g.stroke(); } }
    // copper pipe
    g.fillStyle = '#b06a3a'; g.fillRect(0, 13, 32, 5);
    g.fillStyle = '#d98c50'; g.fillRect(0, 14, 32, 2);
    g.fillStyle = '#8a4f28'; g.fillRect(6, 12, 3, 7); g.fillRect(22, 12, 3, 7);
    // glowing amber rivets
    g.fillStyle = '#ffd873';
    g.fillRect(3, 3, 2, 2); g.fillRect(27, 3, 2, 2); g.fillRect(3, 26, 2, 2); g.fillRect(27, 26, 2, 2);
  });

  T.relic = tex(g => {
    noiseFill(g, '#3a3f52', ['#2f3444', '#454b63'], 0.5);
    // gear
    g.fillStyle = PAL.brown;
    g.beginPath(); g.arc(16, 16, 9, 0, 7); g.fill();
    g.fillStyle = '#3a3f52'; g.beginPath(); g.arc(16, 16, 4, 0, 7); g.fill();
    for (let a = 0; a < 8; a++) {
      const x = 16 + Math.cos(a * Math.PI / 4) * 10, y = 16 + Math.sin(a * Math.PI / 4) * 10;
      g.fillStyle = PAL.brown; g.fillRect(x - 2, y - 2, 4, 4);
    }
    // glowing crystal
    g.fillStyle = PAL.sky; g.fillRect(13, 12, 6, 8);
    g.fillStyle = '#bcdcff'; g.fillRect(14, 13, 3, 4);
  });

  T.cache = tex(g => {
    noiseFill(g, '#2b4a8f', ['#1E3A8A', '#33549e', '#3d63b8'], 0.55);
    g.strokeStyle = PAL.brownDark; g.lineWidth = 3;
    g.strokeRect(2, 2, 28, 28);
    g.beginPath(); g.moveTo(2, 2); g.lineTo(30, 30); g.moveTo(30, 2); g.lineTo(2, 30); g.stroke();
    g.fillStyle = '#ffd873'; // fuel symbol
    g.fillRect(13, 10, 6, 12); g.fillRect(11, 8, 10, 3);
  });

  T.vent = tex(g => {
    noiseFill(g, '#41598f', ['#33497c', '#4d67a5'], 0.5);
    g.fillStyle = '#16224a';
    for (let y = 4; y < 30; y += 6) g.fillRect(3, y, 26, 3);
    g.fillStyle = '#8fb8f5';
    for (let y = 4; y < 30; y += 6) g.fillRect(3, y, 26, 1);
  });

  T.cracked = tex(g => {
    noiseFill(g, '#8a7a5c', ['#7a6b4e', '#99886a', '#6e5f44'], 0.55);
    g.strokeStyle = '#e05a3a'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(16, 1); g.lineTo(12, 10); g.lineTo(18, 16); g.lineTo(11, 25); g.lineTo(15, 31); g.stroke();
    g.strokeStyle = 'rgba(60,45,25,.8)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(4, 4); g.lineTo(10, 12); g.moveTo(28, 6); g.lineTo(22, 14); g.lineTo(26, 24); g.stroke();
  });

  T.dart = tex(g => {
    noiseFill(g, '#6b6156', ['#7a7064', '#5e554b'], 0.5);
    // brass nozzle holes
    for (const [x, y] of [[8, 8], [24, 8], [16, 16], [8, 24], [24, 24]]) {
      g.fillStyle = PAL.brown; g.beginPath(); g.arc(x, y, 4, 0, 7); g.fill();
      g.fillStyle = '#1a1510'; g.beginPath(); g.arc(x, y, 2, 0, 7); g.fill();
    }
  });

  T.bedrock = tex(g => {
    noiseFill(g, '#3c3a36', ['#2e2c29', '#4a4742', '#262421'], 0.7);
  });

  T.water = tex(g => {
    noiseFill(g, '#3b82f6', ['#60A5FA', '#2f6fd8', '#7cb5fc'], 0.5);
    g.fillStyle = 'rgba(255,255,255,.35)';
    for (let i = 0; i < 6; i++) g.fillRect((Math.random()*28)|0, (Math.random()*28)|0, 4, 1);
  });

  // ores: rock base with chunky nuggets
  const ore = (dark, mid, bright) => tex(g => {
    noiseFill(g, '#7d7466', ['#8d8474', '#6e6558', '#948b7a', '#7a7163'], 0.6);
    for (const [x, y, w, h] of [[4,5,6,5],[18,4,5,4],[8,15,5,5],[20,17,6,5],[4,24,5,4],[23,26,5,4],[13,25,4,4]]) {
      g.fillStyle = dark; g.fillRect(x, y, w, h);
      g.fillStyle = mid; g.fillRect(x + 1, y + 1, w - 2, h - 2);
      g.fillStyle = bright; g.fillRect(x + 1, y + 1, 2, 2);
    }
  });
  T.copperOre = ore('#6e3d1a', '#b87333', '#e8a05f');
  T.ironOre = ore('#4a4f57', '#8d959e', '#c8d0d8');
  T.silverOre = ore('#7a7f88', '#d7dce4', '#ffffff');
  T.goldOre = ore('#8a6a10', '#e8b923', '#fff0a0');

  // ---------- biome blocks ----------
  T.grass = tex(g => {
    noiseFill(g, '#5da03e', ['#4f9133', '#6bb24a', '#549a38', '#76bd55'], 0.65);
    g.fillStyle = '#7ecb5e'; // bright blades
    for (let i = 0; i < 12; i++) g.fillRect((Math.random()*30)|0, (Math.random()*30)|0, 1, 3);
    g.fillStyle = 'rgba(60,110,35,.5)';
    for (let i = 0; i < 8; i++) g.fillRect((Math.random()*29)|0, (Math.random()*29)|0, 3, 2);
  });

  // campBase — unbreakable bedrock variant dressed as camp grass (brass survey studs give it away)
  T.campBase = tex(g => {
    noiseFill(g, '#5da03e', ['#4f9133', '#6bb24a', '#549a38', '#76bd55'], 0.65);
    g.fillStyle = '#7ecb5e';
    for (let i = 0; i < 10; i++) g.fillRect((Math.random()*30)|0, (Math.random()*30)|0, 1, 3);
    g.fillStyle = 'rgba(60,110,35,.5)';
    for (let i = 0; i < 7; i++) g.fillRect((Math.random()*29)|0, (Math.random()*29)|0, 3, 2);
    // brass survey studs in the corners — marks the camp's bedrock foundation
    g.fillStyle = '#C4934A';
    for (const [x, y] of [[2, 2], [27, 2], [2, 27], [27, 27]]) g.fillRect(x, y, 3, 3);
    g.fillStyle = '#ffd873';
    for (const [x, y] of [[2, 2], [27, 2], [2, 27], [27, 27]]) g.fillRect(x, y, 1, 1);
  });

  T.snow = tex(g => {
    noiseFill(g, '#eef3f8', ['#e2eaf3', '#f8fbff', '#d8e2ee', '#ffffff'], 0.55);
    g.fillStyle = '#ffffff';
    for (let i = 0; i < 6; i++) g.fillRect((Math.random()*30)|0, (Math.random()*30)|0, 2, 2);
    g.fillStyle = 'rgba(160,185,215,.4)';
    for (let i = 0; i < 6; i++) g.fillRect((Math.random()*28)|0, (Math.random()*28)|0, 4, 1);
  });

  T.ice = tex(g => {
    noiseFill(g, '#a8d4f0', ['#8fc4ea', '#c0e2f8', '#9bccee'], 0.5);
    g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(4, 26); g.lineTo(14, 14); g.lineTo(12, 6); g.stroke();
    g.beginPath(); g.moveTo(28, 24); g.lineTo(20, 18); g.stroke();
    g.fillStyle = 'rgba(255,255,255,.55)';
    g.fillRect(6, 4, 8, 2); g.fillRect(20, 8, 6, 2);
  });

  T.sandstone = tex(g => {
    noiseFill(g, '#cfae74', ['#c2a066', '#dcbd85', '#b9975c'], 0.55);
    // horizontal strata bands
    g.fillStyle = 'rgba(150,115,60,.45)';
    g.fillRect(0, 7, 32, 2); g.fillRect(0, 17, 32, 2); g.fillRect(0, 26, 32, 2);
    g.fillStyle = 'rgba(240,215,160,.5)';
    g.fillRect(0, 4, 32, 1); g.fillRect(0, 14, 32, 1); g.fillRect(0, 23, 32, 1);
  });

  T.slate = tex(g => {
    noiseFill(g, '#4a5160', ['#3e4452', '#565e70', '#434a59'], 0.6);
    g.fillStyle = 'rgba(20,24,32,.6)';
    g.fillRect(0, 9, 32, 1); g.fillRect(0, 21, 32, 1);
    g.strokeStyle = 'rgba(110,120,140,.5)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(3, 28); g.lineTo(11, 18); g.lineTo(9, 12); g.stroke();
    g.fillStyle = 'rgba(140,155,180,.35)';
    for (let i = 0; i < 5; i++) g.fillRect((Math.random()*29)|0, (Math.random()*29)|0, 3, 1);
  });

  T.shroom = tex(g => {
    noiseFill(g, '#2a3548', ['#232c3c', '#324056'], 0.5);
    // glowing mushroom cluster
    g.fillStyle = '#1a9a8a'; g.fillRect(10, 8, 12, 7);   // big cap
    g.fillStyle = '#3fe0c8'; g.fillRect(12, 9, 8, 3);
    g.fillStyle = '#c8b89a'; g.fillRect(14, 15, 4, 9);   // stem
    g.fillStyle = '#1a9a8a'; g.fillRect(4, 20, 7, 4);    // small cap
    g.fillStyle = '#3fe0c8'; g.fillRect(5, 21, 5, 2);
    g.fillStyle = '#c8b89a'; g.fillRect(6, 24, 3, 5);
    g.fillStyle = '#7ff5e5'; // spore glints
    g.fillRect(24, 6, 2, 2); g.fillRect(26, 20, 2, 2); g.fillRect(8, 5, 2, 2);
  });

  T.crystal = tex(g => {
    noiseFill(g, '#3e4452', ['#343a48', '#4a5160'], 0.55);
    // magenta crystal shards
    const shard = (x, y, w, h) => {
      g.fillStyle = '#8a3ad0'; g.beginPath();
      g.moveTo(x, y + h); g.lineTo(x + w / 2, y); g.lineTo(x + w, y + h); g.closePath(); g.fill();
      g.fillStyle = '#c98af5'; g.fillRect(x + w / 2 - 1, y + 3, 2, h - 5);
    };
    shard(6, 8, 8, 14); shard(15, 4, 10, 20); shard(22, 14, 7, 12);
    g.fillStyle = '#eed5ff';
    g.fillRect(19, 7, 2, 3); g.fillRect(9, 12, 2, 2);
  });

  // ---------- trees & wood ----------
  T.log = tex(g => {
    noiseFill(g, '#6b4a2a', ['#5e3f22', '#7a5632', '#634424', '#755130'], 0.6);
    // vertical bark grooves
    g.fillStyle = 'rgba(40,26,12,.7)';
    for (const x of [4, 11, 19, 26]) g.fillRect(x, 0, 2, 32);
    g.fillStyle = 'rgba(150,110,64,.5)';
    for (const x of [7, 15, 23, 29]) g.fillRect(x, 0, 1, 32);
    // knot
    g.fillStyle = '#3d2a12'; g.fillRect(13, 14, 6, 5);
    g.fillStyle = '#8a6236'; g.fillRect(15, 16, 2, 2);
  });

  T.leaf = tex(g => {
    noiseFill(g, '#3e7d2e', ['#356e26', '#4a8f38', '#2f6421', '#57a044'], 0.7);
    g.fillStyle = '#6fbf4a'; // bright leaf glints
    for (let i = 0; i < 10; i++) g.fillRect((Math.random()*30)|0, (Math.random()*30)|0, 2, 2);
    g.fillStyle = 'rgba(20,44,14,.65)';
    for (let i = 0; i < 9; i++) g.fillRect((Math.random()*29)|0, (Math.random()*29)|0, 3, 2);
  });

  T.planks = tex(g => {
    noiseFill(g, '#a5763c', ['#987038', '#b48344', '#8e6832', '#af7d40'], 0.5);
    // board seams + nails
    g.fillStyle = '#5e3f22';
    for (const y of [0, 8, 16, 24]) g.fillRect(0, y, 32, 2);
    g.fillStyle = 'rgba(70,48,24,.55)';
    g.fillRect(10, 2, 1, 6); g.fillRect(22, 10, 1, 6); g.fillRect(6, 18, 1, 6); g.fillRect(26, 26, 1, 6);
    g.fillStyle = '#3d2a12';
    g.fillRect(3, 4, 2, 2); g.fillRect(28, 12, 2, 2); g.fillRect(3, 20, 2, 2); g.fillRect(28, 28, 2, 2);
  });

  T.table = tex(g => {
    noiseFill(g, '#a5763c', ['#987038', '#b48344', '#8e6832'], 0.5);
    g.fillStyle = '#5e3f22'; g.fillRect(0, 0, 32, 3); g.fillRect(0, 29, 32, 3);
    // tool silhouettes: hammer + saw
    g.fillStyle = '#3d2a12';
    g.fillRect(6, 8, 4, 10); g.fillRect(4, 6, 8, 4);
    g.fillRect(20, 8, 3, 12);
    g.fillStyle = '#9aa2ae';
    g.fillRect(18, 18, 10, 3);
    for (let x = 18; x < 28; x += 2) g.fillRect(x, 21, 1, 2);
    g.fillStyle = '#C4934A'; // brass corner plates
    g.fillRect(1, 1, 4, 4); g.fillRect(27, 1, 4, 4); g.fillRect(1, 27, 4, 4); g.fillRect(27, 27, 4, 4);
  });

  T.chest = tex(g => {
    noiseFill(g, '#8a5c2c', ['#7c5226', '#986634', '#744c22'], 0.5);
    // lid seam + brass banding
    g.fillStyle = '#4a3010'; g.fillRect(0, 11, 32, 2);
    g.fillStyle = PAL.brown; g.fillRect(0, 0, 3, 32); g.fillRect(29, 0, 3, 32);
    g.fillStyle = '#8B6914'; g.fillRect(0, 0, 32, 2); g.fillRect(0, 30, 32, 2);
    // latch
    g.fillStyle = '#C4934A'; g.fillRect(13, 9, 6, 8);
    g.fillStyle = '#ffd873'; g.fillRect(14, 10, 4, 3);
    g.fillStyle = '#2a1c05'; g.fillRect(15, 13, 2, 3);
  });

  // oven — rock body with a fiery arched mouth
  T.oven = tex(g => {
    noiseFill(g, '#6b6156', ['#7a7064', '#5e554b', '#847a6d'], 0.5);
    // rock rim
    g.strokeStyle = '#4a4239'; g.lineWidth = 2;
    g.strokeRect(1, 1, 30, 30);
    // black arched mouth, center-bottom
    g.fillStyle = '#0e0a08';
    g.fillRect(9, 16, 14, 13);
    g.fillRect(11, 13, 10, 3);
    g.fillRect(13, 11, 6, 2);
    // fire inside
    g.fillStyle = '#e05a1a';
    g.fillRect(11, 24, 10, 5); g.fillRect(13, 21, 6, 3);
    g.fillStyle = '#ffb340';
    g.fillRect(13, 25, 6, 4); g.fillRect(15, 22, 3, 3);
    g.fillStyle = '#ffe08a';
    g.fillRect(15, 26, 2, 3);
    // stone lintel above the mouth
    g.fillStyle = '#847a6d'; g.fillRect(8, 8, 16, 3);
    g.fillStyle = '#4a4239'; g.fillRect(8, 10, 16, 1);
  });

  // glass — pale pane, mostly light (rendered transparent)
  T.glass = tex(g => {
    g.fillStyle = '#cfe8f8'; g.fillRect(0, 0, 32, 32);
    // white frame border
    g.strokeStyle = '#ffffff'; g.lineWidth = 2;
    g.strokeRect(1, 1, 30, 30);
    // diagonal streaks
    g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(4, 14); g.lineTo(14, 4); g.stroke();
    g.beginPath(); g.moveTo(8, 26); g.lineTo(26, 8); g.stroke();
    g.strokeStyle = 'rgba(170,205,230,.6)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(14, 28); g.lineTo(28, 14); g.stroke();
  });

  // glow lantern — iron cage around blazing amber glass (rendered emissive + feeds the light pool)
  T.lantern = tex(g => {
    g.fillStyle = '#2a2622'; g.fillRect(0, 0, 32, 32);
    g.fillStyle = '#ffb340'; g.fillRect(4, 4, 24, 24);       // glass core
    g.fillStyle = '#ffe08a'; g.fillRect(8, 8, 16, 16);
    g.fillStyle = '#fff6d0'; g.fillRect(12, 12, 8, 8);
    g.fillStyle = '#3c3a36';                                  // iron cage bars
    g.fillRect(0, 0, 32, 3); g.fillRect(0, 29, 32, 3);
    g.fillRect(0, 0, 3, 32); g.fillRect(29, 0, 3, 32);
    g.fillRect(14, 0, 4, 32); g.fillRect(0, 14, 32, 4);
    g.fillStyle = '#C4934A';                                  // brass corner caps
    for (const [x, y] of [[0, 0], [28, 0], [0, 28], [28, 28]]) g.fillRect(x, y, 4, 4);
  });

  // waypoint banner — plank pole, cobalt flag with a gold diamond (shows on the compass)
  T.banner = tex(g => {
    noiseFill(g, '#a5763c', ['#987038', '#b48344', '#8e6832'], 0.5);
    g.fillStyle = '#5e3f22'; g.fillRect(13, 0, 6, 32);        // pole
    g.fillStyle = '#8a6236'; g.fillRect(15, 0, 2, 32);
    g.fillStyle = '#1E3A8A'; g.fillRect(19, 2, 12, 14);       // flag
    g.fillStyle = '#2a4ba0'; g.fillRect(19, 2, 12, 3);
    g.fillStyle = '#ffd873';                                  // gold diamond
    g.fillRect(24, 6, 2, 2); g.fillRect(23, 8, 4, 2); g.fillRect(24, 10, 2, 2);
    g.fillStyle = '#C4934A'; g.fillRect(12, 28, 8, 4);        // base plate
  });

  // wood-gas still — brass boiler with copper coil + glass gauge (logs → fuel)
  T.still = tex(g => {
    noiseFill(g, PAL.brown, ['#b5813a', '#d0a25c', '#a2762f'], 0.5);
    g.fillStyle = '#8B6914';                                  // riveted bands
    g.fillRect(0, 4, 32, 3); g.fillRect(0, 25, 32, 3);
    g.fillStyle = '#ffd873';
    for (const x of [3, 11, 19, 27]) { g.fillRect(x, 5, 1, 1); g.fillRect(x, 26, 1, 1); }
    g.fillStyle = '#b06a3a';                                  // copper coil
    g.fillRect(4, 10, 24, 3); g.fillRect(24, 12, 3, 6); g.fillRect(6, 16, 21, 3); g.fillRect(5, 18, 3, 4);
    g.fillStyle = '#d98c50'; g.fillRect(4, 11, 24, 1); g.fillRect(6, 17, 21, 1);
    g.fillStyle = '#0e0a08'; g.fillRect(11, 21, 10, 8);       // fire box
    g.fillStyle = '#e05a1a'; g.fillRect(13, 24, 6, 4);
    g.fillStyle = '#ffb340'; g.fillRect(14, 25, 3, 3);
    g.fillStyle = '#cfe8f8'; g.fillRect(24, 20, 5, 5);        // glass gauge
    g.fillStyle = '#60A5FA'; g.fillRect(25, 22, 3, 2);
  });

  // blast charge — powder keg, hazard stripes, lit fuse
  T.charge = tex(g => {
    noiseFill(g, '#7c3a26', ['#6e3220', '#8a462e', '#63301e'], 0.5);
    g.fillStyle = '#3c3a36'; g.fillRect(0, 8, 32, 3); g.fillRect(0, 21, 32, 3); // iron bands
    // hazard stripe band
    for (let x = 0; x < 32; x += 8) {
      g.fillStyle = '#d9a516'; g.fillRect(x, 13, 4, 6);
      g.fillStyle = '#14100a'; g.fillRect(x + 4, 13, 4, 6);
    }
    g.fillStyle = '#14100a'; g.fillRect(14, 2, 4, 4);         // fuse port
    g.fillStyle = '#c8b89a'; g.fillRect(15, 0, 2, 3);         // fuse
    g.fillStyle = '#ffe08a'; g.fillRect(14, 0, 1, 1); g.fillRect(17, 1, 1, 1); // sparks
  });

  // hauler track — steel rails on timber sleepers
  T.haulerTrack = tex(g => {
    noiseFill(g, '#7a5b34', ['#6b4d29', '#8a693d', '#5e4222'], 0.45);
    g.fillStyle = '#4b3218';
    for (let y = 3; y < 32; y += 6) g.fillRect(0, y, 32, 2); // sleepers
    g.fillStyle = '#6f757f';
    g.fillRect(7, 0, 5, 32);
    g.fillRect(20, 0, 5, 32);
    g.fillStyle = '#a5adba';
    g.fillRect(8, 0, 2, 32);
    g.fillRect(21, 0, 2, 32);
    g.fillStyle = '#2f3137';
    g.fillRect(12, 0, 2, 32);
    g.fillRect(18, 0, 2, 32);
  });

  // player-placed cobalt panel block
  T.placed = tex(g => {
    noiseFill(g, '#2a4ba0', ['#1E3A8A', '#33549e', '#3d63b8'], 0.55);
    g.strokeStyle = '#C4934A'; g.lineWidth = 2;
    g.strokeRect(2, 2, 28, 28);
    g.fillStyle = '#D4B483';
    for (const [x, y] of [[4,4],[25,4],[4,25],[25,25]]) g.fillRect(x, y, 3, 3);
    g.strokeStyle = 'rgba(0,0,0,.25)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(16, 2); g.lineTo(16, 30); g.moveTo(2, 16); g.lineTo(30, 16); g.stroke();
  });

  return T;
}
