/**
 * Augment the global Window interface to declare the typed IPC bridge injected
 * by the preload script via contextBridge.exposeInMainWorld.
 *
 * The renderer may ONLY interact with the main process through this surface.
 * It must not import Node APIs or @skillkeeper/* core packages directly.
 */
import type { SkillkeeperBridge } from '../preload/index';

declare global {
  interface Window {
    skillkeeper: SkillkeeperBridge;
  }
}

export {};
