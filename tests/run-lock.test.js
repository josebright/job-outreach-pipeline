// tests/run-lock.test.js
// The daily cron and /run both drive the pipeline, and the send cron and /send
// both deliver approved drafts. Without one shared lock, overlapping runs draft
// the same company twice and overlapping send passes deliver the same email twice.
import { describe, it, expect, beforeEach } from 'vitest';
import { withLock, lockInfo, _resetLocksForTests } from '../src/pipeline/util/run-lock.js';

describe('withLock', () => {
  beforeEach(() => _resetLocksForTests());

  it('runs the work and returns its result', async () => {
    const r = await withLock('pipeline', 'test', async () => 42);
    expect(r).toEqual({ busy: false, result: 42 });
  });

  it('refuses a second caller while the first holds the lock, and says who holds it', async () => {
    let release;
    const first = withLock('pipeline', 'cron:daily', () => new Promise(res => { release = res; }));
    let ran = false;
    const second = await withLock('pipeline', 'telegram:/run', async () => { ran = true; });

    expect(second.busy).toBe(true);
    expect(second.info.holder).toBe('cron:daily');
    expect(ran).toBe(false);

    release('done');
    expect((await first).result).toBe('done');
  });

  it('releases the lock even when the work throws', async () => {
    await expect(withLock('send', 'x', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(lockInfo('send')).toBeNull();
    expect((await withLock('send', 'y', async () => 'ok')).result).toBe('ok');
  });

  it('keeps different lock names independent', async () => {
    let release;
    const p = withLock('pipeline', 'a', () => new Promise(res => { release = res; }));
    const s = await withLock('send', 'b', async () => 'sent');
    expect(s).toEqual({ busy: false, result: 'sent' });
    release();
    await p;
  });
});
