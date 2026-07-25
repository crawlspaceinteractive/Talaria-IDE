// game/skypalette.js
// Sky color registry independent from terrain textures

export const DEFAULT_SKY_BIOME = "ice";

export const SKY_PALETTES = {

    ice: {
        top: [40,32,90],
        mid: [120,100,180],
        bottom: [240,180,200],

        ringTop: [255,255,255],
        ringSide: [110,110,140],

        fog: [200,160,200]
    },

    grass: {
        top: [70,120,255],
        mid: [130,180,255],
        bottom: [255,220,200],

        ringTop: [80,200,80],
        ringSide: [100,80,50],

        fog: [180,190,220]
    },

    sand: {
        top: [255,150,90],
        mid: [255,190,120],
        bottom: [255,220,180],

        ringTop: [240,220,140],
        ringSide: [150,110,70],

        fog: [220,180,140]
    },

    bubblegum: {
        top: [170,70,160],
        mid: [220,100,220],
        bottom: [255,180,255],

        ringTop: [255,120,255],
        ringSide: [130,70,130],

        fog: [210,160,220]
    },

    volcanic: {
        top: [30,10,10],
        mid: [80,40,40],
        bottom: [220,80,60],

        ringTop: [120,60,60],
        ringSide: [50,30,30],

        fog: [100,60,60]
    },

    default: {
        top: [40,32,90],
        mid: [120,100,180],
        bottom: [240,180,200],

        ringTop: [255,255,255],
        ringSide: [110,110,140],

        fog: [200,160,200]
    }
};

export function getSkyPalette(biome){

    return (
        SKY_PALETTES[
            biome || DEFAULT_SKY_BIOME
        ] ||
        SKY_PALETTES.default
    );

}
