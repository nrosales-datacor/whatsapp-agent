import { defineConfig } from "drizzle-kit";

// Esquemas: la plataforma y cada módulo tienen su propio schema.ts (ver
// src/platform/db/schemaRegistry.ts). Migraciones en ./drizzle (`npm run db:generate`).
export default defineConfig({
  schema: ["./src/platform/**/schema.ts", "./src/modules/**/schema.ts"],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
