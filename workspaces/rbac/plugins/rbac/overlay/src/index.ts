import { unstable_ClassNameGenerator as ClassNameGenerator } from '@mui/material/className';

ClassNameGenerator.configure(componentName => {
  return componentName.startsWith('v5-')
    ? componentName
    : `v5-${componentName}`;
});

export { rbacPlugin, RbacPage, Administration } from './plugin';
export { rbacApiRef } from './api/RBACBackendClient';
export type { RBACAPI } from './api/RBACBackendClient';

export { default as AdminPanelSettingsOutlinedIcon } from '@mui/icons-material/AdminPanelSettingsOutlined';
export { default as RbacIcon } from '@mui/icons-material/VpnKeyOutlined';
export type {
  MemberEntity,
  RoleError,
  PluginConditionRules,
  RoleBasedConditions,
  ConditionRule,
} from './types';
