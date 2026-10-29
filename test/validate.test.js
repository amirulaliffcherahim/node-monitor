import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSample, validName, num, str } from '../src/validate.js';

test('clamps and computes percentages', () => {
  const s = sanitizeSample({
    cpu: 150, mem_total: 1000, mem_used: 1500, swap_total: 0, swap_used: 0,
    disks: [{ mount: '/', total: 100, used: 40 }, { mount: '/data', total: 200, used: 190 }],
  });
  assert.equal(s.cpu, 100);
  assert.equal(s.mem_used, 1000);
  assert.equal(s.mem_pct, 100);
  assert.equal(s.swap_pct, null);
  assert.equal(s.disk_pct, 95);      // fullest volume, not the average
  assert.equal(s.disk_total, 300);
});

test('rejects garbage without throwing on fields', () => {
  const s = sanitizeSample({ cpu: 'abc', mem_total: -5, disks: 'nope', hostname: 'a\u0000b\nc' });
  assert.equal(s.cpu, null);
  assert.equal(s.mem_total, 0);
  assert.deepEqual(s.disks, []);
  assert.equal(s.hostname, 'abc');
});

test('rejects non-object bodies', () => {
  assert.throws(() => sanitizeSample(null));
  assert.throws(() => sanitizeSample([1, 2]));
});

test('drops invalid disks and caps used at total', () => {
  const s = sanitizeSample({ disks: [{ mount: 'C:', total: 10, used: 50 }, { mount: 'X', total: 0, used: 0 }, {}] });
  assert.equal(s.disks.length, 1);
  assert.equal(s.disks[0].used, 10);
});

test('helpers', () => {
  assert.equal(num(''), null);
  assert.equal(num('5'), 5);
  assert.equal(str(5), null);
  assert.equal(validName('db1'), 'db1');
  assert.equal(validName(' web-01 '), 'web-01');
  assert.equal(validName('<script>'), null);
  assert.equal(validName(''), null);
});
