// runtime-test.js — Basic runtime test for GamepadManager
import { GamepadManager, BTN, AXIS } from '../engine/gamepad.js';

console.log('Testing GamepadManager runtime...');

// Create instance
const gp = new GamepadManager({ deadzone: 0.15 });
console.log('Instance created:', typeof gp);

// Check initial state
console.log('Initial count:', gp.count);
console.log('Chord names:', gp.chordNames);

// Test button map
gp.setButtonMap(0, { [BTN.A]: 1 });
console.log('Button map for pad 0:', gp.getButtonMap(0));
gp.clearButtonMap(0);
console.log('After clear:', gp.getButtonMap(0));

// Test chord definition
gp.defineChord('TEST', [BTN.A, BTN.B]);
console.log('Chord names after define:', gp.chordNames);

// Test helpers (no pads connected, so should return defaults)
console.log('isPressed(0, BTN.A):', gp.isPressed(0, BTN.A));
console.log('axisValue(0, AXIS.LEFT_X):', gp.axisValue(0, AXIS.LEFT_X));
console.log('getStick(0):', gp.getStick(0));

// Test vibrate (should return null since no pad)
const vibrateResult = gp.vibrate(0, { duration: 100 });
console.log('Vibrate result:', vibrateResult);

// Test start/stop (should not crash)
gp.start();
console.log('Started polling');
setTimeout(() => {
  gp.stop();
  console.log('Stopped polling');
  gp.destroy();
  console.log('Destroyed');
  console.log('Runtime test completed successfully!');
}, 100);

