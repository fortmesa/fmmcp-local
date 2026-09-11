// Unit tests for the token-expiry display helpers added for the 2026-09-03
// VSIX UX round: `formatRelativeExpiry` (the Identity LIST row — relative
// only) and `formatExactExpiry` (the TOOLTIP / Identity table — absolute
// only). Both are pure and vscode-free, in src/registry/credentials.ts.
//
// Run against the BUILT output:
//   yarn build && yarn node --test test/registry/expiry-format.test.mjs
//
// `formatRelativeExpiry` takes an injectable `now`, so every case here is
// deterministic without faking the clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatExactExpiry, formatRelativeExpiry } from '../../dist/registry/credentials.js';

const NOW = new Date('2026-09-03T12:00:00Z');
const at = (ms) => new Date(NOW.getTime() + ms);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test('formatRelativeExpiry: undecodable expiry says so rather than rendering a blank', () => {
  assert.equal(formatRelativeExpiry(undefined, NOW), 'expiry unknown');
});

test('formatRelativeExpiry: an expiry in the past is "expired"', () => {
  assert.equal(formatRelativeExpiry(at(-1), NOW), 'expired');
});

test('formatRelativeExpiry: exactly now counts as expired (boundary)', () => {
  assert.equal(formatRelativeExpiry(at(0), NOW), 'expired');
});

test('formatRelativeExpiry: under a minute is not rendered as "0 min"', () => {
  assert.equal(formatRelativeExpiry(at(59_000), NOW), 'expires in under a minute');
});

test('formatRelativeExpiry: minutes below an hour', () => {
  assert.equal(formatRelativeExpiry(at(MINUTE), NOW), 'expires in 1 min');
  assert.equal(formatRelativeExpiry(at(59 * MINUTE), NOW), 'expires in 59 min');
});

test('formatRelativeExpiry: hours below a day (floored, not rounded)', () => {
  assert.equal(formatRelativeExpiry(at(HOUR), NOW), 'expires in 1 h');
  assert.equal(formatRelativeExpiry(at(HOUR + 59 * MINUTE), NOW), 'expires in 1 h');
  assert.equal(formatRelativeExpiry(at(23 * HOUR), NOW), 'expires in 23 h');
});

test('formatRelativeExpiry: a day or more (floored)', () => {
  assert.equal(formatRelativeExpiry(at(DAY), NOW), 'expires in 1 d');
  assert.equal(formatRelativeExpiry(at(DAY + 23 * HOUR), NOW), 'expires in 1 d');
  assert.equal(formatRelativeExpiry(at(30 * DAY), NOW), 'expires in 30 d');
});

test('formatExactExpiry: renders the absolute stamp, and "unknown" for undefined', () => {
  const stamp = new Date('2026-09-03T12:00:00Z');
  assert.equal(
    formatExactExpiry(stamp),
    stamp.toLocaleString(undefined, {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
    }),
  );
  assert.equal(formatExactExpiry(undefined), 'unknown');
});

// PO, 2026-09-10: the Signed-in user card's "Expires" row must be
// unambiguous. It was already LOCAL time (toLocaleString with no options
// renders in the host zone) -- what was missing is which zone that is.
test('formatExactExpiry: names the time zone, and renders in the LOCAL zone (not UTC unless local is UTC)', () => {
  const stamp = new Date('2026-09-03T12:00:00Z');
  const rendered = formatExactExpiry(stamp);

  const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
    .formatToParts(stamp)
    .find((part) => part.type === 'timeZoneName').value;
  assert.ok(rendered.endsWith(zone), `expected "${rendered}" to end with the local zone name "${zone}"`);

  // The hour shown is the LOCAL hour for this instant, whatever the host zone is.
  const localHour = stamp.toLocaleString(undefined, { hour: 'numeric', hour12: false });
  assert.ok(
    rendered.includes(String(Number(localHour))),
    `expected "${rendered}" to carry the local hour ${localHour}`,
  );
});
