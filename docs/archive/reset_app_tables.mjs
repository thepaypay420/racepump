import pg from "pg";
const { Client } = pg;

const run = async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("❌ No DATABASE_URL set."); process.exit(1); }

  const c = new Client({ connectionString: url });
  await c.connect();

  // 1) Discover user tables
  const { rows: tables } = await c.query(`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE'
      AND table_schema NOT IN ('pg_catalog','information_schema')
    ORDER BY table_schema, table_name;
  `);

  console.log("📚 Existing tables:");
  tables.forEach(t => console.log(` - ${t.table_schema}.${t.table_name}`));

  // Expected names in either snake_case or CamelCase
  const want = new Set(["races","bets","settlement_transfers","Races","Bets","SettlementTransfers"]);

  // Present (filter to our expected names only)
  const present = tables.filter(t => want.has(t.table_name));
  if (present.length === 0) {
    console.log("ℹ️ None of the expected app tables found. Nothing to reset.");
    await c.end();
    return;
  }

  // Helpers
  const has = (name) => present.some(t => t.table_name.toLowerCase() === name.toLowerCase());
  const pick = (name) => present.find(t => t.table_name.toLowerCase() === name.toLowerCase());

  // Child tables first
  const order = [];
  if (has("bets")) order.push(pick("bets"));
  if (has("settlement_transfers")) order.push(pick("settlement_transfers"));
  if (has("races")) order.push(pick("races"));

  try {
    await c.query("BEGIN");
    for (const t of order) {
      const fq = `"${t.table_schema}"."${t.table_name}"`;
      console.log("🧹 Clearing:", fq);
      await c.query(`DELETE FROM ${fq};`);
    }
    await c.query("COMMIT");
    console.log("✅ Reset complete.");
  } catch (e) {
    await c.query("ROLLBACK");
    console.error("❌ Reset failed:", e);
    process.exit(1);
  }

  // Verify counts
  for (const t of order) {
    const fq = `"${t.table_schema}"."${t.table_name}"`;
    const { rows } = await c.query(`SELECT COUNT(*)::int AS n FROM ${fq};`);
    console.log(`   ${fq} -> ${rows[0].n}`);
  }

  await c.end();
};

run().catch(e => { console.error(e); process.exit(1); });
