// Login attempt guard tests.
//
// The brute-force guard counts FAILED logins per key in a rolling window. It
// is used twice: per client IP (stops one host hammering the login route) and
// per username (stops a botnet spraying ONE account from many IPs — the per-IP
// counter alone never trips for any single attacker host).
//
// Run: node --test backend/src/loginGuard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoginGuard } from './loginGuard.js';

const withClock = () => {
  let now = 1_000_000;
  return {
    guard: createLoginGuard({ max: 3, windowMs: 60_000, now: () => now }),
    advance: (ms) => { now += ms; },
  };
};

test('an unseen key is never blocked', () => {
  const { guard } = withClock();
  assert.equal(guard.blocked('1.2.3.4'), false);
});

test('a key is blocked only after max failures, not at max-1', () => {
  const { guard } = withClock();
  guard.noteFailure('1.2.3.4');
  guard.noteFailure('1.2.3.4');
  assert.equal(guard.blocked('1.2.3.4'), false, '2 failures < max 3 must not block');
  guard.noteFailure('1.2.3.4');
  assert.equal(guard.blocked('1.2.3.4'), true, 'the 3rd failure must block');
});

test('keys are independent — one key cannot block another', () => {
  const { guard } = withClock();
  for (let i = 0; i < 3; i++) guard.noteFailure('attacker');
  assert.equal(guard.blocked('attacker'), true);
  assert.equal(guard.blocked('innocent'), false);
});

test('the block expires when the window passes', () => {
  const { guard, advance } = withClock();
  for (let i = 0; i < 3; i++) guard.noteFailure('1.2.3.4');
  assert.equal(guard.blocked('1.2.3.4'), true);
  advance(60_001);
  assert.equal(guard.blocked('1.2.3.4'), false, 'after the window the key starts fresh');
});

test('failures do not carry over into the next window', () => {
  const { guard, advance } = withClock();
  guard.noteFailure('1.2.3.4');
  guard.noteFailure('1.2.3.4');
  advance(60_001);
  guard.noteFailure('1.2.3.4');
  assert.equal(guard.blocked('1.2.3.4'), false, 'a stale count must not count toward the new window');
});

test('clear (a successful login) resets the key immediately', () => {
  const { guard } = withClock();
  for (let i = 0; i < 3; i++) guard.noteFailure('1.2.3.4');
  guard.clear('1.2.3.4');
  assert.equal(guard.blocked('1.2.3.4'), false);
});

test('an empty key is never counted or blocked', () => {
  // Callers pass a key only when they have one (an absent username, an unknown
  // socket); an empty string must not become a shared bucket that everybody
  // matches.
  const { guard } = withClock();
  for (let i = 0; i < 10; i++) guard.noteFailure('');
  assert.equal(guard.blocked(''), false);
  assert.equal(guard.blocked('anyone-else'), false);
});
