export { startMcpServer } from './server.js';
export { loadRegistry, saveRegistry, removeRepo, getGitRemote, findEntryWithSiblingWarning } from './registry.js';
export type { RegistryEntry } from './registry.js';
export {
  createGroup, removeGroup, addRepoToGroup, removeRepoFromGroup,
  listGroups, getGroup, getGroupStatus, groupQuery,
  loadGroups, saveGroups,
  autoDetectGroups,
} from './groups.js';
export type { RepoGroup, GroupRepo, GroupsConfig, GroupStatus, ServiceBoundary } from './groups.js';
export {
  extractOpenApiContracts,
  extractDockerComposeContracts,
  extractProtoContracts,
  extractManifestContracts,
} from './manifest-extractor.js';
export type { ManifestContract } from './manifest-extractor.js';
