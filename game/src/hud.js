// The DOM HUD: crosshair, hit marker, health, ammo, money, round timer, team scores,
// kill feed, event feed, buy menu, round banners, a damage-direction indicator, a
// scoreboard and a top-down minimap. It never touches the simulation; main.js pushes
// numbers in and reads the play and buy callbacks out. Every setter caches its last
// value, so a steady frame costs no DOM writes at all. The scoreboard carries the
// round history on top, so a held Tab shows the match's story, not just its frags.
import { WEAPONS, WEAPON_ORDER } from './weapon.js';

const COPY = {
  start: {
    title: 'Dustline Yard',
    copy: 'Vanguard defends two sites — Foundry and Depot — against five Raiders. Win the round by stopping the plant, defusing the charge, or dropping every Raider. Buy a Spark-9 frag grenade (G) to clear a corner no rifle can reach, or a smoke grenade (H) to cross Mid unseen.',
    action: 'Click to play',
  },
  paused: {
    title: 'Dustline Yard',
    copy: 'Paused. Click to resume.',
    action: 'Click to resume',
  },
  end: {
    title: 'Match over',
    copy: '',
    action: 'Play again',
  },
};

// Buy-card stat bars are scaled against the best in the shop, so the bars compare
// weapons at a glance instead of asking the player to compare numbers mid-round.
// The ceilings are the shop's own maxima: the marksman's damage, the SMG's rate,
// the marksman's range.
const STAT_TOP = { damage: 80, rate: 13, range: 100 };
function meter(label, value, max) {
  const pct = Math.max(6, Math.min(100, Math.round((value / max) * 100)));
  return `<span class="stat"><i>${label}</i><b><em style="width:${pct}%"></em></b></span>`;
}

export function createHud(minimapWalls) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('overlay');
  const title = $('overlay-title');
  const copy = $('overlay-copy');
  const play = $('play');
  const ammo = $('ammo');
  const ammoMag = $('ammo-mag');
  const ammoReserve = $('ammo-reserve');
  const weaponName = $('weapon-name');
  const grenadeChip = $('grenade-chip');
  const grenadeCount = $('grenade-count');
  const healthFill = $('health-fill');
  const healthValue = $('health-value');
  const armorValue = $('armor-value');
  const moneyValue = $('money-value');
  const timerValue = $('timer-value');
  const scoreV = $('score-v');
  const scoreR = $('score-r');
  const roundValue = $('round-value');
  const pipsV = $('pips-v');
  const pipsR = $('pips-r');
  const killfeed = $('killfeed');
  const eventfeed = $('eventfeed');
  const banner = $('banner');
  const bannerTitle = $('banner-title');
  const bannerSub = $('banner-sub');
  const toast = $('toast');
  const crosshair = $('crosshair');
  const hitmarker = $('hitmarker');
  const damageFlash = $('damage-flash');
  const damageDir = $('dmg-dir');
  const bombChip = $('bomb-chip');
  const bombText = $('bomb-text');
  const buyMenu = $('buy-menu');
  const buyMoney = $('buy-money');
  const buyGrid = $('buy-grid');
  const buyTimer = $('buy-timer');
  const hint = $('hint');
  const minimap = $('minimap');
  const scoreboard = $('scoreboard');
  const scoreRows = $('score-rows');

  let hitClock = 0;
  let bannerClock = 0;
  let toastClock = 0;
  let magCache = -1;
  let reserveCache = -1;
  let weaponCache = '';
  let grenadeCache = -1;
  let smokeCache = -1;
  let healthCache = -1;
  let armorCache = -1;
  let moneyCache = -1;
  let timerCache = '';
  let scoreCache = '';
  let pipsCache = '';

  // Minimap: static walls, dots for every living actor, ghost dots where a
  // Vanguard bot last saw an enemy, and a tick for the player's facing.
  const mapCtx = minimap.getContext('2d');
  const MAP_W = 48;
  const MAP_H = 40;
  function toMap(x, z) {
    return [((x + MAP_W / 2) / MAP_W) * minimap.width, ((z + MAP_H / 2) / MAP_H) * minimap.height];
  }
  function drawMapBase() {
    mapCtx.fillStyle = 'rgba(20,22,26,0.82)';
    mapCtx.fillRect(0, 0, minimap.width, minimap.height);
    mapCtx.strokeStyle = '#98a0a8';
    mapCtx.lineWidth = 1.5;
    for (const [x1, z1, x2, z2] of minimapWalls) {
      const [a, b] = toMap(x1, z1);
      const [c, d] = toMap(x2, z2);
      mapCtx.beginPath();
      mapCtx.moveTo(a, b);
      mapCtx.lineTo(c, d);
      mapCtx.stroke();
    }
    for (const [letter, x, z, color] of [['A', -17, -13, '#3fc1a8'], ['B', 17, -13, '#f0a830']]) {
      const [mx, my] = toMap(x, z);
      mapCtx.fillStyle = color;
      mapCtx.font = 'bold 11px system-ui, sans-serif';
      mapCtx.textAlign = 'center';
      mapCtx.textBaseline = 'middle';
      mapCtx.fillText(letter, mx, my);
    }
  }

  // Buy menu cards, grouped into sections like a real tactical shop: Sidearms,
  // Rifles, Close Range, Gear, Grenades. Weapon cards carry three stat bars plus
  // the headshot multiplier, so the shop teaches the weapons.
  const BUY_KEY = { pistol: '1', smg: '2', rifle: '3', shotgun: '4', marksman: '5' };
  const BUY_ROW = { pistol: 'sidearm', smg: 'close', rifle: 'rifle', shotgun: 'close', marksman: 'rifle' };
  function section(title) {
    const wrap = document.createElement('div');
    wrap.className = 'buy-section';
    wrap.innerHTML = `<h3>${title}</h3><div class="buy-row"></div>`;
    buyGrid.appendChild(wrap);
    return wrap.querySelector('.buy-row');
  }
  const rows = {
    sidearm: section('Sidearms'),
    rifle: section('Rifles'),
    close: section('Close Range'),
    gear: section('Gear'),
    grenade: section('Grenades'),
  };
  const buyButtons = {};
  for (const id of WEAPON_ORDER) {
    const def = WEAPONS[id];
    const rate = Math.round((1 / def.fireGap) * (def.pellets || 1) * 10) / 10;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'buy-card';
    button.dataset.weapon = id;
    button.innerHTML = `<b>${def.name}</b><span>$${def.price} · ${def.magSize} rounds · headshot ${def.headMult}x</span>`
      + meter('DMG', def.damage * (def.pellets || 1), STAT_TOP.damage)
      + meter('RPM', rate, STAT_TOP.rate)
      + meter('RNG', def.range, STAT_TOP.range)
      + `<i>${BUY_KEY[id]}</i>`;
    rows[BUY_ROW[id]].appendChild(button);
    buyButtons[id] = button;
  }
  const armorButton = document.createElement('button');
  armorButton.type = 'button';
  armorButton.className = 'buy-card';
  armorButton.dataset.armor = '1';
  armorButton.innerHTML = '<b>Plated Vest</b><span>$400 · +50 armour</span>'
    + meter('ARM', 50, 50)
    + '<i>6</i>';
  rows.gear.appendChild(armorButton);
  // The defuse kit's card: half the defuse channel, bought once per match.
  const kitButton = document.createElement('button');
  kitButton.type = 'button';
  kitButton.className = 'buy-card';
  kitButton.dataset.kit = '1';
  kitButton.innerHTML = '<b>Defuse Kit</b><span>$400 · defuse 5s → 2.5s</span>'
    + meter('KIT', 1, 1)
    + '<i>9</i>';
  rows.gear.appendChild(kitButton);
  // The frag grenade's card: blast damage on the bar, radius and the two-carry
  // limit in the line, so the shop teaches the grenade like any weapon.
  const grenadeButton = document.createElement('button');
  grenadeButton.type = 'button';
  grenadeButton.className = 'buy-card';
  grenadeButton.dataset.grenade = '1';
  grenadeButton.innerHTML = '<b>Spark-9 Frag</b><span class="grenade-line">$300 · blast 130 · radius 7 m · max 2</span>'
    + meter('BLST', 130, 130)
    + '<i>7</i>';
  rows.grenade.appendChild(grenadeButton);
  const grenadeLine = grenadeButton.querySelector('.grenade-line');
  // The smoke grenade's card: cloud duration on the bar, radius and the carry
  // limit in the line — the tool for crossing Mid unseen.
  const smokeButton = document.createElement('button');
  smokeButton.type = 'button';
  smokeButton.className = 'buy-card';
  smokeButton.dataset.smoke = '1';
  smokeButton.innerHTML = '<b>Veil Smoke</b><span class="smoke-line">$250 · blocks sight 15 s · radius 4 m · max 2</span>'
    + meter('COVR', 15, 15)
    + '<i>8</i>';
  rows.grenade.appendChild(smokeButton);
  const smokeLine = smokeButton.querySelector('.smoke-line');

  let buyHandler = null;
  let armorHandler = null;
  let grenadeHandler = null;
  let smokeHandler = null;
  let kitHandler = null;
  buyGrid.addEventListener('click', (event) => {
    const card = event.target.closest('.buy-card');
    if (!card) return;
    if (card.dataset.weapon) buyHandler?.(card.dataset.weapon);
    else if (card.dataset.armor) armorHandler?.();
    else if (card.dataset.grenade) grenadeHandler?.('frag');
    else if (card.dataset.smoke) smokeHandler?.('smoke');
    else if (card.dataset.kit) kitHandler?.();
  });

  function feed(container, html, holdMs) {
    const line = document.createElement('div');
    line.className = container === killfeed ? 'kill-line' : 'event-line';
    line.innerHTML = html;
    container.prepend(line);
    while (container.children.length > 5) container.lastChild.remove();
    setTimeout(() => line.remove(), holdMs);
  }

  return {
    setAmmo(mag, reserve, weaponId) {
      if (mag === magCache && reserve === reserveCache && weaponId === weaponCache) return;
      magCache = mag;
      reserveCache = reserve;
      weaponCache = weaponId;
      ammoMag.textContent = String(mag);
      ammoReserve.textContent = `/ ${reserve}`;
      weaponName.textContent = WEAPONS[weaponId].name;
      ammo.classList.toggle('empty', mag === 0);
    },
    setHealth(health, armor) {
      if (health === healthCache && armor === armorCache) return;
      healthCache = health;
      armorCache = armor;
      healthFill.style.width = `${Math.max(0, health)}%`;
      healthFill.classList.toggle('low', health <= 30);
      healthValue.textContent = String(Math.max(0, Math.ceil(health)));
      armorValue.textContent = armor > 0 ? `+${Math.ceil(armor)}` : '';
    },
    setMoney(money) {
      if (money === moneyCache) return;
      moneyCache = money;
      moneyValue.textContent = `$${money}`;
    },
    setTimer(seconds) {
      const text = `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
      if (text === timerCache) return;
      timerCache = text;
      timerValue.textContent = text;
      timerValue.classList.toggle('urgent', seconds <= 10);
    },
    setScore(vanguard, raider, round) {
      const text = `${vanguard}-${raider}-${round}`;
      if (text === scoreCache) return;
      scoreCache = text;
      scoreV.textContent = String(vanguard);
      scoreR.textContent = String(raider);
      roundValue.textContent = `ROUND ${round}`;
    },
    setPips(vanguardAlive, raiderAlive) {
      const text = `${vanguardAlive}/${raiderAlive}`;
      if (text === pipsCache) return;
      pipsCache = text;
      pipsV.textContent = '●'.repeat(vanguardAlive) + '○'.repeat(Math.max(0, 5 - vanguardAlive));
      pipsR.textContent = '●'.repeat(raiderAlive) + '○'.repeat(Math.max(0, 5 - raiderAlive));
    },
    // The bomb chip: hidden until a charge is being planted or is armed, red
    // while the timer runs, and counting down in whole seconds.
    setBomb(state, seconds) {
      if (state === 'none') {
        bombChip.hidden = true;
        return;
      }
      bombChip.hidden = false;
      bombChip.classList.toggle('planted', state === 'planted');
      bombText.textContent = state === 'planting' ? 'CHARGE BEING PLANTED…' : `CHARGE ARMED ${Math.ceil(seconds)}s`;
    },
    setHint(text) {
      hint.textContent = text;
      hint.hidden = !text;
    },
    setCrosshairSpread(spread) {
      const gap = 4 + Math.min(26, spread * 600);
      crosshair.style.setProperty('--gap', `${gap.toFixed(1)}px`);
    },
    setAiming(aiming) {
      crosshair.style.opacity = aiming ? '0.45' : '1';
    },
    hitMarker(killed, holdMs = 90, headshot = false) {
      hitmarker.classList.add('on');
      hitmarker.classList.toggle('kill', killed);
      hitmarker.classList.toggle('headshot', headshot && !killed);
      clearTimeout(hitClock);
      hitClock = setTimeout(() => hitmarker.classList.remove('on', 'kill', 'headshot'), holdMs);
    },
    damageFlash() {
      damageFlash.classList.add('on');
      setTimeout(() => damageFlash.classList.remove('on'), 120);
    },
    // A red arc at the screen edge, rotated to the bearing the shot came from:
    // the player learns where to look without a minimap glance.
    damageDirection(angleDeg) {
      damageDir.style.transform = `translate(-50%, -50%) rotate(${angleDeg}deg)`;
      damageDir.classList.add('on');
      setTimeout(() => damageDir.classList.remove('on'), 450);
    },
    addKill(killer, victim, killerTeam, headshot, holdMs = 6000, cause = 'gun') {
      feed(killfeed, `<span class="${killerTeam}">${killer}</span> ${headshot ? '⌖' : '✕'} <span>${victim}</span>${headshot ? ' <span class="hs">HEADSHOT</span>' : ''}${cause === 'grenade' ? ' <span class="hs">FRAG</span>' : ''}`, holdMs);
    },
    // Captures re-show the feed with long holds: under a slow software renderer
    // the 6 s lines can lapse between the shot and the screenshot.
    clearFeeds() {
      killfeed.innerHTML = '';
      eventfeed.innerHTML = '';
    },
    addEvent(text, holdMs = 5000) {
      feed(eventfeed, text, holdMs);
    },
    showToast(text, ms = 1400) {
      toast.textContent = text;
      toast.hidden = false;
      clearTimeout(toastClock);
      toastClock = setTimeout(() => {
        toast.hidden = true;
      }, ms);
    },
    showBanner(titleText, subText, ms = 2600) {
      bannerTitle.textContent = titleText;
      bannerSub.textContent = subText;
      banner.hidden = false;
      clearTimeout(bannerClock);
      bannerClock = setTimeout(() => {
        banner.hidden = true;
      }, ms);
    },
    hideBanner() {
      clearTimeout(bannerClock);
      banner.hidden = true;
    },
    showOverlay(mode, detail = '') {
      const text = COPY[mode];
      title.textContent = text.title;
      copy.textContent = mode === 'end' ? detail : text.copy;
      play.textContent = text.action;
      overlay.hidden = false;
      play.focus();
    },
    hideOverlay() {
      overlay.hidden = true;
    },
    onPlay(handler) {
      play.addEventListener('click', handler);
    },
    setGrenades(frag, smoke = 0) {
      if (frag === grenadeCache && smoke === smokeCache) return;
      grenadeCache = frag;
      smokeCache = smoke;
      grenadeCount.textContent = `FRAG ×${frag} · SMOKE ×${smoke}`;
      grenadeChip.hidden = frag + smoke <= 0;
    },
    showBuy(money, secondsLeft, ownedWeapon, hasArmor, frag = 0, smoke = 0, hasKit = false) {
      buyMenu.hidden = false;
      buyMoney.textContent = `$${money}`;
      buyTimer.textContent = `Buy phase — ${Math.ceil(secondsLeft)}s`;
      for (const id of WEAPON_ORDER) {
        const button = buyButtons[id];
        button.classList.toggle('owned', id === ownedWeapon);
        button.classList.toggle('cant', WEAPONS[id].price > money && id !== ownedWeapon);
      }
      armorButton.classList.toggle('owned', hasArmor);
      armorButton.classList.toggle('cant', hasArmor || money < 400);
      kitButton.classList.toggle('owned', hasKit);
      kitButton.classList.toggle('cant', hasKit || money < 400);
      grenadeButton.classList.toggle('owned', frag >= 2);
      grenadeButton.classList.toggle('cant', frag >= 2 || money < 300);
      grenadeLine.textContent = frag > 0
        ? `Owned ×${frag} — $300 each · blast 130 · radius 7 m`
        : '$300 · blast 130 · radius 7 m · max 2';
      smokeButton.classList.toggle('owned', smoke >= 2);
      smokeButton.classList.toggle('cant', smoke >= 2 || money < 250);
      smokeLine.textContent = smoke > 0
        ? `Owned ×${smoke} — $250 each · blocks sight 15 s · radius 4 m`
        : '$250 · blocks sight 15 s · radius 4 m · max 2';
    },
    hideBuy() {
      buyMenu.hidden = true;
    },
    onBuy(handler) {
      buyHandler = handler;
    },
    onBuyArmor(handler) {
      armorHandler = handler;
    },
    onBuyGrenade(handler) {
      grenadeHandler = handler;
    },
    onBuySmoke(handler) {
      smokeHandler = handler;
    },
    onBuyKit(handler) {
      kitHandler = handler;
    },
    showScoreboard(rows, history = []) {
      scoreboard.hidden = false;
      const historyLine = history.length
        ? `<div class="score-history">Rounds: ${history.map((r) => `<span class="${r === 'W' ? 'win' : 'loss'}">${r}</span>`).join(' ')}</div>`
        : '';
      scoreRows.innerHTML = historyLine + rows.map((r) => `<div class="score-row ${r.team}"><span>${r.name}</span><span>${r.kills} K</span><span>${r.deaths} D</span><span>${r.alive ? '●' : '○'}</span></div>`).join('');
    },
    hideScoreboard() {
      scoreboard.hidden = true;
    },
    drawMinimap(actors, bomb, ghosts = []) {
      drawMapBase();
      for (const ghost of ghosts) {
        const [mx, my] = toMap(ghost.x, ghost.z);
        mapCtx.fillStyle = '#7d8590';
        mapCtx.beginPath();
        mapCtx.arc(mx, my, 2.5, 0, Math.PI * 2);
        mapCtx.fill();
      }
      for (const actor of actors) {
        if (!actor.alive) continue;
        const [mx, my] = toMap(actor.position.x, actor.position.z);
        mapCtx.fillStyle = actor.team === 'vanguard' ? '#3fc1a8' : '#e4572e';
        mapCtx.beginPath();
        mapCtx.arc(mx, my, actor.isPlayer ? 4 : 3, 0, Math.PI * 2);
        mapCtx.fill();
        if (actor.isPlayer) {
          const fx = mx - Math.sin(actor.yaw) * 8;
          const fz = my - Math.cos(actor.yaw) * 8;
          mapCtx.strokeStyle = '#e9e6df';
          mapCtx.lineWidth = 1.5;
          mapCtx.beginPath();
          mapCtx.moveTo(mx, my);
          mapCtx.lineTo(fx, fz);
          mapCtx.stroke();
        }
      }
      if (bomb) {
        const [mx, my] = toMap(bomb.x, bomb.z);
        mapCtx.fillStyle = '#ff3b30';
        mapCtx.font = 'bold 13px system-ui, sans-serif';
        mapCtx.textAlign = 'center';
        mapCtx.textBaseline = 'middle';
        mapCtx.fillText('✹', mx, my);
      }
    },
  };
}
