import Log from './src/log';
import Storage from './src/storage';
import BrowserStorage from './src/browser_storage';
import Options from './src/options';
import OptionsSync from './src/options_sync';
import { NetworkError, HttpError, HttpNotFoundError, HttpServerError, ContentTypeRejectedError } from './src/errors';

const OmegaPac = require('omega-pac');

const OmegaTarget = {
  Log,
  Storage,
  BrowserStorage,
  Options,
  OptionsSync,
  OmegaPac,
  Promise: global.Promise,
  NetworkError,
  HttpError,
  HttpNotFoundError,
  HttpServerError,
  ContentTypeRejectedError,
};

module.exports = OmegaTarget;
export default OmegaTarget;
export { Log, Storage, BrowserStorage, Options, OptionsSync, OmegaPac, NetworkError, HttpError, HttpNotFoundError, HttpServerError, ContentTypeRejectedError };
