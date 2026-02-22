// https://github.com/zero-peak/ZeroOmega/commit/6c56da0360a7c4940418b5221b8331565c994d20
import Storage from './storage';

declare const idbKeyval: any;

let _globalLocalStorageCache: boolean | null = null;

class BrowserStorage extends Storage {
  storage: Storage;
  prefix: string;
  proto: any;

  constructor(storage: any, prefix = '') {
    super();
    this.storage = storage;
    this.prefix = prefix;
    this.proto = Object.getPrototypeOf(storage);
  }

  get(keys: string | string[] | null | Record<string, any>): Promise<Record<string, any>> {
    const promiseResult = idbKeyval.get('localStorage').then((initValuesMap: any) => {
      if (!_globalLocalStorageCache) {
        this.proto.initValuesMap(initValuesMap);
        _globalLocalStorageCache = true;
      }
      const map: Record<string, any> = {};
      if (typeof keys === 'string') {
        map[keys] = undefined;
      } else if (Array.isArray(keys)) {
        for (const key of keys) map[key] = undefined;
      } else if (typeof keys === 'object' && keys !== null) {
        Object.assign(map, keys);
      }
      for (const key of Object.keys(map)) {
        let value: any;
        try {
          value = JSON.parse(this.proto.getItem.call(this.storage, this.prefix + key));
        } catch (e) {
          console.log('get ', this.prefix + key, 'failed');
        }
        if (value != null) map[key] = value;
        console.log('get ', key, value);
        if (typeof map[key] === 'undefined') delete map[key];
      }
      return map;
    });
    return Promise.resolve(promiseResult);
  }

  set(items: Record<string, any>): Promise<Record<string, any>> {
    const promiseResult = idbKeyval.get('localStorage').then((initValuesMap: any) => {
      if (!_globalLocalStorageCache) {
        this.proto.initValuesMap(initValuesMap);
        _globalLocalStorageCache = true;
      }
      for (const [key, value] of Object.entries(items)) {
        const serialized = JSON.stringify(value);
        this.proto.setItem.call(this.storage, this.prefix + key, serialized);
        console.log('set ', this.prefix + key, serialized);
      }
      return items;
    }).then((items: any) => {
      const initValuesMap = this.proto.getValuesMap();
      return idbKeyval.set('localStorage', initValuesMap).then(() => items);
    });
    return Promise.resolve(promiseResult);
  }

  remove(keys?: string | string[] | null): Promise<void> {
    const promiseResult = idbKeyval.get('localStorage').then((initValuesMap: any) => {
      if (!_globalLocalStorageCache) {
        this.proto.initValuesMap(initValuesMap);
        _globalLocalStorageCache = true;
      }
      if (keys == null) {
        if (!this.prefix) {
          this.proto.clear.call(this.storage);
        } else {
          let index = 0;
          while (true) {
            const key = this.proto.key.call(index);
            if (key === null) break;
            if (key.substr(0, this.prefix.length) === this.prefix) {
              this.proto.removeItem.call(this.storage, this.prefix + keys);
            } else {
              index++;
            }
          }
        }
      } else if (typeof keys === 'string') {
        this.proto.removeItem.call(this.storage, this.prefix + keys);
      } else {
        for (const key of keys) this.proto.removeItem.call(this.storage, this.prefix + key);
      }
    }).then(() => {
      const initValuesMap = this.proto.getValuesMap();
      return idbKeyval.set('localStorage', initValuesMap).then(() => undefined);
    });
    return Promise.resolve(promiseResult);
  }
}

module.exports = BrowserStorage;
export default BrowserStorage;
