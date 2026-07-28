// UI-free barrel: pure helpers only, no React/UI imports. `@/app/store` (the
// store, not this feature's own UI) imports `sshErrorKey` from here rather
// than from the feature's main barrel (`@/features/sshKey`), which pulls in
// `ui/SshKeyField.tsx` -- and that imports `@/app/store` back, a cycle. This
// barrel breaks it: nothing under `lib/` reaches into `ui/` or the store.
export { sshErrorKey } from './sshErrors';
