// Per-weapon ammo pools (slot index → max ammo grant from crate)
// Slot 1=pistol, 2=shotgun, 3=crossbow, 4=cannon, 5=sword(no ammo), 6=plasma2
export const WEAPON_AMMO_MAX = {
  pistol:  999,
  shotgun: 999,
  crossbow: 999,
  cannon:  999,
  plasma2: 999,
};

// Ammo crate gives this much ammo per weapon when picked up
export const AMMO_CRATE_GRANT = {
  pistol:  50,  // slot 1
  shotgun: 25,  // slot 2
  crossbow: 100, // slot 3
  cannon:  10,  // slot 4
  // sword: no ammo
  plasma2: 50,  // slot 6
};

export class Player {
  constructor(x, y, angle) {
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.health = 100;
    this.maxHealth = 100;
    // Legacy single ammo pool kept for backward compat (sword melee check uses it)
    this.ammo = 50;
    this.maxAmmo = 999;
    // Per-weapon ammo pools
    this.weaponAmmo = {
      pistol:  50,
      shotgun: 25,
      crossbow: 100,
      cannon:  10,
      plasma2: 50,
    };
    this.shootCooldown = 0;

    // Viewbob + sway
    this.bobPhase = 0;
    this.bobAmp = 0;        // current bob amplitude (fades in/out)
    this.strafeDir = 0;     // -1 left, 0 none, 1 right — for tilt
    this.strafeTilt = 0;    // smooth tilt angle (radians)

    // Weapon animation state
    this.weaponAnim = 'idle'; // 'idle' | 'shoot' | 'reload'
    this.weaponFrame = 0;     // 0.0 .. 1.0 normalized animation progress
    this.weaponKick = 0;      // recoil kick value (0..1) fades down

    // Damage flash
    this.damageFlash = 0;

    // Weapon & upgrades
    this.equippedWeapon = 'pistol';  // weapon id string
    this.speedMult   = 1.0;
    this.stealthMult = 1.0;
    this.damageMult  = 1.0;
  }
}
