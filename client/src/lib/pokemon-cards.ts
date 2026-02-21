import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

export const POKEMON_CARDS_OWNER = new PublicKey("6yHeKfbTqSDiDgteku2ExJNcF3VghXxAGUEPPyjwqT4u");

/**
 * Optional: explicit mint allowlist for the on-chain card rail.
 *
 * Use this when your RPC cannot reliably enumerate wallet assets (e.g. cNFTs / DAS not enabled),
 * or when you want full manual control over which cards display.
 *
 * Add/remove mints here as needed.
 */
export const POKEMON_CARD_MINT_ALLOWLIST: string[] = [
  // Intentionally empty by default in production: fetch allowlist from the server
  // (`/api/raceswap/pokemon-card-allowlist`) so high-value mints aren’t hardcoded client-side.
];

const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

export type NftAttribute = { trait_type?: string; value?: unknown } & Record<string, unknown>;

export interface PokemonCardNft {
  mint: string;
  name: string;
  symbol?: string;
  uri?: string;
  image: string;
  description?: string;
  externalUrl?: string;
  attributes: NftAttribute[];
  set: string;
  grade: string;
  insuredValueUsd?: number | null;
}

export type PokemonCardsDebug = {
  owner: string;
  rpcEndpoint: string;
  tokenProgramAccounts: number;
  token2022ProgramAccounts: number;
  totalTokenAccounts: number;
  nftLikeTokenAccounts: number; // decimals=0 && amount>0
  uniqueMints: number;
  metaplexMetadataFound: number;
  dasAttempted: boolean;
  dasSupported: boolean;
  dasAssetsFound: number;
  quicknodeAttempted: boolean;
  quicknodeSupported: boolean;
  quicknodeAssetsFound: number;
  offchainFetchOk: number;
  offchainFetchFailed: number;
  resolvedWithImage: number;
  resolvedWithoutImage: number;
};

export type PokemonCardsResult = {
  items: PokemonCardNft[];
  fetchedAt: number;
  debug: PokemonCardsDebug;
};

type CachePayloadV1 = {
  version: 1;
  owner: string;
  fetchedAt: number;
  items: PokemonCardNft[];
  debug?: PokemonCardsDebug;
};

// Bump when metadata extraction changes so cached fields refresh immediately.
const CACHE_SCHEMA_VERSION = 1 as const;
const CACHE_VERSION = 10 as const;
const CACHE_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours
const MEMORY_CACHE = new Map<string, PokemonCardsResult>();

function cacheKey(ownerOrAllowlistKey: string) {
  return `pokemon-cards-cache:v${CACHE_VERSION}:${ownerOrAllowlistKey}`;
}

function safeParseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function resolveUri(uri: string): string {
  const u = uri.trim();
  if (!u) return u;

  // ipfs://<cid>/<path> or ipfs://ipfs/<cid>/<path>
  if (u.startsWith("ipfs://")) {
    const rest = u.slice("ipfs://".length).replace(/^ipfs\//, "");
    return `https://ipfs.io/ipfs/${rest}`;
  }
  // ar://<txid>
  if (u.startsWith("ar://")) {
    return `https://arweave.net/${u.slice("ar://".length)}`;
  }
  return u;
}

const METADATA_PROXY_PATH = "/api/metadata-proxy";

async function fetchMetadataJson(uri: string): Promise<any | null> {
  const tryFetch = async (u: string): Promise<any | null> => {
    const res = await fetch(u, {
      method: "GET",
      headers: { Accept: "application/json" },
      // Keep this fairly short so card rails don't hang on bad gateways.
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    try {
      return await res.json();
    } catch {
      return null;
    }
  };

  const target = String(uri || "").trim();
  if (!target) return null;

  // Direct fetch first (works in Node and in browsers if CORS allows it).
  try {
    const direct = await tryFetch(target);
    if (direct) return direct;
  } catch {
    // ignore: will try proxy in browser
  }

  // Browser-only fallback: same-origin proxy to bypass CORS on arweave/ipfs gateways.
  if (typeof window === "undefined") return null;
  if (target.startsWith(METADATA_PROXY_PATH)) return null;
  try {
    return await tryFetch(`${METADATA_PROXY_PATH}?url=${encodeURIComponent(target)}`);
  } catch {
    return null;
  }
}

async function rpcJson<T>(rpcEndpoint: string, method: string, params: any[]): Promise<T> {
  const res = await fetch(rpcEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  if (!json) throw new Error("RPC returned non-JSON response");
  if (json.error) {
    const msg = typeof json.error?.message === "string" ? json.error.message : JSON.stringify(json.error);
    throw new Error(msg || "RPC error");
  }
  return json.result as T;
}

type DasAsset = {
  id: string;
  content?: {
    json_uri?: string;
    metadata?: { name?: string; symbol?: string };
    files?: Array<{ uri?: string; mime?: string }>;
  };
};

async function tryGetAssetsByOwnerDas(rpcEndpoint: string, owner: string): Promise<DasAsset[] | null> {
  // Metaplex DAS method (supported by Helius / Triton / some providers):
  // https://github.com/metaplex-foundation/digital-asset-standard-api
  try {
    const out = await rpcJson<{ items?: DasAsset[] }>(rpcEndpoint, "getAssetsByOwner", [
      { ownerAddress: owner, page: 1, limit: 1000 },
    ]);
    return Array.isArray(out?.items) ? out.items : [];
  } catch (e: any) {
    const msg = String(e?.message ?? e ?? "");
    // If the RPC doesn't support DAS, it often returns "Method not found"
    if (/method not found/i.test(msg) || /does not exist/i.test(msg) || /-32601/.test(msg)) return null;
    // Other RPC errors (rate limit, etc.) should still surface as "supported but failed"
    throw e;
  }
}

type QuickNodeNft = {
  mint?: string;
  address?: string;
  tokenAddress?: string;
  name?: string;
  symbol?: string;
  image?: string;
  imageUrl?: string;
  metadataUri?: string;
  uri?: string;
  attributes?: any[];
} & Record<string, any>;

function extractQuickNodeNfts(result: any): QuickNodeNft[] {
  if (!result) return [];
  if (Array.isArray(result)) return result as QuickNodeNft[];
  const candidates = [result?.nfts, result?.assets, result?.items, result?.result, result?.tokens];
  for (const c of candidates) {
    if (Array.isArray(c)) return c as QuickNodeNft[];
  }
  return [];
}

async function tryGetQuickNodeNftsByOwner(rpcEndpoint: string, owner: string): Promise<QuickNodeNft[] | null> {
  // QuickNode Solana "Enhanced APIs" (method names vary by addon/version).
  // We try a small set of common names and payload shapes; if none exist, return null.
  const methodAttempts: Array<{ method: string; params: any[] }> = [
    { method: "qn_fetchNFTs", params: [{ wallet: owner, page: 1, perPage: 1000 }] },
    { method: "qn_fetchNFTs", params: [{ owner, page: 1, perPage: 1000 }] },
    { method: "qn_fetchNFTsByOwner", params: [{ wallet: owner, page: 1, perPage: 1000 }] },
    { method: "qn_fetchNFTsByOwner", params: [{ owner, page: 1, perPage: 1000 }] },
  ];

  let sawNonMethodError: Error | null = null;
  for (const attempt of methodAttempts) {
    try {
      const out = await rpcJson<any>(rpcEndpoint, attempt.method, attempt.params);
      return extractQuickNodeNfts(out);
    } catch (e: any) {
      const msg = String(e?.message ?? e ?? "");
      if (/method not found/i.test(msg) || /does not exist/i.test(msg) || /-32601/.test(msg)) {
        continue;
      }
      // Could be a supported method but failing due to addon disabled/auth/rate limit.
      sawNonMethodError = new Error(msg || "QuickNode NFT query failed");
      break;
    }
  }
  if (sawNonMethodError) throw sawNonMethodError;
  return null;
}

function decodeMetaplexNameSymbolUri(data: Uint8Array): { name: string; symbol: string; uri: string } | null {
  // Metaplex Token Metadata account layout (Borsh):
  // key: u8 (1)
  // updateAuthority: [u8;32]
  // mint: [u8;32]
  // data: { name: string, symbol: string, uri: string, ... }
  //
  // IMPORTANT: these are Borsh strings (u32 length + bytes), not fixed-size arrays.
  const buf = data;
  const decoder = new TextDecoder("utf-8");

  const start = 1 + 32 + 32;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const readStr = (offset: number): { value: string; next: number } | null => {
    if (offset + 4 > buf.length) return null;
    const len = view.getUint32(offset, true);
    const next = offset + 4;
    if (len > 10_000) return null; // sanity guard
    if (next + len > buf.length) return null;
    const value = decoder.decode(buf.slice(next, next + len)).replace(/\0/g, "").trim();
    return { value, next: next + len };
  };

  // Primary: proper Borsh decode
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

  // Fallback: legacy fixed-size slicing (some uncommon encoders/padded layouts).
  const NAME_OFFSET = start;
  const SYMBOL_OFFSET = NAME_OFFSET + 32;
  const URI_OFFSET = SYMBOL_OFFSET + 10;
  const END = URI_OFFSET + 200;
  if (buf.length < END) return null;
  const name = decoder.decode(buf.slice(NAME_OFFSET, NAME_OFFSET + 32)).replace(/\0/g, "").trim();
  const symbol = decoder.decode(buf.slice(SYMBOL_OFFSET, SYMBOL_OFFSET + 10)).replace(/\0/g, "").trim();
  const uri = decoder.decode(buf.slice(URI_OFFSET, URI_OFFSET + 200)).replace(/\0/g, "").trim();
  if (!uri) return null;
  return { name, symbol, uri };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const workers = new Array(Math.max(1, concurrency)).fill(0).map(async () => {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  });

  await Promise.all(workers);
  return results;
}

function pickImageFromMetadataJson(json: any): string | null {
  // Common fields: image, properties.files[].uri
  const direct = typeof json?.image === "string" ? json.image : null;
  const direct2 =
    (typeof json?.image_url === "string" ? json.image_url : null) ||
    (typeof json?.imageUrl === "string" ? json.imageUrl : null);
  const files = Array.isArray(json?.properties?.files) ? json.properties.files : [];

  const fileUriCandidates: string[] = files
    .map((f: any) => (typeof f?.uri === "string" ? f.uri : null))
    .filter(Boolean) as string[];

  const bestFromFiles =
    fileUriCandidates.find((u) => /\.(png|jpg|jpeg|webp)(\?|#|$)/i.test(u)) ??
    fileUriCandidates.find((u) => /image/i.test(u)) ??
    (fileUriCandidates.length > 0 ? fileUriCandidates[0] : null);

  return direct ?? direct2 ?? bestFromFiles;
}

function normalizeTraitKey(key: unknown): string {
  return String(key ?? "").trim().toLowerCase();
}

function extractAttributesFromMetadataJson(json: any): NftAttribute[] {
  // Metaplex-style JSON often uses `attributes`, but some collections nest it under `properties`.
  const direct = Array.isArray(json?.attributes) ? (json.attributes as NftAttribute[]) : null;
  if (direct) return direct;

  const propsAttrs = Array.isArray(json?.properties?.attributes) ? (json.properties.attributes as NftAttribute[]) : null;
  if (propsAttrs) return propsAttrs;

  const propsTraits = Array.isArray(json?.properties?.traits) ? (json.properties.traits as NftAttribute[]) : null;
  if (propsTraits) return propsTraits;

  const traits = Array.isArray(json?.traits) ? (json.traits as NftAttribute[]) : null;
  if (traits) return traits;

  return [];
}

function getTraitValue(attributes: NftAttribute[], keys: string[]): string | null {
  const wanted = new Set(keys.map((k) => k.toLowerCase()));
  for (const attr of attributes) {
    const traitType = normalizeTraitKey((attr as any)?.trait_type ?? (attr as any)?.traitType ?? (attr as any)?.type);
    if (!traitType) continue;
    if (!wanted.has(traitType)) continue;
    const v = (attr as any)?.value ?? (attr as any)?.val ?? (attr as any)?.text;
    const str = String(v ?? "").trim();
    if (str) return str;
  }
  return null;
}

function parseUsdLikeNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const str = String(value ?? "").trim();
  if (!str) return null;

  // Accept formats like:
  // - "250"
  // - "250.50"
  // - "$250"
  // - "1,250"
  // - "250 USD"
  const match = str.match(/-?\d[\d,]*(?:\.\d+)?/);
  if (!match?.[0]) return null;
  const normalized = match[0].replace(/,/g, "");
  const num = Number.parseFloat(normalized);
  return Number.isFinite(num) ? num : null;
}

function inferSetFromName(nameOrDescription: string): string | null {
  const n = String(nameOrDescription || "").trim();
  if (!n) return null;

  // Normalize separators and collapse whitespace.
  const cleaned = n
    .replace(/\0/g, "")
    .replace(/\s*\|\s*/g, " | ")
    .replace(/\s+/g, " ")
    .trim();

  // Extract the phrase next to "Pokemon", then remove the word "Pokemon" itself.
  // Examples:
  // - "2000 ... POKEMON ROCKET | 1ST EDITION" -> "ROCKET"
  // - "1999 ... Jungle Pokemon" -> "Jungle"
  // - "2021 ... Celebrations Pokemon" -> "Celebrations"
  //
  // Allow 1-4 words for the set phrase.
  const afterPokemon = cleaned.match(/\bPOKEMON\s+([A-Z0-9][A-Z0-9_-]*(?:\s+[A-Z0-9][A-Z0-9_-]*){0,3})\b/i);
  if (afterPokemon?.[1]) return String(afterPokemon[1]).trim();

  const beforePokemon = cleaned.match(/\b([A-Z0-9][A-Z0-9_-]*(?:\s+[A-Z0-9][A-Z0-9_-]*){0,3})\s+POKEMON\b/i);
  if (beforePokemon?.[1]) return String(beforePokemon[1]).trim();

  return null;
}

function inferGradeFromName(nameOrDescription: string): string | null {
  const n = String(nameOrDescription || "").trim();
  if (!n) return null;
  // Look for "PSA 10" or "PSA10"
  const m = n.match(/\\bPSA\\s*([0-9]{1,2}(?:\\.[0-9])?)\\b/i);
  if (m?.[1]) return `PSA ${m[1]}`.trim();
  return null;
}

function formatGrade(value: string | null | undefined): string {
  if (!value) return "N/A";
  const v = String(value).trim();
  if (!v || /^n\/?a$/i.test(v)) return "N/A";
  // UI requirement: show only the numeric grade (e.g. "9", "10", "9.5")
  const m = v.match(/([0-9]{1,2}(?:\.[0-9])?)/);
  return m?.[1] ? m[1] : "N/A";
}

function formatSet(value: string | null | undefined): string {
  if (!value) return "N/A";
  const v = String(value).trim();
  if (!v || /^n\/?a$/i.test(v)) return "N/A";

  // Remove the literal word "Pokemon" if it appears in the extracted string.
  const withoutPokemon = v.replace(/\bpokemon\b/gi, "").replace(/\s+/g, " ").trim();
  return withoutPokemon || "N/A";
}

export async function getPokemonCards(
  connection: Connection,
  opts?: { forceRefresh?: boolean; allowlist?: string[] }
): Promise<PokemonCardNft[]> {
  const res = await getPokemonCardsResult(connection, opts);
  return res.items;
}

export async function getPokemonCardsResult(
  connection: Connection,
  opts?: { forceRefresh?: boolean; allowlist?: string[] }
): Promise<PokemonCardsResult> {
  const owner = POKEMON_CARDS_OWNER.toBase58();
  const allowlist = (opts?.allowlist ?? POKEMON_CARD_MINT_ALLOWLIST ?? []).map((s) => String(s || "").trim()).filter(Boolean);
  const allowlistKey = allowlist.length ? `allowlist:${allowlist.join(",")}` : owner;
  const key = cacheKey(allowlistKey);
  const now = Date.now();

  // Memory cache
  const mem = MEMORY_CACHE.get(key);
  if (!opts?.forceRefresh && mem && now - mem.fetchedAt < CACHE_TTL_MS) {
    return mem;
  }

  // LocalStorage cache
  if (!opts?.forceRefresh && typeof window !== "undefined") {
    const cached = safeParseJson<CachePayloadV1>(window.localStorage.getItem(key));
    if (
      cached &&
      cached.version === CACHE_SCHEMA_VERSION &&
      cached.owner === allowlistKey &&
      typeof cached.fetchedAt === "number" &&
      Array.isArray(cached.items) &&
      now - cached.fetchedAt < CACHE_TTL_MS
    ) {
      const debug: PokemonCardsDebug = cached.debug ?? {
        owner,
        rpcEndpoint: connection.rpcEndpoint,
        tokenProgramAccounts: 0,
        token2022ProgramAccounts: 0,
        totalTokenAccounts: 0,
        nftLikeTokenAccounts: 0,
        uniqueMints: cached.items.length,
        metaplexMetadataFound: cached.items.length,
        dasAttempted: false,
        dasSupported: false,
        dasAssetsFound: 0,
        quicknodeAttempted: false,
        quicknodeSupported: false,
        quicknodeAssetsFound: 0,
        offchainFetchOk: 0,
        offchainFetchFailed: 0,
        resolvedWithImage: cached.items.filter((i) => Boolean(i.image)).length,
        resolvedWithoutImage: cached.items.filter((i) => !i.image).length,
      };
      const payload: PokemonCardsResult = { fetchedAt: cached.fetchedAt, items: cached.items, debug };
      MEMORY_CACHE.set(key, payload);
      return payload;
    }
  }

  // If an explicit allowlist is present, skip wallet enumeration entirely.
  if (allowlist.length > 0) {
    const validMints: string[] = [];
    for (const mint of allowlist) {
      try {
        validMints.push(new PublicKey(mint).toBase58());
      } catch {
        // ignore invalid mint strings
      }
    }

    if (validMints.length === 0) {
      const empty: PokemonCardsResult = {
        fetchedAt: now,
        items: [],
        debug: {
          owner,
          rpcEndpoint: connection.rpcEndpoint,
          tokenProgramAccounts: 0,
          token2022ProgramAccounts: 0,
          totalTokenAccounts: 0,
          nftLikeTokenAccounts: 0,
          uniqueMints: 0,
          metaplexMetadataFound: 0,
          dasAttempted: false,
          dasSupported: false,
          dasAssetsFound: 0,
          quicknodeAttempted: false,
          quicknodeSupported: false,
          quicknodeAssetsFound: 0,
          offchainFetchOk: 0,
          offchainFetchFailed: 0,
          resolvedWithImage: 0,
          resolvedWithoutImage: 0,
        },
      };
      MEMORY_CACHE.set(key, empty);
      return empty;
    }

    const mintPubkeys = validMints.map((m) => new PublicKey(m));
    const metadataPdas = mintPubkeys.map((mint) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
        METADATA_PROGRAM_ID
      )[0]
    );

    const pdaChunks = chunk(metadataPdas, 100);
    const infos: Array<{ mint: string; name: string; symbol: string; uri: string } | null> = [];

    for (let i = 0; i < pdaChunks.length; i++) {
      const start = i * 100;
      const accounts = await connection.getMultipleAccountsInfo(pdaChunks[i], { commitment: "confirmed" });
      for (let j = 0; j < accounts.length; j++) {
        const mint = mintPubkeys[start + j]?.toBase58();
        const ai = accounts[j];
        if (!mint || !ai?.data) {
          infos.push(null);
          continue;
        }
        const decoded = decodeMetaplexNameSymbolUri(ai.data);
        if (!decoded) {
          infos.push(null);
          continue;
        }
        infos.push({ mint, name: decoded.name, symbol: decoded.symbol, uri: decoded.uri });
      }
    }

    const onchain = infos.filter(Boolean) as Array<{ mint: string; name: string; symbol: string; uri: string }>;
    if (onchain.length === 0) {
      const empty: PokemonCardsResult = {
        fetchedAt: now,
        items: [],
        debug: {
          owner,
          rpcEndpoint: connection.rpcEndpoint,
          tokenProgramAccounts: 0,
          token2022ProgramAccounts: 0,
          totalTokenAccounts: 0,
          nftLikeTokenAccounts: 0,
          uniqueMints: validMints.length,
          metaplexMetadataFound: 0,
          dasAttempted: false,
          dasSupported: false,
          dasAssetsFound: 0,
          quicknodeAttempted: false,
          quicknodeSupported: false,
          quicknodeAssetsFound: 0,
          offchainFetchOk: 0,
          offchainFetchFailed: 0,
          resolvedWithImage: 0,
          resolvedWithoutImage: 0,
        },
      };
      MEMORY_CACHE.set(key, empty);
      return empty;
    }

    let offchainOk = 0;
    let offchainFail = 0;
    const items = await mapWithConcurrency(onchain, 4, async (meta) => {
      const uriResolved = resolveUri(meta.uri);
      const json: any = await fetchMetadataJson(uriResolved);
      if (json) offchainOk++;
      else offchainFail++;

      const name = (typeof json?.name === "string" && json.name.trim()) || meta.name || meta.mint.slice(0, 8);
      const description = typeof json?.description === "string" ? json.description : undefined;
      const attributes: NftAttribute[] = extractAttributesFromMetadataJson(json);
      const image = resolveUri(pickImageFromMetadataJson(json) ?? "");

      // Prefer description when present: this collection sometimes omits `name` or truncates it, but has the full set/grade context in `description`.
      const inferText = (description?.trim() || name.trim()).trim();
      // Prefer an explicit Set trait if present, otherwise infer from name/description (strip "Pokemon").
      const set =
        getTraitValue(attributes, ["the set", "set", "set name", "collection", "series", "expansion", "expansion set"]) ??
        inferSetFromName(inferText) ??
        "N/A";
      const grade =
        getTraitValue(attributes, ["the grade", "grade", "psa grade", "bgs grade", "cgc grade", "grading", "psa"]) ??
        inferGradeFromName(inferText) ??
        "N/A";
      const insuredValueUsd = parseUsdLikeNumber(
        getTraitValue(attributes, ["insured value", "insured_value", "insuredvalue", "insured value usd", "insuredvalueusd"])
      );
      const externalUrl =
        (typeof json?.external_url === "string" ? json.external_url : undefined) ||
        (typeof json?.externalUrl === "string" ? json.externalUrl : undefined);

      return {
        mint: meta.mint,
        name,
        symbol: meta.symbol,
        uri: uriResolved,
        image,
        description,
        externalUrl,
        attributes,
        set: formatSet(set),
        grade: formatGrade(grade),
        insuredValueUsd,
      } satisfies PokemonCardNft;
    });

    const allowIndex = new Map(validMints.map((m, i) => [m, i]));
    const sorted = items.sort((a, b) => {
      const ai = allowIndex.get(a.mint);
      const bi = allowIndex.get(b.mint);
      if (ai !== undefined && bi !== undefined && ai !== bi) return ai - bi;
      return (a.name || "").localeCompare(b.name || "") || a.mint.localeCompare(b.mint);
    });

    const withImage = sorted.filter((i) => Boolean(i.image)).length;
    const withoutImage = sorted.length - withImage;

    const debug: PokemonCardsDebug = {
      owner,
      rpcEndpoint: connection.rpcEndpoint,
      tokenProgramAccounts: 0,
      token2022ProgramAccounts: 0,
      totalTokenAccounts: 0,
      nftLikeTokenAccounts: 0,
      uniqueMints: validMints.length,
      metaplexMetadataFound: onchain.length,
      dasAttempted: false,
      dasSupported: false,
      dasAssetsFound: 0,
      quicknodeAttempted: false,
      quicknodeSupported: false,
      quicknodeAssetsFound: 0,
      offchainFetchOk: offchainOk,
      offchainFetchFailed: offchainFail,
      resolvedWithImage: withImage,
      resolvedWithoutImage: withoutImage,
    };

    const result: PokemonCardsResult = { fetchedAt: now, items: sorted, debug };
    MEMORY_CACHE.set(key, result);
    if (typeof window !== "undefined") {
      try {
        const payload: CachePayloadV1 = {
          version: CACHE_SCHEMA_VERSION,
          owner: allowlistKey,
          fetchedAt: now,
          items: sorted,
          debug,
        };
        window.localStorage.setItem(key, JSON.stringify(payload));
      } catch {
        // ignore
      }
    }
    return result;
  }

  // 1) Get token accounts owned by the collection wallet (Token + Token-2022).
  let tokenAccounts;
  let token2022Accounts;
  try {
    [tokenAccounts, token2022Accounts] = await Promise.all([
      connection.getParsedTokenAccountsByOwner(POKEMON_CARDS_OWNER, { programId: TOKEN_PROGRAM_ID }),
      connection.getParsedTokenAccountsByOwner(POKEMON_CARDS_OWNER, { programId: TOKEN_2022_PROGRAM_ID }),
    ]);
  } catch (e: any) {
    const msg = typeof e?.message === "string" ? e.message : String(e ?? "Unknown RPC error");
    throw new Error(`Failed to query token accounts for ${owner}: ${msg}`);
  }

  const allAccounts = [...tokenAccounts.value, ...token2022Accounts.value];
  const mintSet = new Set<string>();
  let nftLikeCount = 0;

  for (const acc of allAccounts) {
    const info = (acc.account.data as any)?.parsed?.info;
    if (!info) continue;
    const mint = String(info?.mint ?? "");
    const ta = info?.tokenAmount;
    const amount = Number(ta?.uiAmount ?? 0);
    const decimals = Number(ta?.decimals ?? 0);

    // Likely NFTs: decimals=0, amount>=1 (some may be >1 for editions; still fine)
    if (!mint || decimals !== 0 || !Number.isFinite(amount) || amount <= 0) continue;
    nftLikeCount++;
    mintSet.add(mint);
  }

  const mints = Array.from(mintSet);
  // If the wallet doesn't have any obvious NFT-like SPL token accounts, attempt DAS (for cNFTs).
  let dasAttempted = false;
  let dasSupported = false;
  let dasAssetsFound = 0;
  let dasAssets: DasAsset[] | null = null;
  let quicknodeAttempted = false;
  let quicknodeSupported = false;
  let quicknodeAssetsFound = 0;
  let quicknodeAssets: QuickNodeNft[] | null = null;
  if (mints.length === 0) {
    dasAttempted = true;
    dasAssets = await tryGetAssetsByOwnerDas(connection.rpcEndpoint, owner);
    if (dasAssets !== null) {
      dasSupported = true;
      dasAssetsFound = dasAssets.length;
    }

    // If DAS isn't supported, try QuickNode enhanced NFT API (commonly used by explorers/indexers).
    if (!dasSupported) {
      quicknodeAttempted = true;
      quicknodeAssets = await tryGetQuickNodeNftsByOwner(connection.rpcEndpoint, owner);
      if (quicknodeAssets !== null) {
        quicknodeSupported = true;
        quicknodeAssetsFound = quicknodeAssets.length;
      }
    }
  }

  if (
    mints.length === 0 &&
    (!dasAssets || dasAssets.length === 0) &&
    (!quicknodeAssets || quicknodeAssets.length === 0)
  ) {
    const empty: PokemonCardsResult = {
      fetchedAt: now,
      items: [],
      debug: {
        owner,
        rpcEndpoint: connection.rpcEndpoint,
        tokenProgramAccounts: tokenAccounts.value.length,
        token2022ProgramAccounts: token2022Accounts.value.length,
        totalTokenAccounts: allAccounts.length,
        nftLikeTokenAccounts: nftLikeCount,
        uniqueMints: 0,
        metaplexMetadataFound: 0,
        dasAttempted,
        dasSupported,
        dasAssetsFound,
        quicknodeAttempted,
        quicknodeSupported,
        quicknodeAssetsFound,
        offchainFetchOk: 0,
        offchainFetchFailed: 0,
        resolvedWithImage: 0,
        resolvedWithoutImage: 0,
      },
    };
    MEMORY_CACHE.set(key, empty);
    return empty;
  }

  // If we got DAS assets, map them into the same structure as our Metaplex path.
  if (mints.length === 0 && dasAssets && dasAssets.length > 0) {
    let offchainOk = 0;
    let offchainFail = 0;

    const items = await mapWithConcurrency(dasAssets, 4, async (asset) => {
      const jsonUri = typeof asset.content?.json_uri === "string" ? resolveUri(asset.content.json_uri) : "";
      const fallbackName =
        (typeof asset.content?.metadata?.name === "string" && asset.content.metadata.name.trim()) || asset.id.slice(0, 8);

      const json: any = jsonUri ? await fetchMetadataJson(jsonUri) : null;
      if (jsonUri) {
        if (json) offchainOk++;
        else offchainFail++;
      }

      const name = (typeof json?.name === "string" && json.name.trim()) || fallbackName;
      const description = typeof json?.description === "string" ? json.description : undefined;
      const attributes: NftAttribute[] = extractAttributesFromMetadataJson(json);
      const image = resolveUri(pickImageFromMetadataJson(json) ?? "");

      const inferText = (description?.trim() || name.trim()).trim();
      const set =
        getTraitValue(attributes, ["the set", "set", "set name", "collection", "series", "expansion", "expansion set"]) ??
        inferSetFromName(inferText) ??
        "N/A";
      const grade =
        getTraitValue(attributes, ["the grade", "grade", "psa grade", "bgs grade", "cgc grade", "grading", "psa"]) ??
        inferGradeFromName(inferText) ??
        "N/A";
      const insuredValueUsd = parseUsdLikeNumber(
        getTraitValue(attributes, ["insured value", "insured_value", "insuredvalue", "insured value usd", "insuredvalueusd"])
      );
      const externalUrl =
        (typeof json?.external_url === "string" ? json.external_url : undefined) ||
        (typeof json?.externalUrl === "string" ? json.externalUrl : undefined);

      return {
        mint: asset.id,
        name,
        symbol: asset.content?.metadata?.symbol,
        uri: jsonUri || undefined,
        image,
        description,
        externalUrl,
        attributes,
        set: formatSet(set),
        grade: formatGrade(grade),
        insuredValueUsd,
      } satisfies PokemonCardNft;
    });

    const sorted = items.sort((a, b) => (a.name || "").localeCompare(b.name || "") || a.mint.localeCompare(b.mint));
    const withImage = sorted.filter((i) => Boolean(i.image)).length;
    const withoutImage = sorted.length - withImage;

    const debug: PokemonCardsDebug = {
      owner,
      rpcEndpoint: connection.rpcEndpoint,
      tokenProgramAccounts: tokenAccounts.value.length,
      token2022ProgramAccounts: token2022Accounts.value.length,
      totalTokenAccounts: allAccounts.length,
      nftLikeTokenAccounts: nftLikeCount,
      uniqueMints: 0,
      metaplexMetadataFound: 0,
      dasAttempted: true,
      dasSupported: true,
      dasAssetsFound: dasAssetsFound,
      quicknodeAttempted,
      quicknodeSupported,
      quicknodeAssetsFound,
      offchainFetchOk: offchainOk,
      offchainFetchFailed: offchainFail,
      resolvedWithImage: withImage,
      resolvedWithoutImage: withoutImage,
    };

    const result: PokemonCardsResult = { fetchedAt: now, items: sorted, debug };
    MEMORY_CACHE.set(key, result);
    if (typeof window !== "undefined") {
      try {
        const payload: CachePayloadV1 = {
          version: CACHE_SCHEMA_VERSION,
          owner: allowlistKey,
          fetchedAt: now,
          items: sorted,
          debug,
        };
        window.localStorage.setItem(key, JSON.stringify(payload));
      } catch {
        // ignore
      }
    }
    return result;
  }

  // If we got QuickNode NFT assets, map them too.
  if (mints.length === 0 && !dasSupported && quicknodeAssets && quicknodeAssets.length > 0) {
    let offchainOk = 0;
    let offchainFail = 0;

    const items = await mapWithConcurrency(quicknodeAssets, 4, async (asset) => {
      const mint =
        (typeof asset.mint === "string" && asset.mint) ||
        (typeof asset.address === "string" && asset.address) ||
        (typeof asset.tokenAddress === "string" && asset.tokenAddress) ||
        "";
      const name = (typeof asset.name === "string" && asset.name.trim()) || (mint ? mint.slice(0, 8) : "Unknown");
      const symbol = typeof asset.symbol === "string" ? asset.symbol : undefined;
      const image =
        resolveUri(
          (typeof asset.image === "string" ? asset.image : "") || (typeof asset.imageUrl === "string" ? asset.imageUrl : "")
        ) || "";
      const uriResolved = resolveUri((typeof asset.metadataUri === "string" ? asset.metadataUri : "") || (typeof asset.uri === "string" ? asset.uri : ""));

      const json: any = uriResolved ? await fetchMetadataJson(uriResolved) : null;
      if (uriResolved) {
        if (json) offchainOk++;
        else offchainFail++;
      }

      const attributes: NftAttribute[] =
        Array.isArray(asset.attributes) ? (asset.attributes as NftAttribute[]) : Array.isArray(json?.attributes) ? (json.attributes as NftAttribute[]) : [];
      const jsonImage = resolveUri(pickImageFromMetadataJson(json) ?? "");
      const finalImage = image || jsonImage;

      const set =
        getTraitValue(attributes, ["the set", "set", "set name", "collection", "series", "expansion", "expansion set"]) ??
        inferSetFromName(
          (typeof json?.description === "string" && json.description.trim()) ||
            (typeof json?.name === "string" && json.name.trim()) ||
            name
        ) ??
        "N/A";
      const grade =
        getTraitValue(attributes, ["the grade", "grade", "psa grade", "bgs grade", "cgc grade", "grading", "psa"]) ??
        inferGradeFromName(name) ??
        "N/A";
      const insuredValueUsd = parseUsdLikeNumber(
        getTraitValue(attributes, ["insured value", "insured_value", "insuredvalue", "insured value usd", "insuredvalueusd"])
      );

      const description = typeof json?.description === "string" ? json.description : undefined;
      const externalUrl =
        (typeof json?.external_url === "string" ? json.external_url : undefined) ||
        (typeof json?.externalUrl === "string" ? json.externalUrl : undefined);

      return {
        mint: mint || name,
        name: (typeof json?.name === "string" && json.name.trim()) || name,
        symbol,
        uri: uriResolved || undefined,
        image: finalImage,
        description,
        externalUrl,
        attributes,
        set: formatSet(set),
        grade: formatGrade(grade),
        insuredValueUsd,
      } satisfies PokemonCardNft;
    });

    const sorted = items.sort((a, b) => (a.name || "").localeCompare(b.name || "") || a.mint.localeCompare(b.mint));
    const withImage = sorted.filter((i) => Boolean(i.image)).length;
    const withoutImage = sorted.length - withImage;

    const debug: PokemonCardsDebug = {
      owner,
      rpcEndpoint: connection.rpcEndpoint,
      tokenProgramAccounts: tokenAccounts.value.length,
      token2022ProgramAccounts: token2022Accounts.value.length,
      totalTokenAccounts: allAccounts.length,
      nftLikeTokenAccounts: nftLikeCount,
      uniqueMints: 0,
      metaplexMetadataFound: 0,
      dasAttempted,
      dasSupported,
      dasAssetsFound,
      quicknodeAttempted: true,
      quicknodeSupported: true,
      quicknodeAssetsFound: quicknodeAssetsFound,
      offchainFetchOk: offchainOk,
      offchainFetchFailed: offchainFail,
      resolvedWithImage: withImage,
      resolvedWithoutImage: withoutImage,
    };

    const result: PokemonCardsResult = { fetchedAt: now, items: sorted, debug };
    MEMORY_CACHE.set(key, result);
    if (typeof window !== "undefined") {
      try {
        const payload: CachePayloadV1 = {
          version: CACHE_SCHEMA_VERSION,
          owner: allowlistKey,
          fetchedAt: now,
          items: sorted,
          debug,
        };
        window.localStorage.setItem(key, JSON.stringify(payload));
      } catch {
        // ignore
      }
    }
    return result;
  }

  // 2) Fetch Metaplex metadata accounts in batches.
  const mintPubkeys = mints.map((m) => new PublicKey(m));
  const metadataPdas = mintPubkeys.map((mint) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      METADATA_PROGRAM_ID
    )[0]
  );

  const pdaChunks = chunk(metadataPdas, 100);
  const infos: Array<{ mint: string; name: string; symbol: string; uri: string } | null> = [];

  for (let i = 0; i < pdaChunks.length; i++) {
    const start = i * 100;
    const accounts = await connection.getMultipleAccountsInfo(pdaChunks[i], { commitment: "confirmed" });
    for (let j = 0; j < accounts.length; j++) {
      const mint = mintPubkeys[start + j]?.toBase58();
      const ai = accounts[j];
      if (!mint || !ai?.data) {
        infos.push(null);
        continue;
      }
      const decoded = decodeMetaplexNameSymbolUri(ai.data);
      if (!decoded) {
        infos.push(null);
        continue;
      }
      infos.push({ mint, name: decoded.name, symbol: decoded.symbol, uri: decoded.uri });
    }
  }

  const onchain = infos.filter(Boolean) as Array<{ mint: string; name: string; symbol: string; uri: string }>;
  if (onchain.length === 0) {
    const empty: PokemonCardsResult = {
      fetchedAt: now,
      items: [],
      debug: {
        owner,
        rpcEndpoint: connection.rpcEndpoint,
        tokenProgramAccounts: tokenAccounts.value.length,
        token2022ProgramAccounts: token2022Accounts.value.length,
        totalTokenAccounts: allAccounts.length,
        nftLikeTokenAccounts: nftLikeCount,
        uniqueMints: mints.length,
        metaplexMetadataFound: 0,
        dasAttempted,
        dasSupported,
        dasAssetsFound,
        quicknodeAttempted,
        quicknodeSupported,
        quicknodeAssetsFound,
        offchainFetchOk: 0,
        offchainFetchFailed: 0,
        resolvedWithImage: 0,
        resolvedWithoutImage: 0,
      },
    };
    MEMORY_CACHE.set(key, empty);
    return empty;
  }

  // 3) Fetch off-chain JSON metadata (uri) with limited concurrency.
  let offchainOk = 0;
  let offchainFail = 0;
  const items = await mapWithConcurrency(onchain, 4, async (meta) => {
    const uriResolved = resolveUri(meta.uri);
    const json: any = await fetchMetadataJson(uriResolved);
    if (json) offchainOk++;
    else offchainFail++;

    const name = (typeof json?.name === "string" && json.name.trim()) || meta.name || meta.mint.slice(0, 8);
    const description = typeof json?.description === "string" ? json.description : undefined;
    const attributes: NftAttribute[] = extractAttributesFromMetadataJson(json);
    const image = resolveUri(pickImageFromMetadataJson(json) ?? "");

    const inferText = (description?.trim() || name.trim()).trim();
    // Traits can vary; be flexible.
    const set =
      getTraitValue(attributes, ["the set", "set", "set name", "collection", "series", "expansion", "expansion set"]) ??
      inferSetFromName(inferText) ??
      "N/A";
    const grade =
      getTraitValue(attributes, ["the grade", "grade", "psa grade", "bgs grade", "cgc grade", "grading", "psa"]) ??
      inferGradeFromName(inferText) ??
      "N/A";
    const insuredValueUsd = parseUsdLikeNumber(
      getTraitValue(attributes, ["insured value", "insured_value", "insuredvalue", "insured value usd", "insuredvalueusd"])
    );
    const externalUrl =
      (typeof json?.external_url === "string" ? json.external_url : undefined) ||
      (typeof json?.externalUrl === "string" ? json.externalUrl : undefined);

    return {
      mint: meta.mint,
      name,
      symbol: meta.symbol,
      uri: uriResolved,
      image,
      description,
      externalUrl,
      attributes,
      set: formatSet(set),
      grade: formatGrade(grade),
      insuredValueUsd,
    } satisfies PokemonCardNft;
  });

  // Keep stable order by name then mint for a clean rail.
  const sorted = items.sort((a, b) => (a.name || "").localeCompare(b.name || "") || a.mint.localeCompare(b.mint));
  const withImage = sorted.filter((i) => Boolean(i.image)).length;
  const withoutImage = sorted.length - withImage;

  const debug: PokemonCardsDebug = {
    owner,
    rpcEndpoint: connection.rpcEndpoint,
    tokenProgramAccounts: tokenAccounts.value.length,
    token2022ProgramAccounts: token2022Accounts.value.length,
    totalTokenAccounts: allAccounts.length,
    nftLikeTokenAccounts: nftLikeCount,
    uniqueMints: mints.length,
    metaplexMetadataFound: onchain.length,
    dasAttempted,
    dasSupported,
    dasAssetsFound,
    quicknodeAttempted,
    quicknodeSupported,
    quicknodeAssetsFound,
    offchainFetchOk: offchainOk,
    offchainFetchFailed: offchainFail,
    resolvedWithImage: withImage,
    resolvedWithoutImage: withoutImage,
  };

  // Persist caches
  const result: PokemonCardsResult = { fetchedAt: now, items: sorted, debug };
  MEMORY_CACHE.set(key, result);
  if (typeof window !== "undefined") {
    try {
      const payload: CachePayloadV1 = {
        version: CACHE_SCHEMA_VERSION,
        owner: allowlistKey,
        fetchedAt: now,
        items: sorted,
        debug,
      };
      window.localStorage.setItem(key, JSON.stringify(payload));
    } catch {
      // ignore quota / privacy mode
    }
  }

  return result;
}

