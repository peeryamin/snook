import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSessionsForExport } from '../server/server.js';

test('selectSessionsForExport includes completed and pending sessions once for the chosen day', () => {
  const sessions = [
    {
      id: 1,
      start_time: new Date('2026-06-29T10:00:00Z').getTime(),
      end_time: new Date('2026-06-29T10:30:00Z').getTime(),
      payment_status: 'PENDING'
    },
    {
      id: 2,
      start_time: new Date('2026-06-29T22:00:00Z').getTime(),
      end_time: new Date('2026-06-29T23:00:00Z').getTime(),
      payment_status: 'PAID'
    },
    {
      id: 3,
      start_time: new Date('2026-06-29T12:00:00Z').getTime(),
      end_time: null,
      payment_status: 'PENDING'
    },
    {
      id: 2,
      start_time: new Date('2026-06-29T22:00:00Z').getTime(),
      end_time: new Date('2026-06-29T23:00:00Z').getTime(),
      payment_status: 'PAID'
    }
  ];

  const selected = selectSessionsForExport(sessions, '2026-06-29');

  assert.equal(selected.length, 2);
  assert.deepEqual(selected.map((session) => session.id), [1, 2]);
  assert.ok(selected.every((session) => session.payment_status === 'PENDING' || session.payment_status === 'PAID'));
});
