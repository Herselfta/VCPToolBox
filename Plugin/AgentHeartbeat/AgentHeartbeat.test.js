const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('./AgentHeartbeat');

test('empty heartbeat documents are detected', () => {
  assert.equal(_test.isChecklistEmpty(''), true);
  assert.equal(_test.isChecklistEmpty('# HEARTBEAT\n<!-- note -->\n'), true);
  assert.equal(_test.isChecklistEmpty('# HEARTBEAT\n- check tasks'), false);
});

test('agent config clamps intervals and blocks recursive tools', () => {
  const low = _test.normalizeAgent({ intervalMinutes: 1, allowedTools: ['AgentAssistant', 'AgentHeartbeat', 'AgentMessage', 'DailyNoteQuery'] });
  const high = _test.normalizeAgent({ intervalMinutes: 9999 });
  assert.equal(low.intervalMinutes, 5);
  assert.equal(high.intervalMinutes, 1440);
  assert.deepEqual(low.allowedTools, ['DailyNoteQuery']);
});

test('overnight active windows are supported', () => {
  const agent = { activeHours: { start: '23:00', end: '07:00', timezone: 'UTC' } };
  assert.equal(_test.inActive(agent, new Date('2026-07-23T01:00:00Z')), true);
  assert.equal(_test.inActive(agent, new Date('2026-07-23T12:00:00Z')), false);
  assert.equal(_test.nextActive(agent, new Date('2026-07-23T12:00:00Z')).toISOString(), '2026-07-23T23:00:00.000Z');
});
