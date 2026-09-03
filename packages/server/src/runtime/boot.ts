// SharedBoot — a once-per-isolate boot that many invocations await, made safe to share.
//
// The D1 store boots in the Worker: migrate → data migrations → outbox table → bootstrap,
// run by whichever request arrives first in a fresh isolate and memoized as ONE promise the
// rest await (running it per request would re-diff the schema on every call). That memo
// is the bug behind GitHub #51, and the reason is a Workers runtime rule, not pramen code:
// async work belongs to the INVOCATION that started it. When that invocation ends — the
// caller gives up and disconnects, which is exactly what a proxy with a 15 s ceiling does
// to the legitimately slow first request after a deploy carrying a table rebuild — its
// pending I/O is canceled, and a promise chained on canceled I/O never settles. Not
// rejected: never settles. So the `.catch` that was meant to clear the memo never runs,
// and every later fetch in that isolate awaits a promise that cannot resolve, for as long
// as its own caller allows, at 0 ms CPU. Crons stayed healthy in the report because they
// landed in a different isolate; the ~54 % was the share of traffic routed to the wedged
// one; a redeploy "fixed" it by discarding every isolate.
//
// Two defenses, and both are needed:
//
//  1. The STARTER extends its invocation over the boot with `ctx.waitUntil`, so the client
//     disconnecting no longer cancels the boot's I/O. That closes the reported case. It is
//     not sufficient on its own: waitUntil is capped (30 s after the response or the
//     disconnect), and there is no rule that says a promise's owner is the only way it can
//     be orphaned.
//  2. AWAITERS never trust a shared boot unconditionally. The boot reports PROGRESS (every
//     statement the driver runs), and a boot that has made none for `staleMs` while still
//     unsettled is treated as orphaned: the next awaiter — arriving, or one already waiting
//     — starts a fresh boot in its own invocation and awaits that instead. An isolate can
//     therefore be wedged for at most `staleMs`, never for its lifetime. Every step of the
//     boot tolerates a second runner (that is the cross-isolate reality on D1 already: the
//     migration ledger is lease-claimed, migrate is a diff, bootstrap is an upsert), so a
//     false positive costs a redundant boot, not correctness — which is why the threshold is
//     measured from the last STATEMENT and not from the boot's start: a boot that is slow
//     but alive keeps making progress.
//
// Platform-agnostic on purpose (no `cloudflare:workers`): `keepAlive` is whatever the host
// offers to extend an invocation, and `now` is injectable for tests.

import type { Driver } from "./driver";

export interface SharedBootOpts {
  /** How long a still-unsettled boot may go without progress before it counts as orphaned. */
  staleMs: number;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Called when a boot is judged orphaned and replaced, with how long it had been idle. */
  onOrphaned?: (idleMs: number) => void;
}

interface BootRecord {
  promise: Promise<void>;
  lastProgressAt: number;
  done: boolean;
}

/** The boot body. Call `progress()` whenever the boot does observable work — see
 * `observeDriver` for the standard way to get that for free. */
export type BootFn = (progress: () => void) => Promise<void>;

export class SharedBoot {
  private current: BootRecord | undefined;
  private readonly now: () => number;

  constructor(private readonly opts: SharedBootOpts) {
    this.now = opts.now ?? Date.now;
  }

  /** Await the shared boot, starting one if none is live (or the live one looks orphaned).
   *
   * `run` is only invoked when THIS call has to start a boot. `keepAlive` is the calling
   * invocation's lifetime extender (`ctx.waitUntil`); it is handed the boot's promise so
   * the boot survives the caller disconnecting. A rejected boot rejects every awaiter and
   * clears the memo, so the next call retries — fail closed, as before. */
  async ensure(run: BootFn, keepAlive?: (p: Promise<unknown>) => void): Promise<void> {
    let boot = this.current;
    // The STARTER awaits its own boot outright: the boot runs in its invocation, so if
    // the starter is alive to watch, so is the boot — and if the invocation is canceled,
    // this await dies with it. A starter that also watched would restart its own
    // (dead-for-everyone-else) boot every window, endlessly.
    if (!boot || this.isStale(boot)) return this.start(run, keepAlive, boot).promise;
    for (;;) {
      if (boot.done) return;
      // Wait, but wake when the boot WOULD count as stale, and re-check: progress since
      // means it is alive and we keep waiting; none means it is orphaned.
      if (await this.settledBeforeStale(boot)) return;
      // Someone else may already have replaced it — join theirs rather than start a third.
      const live = this.current;
      if (live && live !== boot && !this.isStale(live)) {
        boot = live;
        continue;
      }
      return this.start(run, keepAlive, boot).promise;
    }
  }

  /** Whether a boot has completed in this isolate — for diagnostics only. */
  isDone(): boolean {
    return this.current?.done === true;
  }

  private isStale(boot: BootRecord): boolean {
    return !boot.done && this.now() - boot.lastProgressAt >= this.opts.staleMs;
  }

  private start(run: BootFn, keepAlive: ((p: Promise<unknown>) => void) | undefined, replacing: BootRecord | undefined): BootRecord {
    if (replacing) this.opts.onOrphaned?.(this.now() - replacing.lastProgressAt);
    const record: BootRecord = { promise: Promise.resolve(), lastProgressAt: this.now(), done: false };
    const progress = (): void => {
      record.lastProgressAt = this.now();
    };
    // Through a resolved promise so a synchronous throw in `run` is a rejection, not an
    // exception escaping `ensure` with the memo half-installed.
    record.promise = Promise.resolve()
      .then(() => run(progress))
      .then(
      () => {
        record.done = true;
      },
      (e: unknown) => {
        // Only forget the memo if it is still THIS boot: a replacement started meanwhile
        // must not be discarded because its predecessor finally failed.
        if (this.current === record) this.current = undefined;
        throw e;
      },
    );
    // Every awaiter attaches its own handler; this one just keeps the host from reporting
    // an unhandled rejection when a boot fails with nobody awaiting the stored promise.
    record.promise.catch(() => {});
    keepAlive?.(record.promise.catch(() => {}));
    this.current = record;
    return record;
  }

  /** Resolves `true` when the boot settles (rejects if it rejected), `false` once it has
   * gone `staleMs` without progress — the timer re-arms from the latest progress instant,
   * so a boot that keeps working is never reported stale. */
  private settledBeforeStale(boot: BootRecord): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = (): void => {
        const wait = Math.max(0, boot.lastProgressAt + this.opts.staleMs - this.now());
        timer = setTimeout(() => (this.isStale(boot) ? resolve(false) : arm()), wait);
      };
      const disarm = (): void => {
        if (timer !== undefined) clearTimeout(timer);
      };
      arm();
      boot.promise.then(
        () => {
          disarm();
          resolve(true);
        },
        (e: unknown) => {
          disarm();
          reject(e);
        },
      );
    });
  }
}

/** Wrap a Driver so every statement it runs reports progress — the boot's liveness signal.
 * `batch` is forwarded only when the wrapped driver has it, because the migrator decides
 * between an atomic batch and sequential exec by its presence. */
export function observeDriver(driver: Driver, progress: () => void): Driver {
  const observed: Driver = {
    dialect: driver.dialect,
    exec: async (sql, params) => {
      progress();
      const rows = await driver.exec(sql, params);
      progress();
      return rows;
    },
    transaction: (fn) => driver.transaction(fn),
  };
  if (driver.batch) {
    const batch = driver.batch.bind(driver);
    observed.batch = async (statements) => {
      progress();
      await batch(statements);
      progress();
    };
  }
  return observed;
}
