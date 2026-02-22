// eslint-disable-next-line @typescript-eslint/no-var-requires
const U2: any = require('uglify-js');
import ShexpUtils from './shexp_utils';
import Conditions from './conditions';
import RuleList from './rule_list';
import { AttachedCache, Revision } from './utils';

// Custom AST node for inserting raw code
class AST_Raw extends U2.AST_SymbolRef {
  constructor(raw: string) {
    super({ name: raw });
    this.aborts = () => false;
  }
}

export interface ProxyServer {
  scheme: string;
  host: string;
  port: number;
}

export interface Profile {
  name: string;
  profileType: string;
  color?: string;
  builtin?: boolean;
  revision?: string;
  [key: string]: any;
}

export interface SchemeEntry {
  scheme: string;
  prop: string;
}

export interface ProfileHandler {
  includable?: boolean | ((this: typeof exports, profile: Profile) => boolean);
  inclusive?: boolean;
  create?: (this: typeof exports, profile: Profile) => void;
  directReferenceSet?: (this: typeof exports, profile: Profile) => Record<string, string>;
  analyze?: (this: typeof exports, profile: Profile) => any;
  replaceRef?: (this: typeof exports, profile: Profile, fromName: string, toName: string) => boolean;
  match?: (this: typeof exports, profile: Profile, request: any, cache: any) => any;
  compile: (this: typeof exports, profile: Profile, cache?: any) => any;
  updateUrl?: (this: typeof exports, profile: Profile) => string | undefined;
  updateContentTypeHints?: (this: typeof exports, profile: Profile) => string[];
  update?: (this: typeof exports, profile: Profile, data: string) => boolean;
}

const exports = {
  builtinProfiles: {
    '+direct': {
      name: 'direct',
      profileType: 'DirectProfile',
      color: '#aaaaaa',
      builtin: true,
    },
    '+system': {
      name: 'system',
      profileType: 'SystemProfile',
      color: '#000000',
      builtin: true,
    },
  } as Record<string, Profile>,

  schemes: [
    { scheme: 'http', prop: 'proxyForHttp' },
    { scheme: 'https', prop: 'proxyForHttps' },
    { scheme: 'ftp', prop: 'proxyForFtp' },
    { scheme: '', prop: 'fallbackProxy' },
  ] as SchemeEntry[],

  pacProtocols: {
    http: 'PROXY',
    https: 'HTTPS',
    socks4: 'SOCKS',
    socks5: 'SOCKS5',
  } as Record<string, string>,

  formatByType: {
    SwitchyRuleListProfile: 'Switchy',
    AutoProxyRuleListProfile: 'AutoProxy',
  } as Record<string, string>,

  ruleListFormats: ['Switchy', 'AutoProxy'],

  parseHostPort(str: string, scheme: string): ProxyServer | undefined {
    const sep = str.lastIndexOf(':');
    if (sep < 0) return undefined;
    const port = parseInt(str.substr(sep + 1)) || 80;
    const host = str.substr(0, sep);
    if (!host) return undefined;
    return { scheme, host, port };
  },

  pacResult(proxy?: ProxyServer): string {
    if (proxy) {
      if (proxy.scheme === 'socks5') {
        return `SOCKS5 ${proxy.host}:${proxy.port}; SOCKS ${proxy.host}:${proxy.port}`;
      }
      return `${exports.pacProtocols[proxy.scheme]} ${proxy.host}:${proxy.port}`;
    }
    return 'DIRECT';
  },

  isFileUrl(url?: string): boolean {
    return !!(url?.substr(0, 5).toUpperCase() === 'FILE:');
  },

  nameAsKey(profileName: string | Profile): string {
    if (typeof profileName !== 'string') {
      profileName = profileName.name;
    }
    return '+' + profileName;
  },

  byName(profileName: string | Profile, options: Record<string, Profile>): Profile | undefined {
    if (typeof profileName === 'string') {
      const key = exports.nameAsKey(profileName);
      return exports.builtinProfiles[key] ?? options[key];
    }
    return profileName;
  },

  byKey(key: string | Profile, options: Record<string, Profile>): Profile | undefined {
    if (typeof key === 'string') {
      return exports.builtinProfiles[key] ?? options[key];
    }
    return key;
  },

  each(options: Record<string, any>, callback: (key: string, profile: Profile) => void): void {
    const charCodePlus = '+'.charCodeAt(0);
    for (const [key, profile] of Object.entries(options)) {
      if (key.charCodeAt(0) === charCodePlus) callback(key, profile);
    }
    for (const [key, profile] of Object.entries(exports.builtinProfiles)) {
      if (key.charCodeAt(0) === charCodePlus) callback(key, profile);
    }
  },

  profileResult(profileName: string): any {
    const key = exports.nameAsKey(profileName);
    const val = key === '+direct' ? exports.pacResult() : key;
    return new U2.AST_String({ value: val });
  },

  isIncludable(profile: Profile): boolean {
    const includable = exports._handler(profile).includable;
    if (typeof includable === 'function') {
      return !!(includable as Function).call(exports, profile);
    }
    return !!includable;
  },

  isInclusive(profile: Profile): boolean {
    return !!exports._handler(profile).inclusive;
  },

  updateUrl(profile: Profile): string | undefined {
    return exports._handler(profile).updateUrl?.call(exports, profile);
  },

  updateContentTypeHints(profile: Profile): string[] | undefined {
    return exports._handler(profile).updateContentTypeHints?.call(exports, profile);
  },

  update(profile: Profile, data: string): boolean {
    return exports._handler(profile).update!.call(exports, profile, data);
  },

  tag(profile: Profile): string {
    return exports._profileCache.tag(profile);
  },

  create(profile: string | Profile, opt_profileType?: string): Profile {
    if (typeof profile === 'string') {
      profile = { name: profile, profileType: opt_profileType! };
    } else if (opt_profileType) {
      profile.profileType = opt_profileType;
    }
    const create = exports._handler(profile).create;
    if (create) create.call(exports, profile);
    return profile;
  },

  updateRevision(profile: Profile, revision?: string): void {
    profile.revision = revision ?? Revision.fromTime();
  },

  replaceRef(profile: Profile, fromName: string, toName: string): boolean {
    if (!exports.isInclusive(profile)) return false;
    return exports._handler(profile).replaceRef!.call(exports, profile, fromName, toName);
  },

  analyze(profile: Profile): any {
    const cache = exports._profileCache.get(profile, () => ({}));
    if (!Object.prototype.hasOwnProperty.call(cache, 'analyzed')) {
      const analyzeFn = exports._handler(profile).analyze;
      cache.analyzed = analyzeFn?.call(exports, profile);
    }
    return cache;
  },

  dropCache(profile: Profile): void {
    exports._profileCache.drop(profile);
  },

  directReferenceSet(profile: Profile): Record<string, string> {
    if (!exports.isInclusive(profile)) return {};
    const cache = exports._profileCache.get(profile, () => ({}));
    if (cache.directReferenceSet) return cache.directReferenceSet;
    cache.directReferenceSet = exports._handler(profile).directReferenceSet!.call(exports, profile);
    return cache.directReferenceSet;
  },

  profileNotFound(name: string, action?: any): Profile | null {
    if (action == null) {
      throw new Error(`Profile ${name} does not exist!`);
    }
    if (typeof action === 'function') {
      action = action(name);
    }
    if (typeof action === 'object' && action.profileType) {
      return action;
    }
    switch (action) {
      case 'ignore':
        return null;
      case 'dumb':
        return exports.create({
          name,
          profileType: 'VirtualProfile',
          defaultProfileName: 'direct',
        });
    }
    throw action;
  },

  allReferenceSet(
    profile: string | Profile,
    options: Record<string, Profile>,
    opt_args?: any
  ): Record<string, string> {
    const o_profile = profile;
    const resolved = exports.byName(profile as any, options);
    const p = resolved ?? exports.profileNotFound?.(o_profile as string, opt_args?.profileNotFound);
    opt_args = opt_args ?? {};
    const has_out = opt_args.out != null;
    const result: Record<string, string> = opt_args.out ?? {};
    opt_args.out = result;
    if (p) {
      result[exports.nameAsKey(p.name)] = p.name;
      for (const [key, name] of Object.entries(exports.directReferenceSet(p))) {
        exports.allReferenceSet(name, options, opt_args);
      }
    }
    if (!has_out) delete opt_args.out;
    return result;
  },

  referencedBySet(
    profile: string | Profile,
    options: Record<string, Profile>,
    opt_args?: any
  ): Record<string, string> {
    const profileKey = exports.nameAsKey(profile as any);
    opt_args = opt_args ?? {};
    const has_out = opt_args.out != null;
    const result: Record<string, string> = opt_args.out ?? {};
    opt_args.out = result;
    exports.each(options, (key, prof) => {
      if (exports.directReferenceSet(prof)[profileKey]) {
        result[key] = prof.name;
        exports.referencedBySet(prof, options, opt_args);
      }
    });
    if (!has_out) delete opt_args.out;
    return result;
  },

  validResultProfilesFor(profile: string | Profile, options: Record<string, Profile>): Profile[] {
    const p = exports.byName(profile as any, options);
    if (!p || !exports.isInclusive(p)) return [];
    const profileKey = exports.nameAsKey(p);
    const ref = exports.referencedBySet(p, options);
    ref[profileKey] = profileKey;
    const result: Profile[] = [];
    exports.each(options, (key, prof) => {
      if (!ref[key] && exports.isIncludable(prof)) result.push(prof);
    });
    return result;
  },

  match(profile: Profile, request: any, opt_profileType?: string): any {
    const type = opt_profileType ?? profile.profileType;
    const cache = exports.analyze(profile);
    const matchFn = exports._handler(type).match;
    return matchFn?.call(exports, profile, request, cache);
  },

  compile(profile: Profile, opt_profileType?: string): any {
    const type = opt_profileType ?? profile.profileType;
    const cache = exports.analyze(profile);
    if (cache.compiled) return cache.compiled;
    cache.compiled = exports._handler(type).compile.call(exports, profile, cache);
    return cache.compiled;
  },

  _profileCache: new AttachedCache((profile: Profile) => profile.revision),

  _handler(profileType: string | Profile): ProfileHandler {
    if (typeof profileType !== 'string') {
      profileType = profileType.profileType;
    }
    let handler: any = profileType;
    while (typeof handler === 'string') {
      handler = exports._profileTypes[handler];
    }
    if (handler == null) {
      throw new Error(`Unknown profile type: ${profileType}`);
    }
    return handler;
  },

  _profileTypes: {
    SystemProfile: {
      compile(_profile: Profile) {
        throw new Error('SystemProfile cannot be used in PAC scripts');
      },
    },

    DirectProfile: {
      includable: true,
      compile(this: typeof exports, _profile: Profile) {
        return new U2.AST_String({ value: this.pacResult() });
      },
    },

    FixedProfile: {
      includable: true,
      create(_profile: Profile) {
        if (!_profile.bypassList) {
          _profile.bypassList = [
            { conditionType: 'BypassCondition', pattern: '127.0.0.1' },
            { conditionType: 'BypassCondition', pattern: '[::1]' },
            { conditionType: 'BypassCondition', pattern: 'localhost' },
          ];
        }
      },
      match(this: typeof exports, profile: Profile, request: any) {
        if (profile.bypassList) {
          for (const cond of profile.bypassList) {
            if (Conditions.match(cond, request)) {
              return [this.pacResult(), cond, { scheme: 'direct' }, undefined];
            }
          }
        }
        for (const s of this.schemes) {
          if (s.scheme === request.scheme && profile[s.prop]) {
            return [
              this.pacResult(profile[s.prop]),
              s.scheme,
              profile[s.prop],
              profile.auth?.[s.prop] ?? profile.auth?.['all'],
            ];
          }
        }
        return [
          this.pacResult(profile.fallbackProxy),
          '',
          profile.fallbackProxy,
          profile.auth?.fallbackProxy ?? profile.auth?.['all'],
        ];
      },
      compile(this: typeof exports, profile: Profile) {
        if (
          (!profile.bypassList || !profile.fallbackProxy) &&
          !profile.proxyForHttp &&
          !profile.proxyForHttps &&
          !profile.proxyForFtp
        ) {
          return new U2.AST_String({ value: this.pacResult(profile.fallbackProxy) });
        }
        const body: any[] = [new U2.AST_Directive({ value: 'use strict' })];
        if (profile.bypassList?.length) {
          let conditions: any = null;
          for (const cond of profile.bypassList) {
            const condition = Conditions.compile(cond);
            conditions = conditions
              ? new U2.AST_Binary({ left: conditions, operator: '||', right: condition })
              : condition;
          }
          body.push(new U2.AST_If({
            condition: conditions,
            body: new U2.AST_Return({ value: new U2.AST_String({ value: this.pacResult() }) }),
          }));
        }
        if (!profile.proxyForHttp && !profile.proxyForHttps && !profile.proxyForFtp) {
          body.push(new U2.AST_Return({ value: new U2.AST_String({ value: this.pacResult(profile.fallbackProxy) }) }));
        } else {
          body.push(new U2.AST_Switch({
            expression: new U2.AST_SymbolRef({ name: 'scheme' }),
            body: this.schemes
              .filter(s => !s.scheme || profile[s.prop])
              .map(s => {
                const ret = [new U2.AST_Return({ value: new U2.AST_String({ value: this.pacResult(profile[s.prop]) }) })];
                return s.scheme
                  ? new U2.AST_Case({ expression: new U2.AST_String({ value: s.scheme }), body: ret })
                  : new U2.AST_Default({ body: ret });
              }),
          }));
        }
        return new U2.AST_Function({
          argnames: [
            new U2.AST_SymbolFunarg({ name: 'url' }),
            new U2.AST_SymbolFunarg({ name: 'host' }),
            new U2.AST_SymbolFunarg({ name: 'scheme' }),
          ],
          body,
        });
      },
    },

    PacProfile: {
      includable(this: typeof exports, profile: Profile) {
        return !this.isFileUrl(profile.pacUrl);
      },
      create(_profile: Profile) {
        if (!_profile.pacScript) {
          _profile.pacScript = `function FindProxyForURL(url, host) {\n  return "DIRECT";\n}`;
        }
      },
      compile(_profile: Profile) {
        return new U2.AST_Call({
          args: [new U2.AST_This()],
          expression: new U2.AST_Dot({
            property: 'call',
            expression: new U2.AST_Function({
              argnames: [],
              body: [
                new AST_Raw(';\n' + _profile.pacScript + '\n\n/* End of PAC */;'),
                new U2.AST_Return({ value: new U2.AST_SymbolRef({ name: 'FindProxyForURL' }) }),
              ],
            }),
          }),
        });
      },
      updateUrl(this: typeof exports, profile: Profile) {
        return this.isFileUrl(profile.pacUrl) ? undefined : profile.pacUrl;
      },
      updateContentTypeHints() {
        return [
          '!text/html',
          '!application/xhtml+xml',
          'application/x-ns-proxy-autoconfig',
          'application/x-javascript-config',
        ];
      },
      update(_profile: Profile, data: string) {
        if (_profile.pacScript === data) return false;
        _profile.pacScript = data;
        return true;
      },
    },

    AutoDetectProfile: 'PacProfile',

    SwitchProfile: {
      includable: true,
      inclusive: true,
      create(_profile: Profile) {
        if (!_profile.defaultProfileName) _profile.defaultProfileName = 'direct';
        if (!_profile.rules) _profile.rules = [];
      },
      directReferenceSet(_profile: Profile) {
        const refs: Record<string, string> = {};
        refs[exports.nameAsKey(_profile.defaultProfileName)] = _profile.defaultProfileName;
        for (const rule of _profile.rules) {
          refs[exports.nameAsKey(rule.profileName)] = rule.profileName;
        }
        return refs;
      },
      analyze(_profile: Profile) {
        return _profile.rules;
      },
      replaceRef(_profile: Profile, fromName: string, toName: string) {
        let changed = false;
        if (_profile.defaultProfileName === fromName) {
          _profile.defaultProfileName = toName;
          changed = true;
        }
        for (const rule of _profile.rules) {
          if (rule.profileName === fromName) {
            rule.profileName = toName;
            changed = true;
          }
        }
        return changed;
      },
      match(this: typeof exports, _profile: Profile, request: any, cache: any) {
        for (const rule of cache.analyzed) {
          if (Conditions.match(rule.condition, request)) return rule;
        }
        return [exports.nameAsKey(_profile.defaultProfileName), null];
      },
      compile(this: typeof exports, _profile: Profile, cache: any) {
        const rules = cache.analyzed;
        if (rules.length === 0) return this.profileResult(_profile.defaultProfileName);
        const body: any[] = [new U2.AST_Directive({ value: 'use strict' })];
        for (const rule of rules) {
          body.push(new U2.AST_If({
            condition: Conditions.compile(rule.condition),
            body: new U2.AST_Return({ value: this.profileResult(rule.profileName) }),
          }));
        }
        body.push(new U2.AST_Return({ value: this.profileResult(_profile.defaultProfileName) }));
        return new U2.AST_Function({
          argnames: [
            new U2.AST_SymbolFunarg({ name: 'url' }),
            new U2.AST_SymbolFunarg({ name: 'host' }),
            new U2.AST_SymbolFunarg({ name: 'scheme' }),
          ],
          body,
        });
      },
    },

    VirtualProfile: 'SwitchProfile',

    RuleListProfile: {
      includable: true,
      inclusive: true,
      create(_profile: Profile) {
        if (!_profile.profileType) _profile.profileType = 'RuleListProfile';
        _profile.format = _profile.format ?? (exports.formatByType[_profile.profileType] ?? 'Switchy');
        if (!_profile.defaultProfileName) _profile.defaultProfileName = 'direct';
        if (!_profile.matchProfileName) _profile.matchProfileName = 'direct';
        if (_profile.ruleList == null) _profile.ruleList = '';
      },
      directReferenceSet(_profile: Profile) {
        if (_profile.ruleList != null) {
          const refs = (RuleList as any)[_profile.format]?.directReferenceSet?.(_profile);
          if (refs) return refs;
        }
        const refs: Record<string, string> = {};
        for (const name of [_profile.matchProfileName, _profile.defaultProfileName]) {
          refs[exports.nameAsKey(name)] = name;
        }
        return refs;
      },
      replaceRef(_profile: Profile, fromName: string, toName: string) {
        let changed = false;
        if (_profile.defaultProfileName === fromName) { _profile.defaultProfileName = toName; changed = true; }
        if (_profile.matchProfileName === fromName) { _profile.matchProfileName = toName; changed = true; }
        return changed;
      },
      analyze(_profile: Profile) {
        const format = _profile.format ?? exports.formatByType[_profile.profileType];
        const formatHandler = (RuleList as any)[format];
        if (!formatHandler) throw new Error(`Unsupported rule list format ${format}!`);
        let ruleList = (_profile.ruleList?.trim()) ?? '';
        if (formatHandler.preprocess) ruleList = formatHandler.preprocess(ruleList);
        return formatHandler.parse(ruleList, _profile.matchProfileName, _profile.defaultProfileName);
      },
      match(this: typeof exports, _profile: Profile, request: any) {
        return this.match(_profile, request, 'SwitchProfile');
      },
      compile(this: typeof exports, _profile: Profile) {
        return this.compile(_profile, 'SwitchProfile');
      },
      updateUrl(_profile: Profile) { return _profile.sourceUrl; },
      updateContentTypeHints() {
        return ['!text/html', '!application/xhtml+xml', 'text/plain', '*'];
      },
      update(_profile: Profile, data: string) {
        data = data.trim();
        const original = _profile.format ?? exports.formatByType[_profile.profileType];
        _profile.profileType = 'RuleListProfile';
        let format = original;
        if ((RuleList as any)[format]?.detect?.(data) === false) format = null;
        for (const formatName of Object.keys(RuleList as any)) {
          const result = (RuleList as any)[formatName]?.detect?.(data);
          if (result === true || (result !== false && !format)) {
            _profile.format = format = formatName;
          }
        }
        format = format ?? original;
        const formatHandler = (RuleList as any)[format];
        if (formatHandler.preprocess) data = formatHandler.preprocess(data);
        if (_profile.ruleList === data) return false;
        _profile.ruleList = data;
        return true;
      },
    },

    SwitchyRuleListProfile: 'RuleListProfile',
    AutoProxyRuleListProfile: 'RuleListProfile',
  } as Record<string, ProfileHandler | string>,
};

module.exports = exports;
export default exports;
