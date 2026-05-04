export { startMcpServer } from './server.js';
export { loadRegistry, saveRegistry } from './registry.js';
export type { RegistryEntry } from './registry.js';
export {
  createGroup, removeGroup, addRepoToGroup, removeRepoFromGroup,
  listGroups, getGroup, getGroupStatus, groupQuery,
  loadGroups, saveGroups,
  autoDetectGroups,
} from './groups.js';
export type { RepoGroup, GroupRepo, GroupsConfig, GroupStatus, ServiceBoundary } from './groups.js';
