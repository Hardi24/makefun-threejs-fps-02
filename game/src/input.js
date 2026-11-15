// Keyboard and mouse, and the pointer lock that turns the mouse into look. Plain browser
// APIs only: the game asks the canvas for pointer lock and reads movementX/Y while it
// holds it. Left button fires; right button aims down the sights; the scoreboard key is
// read like any other through takePressed, so no input path is special-cased in main.js.
export function createInput(canvas, onLockChange) {
  const keys = new Set();
  const recent = new Set();
  const state = { keys, locked: false, firing: false, aiming: false, lookX: 0, lookY: 0 };

  function noteKey(event, down) {
    if (down) {
      keys.add(event.code);
      if (!event.repeat) recent.add(event.code);
    } else keys.delete(event.code);
    if (event.code === 'Space' || event.code === 'Tab') event.preventDefault();
  }

  window.addEventListener('keydown', (event) => noteKey(event, true));
  window.addEventListener('keyup', (event) => noteKey(event, false));
  window.addEventListener('blur', () => keys.clear());
  window.addEventListener('mousemove', (event) => {
    if (!state.locked) return;
    state.lookX += event.movementX;
    state.lookY += event.movementY;
  });
  window.addEventListener('mousedown', (event) => {
    if (!state.locked) return;
    if (event.button === 0) state.firing = true;
    if (event.button === 2) state.aiming = true;
  });
  window.addEventListener('mouseup', (event) => {
    if (event.button === 0) state.firing = false;
    if (event.button === 2) state.aiming = false;
  });
  window.addEventListener('contextmenu', (event) => {
    if (state.locked) event.preventDefault();
  });
  document.addEventListener('pointerlockchange', () => {
    state.locked = document.pointerLockElement === canvas;
    if (!state.locked) {
      keys.clear();
      state.firing = false;
      state.aiming = false;
    }
    onLockChange(state.locked);
  });

  return {
    state,
    requestLock() {
      canvas.requestPointerLock();
    },
    takeLook() {
      const x = state.lookX;
      const y = state.lookY;
      state.lookX = 0;
      state.lookY = 0;
      return { x, y };
    },
    // Fresh key presses since the last call (no repeats, no held keys).
    takePressed() {
      const out = [...recent];
      recent.clear();
      return out;
    },
  };
}
