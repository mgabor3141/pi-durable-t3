// T3's /ws methods as types: what each method receives, answers and streams, read from the contract's RPC group, so
// a handler or a value built for the wire is checked against the pinned contract at build time.
import type { WsRpcGroup } from "@t3tools/contracts";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";

export type WsRpcs = RpcGroup.Rpcs<typeof WsRpcGroup>;
/** Handlers for any subset of the methods; the rest are stubs (rpc.ts). */
export type WsHandlers = Partial<RpcGroup.HandlersFrom<WsRpcs>>;
export type WsTag = WsRpcs["_tag"];
type WsRpc<T extends WsTag> = Extract<WsRpcs, { readonly _tag: T }>;
/** The payload a method receives, after the contract decoded it. */
export type WsPayload<T extends WsTag> = Rpc.Payload<WsRpc<T>>;
/** What a unary method answers. */
export type WsSuccess<T extends WsTag> = Rpc.Success<WsRpc<T>>;
/** One item of a streaming method. */
export type WsItem<T extends WsTag> = Rpc.SuccessChunk<WsRpc<T>>;
