import type { Race } from "@shared/schema";
import { getShortRaceTag } from "@shared/race-name";

function formatCompact(value: number): string {
  if (!isFinite(value)) return "0";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${sign}${Math.round(abs)}`;
}

export function buildRaceResultsTweet(
  race: Race,
  opts: { totalPot: number; betCount: number; resultsUrl: string }
): string {
  const idShort = race.id?.slice(-4) || "0000";
  const winnerSymbol =
    race.winnerIndex !== undefined && race.winnerIndex !== null
      ? race.runners?.[race.winnerIndex]?.symbol || "Winner"
      : undefined;

  const potText = `${formatCompact(opts.totalPot)} $RACE`;

  const lines: string[] = [];
  const raceTag = getShortRaceTag(race.id);
  lines.push(`🏁 ${raceTag} Results`);
  if (winnerSymbol) lines.push(`🥇 ${winnerSymbol} wins!`);
  lines.push(`💰 Pot: ${potText} • Bets: ${opts.betCount}`);
  lines.push(opts.resultsUrl);
  lines.push("Join @racepumpfun");

  let tweet = lines.join("\n");
  const limit = 280;
  if (tweet.length <= limit) return tweet;

  // Try removing Bets count
  if (tweet.length > limit) {
    const i = lines.findIndex(l => l.startsWith("💰 Pot:"));
    if (i >= 0) {
      lines[i] = `💰 Pot: ${potText}`;
      tweet = lines.join("\n");
    }
  }

  // Try removing winner line
  if (tweet.length > limit && winnerSymbol) {
    const i = lines.findIndex(l => l.startsWith("🥇 "));
    if (i >= 0) {
      lines.splice(i, 1);
      tweet = lines.join("\n");
    }
  }

  // As last resort, truncate header
  if (tweet.length > limit) {
    const headerIdx = 0;
    const spare = limit - (tweet.length - lines[headerIdx].length) - 1; // keep 1 char for ellipsis
    if (spare > 10) {
      lines[headerIdx] = lines[headerIdx].slice(0, spare) + "…";
      tweet = lines.join("\n");
    }
  }

  // Hard cap
  if (tweet.length > limit) {
    tweet = tweet.slice(0, limit - 1) + "…";
  }
  return tweet;
}

