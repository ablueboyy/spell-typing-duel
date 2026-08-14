// 咒語對決 · 線上對戰伺服器 (權威裁判)
// 前端只負責「打字」與「顯示」;血量/護盾/反彈/打斷一律由伺服器結算,避免不同步或作弊。
const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---- 咒語效果表(名稱必須和前端一致)----
// 攻擊咒可以附帶 freeze(凍住對手輸入)或 scramble(打亂對手咒文)
// cd = 施放成功後的冷卻(毫秒)。讀咒被打斷不算施放,所以不會進冷卻。
// spark 的冷卻刻意壓很短:任何時候都要有招可以出,不然六招全冷卻只能乾等。
const SPELLS = {
  spark:    { type: "attack",    power: 11, cd: 1500  },
  frost:    { type: "attack",    power: 10, freeze: 2000,   cd: 6000  },
  tornado:  { type: "attack",    power: 22, scramble: 3000, cd: 7000  },
  tsunami:  { type: "attack",    power: 44, cd: 12000 },
  heal:     { type: "heal",      power: 40, cd: 18000 },
  silence:  { type: "interrupt", power: 0,  cd: 5000  },
};
const has = (name) => Object.prototype.hasOwnProperty.call(SPELLS, name);
// 造型 id 白名單。前端拿到後會用它去組 SVG 的 href,所以不能讓任意字串轉發出去。
const SKINS = new Set(["astral", "sylvan", "count", "fox", "toad", "abyss", "void", "pumpkin"]);
const skinOf = (s) => (SKINS.has(s) ? s : "astral");
const MAXHP = 150;
// 中一次冰凍後的免疫時間。沒有這個,手速越快的人越會被無限凍結鎖死。
const FREEZE_IMMUNE = 10000;
// 雙方都按下準備之後的倒數。房間要等倒數結束才會 started,
// 否則改過的客戶端可以在倒數期間就開始丟咒語。
const COUNTDOWN = 3000;

// ---- 房間管理 ----
const rooms = new Map();   // code -> room
let quickWaiting = null;   // 等待快速配對的 ws

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function pub(p) { return { hp: p.hp, max: p.max, shield: p.shield, reflect: p.reflect }; }
function initPlayer(ws, name) {
  // cds: 咒語名 -> 可再次施放的時間戳
  return { ws, name: (name || "法師").slice(0, 16), skin: skinOf(ws._skin), hp: MAXHP, max: MAXHP, shield: 0, reflect: false, casting: null, rematch: false, freezeImmUntil: 0, cds: {} };
}
function broadcast(r, obj) { r.players.forEach(p => send(p.ws, obj)); }
function broadcastState(r) {
  r.players.forEach((p, i) => send(p.ws, { t: "state", you: pub(p), opp: pub(r.players[1 - i]) }));
}
function bothPresent(r) {
  return r.players.length === 2 && r.players.every(p => p.ws && p.ws.readyState === 1);
}
// 兩人到齊 → 先進準備畫面,不直接開打。這樣至少看得到對手是誰、選了什麼造型。
function toReady(r) {
  r.phase = "ready"; r.started = false;
  r.players.forEach(p => { p.ready = false; p.casting = null; });
  r.players.forEach((p, i) => {
    const opp = r.players[1 - i];
    send(p.ws, { t: "ready", you: pub(p), opp: pub(opp), oppName: opp.name, oppSkin: opp.skin });
  });
}
function beginCountdown(r) {
  if (!bothPresent(r)) return;
  r.phase = "countdown";
  clearTimeout(r.cdTimer);
  broadcast(r, { t: "countdown", ms: COUNTDOWN });
  // 倒數期間有人跑掉的話就別開場了(close 會清掉這個 timer,這裡再擋一次)
  r.cdTimer = setTimeout(() => { r.cdTimer = null; if (bothPresent(r)) startRoom(r); }, COUNTDOWN);
}
function startRoom(r) {
  r.started = true; r.phase = "playing";
  r.players.forEach((p, i) => {
    const opp = r.players[1 - i];
    send(p.ws, { t: "start", youIdx: i, you: pub(p), opp: pub(opp), oppName: opp.name, oppSkin: opp.skin });
  });
}
function endRoom(r, deadIdx) {
  r.started = false; r.phase = "over";
  clearTimeout(r.cdTimer); r.cdTimer = null;
  // 房間保留(房號不釋放),兩人都還連著就能直接再來一場;真正的清除在 close 事件
  r.players.forEach(p => { p.rematch = false; p.casting = null; });
  r.players.forEach((p, i) => send(p.ws, { t: "gameover", win: i !== deadIdx }));
}
function closeRoom(r) {
  r.started = false; r.phase = "dead";
  clearTimeout(r.cdTimer); r.cdTimer = null;
  r.players.forEach(p => { if (p.ws) p.ws._room = null; });
  if (r.code) rooms.delete(r.code);
}

wss.on("connection", (ws) => {
  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.t === "join") {
      ws._name = (msg.name || "法師").slice(0, 16);
      ws._skin = skinOf(msg.skin);
      const code = (msg.room || "").trim().toLowerCase();

      if (code) {
        // 用房號和朋友對戰
        let r = rooms.get(code);
        if (!r) {
          r = { code, players: [], started: false, phase: "waiting", cdTimer: null };
          rooms.set(code, r);
          r.players.push(initPlayer(ws, ws._name));
          ws._room = r; ws._idx = 0;
          send(ws, { t: "waiting", code });
        } else if (r.players.length === 1) {
          r.players.push(initPlayer(ws, ws._name));
          ws._room = r; ws._idx = 1;
          toReady(r);
        } else {
          send(ws, { t: "roomFull" });
        }
      } else {
        // 快速配對
        if (quickWaiting && quickWaiting.readyState === 1 && quickWaiting !== ws) {
          const r = { code: null, players: [], started: false, phase: "waiting", cdTimer: null };
          r.players.push(initPlayer(quickWaiting, quickWaiting._name));
          quickWaiting._room = r; quickWaiting._idx = 0;
          r.players.push(initPlayer(ws, ws._name));
          ws._room = r; ws._idx = 1;
          quickWaiting = null;
          toReady(r);
        } else {
          quickWaiting = ws;
          send(ws, { t: "waiting" });
        }
      }
      return;
    }

    const r = ws._room;
    if (!r) return;
    const me = r.players[ws._idx];
    const opp = r.players[1 - ws._idx];
    if (!me || !opp) return;

    // 準備:兩人到齊後、開打之前的階段。兩邊都按下才進倒數。
    if (msg.t === "ready") {
      if (r.phase !== "ready") return;
      me.ready = true;
      r.players.forEach((p, i) => send(p.ws, { t: "readyState", you: p.ready, opp: r.players[1 - i].ready }));
      if (r.players.every(p => p.ready)) beginCountdown(r);
      return;
    }

    // 再來一場:只在「分出勝負後」處理,所以必須擺在 started 檢查之前
    if (msg.t === "rematch") {
      if (r.phase !== "over") return;
      if (!opp.ws || opp.ws.readyState !== 1) { send(ws, { t: "oppLeft" }); return; }
      me.rematch = true;
      if (r.players.every(p => p.rematch)) {
        r.players.forEach(p => { p.hp = MAXHP; p.shield = 0; p.reflect = false; p.casting = null; p.rematch = false; p.freezeImmUntil = 0; p.cds = {}; });
        // 兩邊都按過「再來一場」,等於已經準備好了,直接進倒數不用再 ready 一次
        beginCountdown(r);
      } else {
        send(opp.ws, { t: "oppWantsRematch" });
      }
      return;
    }

    if (!r.started) return;

    if (msg.t === "castStart") {
      if (!has(msg.spell)) return;
      // 冷卻中就不准起手。前端自己也會擋,這裡是給改過的客戶端看的。
      const left = (me.cds[msg.spell] || 0) - Date.now();
      if (left > 0) { send(ws, { t: "cdReject", spell: msg.spell, ms: left }); return; }
      me.casting = { spell: msg.spell };
      send(opp.ws, { t: "oppCast", spell: msg.spell });
    }
    else if (msg.t === "progress") {
      send(opp.ws, { t: "oppProgress", index: msg.index | 0 });
    }
    else if (msg.t === "castComplete") {
      if (!has(msg.spell)) return;
      const sp = SPELLS[msg.spell];
      if (!me.casting || me.casting.spell !== msg.spell) return; // 必須先 castStart
      me.casting = null;
      // 冷卻從「施放成功」起算;被 silence 打斷的話不會走到這裡,所以不進冷卻。
      if (sp.cd) { me.cds[msg.spell] = Date.now() + sp.cd; send(ws, { t: "cooldown", spell: msg.spell, ms: sp.cd }); }

      const ev = { t: "resolve", caster: ws._idx, spell: msg.spell, effect: sp.type };
      let deadIdx = -1;

      if (sp.type === "attack") {
        const targetIdx = 1 - ws._idx;
        const tp = r.players[targetIdx];
        tp.hp = Math.max(0, tp.hp - sp.power);
        ev.dmg = sp.power; ev.target = targetIdx;
        if (tp.hp <= 0) deadIdx = targetIdx;
        else {
          // 附帶效果:被打中的人才會收到
          if (sp.freeze) {
            const now = Date.now();
            if (now >= tp.freezeImmUntil) {
              tp.freezeImmUntil = now + FREEZE_IMMUNE;
              ev.freeze = sp.freeze;
              send(tp.ws, { t: "frozen", ms: sp.freeze });
            } else ev.freezeImmune = true;   // 還在免疫中,只吃傷害
          }
          if (sp.scramble) { ev.scramble = sp.scramble; send(tp.ws, { t: "scrambled", ms: sp.scramble }); }
        }
      }
      else if (sp.type === "heal") {
        const before = me.hp; me.hp = Math.min(me.max, me.hp + sp.power);
        ev.value = me.hp - before;
      }
      else if (sp.type === "interrupt") {
        if (opp.casting) { opp.casting = null; ev.hit = true; ev.target = 1 - ws._idx; send(opp.ws, { t: "interrupted" }); }
        else ev.hit = false;
      }

      broadcast(r, ev);
      broadcastState(r);
      if (deadIdx >= 0) endRoom(r, deadIdx);
    }
  });

  ws.on("close", () => {
    if (quickWaiting === ws) quickWaiting = null;
    const r = ws._room;
    ws._room = null;
    if (!r) return;
    const opp = r.players[1 - ws._idx];
    if (opp && opp.ws && opp.ws !== ws) send(opp.ws, { t: "oppLeft" });
    closeRoom(r);   // 少一個人房間就沒得玩了,這時才釋放房號
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`咒語對決伺服器啟動於 http://localhost:${PORT}`));
