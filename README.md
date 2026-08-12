# 咒語對決 · Spell Typing Duel

兩個巫師比拚打字速度的線上對戰遊戲。打出咒語名字啟動,再把跳出來的隨機咒文一個字一個字打完才會發動。越強的咒需要打越多、越長的字,但傷害越高。對手讀咒時你看得到,可以用**打斷 / 護盾 / 反彈**做出反制。

- `public/index.html` — 線上雙人對戰
- `public/practice.html` — 單人 vs AI 練習
- `server.js` — WebSocket 對戰伺服器(當裁判,結算血量/護盾/反彈/打斷)

## 咒語一覽

| 咒語 | 類型 | 咒文字數 | 效果 |
|------|------|---------|------|
| `spark` 火花 | 攻擊 | 1 | 8 傷 |
| `fireball` 火球 | 攻擊 | 3 | 20 傷 |
| `meteor` 隕石 | 攻擊 | 5 | 46 傷 |
| `shield` 護盾 | 防禦 | 2 | +30 盾(吸收傷害) |
| `heal` 治療 | 回復 | 3 | +26 血 |
| `silence` 打斷 | 反制 | 2 | 中斷對手正在讀的咒 |
| `mirror` 反彈 | 反制 | 3 | 反彈對手下一發攻擊 |

## 本機執行

需要 Node.js 18+。

```bash
npm install
npm start
```

瀏覽器開 http://localhost:3000 。想自己測兩邊,開兩個分頁,一邊按「快速配對」或兩邊輸入相同房號即可。

同一區網的朋友:把你電腦的區網 IP 給對方(例如 `http://192.168.x.x:3000`)。要跨網路對戰請部署到雲端(見下)。

## 部署到雲端(推 GitHub → Render 免費方案)

### 最快:一鍵藍圖(本專案已含 `render.yaml`)

1. 登入 [render.com](https://render.com)(用 GitHub 帳號登入最快)。
2. New → **Blueprint** → 選這個 repo → **Apply**。
3. Render 會依 `render.yaml` 自動建立服務,完成後給你網址(例如 `https://spell-typing-duel.onrender.com`),分享給朋友即可對戰。

### 或手動設定

1. 到 [render.com](https://render.com) → New → **Web Service** → 連結這個 repo。
2. 設定:
   - Environment: **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`
3. 部署完成後會給你一個網址,把它分享給朋友就能對戰。

> 伺服器已用 `process.env.PORT`,Render / Railway / Fly.io 等平台都能直接跑。
> 免費方案閒置會休眠,第一次連線可能要等十幾秒喚醒,屬正常現象。

## 備註

打字內容在本機判定(不會把每個按鍵都送伺服器),對戰結果由伺服器結算,一般朋友對戰很夠用;若要正式比賽級的防作弊,再把逐字驗證也移到伺服器即可。
