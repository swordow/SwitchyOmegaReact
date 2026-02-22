/** @module omega-target/storage */
import Log from './log';

export interface StorageChange<T = any> {
  oldValue?: T;
  newValue?: T;
}

export interface WriteOperations {
  set: Record<string, any>;
  remove: string[];
}

export type WatchCallback = (changes: Record<string, any>) => void;

class Storage {
  static RateLimitExceededError = class RateLimitExceededError extends Error {
    constructor() { super('Rate limit exceeded'); this.name = 'RateLimitExceededError'; }
  };

  static QuotaExceededError = class QuotaExceededError extends Error {
    constructor() { super('Quota exceeded'); this.name = 'QuotaExceededError'; }
  };

  static StorageUnavailableError = class StorageUnavailableError extends Error {
    constructor() { super('Storage unavailable'); this.name = 'StorageUnavailableError'; }
  };

  _items: Record<string, any> | null = null;

  static operationsForChanges(
    changes: Record<string, any>,
    { base, merge }: { base?: Record<string, any>; merge?: (key: string, newVal: any, oldVal: any) => any } = {}
  ): WriteOperations {
    const set: Record<string, any> = {};
    const remove: string[] = [];
    for (const [key, newValRaw] of Object.entries(changes)) {
      let newVal = newValRaw;
      const oldVal = base != null ? base[key] : newVal;
      if (merge) newVal = merge(key, newVal, oldVal);
      if (base != null && newVal === oldVal) continue;
      if (typeof newVal === 'undefined') {
        if (typeof oldVal !== 'undefined' || base == null) remove.push(key);
      } else {
        set[key] = newVal;
      }
    }
    return { set, remove };
  }

  get(keys: string | string[] | null | Record<string, any>): Promise<Record<string, any>> {
    Log.method('Storage#get', this, arguments);
    if (!this._items) return Promise.resolve({});
    const map: Record<string, any> = {};
    if (keys == null) {
      return Promise.resolve({ ...this._items });
    } else if (typeof keys === 'string') {
      map[keys] = this._items[keys];
    } else if (Array.isArray(keys)) {
      for (const key of keys) map[key] = this._items[key];
    } else if (typeof keys === 'object') {
      for (const [key, defaultVal] of Object.entries(keys)) {
        map[key] = this._items[key] ?? defaultVal;
      }
    }
    return Promise.resolve(map);
  }

  set(items: Record<string, any>): Promise<Record<string, any>> {
    Log.method('Storage#set', this, arguments);
    if (!this._items) this._items = {};
    for (const [key, value] of Object.entries(items)) {
      this._items[key] = value;
    }
    return Promise.resolve(items);
  }

  remove(keys?: string | string[] | null): Promise<void> {
    Log.method('Storage#remove', this, arguments);
    if (this._items) {
      if (keys == null) {
        this._items = {};
      } else if (Array.isArray(keys)) {
        for (const key of keys) delete this._items[key];
      } else {
        delete this._items[keys];
      }
    }
    return Promise.resolve();
  }

  watch(_keys: string | string[] | null, _callback: WatchCallback): () => void {
    Log.method('Storage#watch', this, arguments);
    return () => null;
  }

  apply(operations: WriteOperations | { changes: Record<string, any>; [key: string]: any }): Promise<WriteOperations> {
    if ('changes' in operations) {
      const ops = Storage.operationsForChanges(operations.changes, operations as any);
      return this.set(ops.set).then(() => this.remove(ops.remove)).then(() => ops);
    }
    return this.set(operations.set).then(() => this.remove(operations.remove)).then(() => operations as WriteOperations);
  }
}

module.exports = Storage;
export default Storage;
