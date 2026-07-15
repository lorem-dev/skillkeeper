// Install / verify / repair.
export { installSkill, uninstallSkill } from './install.js';
export type { InstallOptions } from './install.js';
export { verifyInstall, repairInstall } from './verify.js';
export type {
  VerifyReport,
  VerifyStatus,
  FileVerification,
  HookEditVerification,
  RepairOptions,
} from './verify.js';
