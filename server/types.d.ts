declare module 'node-cache' {
  export interface Options {
    stdTTL?: number;
  }
  export default class NodeCache {
    constructor(options?: Options);
    get<T>(key: string): T | undefined;
    set<T>(key: string, value: T, ttl?: number): boolean;
    del(keys: string | string[]): number;
  }
}

