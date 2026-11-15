// The DOM HUD: crosshair, hit marker, health, ammo, money, round timer, team scores,
// kill feed, buy menu, round banners and a top-down minimap. It never touches the
// simulation; main.js pushes numbers in and reads the play and buy callbacks out.
import { WEAPONS, WEAPON_ORDER } from './weapon.js';

const COPY = {
  start: {
    title: 'Dustline Yard',
    copy: 'Vanguard defends two sites — Foundry and Depot — against four Raiders. Win the round by stopping the plant, defusing the charge, or dropping every Raider.',
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
  const banner = $('banner');
  const bannerTitle = $('banner-title');
  const bannerSub = $('banner-sub');
  const crosshair = $('crosshair');
  const hitmarker = $('hitmarker');
  const damageFlash = $('damage-flash');
  const bombChip = $('bomb-chip');
  const bombText = $('bomb-text');
  const buyMenu = $('buy-menu');
  const buyMoney = $('buy-money');
  const buyGrid = $('buy-grid');
  const buyTimer = $('buy-timer');
  const hint = $('hint');
  const minimap = $('minimap');

  let hitTimer = 0;
  let bannerTimer = 0;
  let lastMag = -1;
  let lastReserve = -1;
  let lastWeapon = '';
  let lastHealth = -1;
  let lastArmor = -1;
  let lastMoney = -1;
  let lastTimer = '';
  let lastScore = '';
  let lastPips = '';

  // Minimap: static walls drawn once, dots each frame.
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

  // Buy menu cards, built once; prices and affordability update per phase.
  const buyButtons = {};
  for (const id of WEAPON_ORDER) {
    const def = WEAPONS[id];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'buy-card';
    button.dataset.weapon = id;
    button.innerHTML = `<b>${def.name}</b><span>$${def.price} · ${def.magSize} rounds · ${def.damage} dmg · headshot ${def.headMult}x</span><i>${WEAPON_ORDER.indexOf(id) + 1}</i>`;
    buyGrid.appendChild(button);
    buyButtons[id] = button;
  }
  const armorButton = document.createElement('button');
  armorButton.type = 'button';
  armorButton.className = 'buy-card';
  armorButton.dataset.armor = '1';
  armorButton.innerHTML = '<b>Plated Vest</b><span>$400 · +50 armour</span><i>5</i>';
  buyGrid.appendChild(armorButton);

  let buyHandler = null;
  let armorHandler = null;
  buyGrid.addEventListener('click', (event) => {
    const card = event.target.closest('.buy-card');
    if (!card) return;
    if (card.dataset.weapon) buyHandler?.(card.dataset.weapon);
    else if (card.dataset.armor) armorHandler?.();
  });

  return {
    setAmmo(mag, reserve, weaponId) {
      if (mag === lastMag && reserve === lastReserve && weaponId === lastWeapon) return;
      lastMag = mag;
      lastReserve = reserve;
      lastWeapon = weaponId;
      ammoMag.textContent = String(mag);
      ammoReserve.textContent = `/ ${reserve}`;
      weaponName.textContent = WEAPONS[weaponId].name;
      ammo.classList.toggle('empty', mag === 0);
    },
    setHealth(health, armor) {
      if (health === lastHealth && armor === lastArmor) return;
      lastHealth = health;
      lastArmor = armor;
      healthFill.style.width = `${Math.max(0, health)}%`;
      healthFill.classList.toggle('low', health <= 30);
      healthValue.textContent = String(Math.max(0, Math.ceil(health)));
      armorValue.textContent = armor > 0 ? `+${Math.ceil(armor)}` : '';
    },
    setMoney(money) {
      if (money === lastMoney) return;
      lastMoney = money;
      moneyValue.textContent = `$${money}`;
    },
    setTimer(seconds) {
      const text = `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
      if (text === lastTimer) return;
      lastTimer = text;
      timerValue.textContent = text;
      timerValue.classList.toggle('urgent', seconds <= 10);
    },
    setScore(vanguard, raider, round) {
      const text = `${vanguard}-${raider}-${round}`;
      if (text === lastScore) return;
      lastScore = text;
      scoreV.textContent = String(vanguard);
      scoreR.textContent = String(raider);
      roundValue.textContent = `ROUND ${round}`;
    },
    setPips(vanguardAlive, raiderAlive) {
      const text = `${vanguardAlive}/${raiderAlive}`;
      if (text === lastPips) return;
      lastPips = text;
      pipsV.textContent = '●'.repeat(vanguardAlive) + '○'.repeat(Math.max(0, 3 - vanguardAlive));
      pipsR.textContent = '●'.repeat(raiderAlive) + '○'.repeat(Math.max(0, 4 - raiderAlive));
    },
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
    hitMarker(killed, holdMs = 90, headshot = false) {
      hitmarker.classList.add('on');
      hitmarker.classList.toggle('kill', killed);
      hitmarker.classList.toggle('headshot', headshot && !killed);
      clearTimeout(hitTimer);
      hitTimer = setTimeout(() => hitmarker.classList.remove('on', 'kill', 'headshot'), holdMs);
    },
    damageFlash() {
      damageFlash.classList.add('on');
      setTimeout(() => damageFlash.classList.remove('on'), 120);
    },
    addKill(killer, victim, killerTeam, headshot, holdMs = 6000) {
      const line = document.createElement('div');
      line.className = 'kill-line';
      line.innerHTML = `<span class="${killerTeam}">${killer}</span> ${headshot ? '⌖' : '✕'} <span>${victim}</span>${headshot ? ' <span class="hs">HEADSHOT</span>' : ''}`;
      killfeed.prepend(line);
      while (killfeed.children.length > 5) killfeed.lastChild.remove();
      setTimeout(() => line.remove(), holdMs);
    },
    showBanner(titleText, subText, ms = 2600) {
      bannerTitle.textContent = titleText;
      bannerSub.textContent = subText;
      banner.hidden = false;
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => {
        banner.hidden = true;
      }, ms);
    },
    hideBanner() {
      clearTimeout(bannerTimer);
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
    showBuy(money, secondsLeft, ownedWeapon, hasArmor) {
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
    drawMinimap(actors, bomb) {
      drawMapBase();
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
