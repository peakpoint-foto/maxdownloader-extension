"use strict";

// Persistent storage for jobs, items, download history, logs and settings.
// IdbStore is used by the engine (offscreen document) and the control panel;
// MemoryStore has the same async API and backs the unit tests.
//
// Records:
//   jobs    { id, site, sourceUrl, keys[], title, status, scan{}, ... }
//   items   { key: jobId + "|" + photoId, jobId, photoId, seq, status, ... }
//   history { key: historyKey, at, jobId, filename }
//   logs    { id (auto), at, level, message, data }
//   kv      arbitrary values (settings, directory handle, flags)
(function installStore(globalObject) {
  "use strict";

  const DB_NAME = "maxdl";
  const DB_VERSION = 1;
  const MAX_LOGS = 3000;

  function itemKey(jobId, photoId) {
    return String(jobId) + "|" + String(photoId);
  }

  function clone(value) {
    return value === undefined ? undefined : structuredCloneSafe(value);
  }

  function structuredCloneSafe(value) {
    if (typeof structuredClone === "function") {
      try {
        return structuredClone(value);
      } catch {
        // Handles (FileSystemDirectoryHandle) cannot be cloned in Node; keep the reference.
        return value;
      }
    }
    return JSON.parse(JSON.stringify(value));
  }

  class MemoryStore {
    constructor() {
      this.jobs = new Map();
      this.items = new Map();
      this.history = new Map();
      this.logs = [];
      this.kv = new Map();
      this.logId = 0;
    }

    async kvGet(key) {
      return clone(this.kv.get(key));
    }

    async kvSet(key, value) {
      this.kv.set(key, clone(value));
    }

    async kvDelete(key) {
      this.kv.delete(key);
    }

    async listJobs() {
      return [...this.jobs.values()].map(clone);
    }

    async putJob(job) {
      this.jobs.set(job.id, clone(job));
    }

    async deleteJob(jobId) {
      this.jobs.delete(jobId);
      for (const [key, item] of this.items) {
        if (item.jobId === jobId) {
          this.items.delete(key);
        }
      }
    }

    async getItems(jobId) {
      return [...this.items.values()].filter((item) => item.jobId === jobId).map(clone);
    }

    async putItems(items) {
      for (const item of items) {
        this.items.set(item.key, clone(item));
      }
    }

    async loadHistoryKeys() {
      return [...this.history.keys()];
    }

    async addHistory(entries) {
      for (const entry of entries) {
        this.history.set(entry.key, clone(entry));
      }
    }

    async clearHistory() {
      this.history.clear();
    }

    async addLogs(entries) {
      for (const entry of entries) {
        this.logs.push({ id: ++this.logId, ...entry });
      }
      if (this.logs.length > MAX_LOGS) {
        this.logs.splice(0, this.logs.length - MAX_LOGS);
      }
    }

    async getLogs(limit = MAX_LOGS) {
      return this.logs.slice(-limit).map(clone);
    }

    async clearLogs() {
      this.logs = [];
    }
  }

  function promisify(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("Transaction aborted"));
    });
  }

  class IdbStore {
    constructor(name = DB_NAME) {
      this.name = name;
      this.dbPromise = null;
      this.logCount = null;
    }

    db() {
      if (!this.dbPromise) {
        this.dbPromise = new Promise((resolve, reject) => {
          const request = indexedDB.open(this.name, DB_VERSION);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains("jobs")) {
              db.createObjectStore("jobs", { keyPath: "id" });
            }
            if (!db.objectStoreNames.contains("items")) {
              const items = db.createObjectStore("items", { keyPath: "key" });
              items.createIndex("jobId", "jobId", { unique: false });
            }
            if (!db.objectStoreNames.contains("history")) {
              db.createObjectStore("history", { keyPath: "key" });
            }
            if (!db.objectStoreNames.contains("logs")) {
              db.createObjectStore("logs", { keyPath: "id", autoIncrement: true });
            }
            if (!db.objectStoreNames.contains("kv")) {
              db.createObjectStore("kv");
            }
          };
          request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => db.close();
            resolve(db);
          };
          request.onerror = () => reject(request.error);
        });
      }
      return this.dbPromise;
    }

    async run(storeNames, mode, body) {
      const db = await this.db();
      const transaction = db.transaction(storeNames, mode);
      const done = transactionDone(transaction);
      const result = await body(transaction);
      await done;
      return result;
    }

    async kvGet(key) {
      return this.run("kv", "readonly", (tx) => promisify(tx.objectStore("kv").get(key)));
    }

    async kvSet(key, value) {
      await this.run("kv", "readwrite", (tx) => {
        tx.objectStore("kv").put(value, key);
      });
    }

    async kvDelete(key) {
      await this.run("kv", "readwrite", (tx) => {
        tx.objectStore("kv").delete(key);
      });
    }

    async listJobs() {
      return this.run("jobs", "readonly", (tx) => promisify(tx.objectStore("jobs").getAll()));
    }

    async putJob(job) {
      await this.run("jobs", "readwrite", (tx) => {
        tx.objectStore("jobs").put(job);
      });
    }

    async deleteJob(jobId) {
      await this.run(["jobs", "items"], "readwrite", async (tx) => {
        tx.objectStore("jobs").delete(jobId);
        const keys = await promisify(tx.objectStore("items").index("jobId").getAllKeys(jobId));
        const items = tx.objectStore("items");
        for (const key of keys) {
          items.delete(key);
        }
      });
    }

    async getItems(jobId) {
      return this.run("items", "readonly", (tx) => promisify(tx.objectStore("items").index("jobId").getAll(jobId)));
    }

    async putItems(list) {
      if (!list.length) {
        return;
      }
      await this.run("items", "readwrite", (tx) => {
        const store = tx.objectStore("items");
        for (const item of list) {
          store.put(item);
        }
      });
    }

    async loadHistoryKeys() {
      return this.run("history", "readonly", (tx) => promisify(tx.objectStore("history").getAllKeys()));
    }

    async addHistory(entries) {
      if (!entries.length) {
        return;
      }
      await this.run("history", "readwrite", (tx) => {
        const store = tx.objectStore("history");
        for (const entry of entries) {
          store.put(entry);
        }
      });
    }

    async clearHistory() {
      await this.run("history", "readwrite", (tx) => {
        tx.objectStore("history").clear();
      });
    }

    async addLogs(entries) {
      if (!entries.length) {
        return;
      }
      await this.run("logs", "readwrite", async (tx) => {
        const store = tx.objectStore("logs");
        for (const entry of entries) {
          store.add(entry);
        }
        if (this.logCount === null) {
          this.logCount = await promisify(store.count());
        } else {
          this.logCount += entries.length;
        }
        if (this.logCount > MAX_LOGS * 1.2) {
          // Ring buffer: drop the oldest rows in one cursor pass.
          let excess = this.logCount - MAX_LOGS;
          await new Promise((resolve, reject) => {
            const cursorRequest = store.openCursor();
            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result;
              if (!cursor || excess <= 0) {
                resolve();
                return;
              }
              cursor.delete();
              excess -= 1;
              cursor.continue();
            };
            cursorRequest.onerror = () => reject(cursorRequest.error);
          });
          this.logCount = MAX_LOGS;
        }
      });
    }

    async getLogs(limit = MAX_LOGS) {
      const all = await this.run("logs", "readonly", (tx) => promisify(tx.objectStore("logs").getAll()));
      return all.slice(-limit);
    }

    async clearLogs() {
      await this.run("logs", "readwrite", (tx) => {
        tx.objectStore("logs").clear();
      });
      this.logCount = 0;
    }
  }

  globalObject.MaxDownloaderStore = Object.freeze({ MemoryStore, IdbStore, itemKey, MAX_LOGS });
})(globalThis);
