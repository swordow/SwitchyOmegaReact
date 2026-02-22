import chai from 'chai';
const should = chai.should();
import PacGenerator from '../src/pac_generator';

describe('PacGenerator', () => {
  const options: Record<string, any> = {
    '+auto': {
      name: 'auto',
      profileType: 'SwitchProfile',
      revision: 'test',
      defaultProfileName: 'direct',
      rules: [
        { profileName: 'proxy', condition: { conditionType: 'UrlRegexCondition', pattern: '^http://(www|www2)\\.example\\.com/' } },
        { profileName: 'direct', condition: { conditionType: 'HostLevelsCondition', minValue: 3, maxValue: 8 } },
        { profileName: 'proxy', condition: { conditionType: 'KeywordCondition', pattern: 'keyword' } },
        { profileName: 'proxy', condition: { conditionType: 'UrlWildcardCondition', pattern: 'https://ssl.example.com/*' } },
      ],
    },
    '+proxy': {
      name: 'proxy',
      profileType: 'FixedProfile',
      revision: 'test',
      fallbackProxy: { scheme: 'http', host: '127.0.0.1', port: 8888 },
      bypassList: [
        { conditionType: 'BypassCondition', pattern: '127.0.0.1:8080' },
        { conditionType: 'BypassCondition', pattern: '127.0.0.1' },
        { conditionType: 'BypassCondition', pattern: '<local>' },
      ],
    },
  };

  it('should generate pac scripts from options', () => {
    const ast = PacGenerator.script(options, 'auto');
    const pac = ast.print_to_string({ beautify: true, comments: true });
    pac.should.not.be.empty;
    // eslint-disable-next-line no-eval
    const func = eval(`(function () { ${pac}\n return FindProxyForURL; })()`);
    const result = func('http://www.example.com/', 'www.example.com');
    result.should.equal('PROXY 127.0.0.1:8888');
  });

  it('should be able to compress pac scripts', () => {
    const ast = PacGenerator.script(options, 'auto');
    const pac = PacGenerator.compress(ast).print_to_string();
    pac.should.not.be.empty;
    // eslint-disable-next-line no-eval
    const func = eval(`(function () { ${pac}\n return FindProxyForURL; })()`);
    const result = func('http://www.example.com/', 'www.example.com');
    result.should.equal('PROXY 127.0.0.1:8888');
  });
});
