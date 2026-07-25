## Beat Em Up Engine — Prototype

**Concept:** Side-scrolling beat 'em up with Genesis-inspired pseudo-3D ground rendering and parallax sky.

**Core Mechanic:** 8-direction movement on a deep perspective ground plane; punch/kick/jump combo combat against waves of AI enemies. Camera follows player with smooth lead.

**Renderer:** Per-scanline perspective ground (worldZ computed per row), pixel-buffer sky with per-scanline X-skew parallax, entity depth-sort + Z-scale projection, shadow ellipses.
