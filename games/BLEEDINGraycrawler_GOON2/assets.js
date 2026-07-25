// assets.js
// All asset URLs point to Supabase CDN storage

const SB = 'https://vtelpopqybfytrgzkomj.supabase.co/storage/v1/object/public/game-assets/public/9f509457-a9ea-4f36-833c-dd820c597ef0/9c8633b2-9b38-4975-a64d-fd8c2caea308/';

// ── Image asset map (filename → Supabase URL) ────────────────────────────────
const IMG = {
  'BOSSWLK2.png':               SB + '9c8633b2-9b38-4975-a64d-fd8c2caea308/a7f67e68-6c6f-409f-b114-e68d90c6467f.png',
  'SPIDATK2.png':               SB + '6c99308c-de3e-4eb5-abc0-159493ed2dbf.png',
  'explosion.png':              SB + '426f07b2-3883-44b9-ba89-3b1ed0ac6325.png',
  'brazier.png':                SB + '7b4c8a76-e4dc-4185-a36e-0381305a3ff9.png',
  'torch.png':                  SB + 'a9c588ad-2fc5-4cf1-a002-5f82ee9300c9.png',
  'exit_portal.png':            SB + 'db05951a-c797-41aa-b333-ace5eb1e06f5.png',
  'bookshelf.png':              SB + 'f856ff98-4223-4bc0-a7f5-fd9703fd267f.png',
  'barrel.png':                 SB + '98314e0d-bc98-4378-aff2-01462cd8b9dd.png',
  'pillar.png':                 SB + 'b491d392-2d20-4586-b45c-ba772551c6f9.png',
  'SPIDDEAD.png':               SB + '7bfdfdd2-34a8-4ca7-ad2d-268225acc05d.png',
  'SPIDWLK1.png':               SB + '98368cd8-5d45-440a-9987-ebbd8839f045.png',
  'SPIDWLK2.png':               SB + '3631bffa-1939-441c-9cd5-86fab90f8fb1.png',
  'SPIDATK1.png':               SB + 'f8719f0e-edde-4895-8d31-ef3107a00611.png',
  'SPIDATK3.png':               SB + 'a8845703-a780-463c-9ce4-74632a082614.png',
  'SPIDIDLE.png':               SB + '0ced55f1-91bb-43cb-afce-6669317f6ac5.png',
  'pistol_sprite_new.png':      SB + '9d81b635-5634-4b3e-811b-edf6db8889c1.png',
  'decor_small.png':            SB + '471c2bc6-550d-4764-98a7-93b992f913ae.png',
  'GOB_WLK2.png':               SB + '8a9a61ea-1833-4f04-9a41-5a7e7ebb6f8a.png',
  'GOB_IDLE.png':               SB + '594ec64b-6724-45ed-afae-cde10ddf1ead.png',
  'GOB_ATK2.png':               SB + '16f33b86-2282-4d04-b703-500fad733664.png',
  'GOB_DEAD.png':               SB + 'c352fa88-e08f-4f56-abb3-6cd705a5c038.png',
  'GOB_ATK3.png':               SB + '86227279-7486-4270-8b5c-a62416c14c00.png',
  'BAT_WLK1.png':               SB + 'b7f9c013-032a-47dc-b327-5b4b1957560b.png',
  'GOB_WLK1.png':               SB + '163d8c08-5b7a-4178-934e-2eff5b19ed62.png',
  'GOB_ATK1.png':               SB + 'aa13091e-8846-4eb9-8833-73979325aa7b.png',
  'BOSSATK1.png':               SB + 'e1934197-df45-4cd6-82b8-2faa9837885a.png',
  'BOSSATK2.png':               SB + '2ab9e902-38b0-4571-b568-22e3f9b2ed72.png',
  'BOSSWLK1.png':               SB + '73f34807-21f9-44aa-b6ae-9dfc8e5add26.png',
  'BOSSIDLE.png':               SB + '8f6f3060-bbb9-4e85-be86-004621f7aa90.png',
  'BOSSDEAD.png':               SB + '3609e1b5-df72-4da3-9523-4ddbe6db8a02.png',
  'ABOMWLK2.png':               SB + 'c578d4c7-d19b-4291-8a1b-766304031704.png',
  'BAT_IDLE.png':               SB + '8d4ec76f-4854-4d81-ba82-6c12489abb5f.png',
  'BOSSATK3.png':               SB + '58fa8ada-1b08-49a5-9ae1-b77b2a7269fa.png',
  'ABOMATK1.png':               SB + 'b8dde7b3-ef69-4247-a61d-c8b6f5308e04.png',
  'ABOMDEAD.png':               SB + '082881b4-6df8-410a-9063-84f204b67e52.png',
  'BAT_DEAD.png':               SB + 'ebd9555e-4d0e-48fb-a99c-8ace175b80dd.png',
  'ABOMATK2.png':               SB + '400a0a57-7712-4386-9678-545e5612f1a2.png',
  'ABOMIDLE.png':               SB + 'c6e26fa6-4c89-49a7-9bdd-2779fb8ea2d7.png',
  'BAT_ATK1.png':               SB + 'a46976ee-cf06-4a5b-8184-cc94458f4254.png',
  'tophat.png':                 SB + '36da9e81-5237-4482-a558-7bc9b0aaaa80.png',
  'ABOMWLK1.png':               SB + '86885830-104c-493f-bc0a-401cf492a23a.png',
  'health_pack.png':            SB + '3b4be6a7-8a18-4828-97eb-d9c0afd15873.png',
  'MENUBUTTONPIECES.png':       SB + '1524d820-8657-47fb-8bb6-1dd4b257b3d3.png',
  'GEM_HANDLE.png':             SB + '646be7c3-6daf-42f3-beff-11122d370d24.png',
  'MENU_GFX.png':               SB + '33483fc2-54a5-4b80-89b3-a1ff24d1700b.png',
  'ABOMATK3.png':               SB + '54dcaa51-8df9-4383-b7b2-7c1f567ed30d.png',
  'BAT_WLK2.png':               SB + '2fc2fa57-10ba-455f-a933-726d1b991297.png',
  'BAT_ATK2.png':               SB + '441207bd-7a6a-413f-8a70-431adaf0425a.png',
  'BAT_ATK3.png':               SB + '8866779f-16bc-4b58-8b6b-bda1b7ab5179.png',
  'muzzle_flash.png':           SB + '317dc8e1-ec6b-4534-b729-d6574df47307.png',
  'plasma_bolt.png':            SB + 'fa2828fa-5be4-4d1b-be2a-d48fe696646a.png',
  'CRSSBOLT.png':               SB + '73098e83-5eb8-4f37-9d9c-d9287c6c4096.png',
  'treasure_chest_open.png':    SB + '5ef22fe6-dce1-459f-8ed2-bfbc857bc1d3.png',
  'gem_keys.png':               SB + 'ec277501-2f60-4846-ae46-e7355bc8e5a7.png',
  'ammo_crate.png':             SB + 'e2daec49-4e00-43dd-bb34-d119156b2d29.png',
  'sword_sprite_new.png':       SB + '06efa552-1e96-488f-b1fa-cca006344b9f.png',
  'puddle_blood.png':           SB + '43b2f88c-6884-4168-9e74-208c14d89469.png',
  'crossbow_sprite_new.png':    SB + '1a074108-2127-443d-b1ab-f77a58cf001c.png',
  'cannon_sprite.png':          SB + 'd6fc6a07-eb7e-404c-becb-d87cb2db0131.png',
  'floor_library.png':          SB + '7f2a5cfe-bf7a-4e87-9dc3-dfac1f4bf864.png',
  'shotgun_sprite_v2.png':      SB + 'a934cf5f-ebee-4bb8-a2e1-31eaa46226cb.png',
  'table.png':                  SB + '6f447a1c-4d70-4169-aa4e-e9f75fe18cc3.png',
  'SLIDER_BAR.png':             SB + 'e5db7692-3c68-4250-af5e-f3cc5184dcf3.png',
  'plasma2_sprite_new.png':     SB + '4d555d25-5e1f-48fe-92e5-228ec3c1eab2.png',
  'puddle_water.png':           SB + '279ae6e9-9b57-48d6-8847-14a247876ea5.png',
  'chair.png':                  SB + '837cb882-355d-41e9-a840-9e85a50d2fd1.png',
  'rubble.png':                 SB + '0b1c20e1-2f93-474d-8029-f5a78e9bcbeb.png',
  'puddle_slime.png':           SB + 'a097622f-b5af-4828-8db3-b2f34d3b9b4d.png',
  'puddle_mud.png':             SB + '783d1fd1-b3b5-4e86-99a9-81373c5b022f.png',
  'shop_bg.png':                SB + '17a44c64-962a-445e-9c59-f0354b4e4ad7.png',
  'TITLE.png':                  SB + '8d5e6138-7d61-4ae1-904a-090fc712ceb5.png',
  'INTERMISSION.png':           SB + '1bf416c3-df0c-49fa-a9da-1dfdb63e3603.png',
  'wall_cave.png':              SB + 'a29fde5d-66e8-4d44-91cf-aa6137ea8d33.png',
  'wall_ruins.png':             SB + '78ca0b6f-9b47-466d-a23d-7b0eaf733bb8.png',
  'wall_door.png':              SB + '5327e2c7-1fbd-4a5e-b330-6ef058babff5.png',
  'wall_dungeon.png':           SB + '26fb4b3f-fd48-40b7-b500-f94441468852.png',
  'floor_abomination.png':      SB + '93c2b3b4-f69f-4dc3-ac34-5cc152f1a5b3.png',
  'floor_cave.png':             SB + '4c8cb38d-f487-4ff5-a651-915024bc6d54.png',
  'wall_library.png':           SB + '0ecd361c-5444-4bb4-ac9d-1c9e69fa7696.png',
};

// Fix: BOSSWLK2.png URL had double UUID segment — correct it
IMG['BOSSWLK2.png'] = SB + 'a7f67e68-6c6f-409f-b114-e68d90c6467f.png';

// ── Audio asset map ───────────────────────────────────────────────────────────
const AUD = {
  'plasma_shoot.mp3':           SB + '68d59ad4-8f18-4ed9-85b7-49f6984b0916.mp3',
  'crossbow_fire.mp3':          SB + '6b839d11-bf90-423a-9d03-de63541f5e4e.mp3',
  'cannon_fire.mp3':            SB + 'bf8152f5-c0b5-40c9-803e-77693e965806.mp3',
  'sword_swing.mp3':            SB + '5efc545e-c233-4eea-b04f-56adfc86f91a.mp3',
  'shop_buy.mp3':               SB + '4bbdd980-9366-49c0-a8af-efea6e84f6c2.mp3',
  'shotgun_fire.mp3':           SB + '66871506-6dbb-406f-8902-7f3b1c6c24eb.mp3',
  'plasma2_fire.mp3':           SB + '9ec3817c-a63b-4780-af32-d7bd6dda3037.mp3',
  'secret_sound_pcm_simulated_bloop_bleep_boop.mp3': SB + 'ec3dcfef-f850-4e23-be61-f345e0df79f1.mp3',
  'bat_die.mp3':                SB + 'e5d27cf7-f1c5-4955-9690-079ac8e9804f.mp3',
  'goblin_die.mp3':             SB + '48c328ab-b673-43de-b358-950eb5d92220.mp3',
  'abomination_die.mp3':        SB + 'f335d89e-f598-4c65-88ba-a0926652a5a0.mp3',
  'spider_die.mp3':             SB + 'ee42148d-eccf-4a05-b7a8-dc17b1d755a1.mp3',
  'troll_die.mp3':              SB + '3dc3b0d2-2f45-43c8-a745-8fdf9882e803.mp3',
  'intro_jingle.mp3':           SB + 'c270b2e9-81e7-43d3-ad1f-ccf3ed675d76.mp3',
  'ambience_b.mp3':             SB + '70fc9968-6cf2-4697-a025-93c2328deb41.mp3',
  'ambience_c.mp3':             SB + '4e4a1ae3-209e-4b33-a5a8-0dc08144300a.mp3',
  'ambience_a.mp3':             SB + 'e9dc79db-2733-41ac-a27e-76abee8c9d1a.mp3',
};

export const SPRITE_URLS = {
  goblin:          IMG['GOB_IDLE.png'],
  goblinDead:      IMG['GOB_DEAD.png'],
  gobIdle:         IMG['GOB_IDLE.png'],
  gobWlk1:         IMG['GOB_WLK1.png'],
  gobWlk2:         IMG['GOB_WLK2.png'],
  gobAtk1:         IMG['GOB_ATK1.png'],
  gobAtk2:         IMG['GOB_ATK2.png'],
  gobAtk3:         IMG['GOB_ATK3.png'],
  gobDead:         IMG['GOB_DEAD.png'],
  bat:             IMG['BAT_IDLE.png'],
  batDead:         IMG['BAT_DEAD.png'],
  batIdle:         IMG['BAT_IDLE.png'],
  batWlk1:         IMG['BAT_WLK1.png'],
  batWlk2:         IMG['BAT_WLK2.png'],
  batAtk1:         IMG['BAT_ATK1.png'],
  batAtk2:         IMG['BAT_ATK2.png'],
  batAtk3:         IMG['BAT_ATK3.png'],
  batDeadFlat:     IMG['BAT_DEAD.png'],
  spider:          IMG['SPIDIDLE.png'],
  spiderDead:      IMG['SPIDDEAD.png'],
  spiderIdle:      IMG['SPIDIDLE.png'],
  spiderWlk1:      IMG['SPIDWLK1.png'],
  spiderWlk2:      IMG['SPIDWLK2.png'],
  spiderAtk1:      IMG['SPIDATK1.png'],
  spiderAtk2:      IMG['SPIDATK2.png'],
  spiderAtk3:      IMG['SPIDATK3.png'],
  spiderDeadFlat:  IMG['SPIDDEAD.png'],
  trollBoss:       IMG['BOSSIDLE.png'],
  trollDead:       IMG['BOSSDEAD.png'],
  bossIdle:        IMG['BOSSIDLE.png'],
  bossWlk1:        IMG['BOSSWLK1.png'],
  bossWlk2:        IMG['BOSSWLK2.png'],
  bossAtk1:        IMG['BOSSATK1.png'],
  bossAtk2:        IMG['BOSSATK2.png'],
  bossAtk3:        IMG['BOSSATK3.png'],
  bossDead:        IMG['BOSSDEAD.png'],
  abomination:     IMG['ABOMIDLE.png'],
  abominationDead: IMG['ABOMDEAD.png'],
  abomIdle:        IMG['ABOMIDLE.png'],
  abomWlk1:        IMG['ABOMWLK1.png'],
  abomWlk2:        IMG['ABOMWLK2.png'],
  abomAtk1:        IMG['ABOMATK1.png'],
  abomAtk2:        IMG['ABOMATK2.png'],
  abomAtk3:        IMG['ABOMATK3.png'],
  abomDead:        IMG['ABOMDEAD.png'],
  wall:            IMG['wall_dungeon.png'],
  floor:           IMG['floor_cave.png'],
  gun:             IMG['pistol_sprite_new.png'],
  muzzle:          IMG['muzzle_flash.png'],
  muzzleFlash:     IMG['muzzle_flash.png'],
  healthPack:      IMG['health_pack.png'],
  ammoCrate:       IMG['ammo_crate.png'],
  barrel:          IMG['barrel.png'],
  pillar:          IMG['pillar.png'],
  torch:           IMG['torch.png'],
  exitPortal:      IMG['exit_portal.png'],
  wallCave:        IMG['wall_cave.png'],
  wallDungeon:     IMG['wall_dungeon.png'],
  wallRuins:       IMG['wall_ruins.png'],
  wallLibrary:     IMG['wall_library.png'],
  explosion:       IMG['explosion.png'],
  floorCave:       IMG['floor_cave.png'],
  floorLibrary:    IMG['floor_library.png'],
  bookshelf:       IMG['bookshelf.png'],
  rubble:          IMG['rubble.png'],
  plasmaBolt:      IMG['plasma_bolt.png'],
  crossbowBolt:    IMG['CRSSBOLT.png'],
  shopBg:          IMG['shop_bg.png'],
  brazier:         IMG['brazier.png'],
  table:           IMG['table.png'],
  chair:           IMG['chair.png'],
  decorSmall:      IMG['decor_small.png'],
  puddleWater:     IMG['puddle_water.png'],
  puddleSlime:     IMG['puddle_slime.png'],
  puddleBlood:     IMG['puddle_blood.png'],
  puddleMud:       IMG['puddle_mud.png'],
  gemKeys:         IMG['gem_keys.png'],
  treasureChest:   IMG['treasure_chest_open.png'],
  floorAbomination:IMG['floor_abomination.png'],
  wallDoor:        IMG['wall_door.png'],
};

export const WEAPON_SPRITE_URLS = {
  pistol:   IMG['pistol_sprite_new.png'],
  shotgun:  IMG['shotgun_sprite_v2.png'],
  crossbow: IMG['crossbow_sprite_new.png'],
  cannon:   IMG['cannon_sprite.png'],
  sword:    IMG['sword_sprite_new.png'],
  plasma2:  IMG['plasma2_sprite_new.png'],
};

export const HAT_BRIM_URL           = IMG['tophat.png'];
export const MENU_BUTTON_PIECES_URL = IMG['MENUBUTTONPIECES.png'];
export const TITLE_URL              = IMG['TITLE.png'];
export const MENU_GFX_URL           = IMG['MENU_GFX.png'];
export const GEM_HANDLE_URL         = IMG['GEM_HANDLE.png'];
export const SLIDER_BAR_URL         = IMG['SLIDER_BAR.png'];
export const INTERMISSION_URL       = IMG['INTERMISSION.png'];

export const SHOP_BUY_SFX_URL = AUD['shop_buy.mp3'];
export const DOOR_SFX_URL     = AUD['secret_sound_pcm_simulated_bloop_bleep_boop.mp3'];
export const doorSfx          = new Audio(DOOR_SFX_URL);
doorSfx.volume = 0.5;

export const ENEMY_ANIM_URLS = {
  goblin: {
            walk: IMG['GOB_WLK1.png'],
            attack: IMG['GOB_ATK1.png']
            },
  bat:    {
            walk: IMG['BAT_WLK1.png'],
            attack: IMG['BAT_ATK1.png']
            },
  spider: {
            walk: IMG['SPIDWLK1.png'],
            attack: IMG['SPIDATK1.png']
            },
  troll:  {
            walk: IMG['BOSSWLK1.png'],
            attack: IMG['BOSSATK1.png']
            },
  abomination: {
            walk: IMG['ABOMWLK1.png'],
            attack: IMG['ABOMATK1.png']
            },
};

export const WEAPON_SFX_URLS = {
  pistol:   AUD['plasma_shoot.mp3'],
  shotgun:  AUD['shotgun_fire.mp3'],
  crossbow: AUD['crossbow_fire.mp3'],
  cannon:   AUD['cannon_fire.mp3'],
  sword:    AUD['sword_swing.mp3'],
  plasma2:  AUD['plasma2_fire.mp3'],
};

export const ENEMY_SFX_URLS = {
  goblin:      AUD['goblin_die.mp3'],
  bat:         AUD['bat_die.mp3'],
  spider:      AUD['spider_die.mp3'],
  troll:       AUD['troll_die.mp3'],
  abomination: AUD['abomination_die.mp3'],
};

export const AMBIENCE_URLS = [
  AUD['ambience_a.mp3'],
  AUD['ambience_b.mp3'],
  AUD['ambience_c.mp3'],
];

// ═══════════════════════════════════════════════════════════════════════════════
// CUSTOM SFX — populated live by ModEditor when players upload audio files.
// Shape: { [sfxId]: Audio }   e.g. { 'wpn_pistol': Audio, 'enemy_goblin': Audio }
// playWeaponSfx / playEnemyDeathSfx check this first before falling back to defaults.
// ═══════════════════════════════════════════════════════════════════════════════
export const customSfx = {};

// ══════════════════════════════════════════════════════════════════════════════
// CUSTOM ANIMATION FRAMES — populated live by ModEditor when players upload
// individual walk/attack frame PNGs for each enemy type.
//
// Shape: { goblin: { walk: [Image|null, Image|null], attack: [Image|null, Image|null, Image|null] }, ... }
// The renderer checks this before falling back to the generated spritesheet.
// ═════════════════��══════════════════════════════════════════════════════════
export const customAnimFrames = {};

const ANIM_ENEMY_TYPES = ['goblin', 'bat', 'spider', 'troll', 'abomination'];
for (const t of ANIM_ENEMY_TYPES) {
  customAnimFrames[t] = {
    walk:   [null, null],
    attack: [null, null, null],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SPRITE ATLAS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ATLAS_SPRITE_SIZE — all single-frame sprite images are scaled to this size
 * and packed into a single atlas canvas during the precache phase.
 * 128×128 is a good fit: big enough for a 320×200 raycaster viewport,
 * small enough that ~60 sprites fit in a 1024×1024 atlas with room to spare.
 */
export const ATLAS_SPRITE_SIZE = 128;

/**
 * Keys that must stay as original HTMLImageElement references because the
 * renderer samples them column-by-column (texX = wallX * naturalWidth) for
 * wall rendering, or uses sub-rect frame math that depends on naturalWidth.
 *
 * Everything NOT in this set will be replaced with an atlas-backed proxy
 * canvas (128×128) after the precache phase completes.
 */
export const FULL_RES_KEYS = new Set([
  // Wall textures — raycaster does per-pixel column sampling
  'wall', 'wallCave', 'wallDungeon', 'wallRuins', 'wallLibrary', 'wallDoor',
  // Floor textures — used for floor/ceiling casting (pixel sampling)
  'floor', 'floorCave', 'floorLibrary', 'floorAbomination',
  // Multi-frame sprite sheets — sub-rect math uses naturalWidth
  'gemKeys',    // 3-wide spritesheet (red|green|blue)
  'decorSmall', // 2x2 spritesheet (skull, bones, claypot, unused)
]);

// ── Exported singleton atlas (populated by precacheTextures) ─────────────────
// Access via: import { spriteAtlas } from './assets.js';
// spriteAtlas.get(key) → HTMLCanvasElement (128×128, .complete/.naturalWidth set)
export let spriteAtlas = null;

/**
 * _makeAtlasProxy(canvas) — wraps an HTMLCanvasElement with the
 * .complete / .naturalWidth / .naturalHeight properties that the renderer
 * checks on HTMLImageElement objects.  This lets atlas canvases drop in as
 * direct replacements for Image refs without touching renderer.js.
 */
function _makeAtlasProxy(canvas) {
  Object.defineProperties(canvas, {
    complete:      { get: () => true,          configurable: true },
    naturalWidth:  { get: () => canvas.width,  configurable: true },
    naturalHeight: { get: () => canvas.height, configurable: true },
  });
  return canvas;
}

/**
 * SpriteAtlas — a single packed canvas containing all single-frame sprites
 * scaled to ATLAS_SPRITE_SIZE×ATLAS_SPRITE_SIZE.
 *
 * After build(), each registered key maps to a standalone 128×128 proxy
 * canvas (extracted from the packed atlas) for direct use as an image source.
 *
 * Layout: sprites are packed left-to-right, top-to-bottom in a square grid.
 * Atlas width = ceil(sqrt(count)) * ATLAS_SPRITE_SIZE.
 */
export class SpriteAtlas {
  constructor() {
    /** @type {Map<string, HTMLCanvasElement>} key → 128×128 proxy canvas */
    this._sprites = new Map();
    /** The packed atlas canvas (for debugging / diagnostics) */
    this.canvas = null;
    this.built = false;
  }

  /**
   * Build the atlas from the provided image map.
   * @param {Object.<string, HTMLImageElement>} imgMap  key → Image
   * @param {Set<string>} [skipKeys]  keys to exclude (full-res keep-list)
   */
  build(imgMap, skipKeys = new Set()) {
    const entries = [];
    for (const [key, img] of Object.entries(imgMap)) {
      if (skipKeys.has(key)) continue;
      if (!(img instanceof HTMLImageElement)) continue;
      if (!img.complete || img.naturalWidth === 0) continue;
      entries.push({ key, img });
    }

    if (entries.length === 0) { this.built = true; return; }

    const S = ATLAS_SPRITE_SIZE;
    // Only scale down to ATLAS_SPRITE_SIZE if the source image is 512×512 or larger.
    // Smaller images are packed at their native resolution to avoid blurriness/distortion.
    const SCALE_THRESHOLD = 512;

    const cols = Math.ceil(Math.sqrt(entries.length));
    const rows = Math.ceil(entries.length / cols);

    // Build the packed atlas canvas (sized to S so all slots are uniform in the grid)
    const atlas = document.createElement('canvas');
    atlas.width  = cols * S;
    atlas.height = rows * S;
    const actx = atlas.getContext('2d');
    actx.imageSmoothingEnabled = false;

    entries.forEach(({ key, img }, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const ax = col * S;
      const ay = row * S;

      const srcW = img.naturalWidth;
      const srcH = img.naturalHeight;
      // Use native size for small images; scale to S×S only for large (≥512) images
      const destW = (srcW >= SCALE_THRESHOLD || srcH >= SCALE_THRESHOLD) ? S : srcW;
      const destH = (srcW >= SCALE_THRESHOLD || srcH >= SCALE_THRESHOLD) ? S : srcH;

      // Draw into the atlas slot (centred within the S×S cell for small images)
      const offX = ax + Math.floor((S - destW) / 2);
      const offY = ay + Math.floor((S - destH) / 2);
      actx.drawImage(img, offX, offY, destW, destH);

      // Extract a standalone canvas for this sprite at its actual drawn size
      const sc = document.createElement('canvas');
      sc.width  = destW;
      sc.height = destH;
      const sctx = sc.getContext('2d');
      sctx.imageSmoothingEnabled = false;
      sctx.drawImage(atlas, offX, offY, destW, destH, 0, 0, destW, destH);

      this._sprites.set(key, _makeAtlasProxy(sc));
    });

    this.canvas = atlas;
    this.built = true;
  }

  /**
   * Get the atlas proxy canvas for a key.
   * Returns null if not found (key was excluded or not loaded).
   * @param {string} key
   * @returns {HTMLCanvasElement|null}
   */
  get(key) {
    return this._sprites.get(key) || null;
  }

  /** All keys registered in this atlas */
  keys() {
    return this._sprites.keys();
  }

  /** Number of sprites packed */
  get size() {
    return this._sprites.size;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOADER UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

export function loadImg(url) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  return img;
}

/** Load all static sprite assets into an object keyed by name */
export function loadAllSprites() {
  const assets = {};
  for (const [key, url] of Object.entries(SPRITE_URLS)) {
    assets[key] = loadImg(url);
  }
  return assets;
}

/** Load weapon sprite images keyed by weapon id (kept for legacy/mod-editor use) */
export function loadWeaponSprites() {
  const sprites = {};
  for (const [key, url] of Object.entries(WEAPON_SPRITE_URLS)) {
    sprites[key] = loadImg(url);
  }
  return sprites;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEAPON SPRITE MANAGER
// Weapons are intentionally decoupled from the SpriteAtlas.  They live on their
// own offscreen canvas so we can apply per-frame torch / fire colour effects
// without contaminating the shared atlas or baking static fog buckets.
//
// Usage:
//   const wm = new WeaponSpriteManager();
//   await wm.ready();                     // waits for all images to load
//   const cvs = wm.get('pistol');         // raw offscreen canvas (native res)
//   const lit = wm.getTorchCanvas('pistol', flicker, time); // fire-tinted copy
// ═══════════════════════════════════════════════════════════════════════════════
export class WeaponSpriteManager {
  constructor() {
    /** @type {Map<string, HTMLImageElement>} source images */
    this._imgs = new Map();
    /** @type {Map<string, HTMLCanvasElement>} offscreen canvases ��� always RENDER_SIZE×RENDER_SIZE */
    this._canvases = new Map();
    /**
     * Torch-tint result cache per weapon key.
     * Each entry: { flicker: number, canvas: HTMLCanvasElement, data: Uint8ClampedArray }
     * Only rebuilt when flicker changes by more than FLICKER_THRESHOLD.
     */
    this._torchCache = new Map();
    /**
     * Flash-composite cache per weapon key.
     * Each entry: { intensity: number, torchFlicker: number, canvas: HTMLCanvasElement }
     */
    this._flashCache = new Map();

    // Pixel-op scratch canvas — ALWAYS RENDER_SIZE × RENDER_SIZE (128×128 = 16k pixels, not 512k)
    this._scratch = document.createElement('canvas');
    this._scratch.width  = ATLAS_SPRITE_SIZE; // 128
    this._scratch.height = ATLAS_SPRITE_SIZE; // 128
    this._scratchCtx = this._scratch.getContext('2d', { willReadFrequently: true });
    this._scratchCtx.imageSmoothingEnabled = false;

    // Load each weapon image and bake onto its own offscreen canvas once ready
    for (const [key, url] of Object.entries(WEAPON_SPRITE_URLS)) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => this._bake(key, img);
      img.src = url;
      this._imgs.set(key, img);
    }
  }

  /** Internal: downscale image to RENDER_SIZE×RENDER_SIZE and bake onto a dedicated canvas.
   *  Working at render resolution (128×128) instead of native (up to 512×512) cuts getImageData
   *  cost by up to 16× and eliminates the per-kill lag spike. */
  _bake(key, img) {
    const S = ATLAS_SPRITE_SIZE; // 128
    const cvs = document.createElement('canvas');
    cvs.width  = S;
    cvs.height = S;
    const cx = cvs.getContext('2d');
    cx.imageSmoothingEnabled = false;
    cx.drawImage(img, 0, 0, S, S);
    this._canvases.set(key, cvs);
    // Invalidate caches for this key whenever a new image is baked
    this._torchCache.delete(key);
    this._flashCache.delete(key);
  }

  /**
   * Returns a Promise that resolves once all weapon images are baked.
   * Safe to await during the loading phase.
   */
  ready() {
    const promises = [];
    for (const [key, img] of this._imgs) {
      if (this._canvases.has(key)) continue;
      promises.push(new Promise(resolve => {
        if (img.complete && img.naturalWidth > 0) {
          this._bake(key, img);
          resolve();
        } else {
          img.addEventListener('load',  () => { this._bake(key, img); resolve(); }, { once: true });
          img.addEventListener('error', () => resolve(), { once: true });
        }
      }));
    }
    return Promise.all(promises);
  }

  /**
   * Get the offscreen canvas for a weapon key (native resolution, no fog).
   * Returns null if the image hasn't loaded yet.
   * @param {string} key
   * @returns {HTMLCanvasElement|null}
   */
  get(key) {
    return this._canvases.get(key) || null;
  }

  /**
   * Get a torch-effect copy of the weapon canvas using 4×4 Bayer dither.
   * Each pixel is either tinted warm-orange or left original depending on the
   * dither threshold, matching the same aesthetic as wall/floor torch halos.
   *
   * @param {string}  key      — weapon id (e.g. 'pistol')
   * @param {number}  flicker  — torch brightness 0..1 (from renderer's _flickerVal)
   * @param {number}  time     — running time in seconds (for animated shimmer)
   * @returns {HTMLCanvasElement|null}
   */
  getTorchCanvas(key, flicker, time) {
    const src = this._canvases.get(key);
    if (!src) return null;

    // Canvas is always ATLAS_SPRITE_SIZE × ATLAS_SPRITE_SIZE (128×128) thanks to _bake().
    const w = src.width, h = src.height; // always 128×128

    // ── Flicker-change cache: skip expensive pixel loop when flicker didn't change enough ──
    const FLICKER_STEPS = 32;
    const flickerQ = Math.round(flicker * FLICKER_STEPS) / FLICKER_STEPS;
    const cached = this._torchCache.get(key);
    if (cached && Math.abs(cached.flicker - flickerQ) < 0.5 / FLICKER_STEPS) {
      if (cached.canvas !== this._scratch) {
        const cx = this._scratchCtx;
        cx.clearRect(0, 0, w, h);
        cx.drawImage(cached.canvas, 0, 0);
      }
      return cached.canvas;
    }

    if (this._scratch.width !== w || this._scratch.height !== h) {
      this._scratch.width  = w;
      this._scratch.height = h;
    }
    const cx = this._scratchCtx;

    cx.clearRect(0, 0, w, h);
    cx.drawImage(src, 0, 0);

    if (flickerQ < 0.01) {
      this._torchCache.set(key, { flicker: flickerQ, canvas: this._scratch });
      return this._scratch;
    }

    const pulse   = 0.5 + 0.5 * Math.sin(time * 6.3);
    const tint    = flickerQ * (0.30 + 0.20 * pulse);
    if (tint < 0.01) {
      this._torchCache.set(key, { flicker: flickerQ, canvas: this._scratch });
      return this._scratch;
    }

    const imgData = cx.getImageData(0, 0, w, h);
    const data    = imgData.data;

    const threshold = tint * 2;
    const threshFull = threshold >= 1.0;

    for (let py = 0; py < h; py++) {
      const rowBase = py * w * 4;
      for (let px = 0; px < w; px++) {
        const idx   = rowBase + px * 4;
        const alpha = data[idx + 3];
        if (alpha < 16) continue;

        const lum = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
        if (lum < 28) continue;

        const checker = (px + py) & 1;
        const pass = checker === 0 ? threshold > 0 : threshFull;
        if (!pass) continue;

        const blend = 0.45;
        data[idx    ] = Math.min(255, data[idx    ] + (255 - data[idx    ]) * blend);
        data[idx + 1] = Math.min(255, data[idx + 1] + (140 - data[idx + 1]) * blend * 0.6);
        data[idx + 2] = Math.max(0,   data[idx + 2] - data[idx + 2]         * blend * 0.5);
      }
    }

    cx.putImageData(imgData, 0, 0);

    const torchCvs = document.createElement('canvas');
    torchCvs.width = w; torchCvs.height = h;
    const tcx = torchCvs.getContext('2d');
    tcx.imageSmoothingEnabled = false;
    tcx.drawImage(this._scratch, 0, 0);
    this._torchCache.set(key, { flicker: flickerQ, canvas: torchCvs });

    return this._scratch;
  }

  /**
   * Composite a muzzle flash onto the weapon canvas (offscreen, black-pixels masked).
   *
   * @param {string}              key         — weapon id (e.g. 'pistol')
   * @param {number}              intensity   — 0..1 flash strength
   * @param {number}              [torchFlicker=0] — if >0 torch dither is also applied
   * @param {number}              [time=0]    — running time for torch shimmer
   * @returns {HTMLCanvasElement|null}
   */
  applyMuzzleFlash(key, intensity, torchFlicker = 0, time = 0) {
    if (intensity <= 0) return null;

    const INTENS_STEPS = 16;
    const intensQ = Math.round(intensity * INTENS_STEPS) / INTENS_STEPS;
    const FLICKER_STEPS = 32;
    const flickerQ = Math.round(torchFlicker * FLICKER_STEPS) / FLICKER_STEPS;

    const fc = this._flashCache.get(key);
    if (fc &&
        Math.abs(fc.intensity     - intensQ) < 0.5 / INTENS_STEPS &&
        Math.abs(fc.torchFlicker  - flickerQ) < 0.5 / FLICKER_STEPS) {
      return fc.canvas;
    }

    let src;
    if (torchFlicker > 0.01) {
      src = this.getTorchCanvas(key, torchFlicker, time);
    } else {
      src = this._canvases.get(key) || null;
    }
    if (!src) return null;

    const w = src.width, h = src.height;

    if (this._scratch.width !== w || this._scratch.height !== h) {
      this._scratch.width  = w;
      this._scratch.height = h;
    }
    const cx = this._scratchCtx;

    if (src !== this._scratch) {
      cx.clearRect(0, 0, w, h);
      cx.drawImage(src, 0, 0);
    }

    const imgData = cx.getImageData(0, 0, w, h);
    const data    = imgData.data;

    const cx0 = w * 0.5;
    const cy0 = h * 0.65;
    const rw   = w * 0.40 * intensQ;
    const rhUp = h * 0.28 * intensQ;
    const rhDn = h * 0.14 * intensQ;

    const rw2   = rw   * rw;
    const rhUp2 = rhUp * rhUp;
    const rhDn2 = Math.max(1, rhDn * rhDn);

    for (let py = 0; py < h; py++) {
      const rowBase = py * w * 4;
      const dy = py - cy0;
      const ry2 = dy < 0 ? (dy * dy) / (rhUp2 || 1) : (dy * dy) / rhDn2;

      for (let px = 0; px < w; px++) {
        const idx   = rowBase + px * 4;
        const alpha = data[idx + 3];
        if (alpha < 16) continue;

        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
        const lum = r * 0.299 + g * 0.587 + b * 0.114;
        if (lum < 28) continue;

        const ddx = px - cx0;
        const radial = (ddx * ddx) / (rw2 || 1) + ry2;
        if (radial >= 1.0) continue;

        const fade = (1.0 - radial) * intensQ;

        data[idx    ] = Math.min(255, r + (255 * fade * 0.90) | 0);
        data[idx + 1] = Math.min(255, g + (140 * fade * 0.55) | 0);
        data[idx + 2] = Math.min(255, b + ( 20 * fade * 0.25) | 0);
      }
    }

    cx.putImageData(imgData, 0, 0);

    const flashCvs = document.createElement('canvas');
    flashCvs.width = w; flashCvs.height = h;
    const fcx = flashCvs.getContext('2d');
    fcx.imageSmoothingEnabled = false;
    fcx.drawImage(this._scratch, 0, 0);
    this._flashCache.set(key, { intensity: intensQ, torchFlicker: flickerQ, canvas: flashCvs });

    return this._scratch;
  }

  /**
   * Hot-swap a weapon's source image (used by ModEditor for custom uploads).
   * @param {string} key   — weapon id
   * @param {string} url   — new image URL
   */
  hotSwap(key, url) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => this._bake(key, img);
    img.src = url;
    this._imgs.set(key, img);
  }
}

/**
 * SpriteSheet: loads a 2x2 spritesheet and extracts individual frame canvases.
 * Each frame is a quarter of the image.
 */
export class SpriteSheet {
  constructor(url, cols = 2, rows = 2) {
    this.url = url;
    this.cols = cols;
    this.rows = rows;
    this.img = loadImg(url);
    this.frames = [];
    this.ready = false;
    this._init();
  }

  _init() {
    this.img.onload = () => {
      const fw = this.img.naturalWidth / this.cols;
      const fh = this.img.naturalHeight / this.rows;
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          const cvs = document.createElement('canvas');
          cvs.width = fw;
          cvs.height = fh;
          const cx = cvs.getContext('2d');
          cx.drawImage(this.img, c * fw, r * fh, fw, fh, 0, 0, fw, fh);
          this.frames.push(cvs);
        }
      }
      this.ready = true;
    };
  }

  /** Get a frame canvas by index (wraps) */
  getFrame(index) {
    if (!this.ready || this.frames.length === 0) return null;
    return this.frames[index % this.frames.length];
  }
}

/** Load all enemy animation spritesheets */
export function loadEnemyAnims() {
  const anims = {};
  for (const [enemyType, animSet] of Object.entries(ENEMY_ANIM_URLS)) {
    anims[enemyType] = {};
    for (const [animName, url] of Object.entries(animSet)) {
      anims[enemyType][animName] = new SpriteSheet(url, 2, 2);
    }
  }
  return anims;
}

/** Load enemy death audio objects */
export function loadEnemySfx() {
  const sfx = {};
  for (const [key, url] of Object.entries(ENEMY_SFX_URLS)) {
    sfx[key] = new Audio(url);
    sfx[key].volume = key === 'goblin' ? 0.3 : 0.45;
  }
  return sfx;
}

/** Load weapon fire audio objects */
export function loadWeaponSfx() {
  const sfx = {};
  for (const [key, url] of Object.entries(WEAPON_SFX_URLS)) {
    sfx[key] = new Audio(url);
    sfx[key].volume = 0.32;
  }
  return sfx;
}

/** Clone an audio node for overlapping playback */
export function cloneAudio(src, vol = 0.4) {
  const a = src.cloneNode();
  a.volume = vol;
  return a;
}

/**
 * precacheTextures — waits for every image to fully decode, then builds the
 * sprite atlas and hot-swaps non-wall entries in spriteAssets with their
 * 128×128 atlas proxy canvases.
 *
 * @param {Object} spriteAssets    — from loadAllSprites()
 * @param {Object} _unused         — formerly weaponSpriteAssets; ignored (pass null)
 * @param {Object} enemyAnimAssets — from loadEnemyAnims()
 * @param {function(loaded:number, total:number):void} [onProgress]
 * @returns {Promise<void>}
 */
export function precacheTextures(spriteAssets, _unused, enemyAnimAssets, onProgress) {
  const imgs = [];

  if (spriteAssets) {
    for (const img of Object.values(spriteAssets)) {
      if (img instanceof HTMLImageElement) imgs.push(img);
    }
  }
  if (enemyAnimAssets) {
    for (const animSet of Object.values(enemyAnimAssets)) {
      for (const sheet of Object.values(animSet)) {
        if (sheet && sheet.img instanceof HTMLImageElement) imgs.push(sheet.img);
      }
    }
  }

  const total = imgs.length;
  if (total === 0) { if (onProgress) onProgress(0, 0); return Promise.resolve(); }

  let loaded = 0;
  const tick = () => { loaded++; if (onProgress) onProgress(loaded, total); };

  const promises = imgs.map(img => new Promise(resolve => {
    if (img.complete && img.naturalWidth > 0) { tick(); resolve(); return; }
    if (img.complete && img.naturalWidth === 0) { tick(); resolve(); return; }
    img.addEventListener('load',  () => { tick(); resolve(); }, { once: true });
    img.addEventListener('error', () => { tick(); resolve(); }, { once: true });
  }));

  return Promise.all(promises).then(() => {
    // ── Build sprite atlas (world sprites only, no weapons) ─────────────────
    const atlas = new SpriteAtlas();
    atlas.build(spriteAssets || {}, FULL_RES_KEYS);

    spriteAtlas = atlas;

    if (spriteAssets) {
      for (const key of Object.keys(spriteAssets)) {
        if (FULL_RES_KEYS.has(key)) continue;
        const proxy = atlas.get(key);
        if (proxy) spriteAssets[key] = proxy;
      }
    }
  });
}
