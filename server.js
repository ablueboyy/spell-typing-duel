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
const SPELLS = {
  spark:    { type: "attack",    power: 12 },
  frost:    { type: "attack",    power: 8,  freeze: 2200 },
  tornado:  { type: "attack",    power: 15, scramble: 3000 },
  tsunami:  { type: "attack",    power: 40 },
  heal:     { type: "heal",      power: 26 },
  silence:  { type: "interrupt", power: 0  },
};
const MAXHP = 100;

// ---- 房間管理 ----
const rooms = new Map();   // code -> room
let quickWaiting = null;   // 等待快速配對的 ws

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function pub(p) { return { hp: p.hp, max: p.max, shield: p.shield, reflect: p.reflect }; }
function initPlayer(ws, name) {
  return { ws, name: (name || "法師").slice(0, 16), hp: MAXHP, max: MAXHP, shield: 0, reflect: false, casting: null, rematch: false };
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
  // 房間保留(房號不釋放),兩人都還連著就能直接再來一場;真正的清除在 close 事件
  r.players.forEach(p => { p.rematch = false; p.casting = null; });
  r.players.forEach((p, i) => send(p.ws, { t: "gameover", win: i !== deadIdx }));
}
function closeRoom(r) {
  r.started = false;
  r.players.forEach(p => { if (p.ws) p.ws._room = null; });
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
    if (!r) return;
    const me = r.players[ws._idx];
    const opp = r.players[1 - ws._idx];
    if (!me || !opp) return;

    // 再來一場:只在「分出勝負後」處理,所以必須擺在 started 檢查之前
    if (msg.t === "rematch") {
      if (r.started) return;
      if (!opp.ws || opp.ws.readyState !== 1) { send(ws, { t: "oppLeft" }); return; }
      me.rematch = true;
      if (r.players.every(p => p.rematch)) {
        r.players.forEach(p => { p.hp = MAXHP; p.shield = 0; p.reflect = false; p.casting = null; p.rematch = false; });
        startRoom(r);
      } else {
        send(opp.ws, { t: "oppWantsRematch" });
      }
      return;
    }

    if (!r.started) return;

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
        const targetIdx = 1 - ws._idx;
        const tp = r.players[targetIdx];
        tp.hp = Math.max(0, tp.hp - sp.power);
        ev.dmg = sp.power; ev.target = targetIdx;
        if (tp.hp <= 0) deadIdx = targetIdx;
        else {
          // 附帶效果:被打中的人才會收到
          if (sp.freeze)   { ev.freeze = sp.freeze;     send(tp.ws, { t: "frozen",    ms: sp.freeze }); }
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
