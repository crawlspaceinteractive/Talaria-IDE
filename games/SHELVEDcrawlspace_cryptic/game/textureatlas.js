// game/textureatlas.js
// Central texture path + biome zone registry.
// Runtime path base is relative to files inside /game.

export const TEXTURE_BASE = "./textures/";

export const TEX = {
  terrain: {
    grass: `${TEXTURE_BASE}terrain/grass.png`,
    dirt: `${TEXTURE_BASE}terrain/dirt.png`,
    rock: `${TEXTURE_BASE}terrain/rock.png`,
    sand: `${TEXTURE_BASE}terrain/sand.png`,
    snow: `${TEXTURE_BASE}terrain/snow.png`,
    ice: `${TEXTURE_BASE}terrain/ice.png`,
    candy: `${TEXTURE_BASE}terrain/candy.png`,
    volcanic: `${TEXTURE_BASE}terrain/volcanic.png`,
  },

  effects: {
    portal: `${TEXTURE_BASE}effects/portal.png`,
    sparkle: `${TEXTURE_BASE}effects/sparkle.png`,
  },

  ui: {
    icons: `${TEXTURE_BASE}ui/icons.png`,
  },
};

export const ZONE = {
  TOP: "top",
  SIDE: "side",
  UNDER: "under",
  ACCENT: "accent",
};

export const BIOME_TEXTURES = {
  grass: {
    top: TEX.terrain.grass,
    side: TEX.terrain.dirt,
    under: TEX.terrain.rock,
    accent: TEX.terrain.grass,
  },

  ice: {
    top: TEX.terrain.snow,
    side: TEX.terrain.ice,
    under: TEX.terrain.dirt,
    accent: TEX.terrain.ice,
  },

  sand: {
    top: TEX.terrain.sand,
    side: TEX.terrain.sand,
    under: TEX.terrain.rock,
    accent: TEX.terrain.sand,
  },

  bubblegum: {
    top: TEX.terrain.candy,
    side: TEX.terrain.dirt,
    under: TEX.terrain.rock,
    accent: TEX.terrain.candy,
  },

  default: {
    top: TEX.terrain.grass,
    side: TEX.terrain.dirt,
    under: TEX.terrain.rock,
    accent: TEX.terrain.grass,
  },
};

export const DEFAULT_BIOME = "grass";
export const DEFAULT_SKY_BIOME = "ice";

export const SKY_BIOME_TEXTURES = {

    ice: {
        top: TEX.terrain.snow,
        side: TEX.terrain.rock,
        under: TEX.terrain.rock,
        accent: TEX.terrain.ice
    },

    volcanic: {
        top: TEX.terrain.volcanic,
        side: TEX.terrain.rock,
        under: TEX.terrain.rock,
        accent: TEX.terrain.volcanic
    },

    grass: {
        top: TEX.terrain.grass,
        side: TEX.terrain.rock,
        under: TEX.terrain.rock,
        accent: TEX.terrain.grass
    },

    sand: {
        top: TEX.terrain.sand,
        side: TEX.terrain.rock,
        under: TEX.terrain.rock,
        accent: TEX.terrain.sand
    },

    default: {
        top: TEX.terrain.snow,
        side: TEX.terrain.rock,
        under: TEX.terrain.rock,
        accent: TEX.terrain.ice
    }
};

export function getBiomeTextures(biome) {

    return (
        BIOME_TEXTURES[
            biome || DEFAULT_BIOME
        ] ||
        BIOME_TEXTURES.default
    );

}

export function getZoneTexture(
    biome,
    zone
) {

    const table =
        getBiomeTextures(biome);

    return (
        table[zone] ||
        table.side ||
        null
    );

}

export function getSkyBiomeTextures(
    biome
) {

    return (
        SKY_BIOME_TEXTURES[
            biome || DEFAULT_SKY_BIOME
        ] ||
        SKY_BIOME_TEXTURES.default
    );

}

export function getSkyZoneTexture(
    biome,
    zone
) {

    const table =
        getSkyBiomeTextures(
            biome
        );

    return (
        table[zone] ||
        table.side ||
        null
    );

}
