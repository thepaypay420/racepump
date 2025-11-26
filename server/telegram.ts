import { raceEvents } from "./sse";
import type { Race } from "@shared/schema";
import { getDb } from "./db";

function formatPercent(n?: number): string | undefined {
  if (n === undefined || n === null || !isFinite(n)) return undefined;
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function buildCaption(race: Race, totalPotSol: number = 0): string {
  const idShort = race.id?.slice(-4) || "0000";
  const winnerIdx = race.winnerIndex ?? -1;
  const winner = winnerIdx >= 0 ? race.runners[winnerIdx] : undefined;

  const lines: string[] = [];
  lines.push(`🏁 Race ${idShort} Results`);
  lines.push(""); // Empty line for spacing
  
  if (winner) {
    const pc = formatPercent(winner.priceChange);
    lines.push(`🥇 ${winner.symbol}${pc ? ` (${pc})` : ""}`);
    lines.push(""); // Empty line for spacing
  }

  // Summarize top 3 by priceChange when available
  try {
    const sorted = [...race.runners]
      .map(r => ({ s: r.symbol, p: r.priceChange ?? 0 }))
      .sort((a, b) => (b.p - a.p));
    const top = sorted.slice(0, Math.min(sorted.length, 3));
    if (top.length) {
      const parts = top.map((r, i) => `${i + 1}) ${r.s} ${formatPercent(r.p) || ""}`.trim());
      lines.push(parts.join("  "));
      lines.push(""); // Empty line for spacing
    }
  } catch {}

  // Total SOL pot
  if (totalPotSol > 0) {
    lines.push(`💰 Total Pot: ${totalPotSol.toFixed(4)} SOL`);
  }

  // Meme reward info
  if (race.memeRewardEnabled && race.memeRewardRecipient && winner) {
    lines.push("");
    lines.push(`🪙 Meme Reward: ${race.memeRewardTokenAmount || '?'} ${winner.symbol}`);
    lines.push(`   Winner: ${race.memeRewardRecipient.slice(0, 4)}...${race.memeRewardRecipient.slice(-4)}`);
    if (race.memeRewardTxSig) {
      lines.push(`   TX: https://solscan.io/tx/${race.memeRewardTxSig}?cluster=devnet`);
    }
  }

  // Timing info
  const start = race.lockedBlockTimeMs || race.lockedTs || race.startTs;
  const end = race.settledBlockTimeMs || Date.now();
  if (start && end && end > start) {
    const mins = Math.round((end - start) / 60000);
    lines.push(`⏱️ Duration: ~${mins}m`);
  }

  lines.push("");
  
  // Race results link
  if (race.id) {
    lines.push(`📊 View Results: https://racepump.fun/race/${race.id}/results`);
  }

  let caption = lines.join("\n");
  if (caption.length > 1024) {
    caption = caption.slice(0, 1020) + " ...";
  }
  return caption;
}

async function getVideoPath(): Promise<string | null> {
  try {
    const fsMod: any = await safeImport("fs");
    const pathMod: any = await safeImport("path");
    const cwd = (globalThis as any).process?.cwd?.() || "/home/runner/workspace";
    
    // Try multiple candidate paths
    const candidates = [
      `${cwd}/tgmsg.mp4`,
      "/home/runner/workspace/tgmsg.mp4",
      "/workspace/tgmsg.mp4",
      pathMod?.resolve?.(cwd, "tgmsg.mp4")
    ].filter(Boolean);
    
    for (const path of candidates) {
      if (fsMod?.existsSync?.(path)) {
        console.log(`[telegram] Found video at: ${path}`);
        return path;
      }
    }
  } catch (e) {
    console.error(`[telegram] Error finding video:`, e);
  }
  return null;
}

async function getScriptPath(): Promise<string | null> {
  try {
    const fsMod: any = await safeImport("fs");
    const pathMod: any = await safeImport("path");
    const cwd = (globalThis as any).process?.cwd?.() || "/home/runner/workspace";
    
    // Try multiple candidate paths
    const candidates = [
      `${cwd}/scripts/send_telegram_race_results.py`,
      "/home/runner/workspace/scripts/send_telegram_race_results.py",
      "/workspace/scripts/send_telegram_race_results.py",
      pathMod?.resolve?.(cwd, "scripts/send_telegram_race_results.py")
    ].filter(Boolean);
    
    for (const path of candidates) {
      if (fsMod?.existsSync?.(path)) {
        console.log(`[telegram] Found script at: ${path}`);
        return path;
      }
    }
  } catch (e) {
    console.error(`[telegram] Error finding script:`, e);
  }
  return null;
}

async function detectPythonBin(env: any): Promise<string | null> {
  // 1) Explicit override via env
  try {
    if (env?.PYTHON_BIN && String(env.PYTHON_BIN).trim()) {
      return String(env.PYTHON_BIN).trim();
    }
  } catch {}

  try {
    const fsMod: any = await safeImport("fs");
    const pathMod: any = await safeImport("path");

    // 2) Common absolute-path candidates (venv first, then system locations)
    const absoluteCandidates: string[] = [
      "/workspace/.venv-telegram/bin/python",
      "/workspace/.venv/bin/python",
      "/home/runner/workspace/.venv-telegram/bin/python",
      "/home/runner/workspace/.venv/bin/python",
      "/usr/local/bin/python3",
      "/usr/bin/python3",
      "/usr/bin/python",
      "/usr/local/bin/python",
      "/opt/homebrew/bin/python3",
      "/usr/bin/pypy3"
    ];
    for (const candidate of absoluteCandidates) {
      try { if (fsMod?.existsSync?.(candidate)) return candidate; } catch {}
    }

    // 3) Search PATH for common interpreter names
    const pathEnv: string = String(env?.PATH || "");
    const names = ["python3.13", "python3", "python", "python3.12", "python3.11", "python3.10", "pypy3"];
    if (pathEnv) {
      const dirs = pathEnv.split(":").filter(Boolean);
      for (const dir of dirs) {
        for (const name of names) {
          try {
            const full = pathMod?.join?.(dir, name) || `${dir}/${name}`;
            if (fsMod?.existsSync?.(full)) return full;
          } catch {}
        }
      }
    }
  } catch {}

  // 4) As a final fallback, return null to indicate not found
  return null;
}

async function sendToTelegram(race: Race): Promise<void> {
  console.log(`[telegram] Preparing Telegram post for race ${race.id} (winnerIndex=${race.winnerIndex})`);
  const video = await getVideoPath();
  if (!video) {
    console.warn("[telegram] tgmsg.mp4 not found; skipping Telegram post.");
    return;
  }

  const env: any = (globalThis as any).process?.env || {};
  const group = env?.TELEGRAM_TARGET_GROUP;
  if (!group) {
    console.warn("[telegram] TELEGRAM_TARGET_GROUP not set; skipping Telegram post.");
    return;
  }

  console.log(`[telegram] Video found at ${video}`);
  
  // Fetch pot information from database
  let totalPotSol = 0;
  try {
    const storage = getDb();
    if (storage && typeof storage.getBetsForRace === 'function') {
      const bets = await storage.getBetsForRace(race.id);
      const betsSol = bets.filter((b: any) => b.currency === 'SOL');
      totalPotSol = betsSol.reduce((sum: number, bet: any) => sum + parseFloat(bet.amount || '0'), 0);
      console.log(`[telegram] Fetched pot for race ${race.id}: ${totalPotSol} SOL from ${betsSol.length} bets`);
    }
  } catch (e) {
    console.warn(`[telegram] Failed to fetch pot for race ${race.id}:`, e);
  }
  
  const caption = buildCaption(race, totalPotSol);
  const scriptPath = await getScriptPath();
  if (!scriptPath) {
    console.error("[telegram] Python sender script not found; expected at scripts/send_telegram_race_results.py");
    return;
  }
  const py = await detectPythonBin(env);
  if (!py) {
    console.warn("[telegram] No Python interpreter found on PATH; skipping Telegram post.");
    return;
  }
  console.log(`[telegram] Using script ${scriptPath} with ${py}; target group=${group}`);

  const cp: any = await safeImport("child_process");
  if (!cp?.spawn) {
    console.error("[telegram] child_process not available in this environment");
    return;
  }

  const args = [scriptPath, "--group", group, "--caption", caption, "--video", video];
  const child: any = cp.spawn(py, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: env
  });

  // Handle spawn errors (e.g., ENOENT when interpreter is missing)
  child.on("error", (err: any) => {
    try {
      const message = err?.message || String(err);
      console.error(`[telegram] Failed to spawn Python: ${message}`);
    } catch {}
  });

  child.stdout.on("data", (d: any) => console.log(`[telegram] ${String(d)}`));
  child.stderr.on("data", (d: any) => console.error(`[telegram:err] ${String(d)}`));
  child.on("close", (code: number | null) => {
    if (code === 0) {
      console.log("[telegram] Video posted successfully.");
    } else {
      console.error(`[telegram] Sender exited with code ${code}`);
    }
  });
}

export function initializeTelegramIntegration(): void {
  // Only attach once
  const flag = (globalThis as any).__telegram_integration__;
  if (flag) return;
  (globalThis as any).__telegram_integration__ = true;
  // Async readiness check (log results once resolved)
  (async () => {
    try {
      const env: any = (globalThis as any).process?.env || {};
      const group = env?.TELEGRAM_TARGET_GROUP;
      const video = await getVideoPath();
      const py = await detectPythonBin(env);
      console.log(`[telegram] Init: group=${group ? 'set' : 'unset'}, video=${video ? 'present' : 'missing'}, python=${py || 'missing'}`);
      // Probe whether Telethon is importable under the detected interpreter for clearer diagnostics
      try {
        const cp: any = await safeImport("child_process");
        if (py && cp?.spawn) {
          const code = "import importlib.util; spec = importlib.util.find_spec('telethon'); print('telethon=' + ('present' if spec else 'missing'))";
          const child: any = cp.spawn(py, ["-c", code], { stdio: ["ignore", "pipe", "pipe"], env });
          let out = "";
          child.stdout.on("data", (d: any) => { try { out += String(d); } catch {} });
          child.on("close", () => {
            try {
              const result = out.trim() || "no-output";
              console.log(`[telegram] Python '${py}' check: ${result}`);
            } catch {}
          });
          child.on("error", (err: any) => {
            try { console.warn(`[telegram] Python probe failed: ${err?.message || String(err)}`); } catch {}
          });
        }
      } catch {}
      if (!group) {
        console.warn('[telegram] TELEGRAM_TARGET_GROUP not set; Telegram posts will be skipped.');
      }
      if (!video) {
        console.warn('[telegram] tgmsg.mp4 not found at /workspace/tgmsg.mp4; place a file to enable posting.');
      }
    } catch {}
  })();

  raceEvents.on("race_settled", (race: Race) => {
    try {
      // Post only if there is a winner index
      if (race.winnerIndex === undefined || race.winnerIndex === null) return;
      console.log(`[telegram] race_settled received for ${race.id}; enqueueing send`);
      void sendToTelegram(race);
    } catch (e) {
      console.error("[telegram] failed to send:", e);
    }
  });

  console.log("[telegram] Integration initialized (listening for race_settled)");
}

async function safeImport(moduleName: string): Promise<any> {
  try {
    // Use dynamic import via Function to avoid static analysis/type resolution
    const dyn = new Function("m", "return import(m)");
    return await (dyn as any)(moduleName);
  } catch {
    try {
      const req = (0, eval)("require");
      return req ? req(moduleName) : null;
    } catch {
      return null;
    }
  }
}

