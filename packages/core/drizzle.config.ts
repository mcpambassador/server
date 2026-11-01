// NEVER run `drizzle-kit migrate` or `push` against prod: the tracked migration runner owns the
// schema. Use `drizzle-kit generate` only to author new migration files.
export default {
  dialect: 'sqlite',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL || './data/ambassador.db',
  },
};
