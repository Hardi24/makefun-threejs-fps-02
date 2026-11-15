// Sound, synthesized live with WebAudio: no audio files, no network, nothing to load.
// Every effect is a short burst of filtered noise or an oscillator, mixed through one
// master gain. A muted context (headless capture) simply does nothing.
export function createSounds() {
  let ctx = null;
  let master = null;
  let enabled = true;

  function ensure() {
    if (ctx) return ctx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    } catch {
      ctx = null;
    }
    return ctx;
  }

  function noiseBuffer(seconds) {
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  function burst({ duration = 0.12, frequency = 1800, type = 'lowpass', gain = 0.5, sweepTo = null, delay = 0 }) {
    if (!enabled) return;
    const ac = ensure();
    if (!ac) return;
    try {
      const t = ac.currentTime + delay;
      const source = ac.createBufferSource();
      source.buffer = noiseBuffer(duration + 0.05);
      const filter = ac.createBiquadFilter();
      filter.type = type;
      filter.frequency.setValueAtTime(frequency, t);
      if (sweepTo !== null) filter.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), t + duration);
      const amp = ac.createGain();
      amp.gain.setValueAtTime(gain, t);
      amp.gain.exponentialRampToValueAtTime(0.001, t + duration);
      source.connect(filter).connect(amp).connect(master);
      source.start(t);
      source.stop(t + duration + 0.05);
    } catch {
      // Audio is decoration; never let it break the game.
    }
  }

  function tone({ frequency = 440, duration = 0.12, type = 'sine', gain = 0.25, slideTo = null, delay = 0 }) {
    if (!enabled) return;
    const ac = ensure();
    if (!ac) return;
    try {
      const t = ac.currentTime + delay;
      const osc = ac.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(frequency, t);
      if (slideTo !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + duration);
      const amp = ac.createGain();
      amp.gain.setValueAtTime(gain, t);
      amp.gain.exponentialRampToValueAtTime(0.001, t + duration);
      osc.connect(amp).connect(master);
      osc.start(t);
      osc.stop(t + duration + 0.05);
    } catch {
      // Audio is decoration; never let it break the game.
    }
  }

  return {
    unlock() {
      const ac = ensure();
      if (ac && ac.state === 'suspended') ac.resume().catch(() => {});
    },
    setEnabled(value) {
      enabled = value;
    },
    shot(weapon) {
      if (weapon === 'marksman') burst({ duration: 0.28, frequency: 900, sweepTo: 120, gain: 0.7 });
      else if (weapon === 'smg') burst({ duration: 0.07, frequency: 2600, sweepTo: 500, gain: 0.32 });
      else burst({ duration: 0.11, frequency: 1900, sweepTo: 300, gain: 0.5 });
      tone({ frequency: 150, duration: 0.08, type: 'square', gain: 0.12, slideTo: 60 });
    },
    distantShot() {
      burst({ duration: 0.1, frequency: 900, sweepTo: 200, gain: 0.14 });
    },
    dryFire() {
      tone({ frequency: 1200, duration: 0.03, type: 'square', gain: 0.08 });
    },
    reload() {
      tone({ frequency: 500, duration: 0.05, type: 'square', gain: 0.1 });
      tone({ frequency: 700, duration: 0.05, type: 'square', gain: 0.1, delay: 0.22 });
      tone({ frequency: 420, duration: 0.06, type: 'square', gain: 0.12, delay: 0.5 });
    },
    hit() {
      tone({ frequency: 1400, duration: 0.05, type: 'sine', gain: 0.22 });
    },
    // A headshot lands its own bright ping on top of the hit tick, so the player
    // knows the 3x multiplier connected without looking at the feed.
    headshot() {
      tone({ frequency: 2093, duration: 0.07, type: 'sine', gain: 0.25 });
      tone({ frequency: 2637, duration: 0.1, type: 'sine', gain: 0.2, delay: 0.05 });
    },
    kill() {
      tone({ frequency: 880, duration: 0.09, type: 'sine', gain: 0.22 });
      tone({ frequency: 1320, duration: 0.12, type: 'sine', gain: 0.2, delay: 0.07 });
    },
    hurt() {
      burst({ duration: 0.14, frequency: 500, sweepTo: 140, gain: 0.4 });
    },
    beep(final = false) {
      tone({ frequency: final ? 1500 : 1050, duration: final ? 0.16 : 0.08, type: 'sine', gain: 0.2 });
    },
    plant() {
      tone({ frequency: 620, duration: 0.1, type: 'square', gain: 0.15 });
      tone({ frequency: 620, duration: 0.1, type: 'square', gain: 0.15, delay: 0.18 });
      tone({ frequency: 930, duration: 0.2, type: 'square', gain: 0.15, delay: 0.36 });
    },
    defuse() {
      tone({ frequency: 930, duration: 0.1, type: 'square', gain: 0.15 });
      tone({ frequency: 930, duration: 0.1, type: 'square', gain: 0.15, delay: 0.18 });
      tone({ frequency: 1240, duration: 0.22, type: 'square', gain: 0.15, delay: 0.36 });
    },
    explosion() {
      burst({ duration: 1.1, frequency: 700, sweepTo: 60, gain: 0.9 });
      tone({ frequency: 90, duration: 0.9, type: 'sine', gain: 0.5, slideTo: 30 });
    },
    roundWin() {
      [523, 659, 784].forEach((f, i) => tone({ frequency: f, duration: 0.16, type: 'triangle', gain: 0.2, delay: i * 0.11 }));
    },
    roundLose() {
      [392, 330, 262].forEach((f, i) => tone({ frequency: f, duration: 0.18, type: 'triangle', gain: 0.18, delay: i * 0.12 }));
    },
    buy() {
      tone({ frequency: 980, duration: 0.06, type: 'sine', gain: 0.18 });
      tone({ frequency: 1470, duration: 0.08, type: 'sine', gain: 0.16, delay: 0.06 });
    },
    deny() {
      tone({ frequency: 220, duration: 0.12, type: 'square', gain: 0.14 });
    },
  };
}
