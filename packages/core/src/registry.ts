import type { z } from 'zod';

import { buildActionDefinition, type DefineActionInput } from './define/action';
import { buildLinkDefinition, type DefineLinkInput } from './define/link';
import { buildObjectDefinition, type DefineObjectInput } from './define/object';
import { markCoreInstance } from './instance';
import type { LinkDefinition, ObjectDefinition, Policy, RuntimeAction } from './types';

/**
 * Create an explicit, resettable registry (§3.2 / AC-4). The engine takes a
 * registry argument; the module-default sugar below registers into a shared
 * instance so `defineObject`/`defineLink`/`defineAction` preserve §4's
 * "register on call" discovery model without OSDK's global-mutable trap.
 * Duplicate names throw.
 */
export const createRegistry = () => {
  const objects = new Map<string, ObjectDefinition>();
  const actions = new Map<string, RuntimeAction>();
  const links: LinkDefinition[] = [];

  const defineObject = <
    Name extends string,
    Schema extends z.ZodType,
    const Def extends DefineObjectInput<Name, Schema>,
  >(
    def: Def,
  ) => {
    const obj = buildObjectDefinition(def);

    if (objects.has(obj.name)) {
      throw new Error(`duplicate object name: "${obj.name}"`);
    }

    objects.set(obj.name, obj as ObjectDefinition);

    return obj;
  };

  const defineLink = <Name extends string>(def: DefineLinkInput<Name>) => {
    const link = buildLinkDefinition(def);

    if (links.some((existing) => existing.name === link.name)) {
      throw new Error(`duplicate link name: "${link.name}"`);
    }

    links.push(link as LinkDefinition);

    return link;
  };

  const defineAction = <
    Name extends string,
    Input extends z.ZodType,
    Target extends ObjectDefinition<string, z.ZodType, boolean> | undefined = undefined,
    P extends Policy<Input, Target> | undefined = undefined,
  >(
    def: DefineActionInput<Name, Input, Target, P>,
  ) => {
    const action = buildActionDefinition(def);

    if (actions.has(action.name)) {
      throw new Error(`duplicate action name: "${action.name}"`);
    }

    actions.set(action.name, action as unknown as RuntimeAction);

    return action;
  };

  const getObject = ({ name }: { name: string }): ObjectDefinition | undefined => objects.get(name);

  const getAction = ({ name }: { name: string }): RuntimeAction | undefined => actions.get(name);

  const listObjects = (): ObjectDefinition[] => [...objects.values()];

  const listActions = (): RuntimeAction[] => [...actions.values()];

  const listLinks = (): LinkDefinition[] => [...links];

  const reset = (): void => {
    objects.clear();
    actions.clear();
    links.length = 0;
  };

  // Stamp the registry with THIS core's instance token (ONT-058). The registry
  // is the carrier the skew check keys on because it is the only unambiguous
  // one: a `Registry` can come from nowhere but `createRegistry`, whereas a
  // `Store` is a documented extension point, so an unmarked store is honestly
  // ambiguous between "old core" and "a conforming adapter someone wrote".
  return markCoreInstance({
    value: {
      defineObject,
      defineLink,
      defineAction,
      getObject,
      getAction,
      listObjects,
      listActions,
      listLinks,
      reset,
    },
  });
};

/** The registry type — a resettable declaration container. */
export type Registry = ReturnType<typeof createRegistry>;

let defaultRegistry = createRegistry();

/** The module-default registry backing the {@link defineObject} sugar. */
export const getDefaultRegistry = (): Registry => defaultRegistry;

/** Replace the module-default registry with a fresh one (test isolation). */
export const resetDefaultRegistry = (): void => {
  defaultRegistry = createRegistry();
};

/** Sugar: define + register an object into the module-default registry. */
export const defineObject = <
  Name extends string,
  Schema extends z.ZodType,
  const Def extends DefineObjectInput<Name, Schema>,
>(
  def: Def,
) => defaultRegistry.defineObject(def);

/** Sugar: define + register a link into the module-default registry. */
export const defineLink = <Name extends string>(def: DefineLinkInput<Name>) =>
  defaultRegistry.defineLink(def);

/** Sugar: define + register an action into the module-default registry. */
export const defineAction = <
  Name extends string,
  Input extends z.ZodType,
  Target extends ObjectDefinition<string, z.ZodType, boolean> | undefined = undefined,
  P extends Policy<Input, Target> | undefined = undefined,
>(
  def: DefineActionInput<Name, Input, Target, P>,
) => defaultRegistry.defineAction(def);
