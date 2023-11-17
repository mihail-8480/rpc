import {
  ISubject,
  blockFromSubject,
  commit,
  createSubject,
  createSubscriber,
} from "@mojsoski/streams";
import { ErrorCodes, ErrorObject, RpcError, createError } from "./error";

export type Notification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown[] | object;
};

export type RequestObject = Notification & { id: string | number | null };

function ensureNotRpcInternal(method: string) {
  if (method.startsWith("rpc.")) {
    throw new TypeError(`RPC method prefix reserved for rpc-internal methods`);
  }
}

function ensureRequestValid(request: RequestObject) {
  if (typeof request !== "object") {
    throw new RpcError(createError(ErrorCodes.InvalidRequest));
  }
  if (request.jsonrpc !== "2.0") {
    throw new RpcError(createError(ErrorCodes.InvalidRequest));
  }
  if (typeof request.method !== "string") {
    throw new RpcError(createError(ErrorCodes.InvalidRequest));
  }
}

export type ResponseObject = {
  jsonrpc: "2.0";
  id: string | number | null;
} & (
  | {
      result: object | number | string | null;
    }
  | {
      error: ErrorObject;
    }
);

export interface RpcInterface<T extends {}> {
  [key: string]: (context: T, ...params: unknown[]) => unknown;
}

type RpcClientMethod<
  T extends (context: unknown, ...params: unknown[]) => unknown
> = T extends (context: any, ...params: infer Params) => infer TReturn
  ? (...params: Params) => Promise<Awaited<TReturn>>
  : never;

type BatchResponse<T extends Promise<any[]>> = T extends Promise<[]>
  ? Promise<void>
  : T;

type RpcClientMethodBatch<
  T extends (context: unknown, ...params: unknown[]) => unknown,
  TClient extends RpcInterface<any>,
  TRequest extends any[]
> = T extends (context: any, ...params: infer Params) => infer TReturn
  ? (...params: Params) => RcpClientBatch<
      TClient,
      [...TRequest, Awaited<TReturn>]
    > & {
      notify: RcpClientBatchNotify<TClient, [...TRequest, Awaited<TReturn>]>;
      send: () => BatchResponse<Promise<[...TRequest, Awaited<TReturn>]>>;
    }
  : never;

type RpcClientMethodBatchNotify<
  T extends (context: unknown, ...params: unknown[]) => unknown,
  TClient extends RpcInterface<any>,
  TRequest extends any[]
> = T extends (context: any, ...params: infer Params) => any
  ? (...params: Params) => RcpClientBatch<TClient, TRequest> & {
      notify: RcpClientBatchNotify<TClient, TRequest>;
      send: () => BatchResponse<Promise<TRequest>>;
    }
  : never;

type RcpClientBatch<T extends RpcInterface<any>, TRequest extends any[]> = {
  [Key in keyof T]: RpcClientMethodBatch<T[Key], T, TRequest>;
} & {
  notify: RcpClientBatchNotify<T, TRequest>;
};

type RcpClientBatchNotify<
  T extends RpcInterface<any>,
  TRequest extends any[]
> = {
  [Key in keyof T]: RpcClientMethodBatchNotify<T[Key], T, TRequest>;
};

export type RpcClient<T extends RpcInterface<any>> = {
  [Key in keyof T]: RpcClientMethod<T[Key]>;
};

export type StreamResponse = ResponseObject | { skip: true };

type TypeOfString = "boolean" | "number" | "object" | "string" | "undefined";

type TypeOf<T extends TypeOfString> = T extends "boolean"
  ? boolean
  : T extends "number"
  ? number
  : T extends "object"
  ? object
  : T extends "string"
  ? string
  : T extends "undefined"
  ? undefined
  : never;

type TypeOfArray<TItems extends TypeOfString[]> = TItems extends [
  infer TCurrent extends TypeOfString,
  ...infer Rest extends TypeOfString[]
]
  ? [TypeOf<TCurrent>, ...TypeOfArray<Rest>]
  : [];

export function params<TItems extends TypeOfString[]>(
  items: unknown[],
  ...types: TItems
): TypeOfArray<TItems> {
  const results: unknown[] = [];
  let idx = 0;
  for (const type of types) {
    results.push(validate(items[idx++], type));
  }
  return results as TypeOfArray<TItems>;
}

function validate<T extends TypeOfString>(value: unknown, type: T): TypeOf<T> {
  if (typeof value === type) {
    return value as TypeOf<T>;
  }
  throw new RpcError(createError(ErrorCodes.InvalidParams));
}

export { RpcError, ErrorCodes, createError };

async function handleRequest<TContext extends {}>(
  context: TContext,
  source: RequestObject,
  impl: RpcInterface<TContext>
): Promise<StreamResponse> {
  try {
    ensureRequestValid(source);
    if (!(source.method in impl)) {
      throw new RpcError(createError(ErrorCodes.MethodNotFound));
    }
    let result: any = undefined;
    if (Array.isArray(source.params)) {
      result = await impl[source.method](context, ...source.params);
    } else {
      if (source.params === undefined) {
        result = await impl[source.method](context);
      } else {
        result = await impl[source.method](context, source.params);
      }
    }

    if (source.id === undefined) {
      return { skip: true };
    }

    return {
      jsonrpc: "2.0",
      id: source.id,
      result,
    };
  } catch (e: unknown) {
    if (typeof source === "object" && source.id === undefined) {
      return { skip: true };
    }

    if (e instanceof RpcError) {
      return {
        jsonrpc: "2.0",
        id: source.id,
        error: {
          message: e.message,
          data: e.data,
          code: e.code,
        },
      };
    }
    return {
      jsonrpc: "2.0",
      id: source.id,
      error: createError(ErrorCodes.InternalError, {
        message:
          typeof e === "object" &&
          "message" in e! &&
          typeof e.message === "string"
            ? e.message
            : undefined,
      }),
    };
  }
}

export function server<T extends {}>(
  impl: RpcInterface<T>,
  createContext: () => Promise<T>
) {
  for (const keys of Object.keys(impl)) {
    ensureNotRpcInternal(keys);
  }

  const handleBlock = async function (
    text: string
  ): Promise<StreamResponse | StreamResponse[]> {
    const context = await createContext();
    try {
      const source: RequestObject | RequestObject[] = JSON.parse(text);
      if (Array.isArray(source)) {
        if (source.length === 0) {
          return {
            jsonrpc: "2.0",
            id: null,
            error: createError(ErrorCodes.InvalidRequest),
          };
        }
        const batchResults = (
          await Promise.all(
            source.map((item) => handleRequest(context, item, impl))
          )
        ).filter((item) => !("skip" in item && item.skip));
        if (batchResults.length) {
          return batchResults;
        }
        return { skip: true };
      } else {
        return await handleRequest(context, source, impl);
      }
    } catch {
      return {
        jsonrpc: "2.0",
        id: null,
        error: createError(ErrorCodes.ParseError),
      };
    }
  };

  return async function* (
    source: AsyncIterable<string>
  ): AsyncIterable<string> {
    for await (const item of source) {
      const result = await handleBlock(item);
      if (!("skip" in result && result.skip)) {
        yield JSON.stringify(result);
      }
    }
  };
}

export type RpcClientDriverHandle = {
  getResponseHandle(id: string | number): Promise<ResponseObject>;
};

export type RpcClientDriver = {
  handleClient(client: ISubject<string>): RpcClientDriverHandle;
};

function sendBatched(
  rpcClient: ReturnType<typeof createSubject<string>>,
  handle: RpcClientDriverHandle,
  ids: (RequestObject | Notification)[]
) {
  const promise = ids
    .filter((item) => "id" in item && typeof item.id !== null)
    .map((item) =>
      handle.getResponseHandle((item as RequestObject).id as string | number)
    );

  rpcClient.notify(JSON.stringify(ids));

  if (promise.length > 0) {
    return Promise.all(
      promise.map(async (promise) => {
        const response = await promise;
        if ("error" in response) {
          throw new RpcError(response.error);
        }
        return response.result;
      })
    );
  }
}

function createNotifyBatchProxy<T extends {}>(
  rpcClient: ReturnType<typeof createSubject<string>>,
  handle: RpcClientDriverHandle,
  idRef: { currentId: number },
  ids: (RequestObject | Notification)[]
): Readonly<RpcClient<T>> {
  return new Proxy<Readonly<RpcClient<T>>>({} as any, {
    get(_, prop) {
      switch (prop) {
        case "notify":
          throw new TypeError("Invalid method name");
        case "send":
          return () => {
            return sendBatched(rpcClient, handle, ids);
          };
      }
      if (typeof prop === "symbol") {
        throw new TypeError("Invalid method name");
      }

      return (...props: unknown[]) => {
        return createBatchProxy(rpcClient, handle, idRef, [
          ...ids,
          {
            jsonrpc: "2.0",
            method: prop,
            params: props,
          },
        ]);
      };
    },
  });
}

function createBatchProxy<T extends {}>(
  rpcClient: ReturnType<typeof createSubject<string>>,
  handle: RpcClientDriverHandle,
  idRef: { currentId: number },
  ids: (RequestObject | Notification)[]
): Readonly<RpcClient<T>> {
  return new Proxy<Readonly<RpcClient<T>>>({} as any, {
    get(_, prop) {
      switch (prop) {
        case "notify":
          return createNotifyBatchProxy(rpcClient, handle, idRef, ids);
        case "send":
          return () => {
            return sendBatched(rpcClient, handle, ids);
          };
      }
      if (typeof prop === "symbol") {
        throw new TypeError("Invalid method name");
      }

      return (...props: unknown[]) => {
        const id = idRef.currentId++;
        return createBatchProxy(rpcClient, handle, idRef, [
          ...ids,
          {
            jsonrpc: "2.0",
            method: prop,
            params: props,
            id,
          },
        ]);
      };
    },
  });
}

export function client<T extends {}>(driver: RpcClientDriver) {
  const rpcClient = createSubject<string>();
  const handle = driver.handleClient(rpcClient.subject);
  const idRef: { currentId: number } = {
    currentId: 0,
  };
  return new Proxy<
    Readonly<RpcClient<T>> & { batch: Readonly<RcpClientBatch<T, []>> }
  >({} as any, {
    get(_, prop) {
      if (typeof prop === "symbol") {
        throw new TypeError("Invalid method name");
      }

      if (prop === "batch") {
        return createBatchProxy(rpcClient, handle, idRef, []);
      }

      return async (...props: unknown[]) => {
        const id = idRef.currentId++;
        const promise = handle.getResponseHandle(id);

        rpcClient.notify(
          JSON.stringify({
            jsonrpc: "2.0",
            method: prop,
            params: props,
            id,
          })
        );

        const response = await promise;

        if ("error" in response) {
          throw new RpcError(response.error);
        }
        return response.result;
      };
    },
  });
}

export function createClientDriver(
  transport: (source: AsyncIterable<string>) => AsyncIterable<string>
): RpcClientDriver {
  return {
    handleClient(client) {
      const requests: Record<
        number | string,
        {
          resolve: (response: ResponseObject) => void;
          reject: (reason?: any) => void;
        }
      > = {};

      const clientSubscriber = createSubscriber<string>({
        data(data) {
          let id: string | number | null = null;
          try {
            const item = JSON.parse(data) as ResponseObject | ResponseObject[];

            if (Array.isArray(item)) {
              for (const i of item) {
                id = i.id;
                if (id !== null) {
                  requests[id]?.resolve(i);
                }
              }
            } else {
              id = item.id;
              if (id !== null) {
                requests[id]?.resolve(item);
              }
            }
          } catch (e) {
            if (id === null) {
              throw e;
            }
            requests[id]?.reject(e);
          }
        },
        end() {},
      });
      commit(blockFromSubject(client).pipe(transport).copyTo(clientSubscriber));
      return {
        getResponseHandle(requestId: number) {
          return new Promise<ResponseObject>((resolve, reject) => {
            requests[requestId] = { resolve, reject };
          });
        },
      };
    },
  };
}
