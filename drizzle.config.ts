import { defineConfig } from 'drizzle-kit';

// Used only by `drizzle-kit generate` / `check`. The runtime database is never targeted by
// drizzle-kit; migrations are applied by the CLI itself (src/storage/client.ts).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/storage/schema.ts',
  out: './drizzle',
});
