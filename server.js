import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const mode = "paper"; // Live trading is deliberately locked until a real, tested signer/execution engine exists.

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

const bots = [
  {
    id: "bot-1",
    name: "Bot 1",
    venue: "pump.fun (monitor-only adapter)",
    walletAddress: "",
    enabled: false,
    takeProfitMultiplier: 1.45,
    stopLossPercent: 15,
    maxPositionSol: 0.05,
    status: "Paper mode · idle"
  }
];

const events = [
  { at: new Date().toISOString(), level: "info", message: "Corvis Trading backend started in paper mode." },
  { at: new Date().toISOString(), level: "info", message: "No wallet signer or live execution is configured." }
];

function log(level, message) {
  events.unshift({ at: new Date().toISOString(), level, message });
  if (events.length > 100) events.length = 100;
}

app.get("/api/status", (_req, res) => {
  res.json({
    app: "Corvis Trading",
    mode,
    liveExecutionEnabled: false,
    status: "online",
    uptimeSeconds: Math.floor(process.uptime()),
    botCount: bots.length,
    note: "Starter build: paper mode only; no transactions are signed or sent."
  });
});

app.get("/api/bots", (_req, res) => res.json(bots));

app.post("/api/bots", (req, res) => {
  const body = req.body || {};
  const name = String(body.name || "").trim().slice(0, 40);
  const walletAddress = String(body.walletAddress || "").trim().slice(0, 64);
  const takeProfitMultiplier = Number(body.takeProfitMultiplier ?? 1.45);
  const stopLossPercent = Number(body.stopLossPercent ?? 15);
  const maxPositionSol = Number(body.maxPositionSol ?? 0.05);

  if (!name) return res.status(400).json({ error: "Bot name is required." });
  if (!(takeProfitMultiplier > 1 && takeProfitMultiplier <= 10))
    return res.status(400).json({ error: "Take profit multiplier must be greater than 1 and at most 10." });
  if (!(stopLossPercent > 0 && stopLossPercent <= 100))
    return res.status(400).json({ error: "Stop loss must be between 0 and 100%." });
  if (!(maxPositionSol > 0 && maxPositionSol <= 10))
    return res.status(400).json({ error: "Max position must be greater than 0 and at most 10 SOL." });

  const bot = {
    id: randomUUID(),
    name,
    venue: String(body.venue || "Jupiter-routed DEX swaps").slice(0, 80),
    walletAddress,
    enabled: false,
    takeProfitMultiplier,
    stopLossPercent,
    maxPositionSol,
    status: "Paper mode · idle"
  };
  bots.push(bot);
  log("info", `${name} profile created. Trading remains disabled.`);
  res.status(201).json(bot);
});

app.patch("/api/bots/:id", (req, res) => {
  const bot = bots.find(b => b.id === req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot not found." });
  if (typeof req.body?.enabled === "boolean") {
    bot.enabled = req.body.enabled;
    bot.status = bot.enabled ? "Paper mode · monitoring simulation" : "Paper mode · paused";
    log("info", `${bot.name} ${bot.enabled ? "started in paper mode" : "paused"}.`);
  }
  res.json(bot);
});

app.delete("/api/bots/:id", (req, res) => {
  const index = bots.findIndex(b => b.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: "Bot not found." });
  if (req.body?.confirm !== true)
    return res.status(400).json({ error: "Explicit confirmation required: send { confirm: true }." });
  const bot = bots[index];
  if (bot.enabled) return res.status(409).json({ error: "Pause this bot before deleting it." });
  bots.splice(index, 1);
  log("info", `${bot.name} profile deleted. No wallet funds were moved.`);
  res.json({ ok: true, id: bot.id, message: "Profile deleted. No wallet funds were moved." });
});

app.get("/api/stats", (_req, res) => {
  res.json({ botCount: bots.length, paperTrades: 0, liveTrades: 0, realizedPnlSol: 0, note: "Trade execution and P&L tracking are not implemented in this starter." });
});

app.get("/api/events", (_req, res) => res.json(events));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(port, "0.0.0.0", () => {
  console.log(`Corvis Trading starter listening on ${port}; mode=${mode}`);
});