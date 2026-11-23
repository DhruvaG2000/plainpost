import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceUnit } from '../scripts/systemd.mjs';

test('boot service captures Node and persistent data without a login shell', () => {
  const unit = serviceUnit({ root: '/home/pi/plainpost', node: '/home/pi/.nvm/versions/node/v24/bin/node', dataDir: '/home/pi/.local/share/plainpost' });
  assert.match(unit, /ExecStart=:"\/home\/pi\/\.nvm\/versions\/node\/v24\/bin\/node" "\/home\/pi\/plainpost\/server\/index\.mjs"/);
  assert.match(unit, /Environment="DATA_DIR=\/home\/pi\/\.local\/share\/plainpost"/);
  assert.match(unit, /UMask=0077/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /WantedBy=default.target/);
});

test('service paths preserve spaces, dollar signs, percent signs, quotes and backslashes', () => {
  const unit = serviceUnit({ root: '/home/pi/mail $box%/"source"', node: '/opt/node tools/bin/node', dataDir: '/home/pi/data\\vault%' });
  assert.ok(unit.includes('WorkingDirectory=/home/pi/mail $box%%/"source"/'));
  assert.ok(unit.includes('ExecStart=:"/opt/node tools/bin/node"'));
  assert.ok(unit.includes('Environment="DATA_DIR=/home/pi/data\\\\vault%%"'));
});

test('service rejects relative paths and unit directive injection', () => {
  const valid = { root: '/home/pi/plainpost', node: '/usr/bin/node', dataDir: '/home/pi/data' };
  for (const key of Object.keys(valid)) {
    for (const invalid of ['relative/path', '/tmp/path\nExecStart=/bin/false', '/tmp/path\0']) {
      assert.throws(() => serviceUnit({ ...valid, [key]: invalid }), /absolute Linux paths/);
    }
  }
});
