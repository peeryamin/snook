import { getDB } from './db.js';

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

async function buildDailyReport(db, date) {
  const summary = await db.get('SELECT * FROM daily_summaries WHERE date = ?', date);
  const players = await db.all(
    'SELECT player_code, name, phone, sessions_count, total_spent FROM daily_players WHERE date = ? ORDER BY total_spent DESC',
    date
  );
  const sessions = await db.all(
    `SELECT s.id, s.customer_name, s.customer_phone, s.amount, s.billed_minutes, s.payment_method,
            t.name as table_name
     FROM sessions s
     LEFT JOIN tables t ON t.id = s.table_id
     WHERE s.start_time >= ? AND s.start_time < ?
     ORDER BY s.start_time`,
    new Date(date + 'T00:00:00').getTime(),
    new Date(date + 'T00:00:00').getTime() + 86400000
  );

  return { date, summary, players, sessions };
}

function formatReportText(report) {
  const lines = [
    `Black Racks Snooker Club - Daily Report`,
    `Date: ${report.date}`,
    '',
    `Total earnings: Rs.${report.summary?.total_earnings || 0}`,
    `Total sessions: ${report.summary?.total_sessions || 0}`,
    `Unique players: ${report.players.length}`,
    '',
    'Players today:',
  ];

  for (const p of report.players) {
    lines.push(`- ${p.player_code} | ${p.name} | ${p.phone || 'no phone'} | ${p.sessions_count} sessions | Rs.${p.total_spent}`);
  }

  if (report.sessions.length) {
    lines.push('', 'Sessions:');
    for (const s of report.sessions) {
      lines.push(`- ${s.table_name || 'Table'} | ${s.customer_name || 'Walk-in'} | Rs.${s.amount} | ${s.billed_minutes}m`);
    }
  }

  return lines.join('\n');
}

async function sendReportEmail(text, date) {
  const to = process.env.REPORT_EMAIL_TO;
  if (!to) {
    console.log('REPORT_EMAIL_TO not set; skipping email. Report preview:\n', text);
    return false;
  }

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user;

  if (!host || !user || !pass) {
    console.log('SMTP not configured; skipping email. Set SMTP_HOST, SMTP_USER, SMTP_PASS, REPORT_EMAIL_TO');
    return false;
  }

  const nodemailer = await import('nodemailer');
  const transporter = nodemailer.default.createTransport({ host, port, secure: port === 465, auth: { user, pass } });

  await transporter.sendMail({
    from,
    to,
    subject: `Black Racks Daily Report - ${date}`,
    text,
  });
  return true;
}

export async function resetDailyData(db, date) {
  const start = new Date(date + 'T00:00:00').getTime();
  const end = start + 86400000;

  await db.run('DELETE FROM sessions WHERE start_time >= ? AND start_time < ?', start, end);
  await db.run('DELETE FROM daily_players WHERE date = ?', date);
  await db.run('DELETE FROM daily_summaries WHERE date = ?', date);
}

export async function runEndOfDayReset() {
  const db = await getDB();
  const date = todayDateString();
  const report = await buildDailyReport(db, date);
  const text = formatReportText(report);

  try {
    await sendReportEmail(text, date);
  } catch (err) {
    console.error('Failed to send daily report email:', err.message);
  }

  await resetDailyData(db, date);
  console.log(`Daily reset completed for ${date}`);
  return { date, players: report.players.length, sessions: report.sessions.length };
}

export function scheduleDailyReset() {
  const hour = Number(process.env.DAILY_RESET_HOUR ?? 23);
  const minute = Number(process.env.DAILY_RESET_MINUTE ?? 59);

  const scheduleNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = next.getTime() - now.getTime();
    setTimeout(async () => {
      try {
        await runEndOfDayReset();
      } catch (err) {
        console.error('Daily reset failed:', err);
      }
      scheduleNext();
    }, delay);
  };

  scheduleNext();
}
