// A beat for the timers from a worker: a page's own timers are slowed to once
// a minute while its window is minimized or hidden for a while, a worker's are
// not, so a timer, ポモドーロ or アラーム comes due on time behind CSP too.
// What came due is worked out on the page (timerclock.ts); this only wakes it.
const scope = globalThis as unknown as { postMessage(message: unknown): void };
setInterval(() => scope.postMessage(Date.now()), 500);
