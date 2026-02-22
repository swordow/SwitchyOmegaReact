/** @module omega-target/log */

function replacer(key: string, value: any): any {
  switch (key) {
    case 'username':
    case 'password':
    case 'host':
    case 'port':
      return '<secret>';
    default:
      return value;
  }
}

const Log = {
  str(obj: any): string {
    if (typeof obj === 'object' && obj !== null) {
      if (obj.debugStr != null) {
        if (typeof obj.debugStr === 'function') return obj.debugStr();
        return obj.debugStr;
      } else if (obj instanceof Error) {
        return obj.stack || obj.message;
      } else {
        return JSON.stringify(obj, replacer, 4);
      }
    } else if (typeof obj === 'function') {
      return obj.name ? `<f: ${obj.name}>` : obj.toString();
    } else {
      return '' + obj;
    }
  },

  log: console.log.bind(console),

  error: console.error.bind(console),

  func(name: string, args: ArrayLike<any>): void {
    this.log(name, '(', Array.prototype.slice.call(args), ')');
  },

  method(name: string, self: any, args: ArrayLike<any>): void {
    this.log(this.str(self), '<<', name, Array.prototype.slice.call(args));
  },
};

module.exports = Log;
export default Log;
