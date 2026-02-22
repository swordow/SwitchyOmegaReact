import Conditions from './conditions';

function strStartsWith(str: string, prefix: string): boolean {
  return str.substr(0, prefix.length) === prefix;
}

const RuleList = {
  AutoProxy: {
    magicPrefix: 'W0F1dG9Qcm94', // Detect base-64 encoded "[AutoProxy".
    detect(text: string): boolean | undefined {
      if (strStartsWith(text, RuleList.AutoProxy.magicPrefix)) return true;
      if (strStartsWith(text, '[AutoProxy')) return true;
      return undefined;
    },
    preprocess(text: string): string {
      if (strStartsWith(text, RuleList.AutoProxy.magicPrefix)) {
        text = Buffer.from(text, 'base64').toString('utf8');
      }
      return text;
    },
    parse(text: string, matchProfileName: string, defaultProfileName: string): any[] {
      const normal_rules: any[] = [];
      const exclusive_rules: any[] = [];
      for (let line of text.split(/\n|\r/)) {
        line = line.trim();
        if (line.length === 0 || line[0] === '!' || line[0] === '[') continue;
        const source = line;
        let profile = matchProfileName;
        let list = normal_rules;
        if (line[0] === '@' && line[1] === '@') {
          profile = defaultProfileName;
          list = exclusive_rules;
          line = line.substring(2);
        }
        let cond: any;
        if (line[0] === '/') {
          cond = { conditionType: 'UrlRegexCondition', pattern: line.substring(1, line.length - 1) };
        } else if (line[0] === '|') {
          if (line[1] === '|') {
            cond = { conditionType: 'HostWildcardCondition', pattern: '*.' + line.substring(2) };
          } else {
            cond = { conditionType: 'UrlWildcardCondition', pattern: line.substring(1) + '*' };
          }
        } else if (line.indexOf('*') < 0) {
          cond = { conditionType: 'KeywordCondition', pattern: line };
        } else {
          cond = { conditionType: 'UrlWildcardCondition', pattern: 'http://*' + line + '*' };
        }
        list.push({ condition: cond, profileName: profile, source });
      }
      return exclusive_rules.concat(normal_rules);
    },
  },

  Switchy: {
    omegaPrefix: '[SwitchyOmega Conditions',
    specialLineStart: '[;#@!',

    detect(text: string): boolean | undefined {
      if (strStartsWith(text, RuleList.Switchy.omegaPrefix)) return true;
      return undefined;
    },

    parse(text: string, matchProfileName: string, defaultProfileName: string): any[] {
      const parser = RuleList.Switchy.getParser(text);
      return (RuleList.Switchy as any)[parser](text, matchProfileName, defaultProfileName);
    },

    directReferenceSet({ ruleList, matchProfileName, defaultProfileName }: any): Record<string, string> | undefined {
      const text = ruleList.trim();
      const parser = RuleList.Switchy.getParser(text);
      if (parser !== 'parseOmega') return undefined;
      if (!/(^|\n)@with\s+results?(\r|\n|$)/i.test(text)) return undefined;
      const refs: Record<string, string> = {};
      for (let line of text.split(/\n|\r/)) {
        line = line.trim();
        if (RuleList.Switchy.specialLineStart.indexOf(line[0]) < 0) {
          const iSpace = line.lastIndexOf(' +');
          const profile = iSpace < 0 ? (defaultProfileName || 'direct') : line.substr(iSpace + 2).trim();
          refs['+' + profile] = profile;
        }
      }
      return refs;
    },

    compose({ rules, defaultProfileName }: any, { withResult, useExclusive }: any = {}): string {
      const eol = '\r\n';
      let ruleList = '[SwitchyOmega Conditions]' + eol;
      useExclusive = useExclusive ?? !withResult;
      if (withResult) {
        ruleList += '@with result' + eol + eol;
      } else {
        ruleList += eol;
      }
      const specialLineStart = RuleList.Switchy.specialLineStart + '+';
      for (const rule of rules) {
        if (rule.note) ruleList += '@note ' + rule.note + eol;
        let line = Conditions.str(rule.condition);
        if (useExclusive && rule.profileName === defaultProfileName) {
          line = '!' + line;
        } else {
          if (specialLineStart.indexOf(line[0]) >= 0) line = ': ' + line;
          if (withResult) line += ' +' + rule.profileName;
        }
        ruleList += line + eol;
      }
      if (withResult) {
        ruleList += eol + '* +' + defaultProfileName + eol;
      }
      return ruleList;
    },

    getParser(text: string): string {
      if (!strStartsWith(text, RuleList.Switchy.omegaPrefix)) {
        if (text[0] === '#' || text.indexOf('\n#') >= 0) return 'parseLegacy';
      }
      return 'parseOmega';
    },

    conditionFromLegacyWildcard(pattern: string): any {
      if (pattern[0] === '@') {
        pattern = pattern.substring(1);
      } else {
        if (pattern.indexOf('://') <= 0 && pattern[0] !== '*') pattern = '*' + pattern;
        if (pattern[pattern.length - 1] !== '*') pattern += '*';
      }
      const host = Conditions.urlWildcard2HostWildcard(pattern);
      if (host) {
        return { conditionType: 'HostWildcardCondition', pattern: host };
      }
      return { conditionType: 'UrlWildcardCondition', pattern };
    },

    parseLegacy(text: string, matchProfileName: string, defaultProfileName: string): any[] {
      const normal_rules: any[] = [];
      const exclusive_rules: any[] = [];
      let begin = false;
      let section = 'WILDCARD';
      for (let line of text.split(/\n|\r/)) {
        line = line.trim();
        if (line.length === 0 || line[0] === ';') continue;
        if (!begin) {
          if (line.toUpperCase() === '#BEGIN') begin = true;
          continue;
        }
        if (line.toUpperCase() === '#END') break;
        if (line[0] === '[' && line[line.length - 1] === ']') {
          section = line.substring(1, line.length - 1).toUpperCase();
          continue;
        }
        const source = line;
        let profile = matchProfileName;
        let list = normal_rules;
        if (line[0] === '!') {
          profile = defaultProfileName;
          list = exclusive_rules;
          line = line.substring(1);
        }
        let cond: any = null;
        if (section === 'WILDCARD') {
          cond = RuleList.Switchy.conditionFromLegacyWildcard(line);
        } else if (section === 'REGEXP') {
          cond = { conditionType: 'UrlRegexCondition', pattern: line };
        }
        if (cond != null) list.push({ condition: cond, profileName: profile, source });
      }
      return exclusive_rules.concat(normal_rules);
    },

    parseOmega(text: string, matchProfileName: string, defaultProfileName: string, args: any = {}): any[] {
      const { strict } = args;
      const error = strict
        ? (fields: any) => {
            const err: any = new Error(fields.message);
            for (const [key, value] of Object.entries(fields)) err[key] = value;
            throw err;
          }
        : undefined;
      const includeSource = args.source ?? true;
      const rules: any[] = [];
      const rulesWithDefaultProfile: any[] = [];
      let withResult = false;
      let exclusiveProfile: string | null = null;
      let noteForNextRule: string | null = null;
      let lno = 0;
      for (let line of text.split(/\n|\r/)) {
        lno++;
        line = line.trim();
        if (line.length === 0) continue;
        switch (line[0]) {
          case '[': continue;
          case ';': continue;
          case '@': {
            let iSpace = line.indexOf(' ');
            if (iSpace < 0) iSpace = line.length;
            const directive = line.substr(1, iSpace - 1);
            line = line.substr(iSpace + 1).trim();
            switch (directive.toUpperCase()) {
              case 'WITH': {
                const feature = line.toUpperCase();
                if (feature === 'RESULT' || feature === 'RESULTS') withResult = true;
                break;
              }
              case 'NOTE':
                noteForNextRule = line;
                break;
            }
            continue;
          }
        }
        let source: string | null = null;
        if (strict) exclusiveProfile = null;
        let profile: string | null;
        if (line[0] === '!') {
          profile = withResult ? null : defaultProfileName;
          source = line;
          line = line.substr(1);
        } else if (withResult) {
          const iSpace = line.lastIndexOf(' +');
          if (iSpace < 0) {
            error?.({ message: 'Missing result profile name: ' + line, reason: 'missingResultProfile', source: line, sourceLineNo: lno });
            continue;
          }
          profile = line.substr(iSpace + 2).trim();
          line = line.substr(0, iSpace).trim();
          if (line === '*') exclusiveProfile = profile;
        } else {
          profile = matchProfileName;
        }
        const cond = Conditions.fromStr(line);
        if (!cond) {
          error?.({ message: 'Invalid rule: ' + line, reason: 'invalidRule', source: source ?? line, sourceLineNo: lno });
          continue;
        }
        const rule: any = {
          condition: cond,
          profileName: profile,
          source: includeSource ? (source ?? line) : undefined,
        };
        if (noteForNextRule != null) { rule.note = noteForNextRule; noteForNextRule = null; }
        rules.push(rule);
        if (!profile) rulesWithDefaultProfile.push(rule);
      }
      if (withResult) {
        if (!exclusiveProfile) {
          error?.({ message: "Missing default rule with catch-all '*' condition", reason: 'noDefaultRule' });
          exclusiveProfile = defaultProfileName || 'direct';
        }
        for (const rule of rulesWithDefaultProfile) rule.profileName = exclusiveProfile;
      }
      return rules;
    },
  },
};

module.exports = RuleList;
export default RuleList;
