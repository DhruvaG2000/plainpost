import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

// Encryption protects the token file alone. The key and vault directory must
// still be protected by the host OS; this is a single-user local application.
export class Vault {
  constructor(dir) { this.dir = dir; this.queue = Promise.resolve(); }
  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, 'key');
    try { this.key = await readFile(path); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const key = randomBytes(32);
      try { await writeFile(path, key, { flag: 'wx', mode: 0o600 }); this.key = key; }
      catch (e) { if (e.code !== 'EEXIST') throw e; this.key = await readFile(path); }
    }
    if (this.key.length !== 32) throw new Error('Invalid vault key. Restore the data directory from a backup.');
    try {
      const value = JSON.parse(await readFile(join(this.dir, 'vault.json'), 'utf8'));
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
      this.data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString());
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot decrypt the token vault. Check the key and vault files.'); this.data = { accounts: {}, sessions: {} }; }
    return this;
  }
  async save() {
    this.queue = this.queue.catch(() => {}).then(async () => {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(this.data)), cipher.final()]);
      const temp = join(this.dir, 'vault.json.tmp');
      await writeFile(temp, JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64') }), { mode: 0o600 });
      await rename(temp, join(this.dir, 'vault.json'));
      if (process.platform !== 'win32') await chmod(join(this.dir, 'vault.json'), 0o600);
    });
    return this.queue;
  }
}
