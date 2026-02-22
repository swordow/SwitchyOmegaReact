/** @module omega-target/options_sync */
import Storage from './storage';
import Log from './log';
import { Revision } from 'omega-pac';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jsondiffpatch = require('jsondiffpatch');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TokenBucket } = require('limiter');

class OptionsSync {
  static TokenBucket = TokenBucket;

  _timeout: ReturnType<typeof setTimeout> | null = null;
  _bucket: any;
  _waiting = false;
  _pending: Record<string, any> = {};

  debounce = 1000;
  pullThrottle = 1000;
  storage: Storage;
  enabled = true;

  private static _diff = jsondiffpatch.create({
    objectHash: (obj: any) => JSON.stringify(obj),
    textDiff: { minLength: Infinity },
  });

  constructor(storage: Storage, bucket?: any) {
    this.storage = storage;
    this._pending = {};
    this._bucket = bucket ?? new TokenBucket(10, 10, 'minute', null);
    if (!this._bucket.clear) {
      this._bucket.clear = () => {
        this._bucket.tryRemoveTokens(this._bucket.content);
      };
    }
  }

  transformValue(v: any, _key?: string): any {
    return v;
  }

  merge(key: string, newVal: any, oldVal: any): any {
    if (newVal === oldVal) return oldVal;
    if (oldVal?.syncOptions === 'disabled' || newVal?.syncOptions === 'disabled') return oldVal;
    if (oldVal?.revision != null && newVal?.revision != null) {
      const result = Revision.compare(oldVal.revision, newVal.revision);
      if (result >= 0) return oldVal;
    }
    if (!OptionsSync._diff.diff(oldVal, newVal)) return oldVal;
    return newVal;
  }

  requestPush(changes: Record<string, any>): void {
    if (this._timeout != null) clearTimeout(this._timeout);
    for (const [key, value] of Object.entries(changes)) {
      if (typeof value !== 'undefined') {
        const transformed = this.transformValue(value, key);
        if (typeof transformed === 'undefined') continue;
        this._pending[key] = transformed;
      } else {
        this._pending[key] = value;
      }
    }
    if (!this.enabled) return;
    this._timeout = setTimeout(this._doPush.bind(this), this.debounce);
  }

  pendingChanges(): Record<string, any> {
    return this._pending;
  }

  _doPush(): void {
    this._timeout = null;
    if (this._waiting) return;
    this._waiting = true;
    this._bucket.removeTokens(1, () => {
      this.storage.get(null).then((base) => {
        const changes = this._pending;
        this._pending = {};
        this._waiting = false;
        return Storage.operationsForChanges(changes, { base, merge: this.merge.bind(this) });
      }).then(({ set, remove }) => {
        const doSet: Promise<number> =
          Object.keys(set).length === 0
            ? Promise.resolve(0)
            : (Log.log('OptionsSync::set', set), this.storage.set(set).then(() => 1));
        return doSet.then((cost) => {
          const s = set;
          if (remove.length > 0) {
            if (this._bucket.tryRemoveTokens(cost)) {
              Log.log('OptionsSync::remove', remove);
              return this.storage.remove(remove);
            } else {
              return Promise.reject('bucket');
            }
          }
          return Promise.resolve();
        }).catch((e: any) => {
          for (const [key, value] of Object.entries(set)) {
            if (!(key in this._pending)) this._pending[key] = value;
          }
          for (const key of remove) {
            if (!(key in this._pending)) this._pending[key] = undefined;
          }
          if (e === 'bucket') {
            this._doPush();
          } else if (e instanceof Storage.RateLimitExceededError) {
            Log.log('OptionsSync::rateLimitExceeded');
            this._bucket.clear();
            this.requestPush({});
          } else if (e instanceof Storage.QuotaExceededError) {
            let valuesAffected = 0;
            for (const [key, value] of Object.entries(set)) {
              if (key[0] === '+' && value.syncOptions !== 'disabled') {
                value.syncOptions = 'disabled';
                value.syncError = { reason: 'quotaPerItem' };
                valuesAffected++;
              }
            }
            if (valuesAffected > 0) {
              this.requestPush({});
            } else {
              this._pending = {};
            }
          } else {
            return Promise.reject(e);
          }
        });
      });
    });
  }

  _logOperations(text: string, operations: { set: Record<string, any>; remove: string[] }): void {
    if (Object.keys(operations.set).length) Log.log(text + '::set', operations.set);
    if (operations.remove.length) Log.log(text + '::remove', operations.remove);
  }

  copyTo(local: Storage): Promise<any> {
    return Promise.all([local.get(null), this.storage.get(null)]).then(([base, changes]) => {
      for (const key of Object.keys(base)) {
        if (!(key in changes) && key[0] === '+' && base[key]?.syncOptions !== 'disabled') {
          changes[key] = undefined;
        }
      }
      return local.apply({ changes, base, merge: this.merge.bind(this) }).then((operations: any) => {
        this._logOperations('OptionsSync::copyTo', operations);
      });
    });
  }

  watchAndPull(local: Storage): () => void {
    let pullScheduled: ReturnType<typeof setTimeout> | null = null;
    let pull: Record<string, any> = {};
    const doPull = () => {
      local.get(null).then((base) => {
        const changes = pull;
        pull = {};
        pullScheduled = null;
        return Storage.operationsForChanges(changes, { base, merge: this.merge.bind(this) });
      }).then((operations) => {
        this._logOperations('OptionsSync::pull', operations);
        return local.apply(operations);
      });
    };
    return this.storage.watch(null, (changes) => {
      for (const [key, value] of Object.entries(changes)) {
        pull[key] = value;
      }
      if (pullScheduled != null) return;
      pullScheduled = setTimeout(doPull, this.pullThrottle);
    });
  }
}

module.exports = OptionsSync;
export default OptionsSync;
