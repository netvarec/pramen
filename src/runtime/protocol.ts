// Live-query wire protocol (JSON over WebSocket).
//
// Client -> server:
//   { type: "subscribe",   id, name, input? }   // query handler; initial data + pushes
//   { type: "unsubscribe", id }
//   { type: "call",        id, name, input? }    // one-shot any handler (query or mutation)
//
// Server -> client:
//   { type: "data",   id, result }   // initial subscription result + every update
//   { type: "result", id, result }   // reply to a one-shot call
//   { type: "error",  id, error }

export interface SubscribeMsg {
  type: "subscribe";
  id: string;
  name: string;
  input?: unknown;
}
export interface UnsubscribeMsg {
  type: "unsubscribe";
  id: string;
}
export interface CallMsg {
  type: "call";
  id: string;
  name: string;
  input?: unknown;
}

export type ClientMsg = SubscribeMsg | UnsubscribeMsg | CallMsg;

export type ServerMsg =
  | { type: "data"; id: string; result: unknown }
  | { type: "result"; id: string; result: unknown }
  | { type: "error"; id: string; error: string };

/** A live subscription, persisted on the socket so it survives DO hibernation. */
export interface Subscription {
  id: string;
  name: string;
  input: unknown;
  /** Tables the query read — its invalidation dependency set. */
  tables: string[];
}
