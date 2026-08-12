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
const SPELLS = {
  spark:    { type: "attack",    power: 8  },
  fireball: { type: "attack",    power: 20 },
  meteor:   { type: "attack",    power: 46 },
  shield:   { type: "shield",    power: 30 },
  heal:     { type: "heal",      power: 26 },
  silence:  { type: "interrupt", power: 0  },
  mirror:   { type: "reflect",   power: 0  },
  frost:    { type: "freeze",    power: 0, ms: 2500 },
  scramble: { type: "scramble",  power: 0, ms: 3000 },
};
const MAXHP = 100;
const SHIELD_CAP = 80;

// ---- 房間管理 ----
const rooms = new Map();   // code -> room
let quickWaiting = null;   // 等待快速配對的 ws

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function pub(p) { return { hp: p.hp, max: p.max, shield: p.shield, reflect: p.reflect }; }
function initPlayer(ws, name) {
  return { ws, name: (name || "法師").slice(0, 16), hp: MAXHP, max: MAXHP, shield: 0, reflect: false, casting: null };
}
function broadcast(r, obj) { r.players.forEach(p => send(p.ws, obj)); }
function broadcastState(r) {
  r.players.forEach((p, i) => send(p.ws, { t: "state", you: pub(p), opp: pub(r.players[1 - i]) }));
}
function startRoom(r) {
  r.started = true;
  r.players.forEach((p, i) => {
    const opp = r.players[1 - i];
    send(p.ws, { t: "start", youIdx: i, you: pub(p), opp: pub(opp), oppName: opp.name });
  });
}
function endRoom(r, deadIdx) {
  r.started = false;
  r.players.forEach((p, i) => send(p.ws, { t: "gameover", win: i !== deadIdx }));
  if (r.code) rooms.delete(r.code);
}

wss.on("connection", (ws) => {
  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.t === "join") {
      ws._name = (msg.name || "法師").slice(0, 16);
      const code = (msg.room || "").trim().toLowerCase();

      if (code) {
        // 用房號和朋友對戰
        let r = rooms.get(code);
        if (!r) {
          r = { code, players: [], started: false };
          rooms.set(code, r);
          r.players.push(initPlayer(ws, ws._name));
          ws._room = r; ws._idx = 0;
          send(ws, { t: "waiting", code });
        } else if (r.players.length === 1) {
          r.players.push(initPlayer(ws, ws._name));
          ws._room = r; ws._idx = 1;
          startRoom(r);
        } else {
          send(ws, { t: "roomFull" });
        }
      } else {
        // 快速配對
        if (quickWaiting && quickWaiting.readyState === 1 && quickWaiting !== ws) {
          const r = { code: null, players: [], started: false };
          r.players.push(initPlayer(quickWaiting, quickWaiting._name));
          quickWaiting._room = r; quickWaiting._idx = 0;
          r.players.push(initPlayer(ws, ws._name));
          ws._room = r; ws._idx = 1;
          quickWaiting = null;
          startRoom(r);
        } else {
          quickWaiting = ws;
          send(ws, { t: "waiting" });
        }
      }
      return;
    }

    const r = ws._room;
    if (!r || !r.started) return;
    const me = r.players[ws._idx];
    const opp = r.players[1 - ws._idx];

    if (msg.t === "castStart") {
      const sp = SPELLS[msg.spell];
      if (!sp) return;
      me.casting = { spell: msg.spell };
      send(opp.ws, { t: "oppCast", spell: msg.spell });
    }
    else if (msg.t === "progress") {
      send(opp.ws, { t: "oppProgress", index: msg.index | 0 });
    }
    else if (msg.t === "castComplete") {
      const sp = SPELLS[msg.spell];
      if (!sp) return;
      if (!me.casting || me.casting.spell !== msg.spell) return; // 必須先 castStart
      me.casting = null;

      const ev = { t: "resolve", caster: ws._idx, spell: msg.spell, effect: sp.type };
      let deadIdx = -1;

      if (sp.type === "attack") {
        let targetIdx = 1 - ws._idx;
        let reflected = false;
        if (opp.reflect) { opp.reflect = false; reflected = true; targetIdx = ws._idx; }
        const tp = r.players[targetIdx];
        let amt = sp.power;
        if (tp.shield > 0) { const ab = Math.min(tp.shield, amt); tp.shield -= ab; amt -= ab; }
        tp.hp = Math.max(0, tp.hp - amt);
        ev.dmg = sp.power; ev.reflected = reflected; ev.target = targetIdx;
        if (tp.hp <= 0) deadIdx = targetIdx;
      }
      else if (sp.type === "shield") {
        me.shield = Math.min(SHIELD_CAP, me.shield + sp.power);
        ev.value = sp.power;
      }
      else if (sp.type === "heal") {
        const before = me.hp; me.hp = Math.min(me.max, me.hp + sp.power);
        ev.value = me.hp - before;
      }
      else if (sp.type === "interrupt") {
        if (opp.casting) { opp.casting = null; ev.hit = true; ev.target = 1 - ws._idx; send(opp.ws, { t: "interrupted" }); }
        else ev.hit = false;
      }
      else if (sp.type === "reflect") {
        me.reflect = true;
      }
      else if (sp.type === "freeze") {
        ev.target = 1 - ws._idx; ev.ms = sp.ms;
        send(opp.ws, { t: "frozen", ms: sp.ms });
      }
      else if (sp.type === "scramble") {
        ev.target = 1 - ws._idx; ev.ms = sp.ms;
        send(opp.ws, { t: "scrambled", ms: sp.ms });
      }

      broadcast(r, ev);
      broadcastState(r);
      if (deadIdx >= 0) endRoom(r, deadIdx);
    }
    else if (msg.t === "rematch") {
      // 兩邊都要求就重置
      me._rematch = true;
      if (r.players.every(p => p._rematch)) {
        r.players.forEach(p => { p.hp = MAXHP; p.shield = 0; p.reflect = false; p.casting = null; p._rematch = false; });
        startRoom(r);
      } else {
        send(opp.ws, { t: "oppWantsRematch" });
      }
    }
  });

  ws.on("close", () => {
    if (quickWaiting === ws) quickWaiting = null;
    const r = ws._room;
    if (r) {
      const opp = r.players[1 - ws._idx];
      if (opp && opp.ws) send(opp.ws, { t: "oppLeft" });
      r.started = false;
      if (r.code) rooms.delete(r.code);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`咒語對決伺服器啟動於 http://localhost:${PORT}`));
