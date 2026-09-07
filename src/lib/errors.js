class AppError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

function notFound(code = 'not_found') {
  return new AppError(404, code);
}

function badRequest(code, message) {
  return new AppError(400, code, message);
}

function forbidden(code = 'forbidden') {
  return new AppError(403, code);
}

function unauthorized(code = 'unauthorized') {
  return new AppError(401, code);
}

module.exports = { AppError, notFound, badRequest, forbidden, unauthorized };
