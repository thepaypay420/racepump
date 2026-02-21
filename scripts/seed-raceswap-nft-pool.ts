import { Pool } from "pg";

type Args = {
  mints?: string[];
  allowlistFromEnv?: boolean;
  verifyEscrow?: boolean;
};

function parseArgs(argv: string[]): Args {
  // Safety default:
  // - seed from allowlist (env or explicit) only
  // - verify escrow holds them
  const out: Args = { allowlistFromEnv: true, verifyEscrow: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mints") {
      const v = String(argv[i + 1] || "");
      i++;
      out.mints = v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--allowlist-from-env") {
      out.allowlistFromEnv = true;
    } else if (a === "--no-allowlist-from-env") {
      out.allowlistFromEnv = false;
    } else if (a === "--no-verify") {
      out.verifyEscrow = false;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const url = String(process.env.DATABASE_URL || "").trim();
  if (!url) {
    console.error("❌ DATABASE_URL is required to seed raceswap_nft_pool");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } } as any);
  try {
    const { runSqlMigrations } = await import("./sql-migrations");
    await runSqlMigrations(pool);

    // Determine candidate mints
    const candidates = new Set<string>();

    if (args.mints?.length) {
      for (const m of args.mints) candidates.add(m);
    }

    const envAllowlist = String(process.env.POKEMON_CARD_MINT_ALLOWLIST || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (args.allowlistFromEnv) {
      for (const m of envAllowlist) candidates.add(m);
    }

    const candidateList = Array.from(candidates).map((s) => String(s || "").trim()).filter(Boolean);
    if (candidateList.length === 0) {
      console.log("❌ No allowlist provided.");
      console.log("- Set POKEMON_CARD_MINT_ALLOWLIST, or pass --mints \"mint1,mint2,...\"");
      console.log("- If you explicitly want to skip env allowlist: add --no-allowlist-from-env");
      process.exit(1);
    }

    let final = candidateList.slice();

    if (args.verifyEscrow) {
      try {
        const allowSet = new Set(candidateList);
        const { connection, serverKeypair } = await import("../server/solana");
        const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await import("@solana/spl-token");
        const owner = serverKeypair?.publicKey;
        if (!owner) throw new Error("serverKeypair not available (missing escrow keypair secret?)");

        const [p1, p2] = await Promise.all([
          connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }).catch(() => ({ value: [] as any[] })),
          connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }).catch(() => ({ value: [] as any[] })),
        ]);

        const held = new Set<string>();
        for (const acc of [...(p1.value || []), ...(p2.value || [])]) {
          const info = (acc.account.data as any)?.parsed?.info;
          const mint = info?.mint ? String(info.mint) : "";
          const tokenAmount = info?.tokenAmount;
          const decimals = Number(tokenAmount?.decimals ?? 0);
          const amountStr = tokenAmount?.amount ? String(tokenAmount.amount) : "0";
          if (!mint) continue;
          if (!allowSet.has(mint)) continue;
          if (decimals !== 0) continue;
          if (amountStr === "0") continue;
          held.add(mint);
        }

        const missing = candidateList.filter((m) => !held.has(m));
        if (missing.length) {
          console.log(`⚠️ ${missing.length} allowlisted mint(s) are not currently in escrow; they will NOT be seeded:`);
          console.log(missing.slice(0, 25).join("\n"));
          if (missing.length > 25) console.log(`... (+${missing.length - 25} more)`);
        }

        final = Array.from(held);
      } catch (e: any) {
        console.warn("⚠️ Escrow verification failed; refusing to seed without verification. Use --no-verify to override.");
        console.warn(String(e?.message || e));
        process.exit(1);
      }
    }

    final = Array.from(new Set(final)).sort();
    if (final.length === 0) {
      console.log("⚠️ No mints to insert (after verification).");
      return;
    }

    let inserted = 0;
    for (const mint of final) {
      try {
        await pool.query(
          `INSERT INTO raceswap_nft_pool (mint, enabled, sent) VALUES ($1, TRUE, FALSE) ON CONFLICT (mint) DO NOTHING`,
          [mint]
        );
        inserted++;
      } catch {
        // ignore individual failures
      }
    }

    const countRes = await pool.query(`SELECT COUNT(1) AS c FROM raceswap_nft_pool`);
    const availableRes = await pool.query(`SELECT COUNT(1) AS c FROM raceswap_nft_pool WHERE enabled = TRUE AND sent = FALSE`);

    console.log(`✅ Seed complete`);
    console.log(`- attempted inserts: ${final.length}`);
    console.log(`- inserted (best-effort): ${inserted}`);
    console.log(`- total rows: ${Number(countRes.rows?.[0]?.c || 0)}`);
    console.log(`- available (enabled & unsent): ${Number(availableRes.rows?.[0]?.c || 0)}`);
  } finally {
    try {
      await pool.end();
    } catch {}
  }
}

main().catch((e) => {
  console.error("❌ seed-raceswap-nft-pool failed:", e);
  process.exit(1);
});

