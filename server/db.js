import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import fs from 'fs';
import path from 'path';
import url from 'url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || (process.env.VERCEL ? '/tmp/parlor.db' : path.join(__dirname, 'parlor.db'));
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const USE_TURSO = Boolean(process.env.TURSO_DATABASE_URL);

const BLACK_RACKS_TABLES = [
  { id: 1, name: 'Table 1', type: 'ENGLISH', hourly_rate: 300, minimum_charge: 100 },
  { id: 2, name: 'Table 2', type: 'FRENCH', hourly_rate: 420, minimum_charge: 150 }
];

let dbInstance = null;

function createTursoAdapter(client) {
  return {
    async get(sql, ...params) {
      const result = await client.execute({ sql, args: params });
      return result.rows[0] ?? undefined;
    },
    async all(sql, ...params) {
      const result = await client.execute({ sql, args: params });
      return [...result.rows];
    },
    async run(sql, ...params) {
      const result = await client.execute({ sql, args: params });
      return {
        lastID: Number(result.lastInsertRowid ?? 0),
        changes: result.rowsAffected ?? 0
      };
    },
    async exec(sql) {
      await client.executeMultiple(sql);
    },
    async close() {
      client.close();
    }
  };
}

export async function getDB() {
  if (!dbInstance) {
    if (USE_TURSO) {
      const { createClient } = await import('@libsql/client');
      const client = createClient({
        url: process.env.TURSO_DATABASE_URL,
        authToken: process.env.TURSO_AUTH_TOKEN
      });
      dbInstance = createTursoAdapter(client);
      console.log('📡 Using Turso database (persistent)');
    } else {
      if (process.env.VERCEL) {
        console.warn('⚠️ Vercel without TURSO_DATABASE_URL — each server instance has its own /tmp DB. Set up Turso for reliable multi-table sessions.');
      }
      dbInstance = await open({
        filename: DB_PATH,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE
      });
      await dbInstance.exec('PRAGMA foreign_keys = ON;');
      await dbInstance.exec('PRAGMA journal_mode = WAL;');
    }
  }
  return dbInstance;
}

export async function withTransaction(fn) {
  const db = await getDB();
  await db.run('BEGIN IMMEDIATE');
  try {
    const result = await fn(db);
    await db.run('COMMIT');
    return result;
  } catch (error) {
    await db.run('ROLLBACK');
    throw error;
  }
}

export async function closeDB() {
  if (dbInstance) {
    await dbInstance.close();
    dbInstance = null;
  }
}

export async function migrate() {
  console.log('🔄 Running database migrations...');
  const db = await getDB();

  try {
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
    await db.exec(schema);

    await runAdditionalMigrations(db);

    const tableCount = await db.get('SELECT COUNT(*) as count FROM tables');
    if (tableCount.count === 0) {
      console.log('🌱 Seeding Black Racks tables...');
      await seedBlackRacksTables(db);
    } else {
      await configureBlackRacksParlor(db);
    }

    await syncTableNames(db);

    console.log('✅ Database migration completed');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  }
}

async function seedBlackRacksTables(db) {
  for (const table of BLACK_RACKS_TABLES) {
    await db.run(
      `INSERT INTO tables (id, name, type, hourly_rate, minimum_charge, status, light_on)
       VALUES (?, ?, ?, ?, ?, 'AVAILABLE', 0)`,
      table.id, table.name, table.type, table.hourly_rate, table.minimum_charge
    );
  }

  await db.run(
    `INSERT OR REPLACE INTO settings (key, value, description) VALUES (?, ?, ?)`,
    'parlor_name', 'Black Racks Snooker Club by Zaid', 'Name of the snooker parlor'
  );
  await db.run(
    `INSERT OR REPLACE INTO settings (key, value, description) VALUES (?, ?, ?)`,
    'black_racks_configured', 'true', 'Black Racks parlor setup complete'
  );

  console.log('✅ Black Racks tables seeded successfully');
}

async function configureBlackRacksParlor(db) {
  const configured = await db.get(`SELECT value FROM settings WHERE key = 'black_racks_configured'`);
  if (configured?.value === 'true') return;

  console.log('🎱 Configuring Black Racks Snooker Club...');

  await db.run('DELETE FROM sessions WHERE table_id > 2');
  await db.run('DELETE FROM tables WHERE id > 2');

  for (const table of BLACK_RACKS_TABLES) {
    const existing = await db.get('SELECT id FROM tables WHERE id = ?', table.id);
    if (existing) {
      await db.run(
        `UPDATE tables SET name = ?, type = ?, hourly_rate = ?, minimum_charge = ? WHERE id = ?`,
        table.name, table.type, table.hourly_rate, table.minimum_charge, table.id
      );
    } else {
      await db.run(
        `INSERT INTO tables (id, name, type, hourly_rate, minimum_charge, status, light_on)
         VALUES (?, ?, ?, ?, ?, 'AVAILABLE', 0)`,
        table.id, table.name, table.type, table.hourly_rate, table.minimum_charge
      );
    }
  }

  await db.run(
    `INSERT OR REPLACE INTO settings (key, value, description) VALUES (?, ?, ?)`,
    'parlor_name', 'Black Racks Snooker Club by Zaid', 'Name of the snooker parlor'
  );
  await db.run(
    `INSERT OR REPLACE INTO settings (key, value, description) VALUES (?, ?, ?)`,
    'black_racks_configured', 'true', 'Black Racks parlor setup complete'
  );

  console.log('✅ Black Racks configuration applied');
}

async function syncTableNames(db) {
  await db.run(`UPDATE tables SET name = 'Table 1' WHERE id = 1`);
  await db.run(`UPDATE tables SET name = 'Table 2' WHERE id = 2`);
}

async function runAdditionalMigrations(db) {
  console.log('🔧 Running additional migrations...');

  try {
    const nameColumnExists = await db.get(`
      SELECT COUNT(*) as count
      FROM pragma_table_info('tables')
      WHERE name = 'name'
    `);

    if (nameColumnExists.count === 0) {
      console.log('📝 Adding name column to tables...');
      await db.exec('ALTER TABLE tables ADD COLUMN name TEXT');
      console.log('✅ Added name column');
    }

    const minimumChargeColumnExists = await db.get(`
      SELECT COUNT(*) as count
      FROM pragma_table_info('tables')
      WHERE name = 'minimum_charge'
    `);

    if (minimumChargeColumnExists.count === 0) {
      console.log('📝 Adding minimum_charge column to tables...');
      await db.exec('ALTER TABLE tables ADD COLUMN minimum_charge INTEGER NOT NULL DEFAULT 0');
      console.log('✅ Added minimum_charge column');
    }

    const loyaltyColumnExists = await db.get(`
      SELECT COUNT(*) as count
      FROM pragma_table_info('customers')
      WHERE name = 'loyalty_points'
    `);

    if (loyaltyColumnExists.count === 0) {
      console.log('📝 Adding loyalty_points column to customers table...');
      await db.exec('ALTER TABLE customers ADD COLUMN loyalty_points INTEGER DEFAULT 0');
      console.log('✅ Added loyalty_points column');
    }

    const expiryColumnExists = await db.get(`
      SELECT COUNT(*) as count
      FROM pragma_table_info('customers')
      WHERE name = 'membership_expiry_date'
    `);

    if (expiryColumnExists.count === 0) {
      console.log('📝 Adding membership_expiry_date column to customers table...');
      await db.exec('ALTER TABLE customers ADD COLUMN membership_expiry_date INTEGER');
      console.log('✅ Added membership_expiry_date column');
    }

    const statusColumnExists = await db.get(`
      SELECT COUNT(*) as count
      FROM pragma_table_info('customers')
      WHERE name = 'membership_status'
    `);

    if (statusColumnExists.count === 0) {
      console.log('📝 Adding membership_status column to customers table...');
      await db.exec(`ALTER TABLE customers ADD COLUMN membership_status TEXT DEFAULT 'ACTIVE' CHECK (membership_status IN ('ACTIVE','EXPIRED','SUSPENDED'))`);
      console.log('✅ Added membership_status column');
    }

    const dobColumnExists = await db.get(`
      SELECT COUNT(*) as count
      FROM pragma_table_info('customers')
      WHERE name = 'date_of_birth'
    `);

    if (dobColumnExists.count === 0) {
      console.log('📝 Adding date_of_birth column to customers table...');
      await db.exec('ALTER TABLE customers ADD COLUMN date_of_birth INTEGER');
      console.log('✅ Added date_of_birth column');
    }

    const addressColumnExists = await db.get(`
      SELECT COUNT(*) as count
      FROM pragma_table_info('customers')
      WHERE name = 'address'
    `);

    if (addressColumnExists.count === 0) {
      console.log('📝 Adding address column to customers table...');
      await db.exec('ALTER TABLE customers ADD COLUMN address TEXT');
      console.log('✅ Added address column');
    }

    const emergencyColumnExists = await db.get(`
      SELECT COUNT(*) as count
      FROM pragma_table_info('customers')
      WHERE name = 'emergency_contact'
    `);

    if (emergencyColumnExists.count === 0) {
      console.log('📝 Adding emergency_contact column to customers table...');
      await db.exec('ALTER TABLE customers ADD COLUMN emergency_contact TEXT');
      console.log('✅ Added emergency_contact column');
    }

    const idCardColumnExists = await db.get(`
      SELECT COUNT(*) as count
      FROM pragma_table_info('customers')
      WHERE name = 'id_card_number'
    `);

    if (idCardColumnExists.count === 0) {
      console.log('📝 Adding id_card_number column to customers table...');
      await db.exec('ALTER TABLE customers ADD COLUMN id_card_number TEXT');
      console.log('✅ Added id_card_number column');
    }

    const photoColumnExists = await db.get(`
      SELECT COUNT(*) as count
      FROM pragma_table_info('customers')
      WHERE name = 'photo_url'
    `);

    if (photoColumnExists.count === 0) {
      console.log('📝 Adding photo_url column to customers table...');
      await db.exec('ALTER TABLE customers ADD COLUMN photo_url TEXT');
      console.log('✅ Added photo_url column');
    }

    const membershipStartColumnExists = await db.get(`
      SELECT COUNT(*) as count
      FROM pragma_table_info('customers')
      WHERE name = 'membership_start_date'
    `);

    if (membershipStartColumnExists.count === 0) {
      console.log('Adding membership_start_date column to customers table...');
      await db.exec('ALTER TABLE customers ADD COLUMN membership_start_date INTEGER');
    }

    await db.exec(`
      CREATE TABLE IF NOT EXISTS daily_players (
        id INTEGER PRIMARY KEY,
        player_code TEXT NOT NULL,
        name TEXT NOT NULL,
        phone TEXT,
        sessions_count INTEGER NOT NULL DEFAULT 0,
        total_spent INTEGER NOT NULL DEFAULT 0,
        date TEXT NOT NULL,
        last_seen INTEGER NOT NULL,
        UNIQUE(player_code, date)
      )
    `);
    await db.exec('CREATE INDEX IF NOT EXISTS idx_daily_players_date ON daily_players(date)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_daily_players_name ON daily_players(name)');

    await db.run(`DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM users WHERE role = 'employee')`);
    await db.run(`DELETE FROM users WHERE role = 'employee'`);

  } catch (error) {
    console.error('❌ Additional migrations failed:', error);
  }
}

export async function backupDatabase() {
  if (USE_TURSO) {
    throw new Error('Database backup is not supported with Turso. Use Turso dashboard backups.');
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(__dirname, `backup-${timestamp}.db`);

  try {
    fs.copyFileSync(DB_PATH, backupPath);
    console.log(`✅ Database backed up to: ${backupPath}`);
    return backupPath;
  } catch (error) {
    console.error('❌ Backup failed:', error);
    throw error;
  }
}
