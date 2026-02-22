import chai from 'chai';
const should = chai.should();
import ShexpUtils from '../src/shexp_utils';

describe('ShexpUtils', () => {
  describe('#escapeSlash', () => {
    it('should escape all forward slashes', () => {
      const regex = ShexpUtils.escapeSlash('/test/');
      regex.should.equal('\\/test\\/');
    });
    it('should not escape slashes that are already escaped', () => {
      const regex = ShexpUtils.escapeSlash('\\/test\\/');
      regex.should.equal('\\/test\\/');
    });
    it('should know the difference between escaped and unescaped slashes', () => {
      const regex = ShexpUtils.escapeSlash('\\\\/\\/test\\/');
      regex.should.equal('\\\\\\/\\/test\\/');
    });
  });
  describe('#shExp2RegExp', () => {
    it('should escape regex meta chars and back slashes', () => {
      const regex = ShexpUtils.shExp2RegExp('this.is|a\\test+');
      regex.should.equal('^this\\.is\\|a\\\\test\\+$');
    });
  });
});
