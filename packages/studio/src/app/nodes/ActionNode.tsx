import type { NodeProps } from '@xyflow/react';

import type { ActionNode as ActionNodeType } from '../model';
import { Pill } from '../edges/Pill';

/**
 * A target-less action rendered as a free-standing pill node, grouped with the
 * isolated cluster (plan section 3.3 / 3.4). It reuses the same Pill component
 * as the self-loop edge label, so the grammar is identical whether an action
 * targets an object or not.
 */
export const ActionNode = ({ data }: NodeProps<ActionNodeType>) => (
  <Pill action={data.action} active={data.active} highlighted={data.highlighted} dim={data.dim} />
);
