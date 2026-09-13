// Shared result shape + machine error-code vocabulary for the service layer (services/*, plus the
// browser-safe runtime/localService.ts). A service returns an HTTP-ish `{ code, body }` and the route
// adapter translates it at the edge. The `error` field has drifted as a bare string across modules, so
// the stable machine codes live here as one union: adapters can branch on `body.error` against the
// same vocabulary, and `ServiceErrorCode` guides autocomplete. The `(string & {})` arm keeps the
// pre-existing free-text codes compiling — the HTTP contract is unchanged by this sweep.

/** Machine-readable `error` codes the service layer returns in a result body. */
export type ServiceErrorCode =
  | 'unsupported'
  | 'building'
  | 'no device detected'
  | 'block-exists'
  | 'block-save-failed'
  | 'block-capture-failed'
  | 'block-not-found'
  | 'saved-block-family-mismatch'
  | 'saved-block-apply-failed'
  | 'invalid-saved-block'
  | 'unsaved-family'
  | 'firmware-not-reported'
  | 'model-mismatch'
  | 'firmware-mismatch'
  | 'cache-parse-failed'
  // Free-text legacy codes still in circulation; kept assignable so this sweep stays non-breaking.
  | (string & {});

/** A service result body. `error` (when present) is a machine code; `message`/other fields ride along. */
export interface ServiceBody {
  error?: ServiceErrorCode;
  [extra: string]: unknown;
}

/** The shared service return shape: an HTTP status plus its JSON body. */
export interface ServiceResult {
  code: number;
  body: ServiceBody;
}
