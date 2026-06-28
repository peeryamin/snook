#!/usr/bin/env node
/**
 * Set admin password before deployment.
 * Usage: cd server && npm run set-password -- "YourNewPassword"
 */
import bcrypt from 'bcrypt';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import path from 'path';
import url from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../parlor.db');
const password = process.argv[2];

if (!password || password.length < 8) {
  console.error('Usage: npm run set-password -- "password-at-least-8-chars"');
  process.exit(1);
}

const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
const hash = await bcrypt.hash(password, 10);
const result = await db.run(
  `UPDATE users SET password_hash = ? WHERE role = 'admin'`,
  hash
);

if (result.changes === 0) {
  console.error('No admin user found. Start the server once to seed the database.');
  process.exit(1);
}

console.log('Admin password updated successfully.');
await db.close();
