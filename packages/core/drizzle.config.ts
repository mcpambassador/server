import { config } from 'dotenv';

export default {
  schema: './src/schema/index.ts',
  out: './drizzle',
  driver: 'better-sqlite',
  dbCredentials: {
    url: process.env.DATABASE_URL || './data/ambassador.db',
  },
};
