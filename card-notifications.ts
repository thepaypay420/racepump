/**
 * Card Win Notifications
 * 
 * Handles:
 * - Fetching card metadata (name, image, insured value) for notifications
 * - Scheduled "card winners roll" posts (twice daily)
 */

import { PublicKey } from "@solana/web3.js";

// Metadata Program ID for Metaplex
const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

export interface CardMetadata {
  mint: string;
  name: string;
  image: string | null;
  insuredValueUsd: number | null;
  set: string | null;
  grade: string | null;
}

/**
 * Fetch card metadata from on-chain + off-chain sources
 */
export async function fetchCardMetadataForNotification(mint: string): Promise<CardMetadata | null> {
  try {
    const { connection } = await import('./solana');
    const mintPk = new PublicKey(mint);
    
    // Derive metadata PDA
    const [metadataPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mintPk.toBuffer()],
      METADATA_PROGRAM_ID
    );
    
    // Fetch on-chain metadata account
    const accountInfo = await connection.getAccountInfo(metadataPda, "confirmed");
    if (!accountInfo?.data) {
      console.warn(`[card-notifications] No metadata found for ${mint}`);
      return null;
    }
    
    // Decode on-chain metadata (name, symbol, uri)
    const decoded = decodeMetaplexNameSymbolUri(accountInfo.data);
    if (!decoded) {
      console.warn(`[card-notifications] Failed to decode metadata for ${mint}`);
      return null;
    }
    
    // Fetch off-chain JSON metadata
    const uri = resolveUri(decoded.uri);
    const json = await fetchMetadataJson(uri);
    
    // Extract attributes
    const name = json?.name || decoded.name || `Card ${mint.slice(0, 6)}...`;
    const image = resolveUri(pickImageFromJson(json) || "");
    const attributes = extractAttributes(json);
    const insuredValueUsd = parseUsdValue(getTraitValue(attributes, ["insured value", "insured_value", "insuredvalue"]));
    const set = getTraitValue(attributes, ["set", "set name", "collection"]);
    const grade = getTraitValue(attributes, ["grade", "psa grade", "psa"]);
    
    return {
      mint,
      name,
      image: image || null,
      insuredValueUsd,
      set,
      grade,
    };
  } catch (e: any) {
    console.error(`[card-notifications] Error fetching metadata for ${mint}:`, e?.message || e);
    return null;
  }
}

/**
 * Post a rolling card winners announcement to Telegram
 * Shows recent card winners to celebrate and encourage swapping
 */
export async function postCardWinnersRoll(): Promise<boolean> {
  console.log('[card-notifications] postCardWinnersRoll called');
  try {
    const { pgPool } = await import('./db/clients');
    const { notifyTelegramWithAsset } = await import('./telegram');
    
    console.log('[card-notifications] pgPool imported:', !!pgPool);
    
    if (!pgPool) {
      console.warn('[card-notifications] No database connection, skipping card winners roll');
      return false;
    }
    
    // Test database connectivity
    try {
      const testResult = await pgPool.query('SELECT 1 as test');
      console.log('[card-notifications] Database connectivity test:', testResult.rows?.[0]?.test === 1 ? 'OK' : 'FAILED');
    } catch (connErr) {
      console.error('[card-notifications] Database connectivity test FAILED:', connErr);
      return false;
    }
    
    // Fetch recent card winners (last 7 days, limit 10)
    const cutoffTimestamp = Date.now() - 7 * 24 * 60 * 60 * 1000;
    console.log('[card-notifications] Querying card winners since:', new Date(cutoffTimestamp).toISOString());
    
    const result = await pgPool.query(`
      SELECT 
        recipient, 
        card_mint, 
        card_reward_sig,
        usd_value,
        boost_tier,
        boost_multiplier,
        card_roll,
        card_win_probability,
        created_at
      FROM raceswap_swap_rewards 
      WHERE card_won = TRUE 
      AND created_at > $1
      ORDER BY created_at DESC 
      LIMIT 10
    `, [cutoffTimestamp]);
    
    console.log('[card-notifications] Query returned', result.rows?.length ?? 0, 'rows');
    
    const winners = result.rows || [];
    
    if (winners.length === 0) {
      console.log('[card-notifications] No recent card winners to post');
      
      // Debug: Check if there are ANY card winners in the table
      try {
        const debugResult = await pgPool.query(`
          SELECT recipient, card_mint, created_at, card_won
          FROM raceswap_swap_rewards 
          WHERE card_won = TRUE 
          ORDER BY created_at DESC 
          LIMIT 5
        `);
        console.log('[card-notifications] Debug: ALL card winners in DB (latest 5):', 
          JSON.stringify(debugResult.rows?.map((r: any) => ({
            recipient: r.recipient?.slice(0, 8) + '...',
            card_mint: r.card_mint?.slice(0, 8) + '...',
            created_at: r.created_at,
            created_at_date: new Date(Number(r.created_at)).toISOString()
          })) || []));
      } catch (debugErr) {
        console.error('[card-notifications] Debug query failed:', debugErr);
      }
      
      return false;
    }
    
    // Fetch metadata for the most recent winner's card (for the image)
    const latestWinner = winners[0];
    const cardMeta = await fetchCardMetadataForNotification(latestWinner.card_mint);
    
    // Build the message with new cleaner format
    const lines: string[] = [
      `🃏 CARD WINNERS ROLL 🎲`,
      ``,
      `Recent Pokémon card drops from RaceSwap!`,
      ``,
    ];
    
    // Calculate total card value given away (collect metadata as we go)
    let totalValue = 0;
    const winnerMetas: (CardMetadata | null)[] = [];
    
    // Fetch metadata for all winners we'll display (up to 5)
    for (let i = 0; i < Math.min(winners.length, 5); i++) {
      const w = winners[i];
      const meta = i === 0 ? cardMeta : await fetchCardMetadataForNotification(w.card_mint);
      winnerMetas.push(meta);
      if (meta?.insuredValueUsd) {
        totalValue += meta.insuredValueUsd;
      }
    }
    
    // Add each winner with new format
    for (let i = 0; i < Math.min(winners.length, 5); i++) {
      const w = winners[i];
      const meta = winnerMetas[i];
      const shortWallet = `${w.recipient.slice(0, 4)}...${w.recipient.slice(-4)}`;
      const swapValue = Number(w.usd_value || 0).toFixed(2);
      const boostDisplay = formatBoostTier(w.boost_tier);
      
      // Get card name if available
      let cardName = meta?.name || `Card ${w.card_mint.slice(0, 6)}...`;
      
      const timeAgo = formatTimeAgo(Number(w.created_at));
      
      // New format: medal + short wallet, then boost tier, card name, value, and full wallet
      lines.push(`${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '🎴'} ${shortWallet}`);
      lines.push(`🚀 ${boostDisplay}`);
      lines.push(`🎴 ${cardName}`);
      lines.push(`💵 $${swapValue} swap • ${timeAgo}`);
      lines.push(`📬 ${w.recipient}`);
      lines.push(``);
    }
    
    // Add total value if we have any
    if (totalValue > 0) {
      lines.push(`💰 Total Value Dropped: $${Math.round(totalValue)}`);
      lines.push(``);
    }
    
    lines.push(`🔄 Swap on RaceSwap for your chance to win!`);
    lines.push(`https://racepump.fun`);
    
    const message = lines.join('\n');
    
    // Send with the latest winner's card image if available
    await notifyTelegramWithAsset(message, cardMeta?.image || null);
    
    console.log(`[card-notifications] ✅ Card winners roll posted (${winners.length} winners)`);
    return true;
  } catch (e: any) {
    console.error('[card-notifications] Failed to post card winners roll:', e?.message || e);
    return false;
  }
}

// ---- Helper functions ----

function decodeMetaplexNameSymbolUri(data: Uint8Array): { name: string; symbol: string; uri: string } | null {
  try {
    const decoder = new TextDecoder("utf-8");
    const start = 1 + 32 + 32; // key + updateAuthority + mint
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    
    const readStr = (offset: number): { value: string; next: number } | null => {
      if (offset + 4 > data.length) return null;
      const len = view.getUint32(offset, true);
      const next = offset + 4;
      if (len > 10_000) return null;
      if (next + len > data.length) return null;
      const value = decoder.decode(data.slice(next, next + len)).replace(/\0/g, "").trim();
      return { value, next: next + len };
    };
    
    const name1 = readStr(start);
    if (name1) {
      const sym1 = readStr(name1.next);
      if (sym1) {
        const uri1 = readStr(sym1.next);
        if (uri1?.value) {
          return { name: name1.value, symbol: sym1.value, uri: uri1.value };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function resolveUri(uri: string): string {
  const u = uri?.trim() || "";
  if (!u) return u;
  if (u.startsWith("ipfs://")) {
    const rest = u.slice("ipfs://".length).replace(/^ipfs\//, "");
    return `https://ipfs.io/ipfs/${rest}`;
  }
  if (u.startsWith("ar://")) {
    return `https://arweave.net/${u.slice("ar://".length)}`;
  }
  return u;
}

async function fetchMetadataJson(uri: string): Promise<any | null> {
  if (!uri) return null;
  try {
    const res = await fetch(uri, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function pickImageFromJson(json: any): string | null {
  if (!json) return null;
  if (typeof json.image === "string") return json.image;
  if (typeof json.image_url === "string") return json.image_url;
  if (typeof json.imageUrl === "string") return json.imageUrl;
  const files = Array.isArray(json?.properties?.files) ? json.properties.files : [];
  for (const f of files) {
    if (typeof f?.uri === "string" && /\.(png|jpg|jpeg|webp|gif)/i.test(f.uri)) {
      return f.uri;
    }
  }
  return null;
}

function extractAttributes(json: any): Array<{ trait_type?: string; value?: unknown }> {
  if (Array.isArray(json?.attributes)) return json.attributes;
  if (Array.isArray(json?.properties?.attributes)) return json.properties.attributes;
  if (Array.isArray(json?.traits)) return json.traits;
  return [];
}

function getTraitValue(attributes: Array<{ trait_type?: string; value?: unknown }>, keys: string[]): string | null {
  const wanted = new Set(keys.map(k => k.toLowerCase()));
  for (const attr of attributes) {
    const traitType = String(attr?.trait_type || "").toLowerCase().trim();
    if (!traitType || !wanted.has(traitType)) continue;
    const v = attr?.value;
    const str = String(v ?? "").trim();
    if (str) return str;
  }
  return null;
}

function parseUsdValue(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/-?\d[\d,]*(?:\.\d+)?/);
  if (!match?.[0]) return null;
  const num = Number.parseFloat(match[0].replace(/,/g, ""));
  return Number.isFinite(num) ? num : null;
}

function formatTimeAgo(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  
  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

function formatBoostTier(tier: string | null | undefined): string {
  const t = String(tier || 'none').toLowerCase();
  switch (t) {
    case '20m': return '20M RACE Holder (2x Boost)';
    case '10m': return '10M RACE Holder (1.5x Boost)';
    case '5m': return '5M RACE Holder (1.25x Boost)';
    case '1m': return '1M RACE Holder (1.1x Boost)';
    case 'none':
    default: return 'No RACE Boost';
  }
}
