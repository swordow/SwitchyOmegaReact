export class NetworkError extends Error {
  cause: any;
  constructor(err?: any) {
    super(err?.message || String(err));
    this.cause = err;
    this.name = 'NetworkError';
  }
}

export class HttpError extends NetworkError {
  statusCode: number | undefined;
  constructor(err?: any) {
    super(err);
    this.statusCode = this.cause?.statusCode;
    this.name = 'HttpError';
  }
}

export class HttpNotFoundError extends HttpError {
  constructor(err?: any) {
    super(err);
    this.name = 'HttpNotFoundError';
  }
}

export class HttpServerError extends HttpError {
  constructor(err?: any) {
    super(err);
    this.name = 'HttpServerError';
  }
}

export class ContentTypeRejectedError extends Error {
  constructor() {
    super();
    this.name = 'ContentTypeRejectedError';
  }
}

module.exports = {
  NetworkError,
  HttpError,
  HttpNotFoundError,
  HttpServerError,
  ContentTypeRejectedError,
};
