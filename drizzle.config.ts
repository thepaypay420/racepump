import { defineConfig } from "drizzle-kit";

// Runtime dialect selection based on environment
const isProd = process.env.NODE_ENV === "production" || process.env.FORCE_PG === "true";
const databaseUrl = process.env.DATABASE_URL;

// Production: use PostgreSQL dialect with DATABASE_URL
// Development: use SQLite dialect with file path
export default defineConfig({
  schema: "./server/db/schema.ts",
  out: "./drizzle",
  dialect: isProd && databaseUrl ? "postgresql" : "sqlite",
  dbCredentials: isProd && databaseUrl
    ? { url: databaseUrl }
    : { url: "file:./data/pump-racers.db" },
  verbose: true,
  strict: true,
});
