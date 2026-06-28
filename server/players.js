import crypto from 'crypto';

export function buildPlayerCode(name) {
  const slug = String(name)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6) || 'PLAYER';
  const hash = crypto.createHash('md5').update(name.trim().toLowerCase()).digest('hex').slice(0, 4).toUpperCase();
  return `BR-${slug}-${hash}`;
}

export async function upsertDailyPlayer(db, { name, phone, amount = 0, date }) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) return null;

  const playerCode = buildPlayerCode(trimmedName);
  const existing = await db.get(
    'SELECT * FROM daily_players WHERE player_code = ? AND date = ?',
    playerCode,
    date
  );

  if (existing) {
    await db.run(
      `UPDATE daily_players SET
        phone = COALESCE(?, phone),
        sessions_count = sessions_count + 1,
        total_spent = total_spent + ?,
        last_seen = ?
      WHERE id = ?`,
      phone || null,
      amount,
      Date.now(),
      existing.id
    );
    return playerCode;
  }

  await db.run(
    `INSERT INTO daily_players (player_code, name, phone, sessions_count, total_spent, date, last_seen)
     VALUES (?, ?, ?, 1, ?, ?, ?)`,
    playerCode,
    trimmedName,
    phone || null,
    amount,
    date,
    Date.now()
  );
  return playerCode;
}

export async function searchDailyPlayers(db, query, date, limit = 10) {
  const term = `%${query.trim()}%`;
  return db.all(
    `SELECT player_code, name, phone, sessions_count, total_spent
     FROM daily_players
     WHERE date = ? AND (name LIKE ? OR phone LIKE ? OR player_code LIKE ?)
     ORDER BY last_seen DESC
     LIMIT ?`,
    date,
    term,
    term,
    term,
    limit
  );
}
