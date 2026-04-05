// src/browser/types.ts — shared types for the browser subsystem.
//
// These types define the contract between BrowserService and the web-browser
// skill handler. Keeping them separate avoids circular imports between
// browser-service.ts and handler.ts.

/** Opaque session identifier returned by BrowserService and threaded by the LLM. */
export type SessionId = string;

/**
 * The set of actions the web-browser skill can perform.
 * Each action maps to a single Playwright operation.
 */
export type BrowserAction =
  | 'navigate'
  | 'click'
  | 'type'
  | 'select'
  | 'get_content'
  | 'screenshot'
  | 'close_session';
