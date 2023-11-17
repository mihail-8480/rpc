export type ErrorObject = {
  code: number;
  message: string;
  data?: object | number | string;
};

function ensureErrorCodeNotReserved(code: number) {
  if (code >= -32768 && code <= -32000) {
    throw new TypeError(`Error code reserved for pre-defined errors`);
  }
}

export class RpcError implements ErrorObject {
  public code: number;
  public message: string;
  public data?: string | number | object;

  constructor({ code, message, data }: ErrorObject) {
    this.code = code;
    this.message = message;
    this.data = data;
  }
}

export enum ErrorCodes {
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,
}

export function createError(
  code: number,
  { message, data }: { message?: string; data?: object | number | string } = {}
): ErrorObject {
  if (code === ErrorCodes.ParseError) {
    return {
      code,
      message: message ?? "Parse error",
      data,
    };
  }
  if (code === ErrorCodes.InvalidRequest) {
    return {
      code,
      message: message ?? "Invalid Request",
      data,
    };
  }
  if (code === ErrorCodes.MethodNotFound) {
    return {
      code,
      message: message ?? "Method not found",
      data,
    };
  }

  if (code === ErrorCodes.InvalidParams) {
    return {
      code,
      message: message ?? "Invalid params",
      data,
    };
  }

  if (code === ErrorCodes.InternalError) {
    return {
      code,
      message: message ?? "Internal error",
      data,
    };
  }

  ensureErrorCodeNotReserved(code);

  return {
    code,
    message: message ?? "Unknown error",
    data,
  };
}
