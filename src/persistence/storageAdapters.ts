import type { StorageAdapter } from "./types";

export interface MinimalWebStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  length?: number;
  key?: (index: number) => string | null;
}

/**
 * Adapter basato su localStorage (o storage iniettabile per test deterministici).
 */
export class LocalStorageAdapter implements StorageAdapter {
  readonly name = "LocalStorageAdapter";
  private readonly storage: MinimalWebStorage | null;

  constructor(storage?: MinimalWebStorage | null) {
    if (storage !== undefined) {
      this.storage = storage;
    } else if (typeof window !== "undefined" && window.localStorage) {
      this.storage = window.localStorage;
    } else {
      this.storage = null;
    }
  }

  isAvailable(): boolean {
    return this.storage !== null;
  }

  getItem(key: string): string | null {
    if (!this.storage) return null;
    try {
      return this.storage.getItem(key);
    } catch {
      return null;
    }
  }

  setItem(key: string, value: string): void {
    if (!this.storage) return;
    this.storage.setItem(key, value);
  }

  removeItem(key: string): void {
    if (!this.storage) return;
    this.storage.removeItem(key);
  }

  keys(): string[] {
    if (!this.storage) return [];
    if (typeof this.storage.length === "number" && typeof this.storage.key === "function") {
      const result: string[] = [];
      for (let i = 0; i < this.storage.length; i++) {
        const k = this.storage.key(i);
        if (k) result.push(k);
      }
      return result;
    }
    return [];
  }
}

/**
 * Adapter in-memory di fallback per ambienti senza Web Storage.
 */
export class MemoryStorageAdapter implements StorageAdapter {
  readonly name = "MemoryStorageAdapter";
  private readonly map = new Map<string, string>();

  isAvailable(): boolean {
    return true;
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  keys(): string[] {
    return Array.from(this.map.keys());
  }
}

/**
 * Mirror asincrono su IndexedDB quando disponibile nel browser (Chrome Android / Desktop).
 * Mantiene LocalStorageAdapter come layer sincrono immediato e fallback compatibile.
 */
export class IndexedDbMirror {
  private readonly dbName = "aura_operational_db_v1";
  private readonly storeName = "kv_store";

  isSupported(): boolean {
    return typeof indexedDB !== "undefined";
  }

  private openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async put(key: string, value: string): Promise<void> {
    if (!this.isSupported()) return;
    try {
      const db = await this.openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(this.storeName, "readwrite");
        tx.objectStore(this.storeName).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch {
      // Fallback silenzioso su LocalStorageAdapter
    }
  }

  async delete(key: string): Promise<void> {
    if (!this.isSupported()) return;
    try {
      const db = await this.openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(this.storeName, "readwrite");
        tx.objectStore(this.storeName).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch {
      // Fallback silenzioso
    }
  }
}
