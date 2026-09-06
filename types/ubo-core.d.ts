// Ambient type declarations for @gorhill/ubo-core (pure-JS package, ships no
// types). Covers only the API surface the StayBrave pipeline actually uses
// (`src/ubo.js` and `examples/verify.js`); the members mirror the upstream
// static-filtering-parser.js / static-net-filtering.js public fields and
// methods. When ubo-core upstream eventually publishes its own types, this
// file can be deleted.

declare module '@gorhill/ubo-core/js/static-filtering-parser.js' {
  export interface AstFilterParserOptions {
    interactive?: boolean;
    trustedSource?: boolean;
    trustedScriptletTokens?: Set<string>;
    badTypes?: string[];
    maxTokenLength?: number;
  }

  export class AstFilterParser {
    constructor(options?: AstFilterParserOptions);
    parse(raw: string): void;
    finish(): void;
    readonly raw: string;
    readonly astType: number;
    readonly astTypeFlavor: number;
    readonly astFlags: number;
    readonly astError: number;
  }
}

declare module '@gorhill/ubo-core' {
  export interface ListSource {
    name: string;
    raw: string;
  }

  export interface UseListsOptions {
    events?: Array<{ text: string }>;
  }

  export interface MatchRequestDetails {
    url: string;
    originURL?: string;
    type?: string;
    tabId?: number;
    docId?: number;
    frameId?: number;
  }

  export class StaticNetFilteringEngine {
    static create(): Promise<StaticNetFilteringEngine>;
    useLists(
      lists: ListSource[],
      options?: UseListsOptions
    ): Promise<number>;
    matchRequest(details: MatchRequestDetails): Promise<number>;
    matchAndFetchModifiers(
      details: MatchRequestDetails,
      modifierName: string
    ): Promise<Array<unknown> | undefined>;
    filterQuery(
      details: MatchRequestDetails
    ): Promise<{ redirectURL?: string; directives: Array<unknown> } | undefined>;
    static release(): Promise<void>;
  }
}

declare module '@gorhill/ubo-core/js/static-net-filtering.js' {
  interface StaticNetFilteringEngineSingleton {
    getFilterCount(): number;
  }
  const snfe: StaticNetFilteringEngineSingleton;
  export default snfe;
}