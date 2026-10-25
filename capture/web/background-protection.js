/** Consecutive samples, staged protection and explicit recovery; no persistence or request access. */
(function (root) {
  "use strict";
  class BackgroundMemoryProtection {
    constructor(onAction, now = () => Date.now()) {
      this.onAction = onAction;
      this.now = now;
      this.reset();
    }
    reset() {
      this.level = 0;
      this.count = 0;
      this.pid = null;
      this.last = null;
    }
    sample(value, active = true) {
      const config = value?.settings;
      if (!active || value?.unavailable || !Number.isFinite(value?.mib) || value.mib < 0 ||
          !Number.isInteger(value?.pid) || value.pid <= 0 || !config?.enabled ||
          !(config.hide_mib > config.pause_mib && config.pause_mib > 0) ||
          !Number.isInteger(config.consecutive_samples) || config.consecutive_samples < 2 ||
          !(config.interval_seconds >= 5)) {
        this.count = 0;
        this.last = null;
        return;
      }
      const time = this.now();
      if (value.pid !== this.pid || (this.last !== null && time - this.last > config.interval_seconds * 2500)) this.count = 0;
      this.pid = value.pid;
      this.last = time;
      if (this.level === 2) return;
      const threshold = this.level === 0 ? config.pause_mib : config.hide_mib;
      this.count = value.mib > threshold ? this.count + 1 : 0;
      if (this.count >= config.consecutive_samples) {
        this.level++;
        this.count = 0;
        this.onAction(this.level, value);
      }
    }
  }
  root.BackgroundMemoryProtection = BackgroundMemoryProtection;
  if (typeof module !== "undefined") module.exports = {BackgroundMemoryProtection};
})(typeof globalThis === "undefined" ? this : globalThis);
