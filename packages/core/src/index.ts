/**
 * orangerail core — public entry.
 *
 * The ontology declaration surface (defineObject / defineLink / defineAction),
 * the registry, the policy engine, the governed action lifecycle engine, the
 * hash-chained audit log, the identity/authorization contract, and the store
 * adapter with an in-memory reference implementation. Pure TypeScript, zero
 * transport concerns — MCP / CLI / file store consume this in ONT-003+.
 */

/** Package marker version (pre-release). */
export const version = '0.0.0';

export * from './types';

export {
  createRegistry,
  defineAction,
  defineLink,
  defineObject,
  getDefaultRegistry,
  resetDefaultRegistry,
} from './registry';
export type { Registry } from './registry';

export type { DefineObjectInput } from './define/object';
export type { DefineLinkInput } from './define/link';
export type { DefineActionInput } from './define/action';
export { isNotImplemented, notImplemented } from './define/action';

export { createMemoryStore } from './store/memory';
export { createFileStore, isFileStore } from './store/file';
export type { FileStore } from './store/file';
export { acquireLock, isLockOwner, releaseLock, unlockStore } from './store/file-lock';
export type { LockOwner, UnlockResult } from './store/file-lock';
export type {
  ApprovalRecord,
  ApprovalStatus,
  AuditInput,
  AuditPhase,
  AuditRecord,
  ConsumeApprovalResult,
  CreateApprovalInput,
  ResolveApprovalResult,
  Store,
} from './store/contract';

export { createEngine } from './lifecycle/engine';
export type {
  ApproveResult,
  Engine,
  EngineMode,
  ExecuteResult,
  RedactAudit,
  RejectResult,
  StageResult,
} from './lifecycle/engine';

export { verifyAudit } from './audit/verify';
export type { AuditVerifyResult } from './audit/verify';
export { GENESIS_HASH, hashAuditRecord } from './audit/chain';

export { authorizeApprover, DEV_SUBJECT, resolveCaller } from './identity/contract';
export type { IdentityConfig, ResolveIdentity, ResolveIdentityContext } from './identity/contract';

export { evaluateWhere, isSerializableWhere } from './policy/where';

export { computeSignatureHash } from './signature';
export { canonicalJson, inputShape, shapeKeys, typeNameOf } from './introspect';
