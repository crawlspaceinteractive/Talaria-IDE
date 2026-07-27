export const profiler = {

    enabled: true,

    frame: 0,

    trisIn: 0,
    trisCulled: 0,
    trisClipped: 0,
    trisSubdivided: 0,
    trisDrawn: 0,

    frameStart: 0,
    frameMS: 0,

    resetFrame() {

        this.trisIn = 0;
        this.trisCulled = 0;
        this.trisClipped = 0;
        this.trisSubdivided = 0;
        this.trisDrawn = 0;

        this.frame++;

        this.frameStart =
            performance.now();

    },

    endFrame() {

        this.frameMS =
            performance.now() -
            this.frameStart;

    }

};
