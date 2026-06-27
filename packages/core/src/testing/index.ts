/**
 * In-memory test fakes shared across the SkillKeeper monorepo. Other packages
 * import these via the `@skillkeeper/core/testing` subpath. Excluded from the
 * production build and the coverage gate.
 */
export { createMemFs } from './memfs.js';
export { createFakeGit } from './fakeGit.js';
export type { FakeGit, FakeGitOptions, GitCall } from './fakeGit.js';
