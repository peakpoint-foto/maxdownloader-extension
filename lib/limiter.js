"use strict";

// Per-host rate limiter shared by every job in the engine.
// - one schedule per key (hostname, or "dl:" + hostname for file downloads), so
//   two albums on the same site never double the request rate;
// - AIMD concurrency: +1 after a run of clean responses, halved on 429/503;
// - Retry-After and exponential back-off become a shared "blockedUntil";
// - hold()/unhold() freeze a host while the user clears a CAPTCHA.
(function installLimiter(globalObject) {
  "use strict";

  const OK_STREAK_TO_GROW = 10;
  const MAX_DELAY_FACTOR = 8;
  const MAX_BACKOFF_MS = 5 * 60 * 1000;
  const JITTER = 0.3;

  class AbortedError extends Error {
    constructor() {
      super("Cancelled");
      this.name = "AbortError";
    }
  }

  class HostLimiter {
    // config(key) -> { delayMs, maxConcurrency, adaptive }
    constructor({ config, now = () => Date.now(), random = Math.random } = {}) {
      this.config = typeof config === "function" ? config : () => ({ delayMs: 0, maxConcurrency: 1, adaptive: false });
      this.now = now;
      this.random = random;
      this.hosts = new Map();
    }

    host(key) {
      let state = this.hosts.get(key);
      if (!state) {
        const cfg = this.cfg(key);
        state = {
          key,
          limit: cfg.adaptive ? Math.max(1, Math.ceil(cfg.maxConcurrency / 2)) : cfg.maxConcurrency,
          inFlight: 0,
          nextAt: 0,
          blockedUntil: 0,
          held: false,
          holdReason: "",
          okStreak: 0,
          rateStreak: 0,
          delayFactor: 1,
          waiters: new Set()
        };
        this.hosts.set(key, state);
      }
      return state;
    }

    cfg(key) {
      const raw = this.config(key) || {};
      return {
        delayMs: Math.max(0, Number(raw.delayMs) || 0),
        maxConcurrency: Math.max(1, Math.round(Number(raw.maxConcurrency) || 1)),
        adaptive: raw.adaptive !== false
      };
    }

    wake(state) {
      const list = [...state.waiters];
      state.waiters.clear();
      for (const resolve of list) {
        resolve();
      }
    }

    // Waits for an event on this host (release/unhold) or at most `ms`.
    wait(state, ms, signal) {
      return new Promise((resolve) => {
        let timer = null;
        const done = () => {
          clearTimeout(timer);
          state.waiters.delete(done);
          if (signal) {
            signal.removeEventListener("abort", done);
          }
          resolve();
        };
        timer = setTimeout(done, Math.max(1, ms));
        state.waiters.add(done);
        if (signal) {
          signal.addEventListener("abort", done, { once: true });
        }
      });
    }

    // Resolves once a request to `key` may start. Always pair with release().
    async acquire(key, signal) {
      const state = this.host(key);
      for (;;) {
        if (signal && signal.aborted) {
          throw new AbortedError();
        }
        const cfg = this.cfg(key);
        if (!cfg.adaptive) {
          state.limit = cfg.maxConcurrency;
        }
        state.limit = Math.min(state.limit, cfg.maxConcurrency);
        const now = this.now();
        if (state.held || state.inFlight >= state.limit) {
          await this.wait(state, 1000, signal);
          continue;
        }
        const readyAt = Math.max(state.blockedUntil, state.nextAt);
        if (now < readyAt) {
          await this.wait(state, Math.min(1000, readyAt - now), signal);
          continue;
        }
        const delay = cfg.delayMs * state.delayFactor;
        state.nextAt = now + delay + Math.round(delay * JITTER * this.random());
        state.inFlight += 1;
        return;
      }
    }

    // outcome: "ok" | "rate" | "captcha" | "error"
    release(key, outcome = "ok", { retryAfterMs = 0 } = {}) {
      const state = this.host(key);
      const cfg = this.cfg(key);
      state.inFlight = Math.max(0, state.inFlight - 1);
      if (outcome === "ok") {
        state.rateStreak = 0;
        state.okStreak += 1;
        state.delayFactor = Math.max(1, state.delayFactor * 0.95);
        if (cfg.adaptive && state.okStreak >= OK_STREAK_TO_GROW && state.limit < cfg.maxConcurrency) {
          state.limit += 1;
          state.okStreak = 0;
        }
      } else if (outcome === "rate") {
        state.okStreak = 0;
        state.rateStreak += 1;
        if (cfg.adaptive) {
          state.limit = Math.max(1, Math.floor(state.limit / 2));
        }
        state.delayFactor = Math.min(MAX_DELAY_FACTOR, state.delayFactor * 1.5);
        const fromHost = Number(retryAfterMs);
        const backoff = Number.isFinite(fromHost) && fromHost > 0
          ? Math.min(MAX_BACKOFF_MS, fromHost)
          : Math.min(MAX_BACKOFF_MS, Math.max(2000, cfg.delayMs) * 2 ** Math.min(state.rateStreak, 8));
        state.blockedUntil = Math.max(state.blockedUntil, this.now() + backoff);
      } else if (outcome === "captcha") {
        state.okStreak = 0;
        state.limit = 1;
        state.delayFactor = Math.min(MAX_DELAY_FACTOR, Math.max(2, state.delayFactor * 2));
      }
      this.wake(state);
    }

    hold(key, reason = "captcha") {
      const state = this.host(key);
      state.held = true;
      state.holdReason = reason;
    }

    unhold(key, cooldownMs = 0) {
      const state = this.host(key);
      state.held = false;
      state.holdReason = "";
      state.rateStreak = 0;
      if (cooldownMs > 0) {
        state.blockedUntil = Math.max(state.blockedUntil, this.now() + cooldownMs);
      }
      this.wake(state);
    }

    isHeld(key) {
      return Boolean(this.hosts.get(key) && this.hosts.get(key).held);
    }

    blockedUntil(key) {
      const state = this.hosts.get(key);
      return state ? state.blockedUntil : 0;
    }

    snapshot() {
      return [...this.hosts.values()].map((state) => ({
        key: state.key,
        limit: state.limit,
        inFlight: state.inFlight,
        delayMs: Math.round(this.cfg(state.key).delayMs * state.delayFactor),
        blockedUntil: state.blockedUntil,
        held: state.held,
        holdReason: state.holdReason
      }));
    }
  }

  globalObject.MaxDownloaderLimiter = Object.freeze({ HostLimiter, AbortedError });
})(globalThis);
