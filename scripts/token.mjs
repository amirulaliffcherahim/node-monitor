// Recovery CLI for UI access tokens (works without the web UI).
//   npm run token -- create "my laptop"
//   npm run token -- list
//   npm run token -- revoke 3
import { migrate, pool, q, S } from '../src/db.js';
import { createUiToken, revokeUiToken } from '../src/auth.js';
import { validName } from '../src/validate.js';

const [cmd, arg] = process.argv.slice(2);

try {
  await migrate();
  if (cmd === 'create') {
    const label = validName(arg || 'cli');
    if (!label) throw new Error('label: 1-63 chars, letters, digits, space . _ -');
    const t = await createUiToken(label);
    console.log(`Created UI token #${t.id} "${t.label}" (shown once, never expires until revoked):\n\n  ${t.token}\n`);
  } else if (cmd === 'list') {
    const r = await q(`SELECT id, label, token_hint, created_at, last_used_at, revoked_at FROM ${S}.ui_tokens ORDER BY id`);
    console.table(r.rows);
  } else if (cmd === 'revoke' && /^\d+$/.test(arg || '')) {
    console.log((await revokeUiToken(Number(arg))) ? `Revoked #${arg}, its sessions are signed out.` : 'Not found or already revoked.');
  } else {
    console.log('usage: npm run token -- create "<label>" | list | revoke <id>');
    process.exitCode = 2;
  }
} catch (e) {
  console.error('error:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
