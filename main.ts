// Process lifecycle for the grading harness: start the forge on a kernel-chosen
// port, announce that port to the environment service, then idle until the
// environment reports the trial finished, and shut down cleanly.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL || '').replace(/\/+$/, '');
if (!envOrigin) {
  console.error('MAKEFUN_ENV_URL missing: no environment to register with');
  process.exit(1);
}

const TIMEOUT = 30_000;
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const backoff = (n: number) => Math.min(2_000, 250 * 2 ** Math.min(n, 8));

async function announce(port: number): Promise<void> {
  let tries = 0;
  for (;;) {
    let fatal: Error | null = null;
    try {
      const reply = await fetch(envOrigin + '/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        fatal = new Error('register refused with HTTP ' + reply.status + ': ' + (await reply.text()));
      }
    } catch (err) {
      if (fatal) throw fatal;
      void err;
    }
    if (fatal) throw fatal;
    tries += 1;
    await pause(backoff(tries));
  }
}

async function untilFinished(): Promise<void> {
  let tries = 0;
  for (;;) {
    try {
      const reply = await fetch(envOrigin + '/done', { signal: AbortSignal.timeout(TIMEOUT) });
      if (reply.ok) {
        const payload: any = await reply.json();
        if (payload && payload.done === true) return;
        tries = 0;
      }
    } catch {
      // Environment not reachable yet; keep waiting.
    }
    tries += 1;
    await pause(backoff(tries));
  }
}

const app = createApp();
await new Promise<void>((resolve, reject) => {
  app.once('error', reject);
  app.listen(0, () => resolve());
});
const bound: any = app.address();
if (!bound || typeof bound !== 'object') {
  console.error('server did not bind a TCP port');
  process.exit(1);
}
console.log('forge listening on port ' + bound.port);
await announce(bound.port);
console.log('registered with the environment; waiting for done');
await untilFinished();
app.close();
console.log('environment done; exiting');
process.exit(0);
