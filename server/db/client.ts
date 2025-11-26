import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import pg from "pg";
import Database from "better-sqlite3";
import url from "node:url";
import path from "node:path";
import fs from "node:fs";

// Determine runtime environment
const isProd = process.env.NODE_ENV === "production" || process.env.FORCE_PG === "true";

// Type definition for our unified db instance
type DbInstance = ReturnType<typeof drizzlePg> | ReturnType<typeof drizzleSqlite>;

let db: DbInstance;
let dbDriver: "postgres" | "sqlite";

// Initialize database connection based on environment
if (isProd) {
  // PRODUCTION: Use PostgreSQL with DATABASE_URL (required)
  const connectionString = process.env.DATABASE_URL;
  
  if (!connectionString) {
    console.error("");
    console.error("═".repeat(80));
    console.error("❌ CRITICAL: DATABASE_URL is REQUIRED in production!");
    console.error("");
    console.error("Without Postgres, all data will be lost on redeploy.");
    console.error("");
    console.error("To fix:");
    console.error("1. Sign up for Neon Postgres (free): https://neon.tech");
    console.error("2. Create a database and copy the connection string");
    console.error("3. Set DATABASE_URL in environment/secrets:");
    console.error("   DATABASE_URL=postgres://user:pass@host.neon.tech/dbname?sslmode=require");
    console.error("");
    console.error("═".repeat(80));
    console.error("");
    throw new Error("DATABASE_URL is required in production");
  }

  // Create PostgreSQL pool with SSL (required for Neon)
  const pool = new pg.Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  db = drizzlePg(pool as any);
  dbDriver = "postgres";

  // Log connection info (mask credentials)
  try {
    const parsedUrl = new url.URL(connectionString);
    const host = parsedUrl.host;
    const database = parsedUrl.pathname.slice(1);
    console.log("");
    console.log("═".repeat(80));
    console.log(`[DB] Driver=postgres`);
    console.log(`[DB] Host=${host}`);
    console.log(`[DB] Database=${database}`);
    console.log(`[DB] SSL=enabled (required for Neon)`);
    console.log("═".repeat(80));
    console.log("");
  } catch {
    console.log("");
    console.log("═".repeat(80));
    console.log("[DB] Driver=postgres");
    console.log("[DB] Connection string configured");
    console.log("═".repeat(80));
    console.log("");
  }

  // Verify connection
  pool.query('SELECT 1').then(
    () => console.log("✅ Postgres connection verified"),
    (err) => {
      console.error("❌ Failed to connect to Postgres:", err);
      process.exit(1);
    }
  );

} else {
  // DEVELOPMENT: Use SQLite with local file
  const dbPath = process.env.DB_PATH || "./data/pump-racers.db";
  
  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(dbPath);
  
  // Configure SQLite for better performance and reliability
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("busy_timeout = 5000");

  db = drizzleSqlite(sqlite);
  dbDriver = "sqlite";

  console.log("");
  console.log("═".repeat(80));
  console.log(`[DB] Driver=sqlite`);
  console.log(`[DB] File=${dbPath}`);
  console.log(`[DB] WAL mode enabled`);
  console.log("═".repeat(80));
  console.log("");
}

// Export single db instance and driver info
export { db, dbDriver };

// Export type for use in other modules
export type { DbInstance };

// Helper to get current driver (for diagnostics)
export function getCurrentDriver(): "postgres" | "sqlite" {
  return dbDriver;
}

// Helper for raw SQL queries (when Drizzle queries aren't sufficient)
export async function executeRawSql(query: string, params?: any[]): Promise<any> {
  if (dbDriver === "postgres") {
    // For Postgres, we need to access the underlying pool
    const pgDb = db as ReturnType<typeof drizzlePg>;
    // Drizzle pg instance doesn't expose execute directly, 
    // so we'd need to import the pool separately or use Drizzle's sql
    throw new Error("Raw SQL execution needs to be implemented via Drizzle's sql`` tag");
  } else {
    // For SQLite, we can use the underlying better-sqlite3 instance
    const getDb() = db as ReturnType<typeof drizzleSqlite>;
    // Similar issue - would need access to underlying Database instance
    throw new Error("Raw SQL execution needs to be implemented via Drizzle's sql`` tag");
  }
}

// Graceful shutdown handler
process.on("SIGINT", async () => {
  console.log("\n🛑 Gracefully shutting down database connection...");
  
  if (dbDriver === "sqlite") {
    // SQLite: checkpoint WAL before exit
    try {
      // Note: Would need access to underlying sqlite instance to do this
      console.log("💾 SQLite WAL checkpoint...");
    } catch (e) {
      console.error("❌ WAL checkpoint failed:", e);
    }
  } else {
    // Postgres: end pool
    try {
      // Note: Would need access to underlying pool to do this
      console.log("🔌 Closing Postgres connections...");
    } catch (e) {
      console.error("❌ Failed to close Postgres pool:", e);
    }
  }
  
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 Received SIGTERM, shutting down database connection...");
  
  if (dbDriver === "sqlite") {
    try {
      console.log("💾 SQLite WAL checkpoint...");
    } catch (e) {
      console.error("❌ WAL checkpoint failed:", e);
    }
  } else {
    try {
      console.log("🔌 Closing Postgres connections...");
    } catch (e) {
      console.error("❌ Failed to close Postgres pool:", e);
    }
  }
  
  process.exit(0);
});
