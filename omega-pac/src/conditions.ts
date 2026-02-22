// eslint-disable-next-line @typescript-eslint/no-var-requires
const U2: any = require('uglify-js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const IP: any = require('ip-address');
import * as Url from 'url';
import { shExp2RegExp, escapeSlash } from './shexp_utils';
import { AttachedCache } from './utils';

export interface Request {
  url: string;
  host: string;
  scheme: string;
}

export interface Condition {
  conditionType: string;
  pattern?: string;
  ip?: string;
  prefixLength?: number;
  minValue?: number;
  maxValue?: number;
  startDay?: number;
  endDay?: number;
  days?: string;
  startHour?: number;
  endHour?: number;
}

export interface ConditionHandler {
  abbrs: string[];
  tag?: (this: typeof exports, condition: Condition) => string;
  analyze: (this: typeof exports, condition: Condition) => any;
  match: (this: typeof exports, condition: Condition, request: Request, cache: any) => boolean;
  compile: (this: typeof exports, condition: Condition, cache: any) => any;
  str?: (this: typeof exports, condition: Condition) => string;
  fromStr?: (this: typeof exports, str: string, condition: Condition) => Condition | null;
}

const exports = {
  requestFromUrl(url: string | any): Request {
    if (typeof url === 'string') {
      url = Url.parse(url);
    }
    return {
      url: Url.format(url),
      host: url.hostname,
      scheme: url.protocol.replace(':', ''),
    };
  },

  urlWildcard2HostWildcard(pattern: string): string | undefined {
    const result = pattern.match(
      /^\*:\/\/((?:\w|[?*._\-])+)\/\*$/
    );
    return result?.[1];
  },

  tag(condition: Condition): string {
    return exports._condCache.tag(condition);
  },

  analyze(condition: Condition): any {
    return exports._condCache.get(condition, () => ({
      analyzed: exports._handler(condition.conditionType).analyze.call(exports, condition),
    }));
  },

  match(condition: Condition, request: Request): boolean {
    const cache = exports.analyze(condition);
    return exports._handler(condition.conditionType).match.call(exports, condition, request, cache);
  },

  compile(condition: Condition): any {
    const cache = exports.analyze(condition);
    if (cache.compiled) return cache.compiled;
    const handler = exports._handler(condition.conditionType);
    cache.compiled = handler.compile.call(exports, condition, cache);
    return cache.compiled;
  },

  str(condition: Condition, { abbr }: { abbr?: number } = { abbr: -1 }): string {
    const handler = exports._handler(condition.conditionType);
    if (handler.abbrs[0].length === 0) {
      const endCode = condition.pattern!.charCodeAt(condition.pattern!.length - 1);
      if (endCode !== exports.colonCharCode && condition.pattern!.indexOf(' ') < 0) {
        return condition.pattern!;
      }
    }
    const strFn = handler.str;
    const typeStr =
      typeof abbr === 'number'
        ? handler.abbrs[(handler.abbrs.length + abbr) % handler.abbrs.length]
        : condition.conditionType;
    let result = typeStr + ':';
    const part = strFn ? strFn.call(exports, condition) : condition.pattern;
    if (part) result += ' ' + part;
    return result;
  },

  colonCharCode: ':'.charCodeAt(0),

  fromStr(str: string): Condition | null {
    str = str.trim();
    let i = str.indexOf(' ');
    if (i < 0) i = str.length;
    let conditionType: string;
    if (str.charCodeAt(i - 1) === exports.colonCharCode) {
      conditionType = str.substr(0, i - 1);
      str = str.substr(i + 1).trim();
    } else {
      conditionType = '';
    }
    conditionType = exports.typeFromAbbr(conditionType);
    if (!conditionType) return null;
    const condition: Condition = { conditionType };
    const fromStr = exports._handler(condition.conditionType).fromStr;
    if (fromStr) {
      return fromStr.call(exports, str, condition);
    } else {
      condition.pattern = str;
      return condition;
    }
  },

  _abbrs: null as Record<string, string> | null,

  typeFromAbbr(abbr: string): string {
    if (!exports._abbrs) {
      exports._abbrs = {};
      for (const [type, handler] of Object.entries(exports._conditionTypes)) {
        exports._abbrs[type.toUpperCase()] = type;
        for (const ab of (handler as ConditionHandler).abbrs) {
          exports._abbrs[ab.toUpperCase()] = type;
        }
      }
    }
    return exports._abbrs[abbr.toUpperCase()];
  },

  comment(comment: string | null | undefined, node: any): any {
    if (!comment) return node;
    if (!node.start) node.start = {};
    Object.defineProperty(node.start, '_comments_dumped', {
      get: () => false,
      set: () => false,
    });
    if (!node.start.comments_before) node.start.comments_before = [];
    node.start.comments_before.push({ type: 'comment2', value: comment });
    return node;
  },

  safeRegex(expr: string | RegExp): RegExp {
    try {
      return new RegExp(expr);
    } catch (_) {
      return /(?!)/;
    }
  },

  regTest(expr: string | any, regexp: string | RegExp): any {
    if (typeof regexp === 'string') {
      regexp = escapeSlash(regexp);
    }
    if (typeof expr === 'string') {
      expr = new U2.AST_SymbolRef({ name: expr });
    }
    return new U2.AST_Call({
      args: [expr],
      expression: new U2.AST_Dot({
        property: 'test',
        expression: new U2.AST_RegExp({ value: regexp }),
      }),
    });
  },

  isInt(num: any): boolean {
    return typeof num === 'number' && !isNaN(num) && parseFloat(num) === parseInt(num, 10);
  },

  between(val: any, min: any, max: any, comment?: string): any {
    if (min === max) {
      if (typeof min === 'number') {
        min = new U2.AST_Number({ value: min });
      }
      return exports.comment(comment || null, new U2.AST_Binary({
        left: val,
        operator: '===',
        right: min,
      }));
    }
    if (min > max) {
      return exports.comment(comment || null, new U2.AST_False());
    }
    if (exports.isInt(min) && exports.isInt(max) && max - min < 32) {
      comment = comment || `${min} <= value && value <= ${max}`;
      const tmpl = '0123456789abcdefghijklmnopqrstuvwxyz';
      const str =
        max < tmpl.length
          ? tmpl.substr(min, max - min + 1)
          : tmpl.substr(0, max - min + 1);
      const pos =
        min === 0
          ? val
          : new U2.AST_Binary({
              left: val,
              operator: '-',
              right: new U2.AST_Number({ value: min }),
            });
      return exports.comment(comment, new U2.AST_Binary({
        left: new U2.AST_Call({
          expression: new U2.AST_Dot({
            expression: new U2.AST_String({ value: str }),
            property: 'charCodeAt',
          }),
          args: [pos],
        }),
        operator: '>',
        right: new U2.AST_Number({ value: 0 }),
      }));
    }
    if (typeof min === 'number') min = new U2.AST_Number({ value: min });
    if (typeof max === 'number') max = new U2.AST_Number({ value: max });
    return exports.comment(comment || null, new U2.AST_Call({
      args: [val, min, max],
      expression: new U2.AST_Function({
        argnames: [
          new U2.AST_SymbolFunarg({ name: 'value' }),
          new U2.AST_SymbolFunarg({ name: 'min' }),
          new U2.AST_SymbolFunarg({ name: 'max' }),
        ],
        body: [
          new U2.AST_Return({
            value: new U2.AST_Binary({
              left: new U2.AST_Binary({
                left: new U2.AST_SymbolRef({ name: 'min' }),
                operator: '<=',
                right: new U2.AST_SymbolRef({ name: 'value' }),
              }),
              operator: '&&',
              right: new U2.AST_Binary({
                left: new U2.AST_SymbolRef({ name: 'value' }),
                operator: '<=',
                right: new U2.AST_SymbolRef({ name: 'max' }),
              }),
            }),
          }),
        ],
      }),
    }));
  },

  parseIp(ip: string): any {
    if (ip.charCodeAt(0) === '['.charCodeAt(0)) {
      ip = ip.substr(1, ip.length - 2);
    }
    let addr = new IP.v4.Address(ip);
    if (!addr.isValid()) {
      addr = new IP.v6.Address(ip);
      if (!addr.isValid()) return null;
    }
    return addr;
  },

  normalizeIp(addr: any): string {
    return (addr.correctForm ?? addr.canonicalForm).call(addr);
  },

  ipv6Max: new IP.v6.Address('::/0').endAddress().canonicalForm(),

  localHosts: ['127.0.0.1', '[::1]', 'localhost'],

  getWeekdayList(condition: Condition): boolean[] {
    if (condition.days) {
      return Array.from({ length: 7 }, (_, i) => condition.days!.charCodeAt(i) > 64);
    }
    return Array.from({ length: 7 }, (_, i) => condition.startDay! <= i && i <= condition.endDay!);
  },

  _condCache: new AttachedCache((condition: Condition) => {
    const tag = exports._handler(condition.conditionType).tag;
    const result = tag ? tag.apply(exports, [condition] as any) : exports.str(condition);
    return condition.conditionType + '$' + result;
  }),

  _setProp(obj: any, prop: string, value: any): void {
    if (!Object.prototype.hasOwnProperty.call(obj, prop)) {
      Object.defineProperty(obj, prop, { writable: true, enumerable: false, configurable: true });
    }
    obj[prop] = value;
  },

  _handler(conditionType: string | Condition): ConditionHandler {
    if (typeof conditionType !== 'string') {
      conditionType = conditionType.conditionType;
    }
    const handler = (exports._conditionTypes as any)[conditionType];
    if (handler == null) {
      throw new Error(`Unknown condition type: ${conditionType}`);
    }
    return handler;
  },

  _conditionTypes: {
    TrueCondition: {
      abbrs: ['True'],
      analyze: (_condition: Condition) => null,
      match: () => true,
      compile: (_condition: Condition) => new U2.AST_True(),
      str: (_condition: Condition) => '',
      fromStr: (_str: string, condition: Condition) => condition,
    },

    FalseCondition: {
      abbrs: ['False', 'Disabled'],
      analyze: (_condition: Condition) => null,
      match: () => false,
      compile: (_condition: Condition) => new U2.AST_False(),
      fromStr: (str: string, condition: Condition) => {
        if (str.length > 0) condition.pattern = str;
        return condition;
      },
    },

    UrlRegexCondition: {
      abbrs: ['UR', 'URegex', 'UrlR', 'UrlRegex'],
      analyze(this: typeof exports, condition: Condition) {
        return this.safeRegex(escapeSlash(condition.pattern!));
      },
      match(_condition: Condition, request: Request, cache: any) {
        return cache.analyzed.test(request.url);
      },
      compile(this: typeof exports, _condition: Condition, cache: any) {
        return this.regTest('url', cache.analyzed);
      },
    },

    UrlWildcardCondition: {
      abbrs: ['U', 'UW', 'Url', 'UrlW', 'UWild', 'UWildcard', 'UrlWild', 'UrlWildcard'],
      analyze(this: typeof exports, condition: Condition) {
        const parts = condition.pattern!.split('|')
          .filter(p => p)
          .map(pattern => shExp2RegExp(pattern, { trimAsterisk: true }));
        return this.safeRegex(parts.join('|'));
      },
      match(_condition: Condition, request: Request, cache: any) {
        return cache.analyzed.test(request.url);
      },
      compile(this: typeof exports, _condition: Condition, cache: any) {
        return this.regTest('url', cache.analyzed);
      },
    },

    HostRegexCondition: {
      abbrs: ['R', 'HR', 'Regex', 'HostR', 'HRegex', 'HostRegex'],
      analyze(this: typeof exports, condition: Condition) {
        return this.safeRegex(escapeSlash(condition.pattern!));
      },
      match(_condition: Condition, request: Request, cache: any) {
        return cache.analyzed.test(request.host);
      },
      compile(this: typeof exports, _condition: Condition, cache: any) {
        return this.regTest('host', cache.analyzed);
      },
    },

    HostWildcardCondition: {
      abbrs: ['', 'H', 'W', 'HW', 'Wild', 'Wildcard', 'Host', 'HostW', 'HWild',
        'HWildcard', 'HostWild', 'HostWildcard'],
      analyze(this: typeof exports, condition: Condition) {
        const parts = condition.pattern!.split('|').filter(p => p).map(pattern => {
          if (pattern.charCodeAt(0) === '.'.charCodeAt(0)) {
            pattern = '*' + pattern;
          }
          if (pattern.indexOf('**.') === 0) {
            return shExp2RegExp(pattern.substring(1), { trimAsterisk: true });
          } else if (pattern.indexOf('*.') === 0) {
            return shExp2RegExp(pattern.substring(2), { trimAsterisk: false })
              .replace(/./, '(?:^|\\.)').replace(/\.\*\$$/, '');
          } else {
            return shExp2RegExp(pattern, { trimAsterisk: true });
          }
        });
        return this.safeRegex(parts.join('|'));
      },
      match(_condition: Condition, request: Request, cache: any) {
        return cache.analyzed.test(request.host);
      },
      compile(this: typeof exports, _condition: Condition, cache: any) {
        return this.regTest('host', cache.analyzed);
      },
    },

    BypassCondition: {
      abbrs: ['B', 'Bypass'],
      analyze(this: typeof exports, condition: Condition) {
        const cache: any = {
          host: null,
          ip: null,
          scheme: null,
          url: null,
          normalizedPattern: '',
        };
        let server = condition.pattern!;
        if (server === '<local>') {
          cache.host = server;
          return cache;
        }
        const schemeParts = server.split('://');
        if (schemeParts.length > 1) {
          cache.scheme = schemeParts[0];
          cache.normalizedPattern = cache.scheme + '://';
          server = schemeParts[1];
        }
        const slashParts = server.split('/');
        if (slashParts.length > 1) {
          const addr = this.parseIp(slashParts[0]);
          const prefixLen = parseInt(slashParts[1]);
          if (addr && !isNaN(prefixLen)) {
            cache.ip = {
              conditionType: 'IpCondition',
              ip: this.normalizeIp(addr),
              prefixLength: prefixLen,
            };
            cache.normalizedPattern += cache.ip.ip + '/' + cache.ip.prefixLength;
            return cache;
          }
        }
        let matchPort: string | undefined;
        let serverIp = this.parseIp(server);
        if (!serverIp) {
          const pos = server.lastIndexOf(':');
          if (pos >= 0) {
            matchPort = server.substring(pos + 1);
            server = server.substring(0, pos);
          }
          serverIp = this.parseIp(server);
        }
        if (serverIp) {
          server = this.normalizeIp(serverIp);
          if (serverIp.v4) {
            cache.normalizedPattern += server;
          } else {
            cache.normalizedPattern += '[' + server + ']';
          }
        } else {
          if (server.charCodeAt(0) === '.'.charCodeAt(0)) {
            server = '*' + server;
          }
          cache.normalizedPattern = server;
        }
        if (matchPort) {
          cache.port = matchPort;
          cache.normalizedPattern += ':' + cache.port;
          if (serverIp && !serverIp.v4) {
            server = '[' + server + ']';
          }
          let serverRegex = shExp2RegExp(server);
          serverRegex = serverRegex.substring(1, serverRegex.length - 1);
          const scheme = cache.scheme ?? '[^:]+';
          cache.url = this.safeRegex('^' + scheme + ':\\/\\/' + serverRegex + ':' + matchPort + '\\/');
        } else if (server !== '*') {
          const serverRegex = shExp2RegExp(server, { trimAsterisk: true });
          cache.host = this.safeRegex(serverRegex);
        }
        return cache;
      },
      match(this: typeof exports, condition: Condition, request: Request, cache: any) {
        const c = cache.analyzed;
        if (c.scheme != null && c.scheme !== request.scheme) return false;
        if (c.ip != null && !this.match(c.ip, request)) return false;
        if (c.host != null) {
          if (c.host === '<local>') {
            return (
              request.host === '127.0.0.1' ||
              request.host === '::1' ||
              request.host.indexOf('.') < 0
            );
          } else {
            if (!c.host.test(request.host)) return false;
          }
        }
        if (c.url != null && !c.url.test(request.url)) return false;
        return true;
      },
      str(this: typeof exports, condition: Condition) {
        const analyze = this._handler(condition).analyze;
        const cache = analyze.call(exports, condition);
        return cache.normalizedPattern || condition.pattern!;
      },
      compile(this: typeof exports, condition: Condition, cache: any) {
        const c = cache.analyzed;
        if (c.url != null) return this.regTest('url', c.url);
        if (c.host === '<local>') {
          const hostEquals = (host: string) => new U2.AST_Binary({
            left: new U2.AST_SymbolRef({ name: 'host' }),
            operator: '===',
            right: new U2.AST_String({ value: host }),
          });
          return new U2.AST_Binary({
            left: new U2.AST_Binary({
              left: hostEquals('127.0.0.1'),
              operator: '||',
              right: hostEquals('::1'),
            }),
            operator: '||',
            right: new U2.AST_Binary({
              left: new U2.AST_Call({
                expression: new U2.AST_Dot({
                  expression: new U2.AST_SymbolRef({ name: 'host' }),
                  property: 'indexOf',
                }),
                args: [new U2.AST_String({ value: '.' })],
              }),
              operator: '<',
              right: new U2.AST_Number({ value: 0 }),
            }),
          });
        }
        const conditions: any[] = [];
        if (c.scheme != null) {
          conditions.push(new U2.AST_Binary({
            left: new U2.AST_SymbolRef({ name: 'scheme' }),
            operator: '===',
            right: new U2.AST_String({ value: c.scheme }),
          }));
        }
        if (c.host != null) {
          conditions.push(this.regTest('host', c.host));
        } else if (c.ip != null) {
          conditions.push(this.compile(c.ip));
        }
        switch (conditions.length) {
          case 0: return new U2.AST_True();
          case 1: return conditions[0];
          default:
            return new U2.AST_Binary({
              left: conditions[0],
              operator: '&&',
              right: conditions[1],
            });
        }
      },
    },

    KeywordCondition: {
      abbrs: ['K', 'KW', 'Keyword'],
      analyze: (_condition: Condition) => null,
      match(_condition: Condition, request: Request) {
        return request.scheme === 'http' && request.url.indexOf(_condition.pattern!) >= 0;
      },
      compile(_condition: Condition) {
        return new U2.AST_Binary({
          left: new U2.AST_Binary({
            left: new U2.AST_SymbolRef({ name: 'scheme' }),
            operator: '===',
            right: new U2.AST_String({ value: 'http' }),
          }),
          operator: '&&',
          right: new U2.AST_Binary({
            left: new U2.AST_Call({
              expression: new U2.AST_Dot({
                expression: new U2.AST_SymbolRef({ name: 'url' }),
                property: 'indexOf',
              }),
              args: [new U2.AST_String({ value: _condition.pattern! })],
            }),
            operator: '>=',
            right: new U2.AST_Number({ value: 0 }),
          }),
        });
      },
    },

    IpCondition: {
      abbrs: ['Ip'],
      analyze(this: typeof exports, condition: Condition) {
        const cache: any = { addr: null, normalized: null };
        let ip = condition.ip!;
        if (ip.charCodeAt(0) === '['.charCodeAt(0)) {
          ip = ip.substr(1, ip.length - 2);
        }
        const addr = ip + '/' + condition.prefixLength;
        cache.addr = this.parseIp(addr);
        if (!cache.addr) throw new Error(`Invalid IP address ${addr}`);
        cache.normalized = this.normalizeIp(cache.addr);
        const mask = cache.addr.v4
          ? new IP.v4.Address('255.255.255.255/' + cache.addr.subnetMask)
          : new IP.v6.Address(this.ipv6Max + '/' + cache.addr.subnetMask);
        cache.mask = this.normalizeIp(mask.startAddress());
        return cache;
      },
      match(this: typeof exports, condition: Condition, request: Request, cache: any) {
        const addr = this.parseIp(request.host);
        if (!addr) return false;
        const c = cache.analyzed;
        if (addr.v4 !== c.addr.v4) return false;
        return addr.isInSubnet(c.addr);
      },
      compile(this: typeof exports, _condition: Condition, cache: any) {
        const c = cache.analyzed;
        const hostLooksLikeIp = c.addr.v4
          ? new U2.AST_Binary({
              left: new U2.AST_Sub({
                expression: new U2.AST_SymbolRef({ name: 'host' }),
                property: new U2.AST_Binary({
                  left: new U2.AST_Dot({
                    expression: new U2.AST_SymbolRef({ name: 'host' }),
                    property: 'length',
                  }),
                  operator: '-',
                  right: new U2.AST_Number({ value: 1 }),
                }),
              }),
              operator: '>=',
              right: new U2.AST_Number({ value: 0 }),
            })
          : new U2.AST_Binary({
              left: new U2.AST_Call({
                expression: new U2.AST_Dot({
                  expression: new U2.AST_SymbolRef({ name: 'host' }),
                  property: 'indexOf',
                }),
                args: [new U2.AST_String({ value: ':' })],
              }),
              operator: '>=',
              right: new U2.AST_Number({ value: 0 }),
            });
        if (c.addr.subnetMask === 0) return hostLooksLikeIp;
        let hostIsInNet: any = new U2.AST_Call({
          expression: new U2.AST_SymbolRef({ name: 'isInNet' }),
          args: [
            new U2.AST_SymbolRef({ name: 'host' }),
            new U2.AST_String({ value: c.normalized }),
            new U2.AST_String({ value: c.mask }),
          ],
        });
        if (!c.addr.v4) {
          const hostIsInNetEx = new U2.AST_Call({
            expression: new U2.AST_SymbolRef({ name: 'isInNetEx' }),
            args: [
              new U2.AST_SymbolRef({ name: 'host' }),
              new U2.AST_String({ value: c.normalized + c.addr.subnet }),
            ],
          });
          hostIsInNet = new U2.AST_Conditional({
            condition: new U2.AST_Binary({
              left: new U2.AST_UnaryPrefix({
                operator: 'typeof',
                expression: new U2.AST_SymbolRef({ name: 'isInNetEx' }),
              }),
              operator: '===',
              right: new U2.AST_String({ value: 'function' }),
            }),
            consequent: hostIsInNetEx,
            alternative: hostIsInNet,
          });
        }
        return new U2.AST_Binary({
          left: hostLooksLikeIp,
          operator: '&&',
          right: hostIsInNet,
        });
      },
      str(_condition: Condition) {
        return _condition.ip + '/' + _condition.prefixLength;
      },
      fromStr(this: typeof exports, str: string, condition: Condition) {
        const addr = this.parseIp(str);
        if (addr) {
          condition.ip = addr.addressMinusSuffix;
          condition.prefixLength = addr.subnetMask;
        } else {
          condition.ip = '0.0.0.0';
          condition.prefixLength = 0;
        }
        return condition;
      },
    },

    HostLevelsCondition: {
      abbrs: ['Lv', 'Level', 'Levels', 'HL', 'HLv', 'HLevel', 'HLevels',
        'HostL', 'HostLv', 'HostLevel', 'HostLevels'],
      analyze: (_condition: Condition) => '.'.charCodeAt(0),
      match(_condition: Condition, request: Request, cache: any) {
        const dotCharCode = cache.analyzed;
        let dotCount = 0;
        for (let i = 0; i < request.host.length; i++) {
          if (request.host.charCodeAt(i) === dotCharCode) {
            dotCount++;
            if (dotCount > _condition.maxValue!) return false;
          }
        }
        return dotCount >= _condition.minValue!;
      },
      compile(this: typeof exports, condition: Condition) {
        const val = new U2.AST_Dot({
          property: 'length',
          expression: new U2.AST_Call({
            args: [new U2.AST_String({ value: '.' })],
            expression: new U2.AST_Dot({
              expression: new U2.AST_SymbolRef({ name: 'host' }),
              property: 'split',
            }),
          }),
        });
        return this.between(val, condition.minValue! + 1, condition.maxValue! + 1,
          `${condition.minValue} <= hostLevels <= ${condition.maxValue}`);
      },
      str(condition: Condition) {
        return condition.minValue + '~' + condition.maxValue;
      },
      fromStr(_str: string, condition: Condition) {
        const [minValue, maxValue] = _str.split('~');
        condition.minValue = parseInt(minValue, 10);
        condition.maxValue = parseInt(maxValue, 10);
        if (!(condition.minValue > 0)) condition.minValue = 1;
        if (!(condition.maxValue > 0)) condition.maxValue = 1;
        return condition;
      },
    },

    WeekdayCondition: {
      abbrs: ['WD', 'Week', 'Day', 'Weekday'],
      analyze: (_condition: Condition) => null,
      match(condition: Condition, _request: Request) {
        const day = new Date().getDay();
        if (condition.days) return condition.days.charCodeAt(day) > 64;
        return condition.startDay! <= day && day <= condition.endDay!;
      },
      compile(this: typeof exports, condition: Condition) {
        const getDay = new U2.AST_Call({
          args: [],
          expression: new U2.AST_Dot({
            property: 'getDay',
            expression: new U2.AST_New({
              args: [],
              expression: new U2.AST_SymbolRef({ name: 'Date' }),
            }),
          }),
        });
        if (condition.days) {
          return new U2.AST_Binary({
            left: new U2.AST_Call({
              expression: new U2.AST_Dot({
                expression: new U2.AST_String({ value: condition.days }),
                property: 'charCodeAt',
              }),
              args: [getDay],
            }),
            operator: '>',
            right: new U2.AST_Number({ value: 64 }),
          });
        }
        return this.between(getDay, condition.startDay!, condition.endDay!);
      },
      str(condition: Condition) {
        return condition.days || (condition.startDay + '~' + condition.endDay);
      },
      fromStr(_str: string, condition: Condition) {
        if (_str.indexOf('~') < 0 && _str.length === 7) {
          condition.days = _str;
        } else {
          const [startDay, endDay] = _str.split('~');
          condition.startDay = parseInt(startDay, 10);
          condition.endDay = parseInt(endDay, 10);
          if (!(0 <= condition.startDay && condition.startDay <= 6)) condition.startDay = 0;
          if (!(0 <= condition.endDay && condition.endDay <= 6)) condition.endDay = 0;
        }
        return condition;
      },
    },

    TimeCondition: {
      abbrs: ['T', 'Time', 'Hour'],
      analyze: (_condition: Condition) => null,
      match(condition: Condition, _request: Request) {
        const hour = new Date().getHours();
        return condition.startHour! <= hour && hour <= condition.endHour!;
      },
      compile(this: typeof exports, condition: Condition) {
        const val = new U2.AST_Call({
          args: [],
          expression: new U2.AST_Dot({
            property: 'getHours',
            expression: new U2.AST_New({
              args: [],
              expression: new U2.AST_SymbolRef({ name: 'Date' }),
            }),
          }),
        });
        return this.between(val, condition.startHour!, condition.endHour!);
      },
      str(condition: Condition) {
        return condition.startHour + '~' + condition.endHour;
      },
      fromStr(_str: string, condition: Condition) {
        const [startHour, endHour] = _str.split('~');
        condition.startHour = parseInt(startHour, 10);
        condition.endHour = parseInt(endHour, 10);
        if (!(0 <= condition.startHour && condition.startHour < 24)) condition.startHour = 0;
        if (!(0 <= condition.endHour && condition.endHour < 24)) condition.endHour = 0;
        return condition;
      },
    },
  } as Record<string, ConditionHandler>,
};

module.exports = exports;
export default exports;
