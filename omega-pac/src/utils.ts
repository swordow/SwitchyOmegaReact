import * as tld from 'tldjs';
import * as Url from 'url';

export const Revision = {
  fromTime(time?: string | number | Date): string {
    const t = time ? new Date(time as any) : new Date();
    return t.getTime().toString(16);
  },
  compare(a: string | null | undefined, b: string | null | undefined): number {
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    if (a.length > b.length) return 1;
    if (a.length < b.length) return -1;
    if (a > b) return 1;
    if (a < b) return -1;
    return 0;
  },
};

export interface CacheEntry<T> {
  tag: string;
  value: T;
}

export class AttachedCache<T = any> {
  prop: string;
  tag: (obj: any) => string;

  constructor(optPropOrTag: string | ((obj: any) => string), tag?: (obj: any) => string) {
    if (typeof optPropOrTag === 'function') {
      this.tag = optPropOrTag;
      this.prop = '_cache';
    } else {
      this.prop = optPropOrTag;
      this.tag = tag as (obj: any) => string;
    }
  }

  get(obj: any, otherwise: T | (() => T)): T {
    const tag = this.tag(obj);
    const cache = this._getCache(obj);
    if (cache != null && cache.tag === tag) {
      return cache.value;
    }
    const value = typeof otherwise === 'function' ? (otherwise as () => T)() : otherwise;
    this._setCache(obj, { tag, value });
    return value;
  }

  drop(obj: any): void {
    if (obj[this.prop] != null) {
      obj[this.prop] = undefined;
    }
  }

  _getCache(obj: any): CacheEntry<T> | undefined {
    return obj[this.prop];
  }

  _setCache(obj: any, value: CacheEntry<T>): void {
    if (!Object.prototype.hasOwnProperty.call(obj, this.prop)) {
      Object.defineProperty(obj, this.prop, { writable: true, enumerable: false, configurable: true });
    }
    obj[this.prop] = value;
  }
}

export function isIp(domain: string): boolean {
  if (domain.indexOf(':') > 0) return true; // IPv6
  const lastCharCode = domain.charCodeAt(domain.length - 1);
  if (48 <= lastCharCode && lastCharCode <= 57) return true; // ends with digit
  return false;
}

export function getBaseDomain(domain: string): string {
  if (isIp(domain)) return domain;
  return (tld as any).getDomain(domain) ?? domain;
}

export function wildcardForDomain(domain: string): string {
  if (isIp(domain)) return domain;
  return '*.' + getBaseDomain(domain);
}

export function wildcardForUrl(url: string): string {
  const domain = Url.parse(url).hostname || '';
  return wildcardForDomain(domain);
}
