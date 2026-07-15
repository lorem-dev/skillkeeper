// electron-vite resolves `?asset` imports to the emitted file path (string),
// copying the file into the build output. Declared here because tsconfig.node
// pins `types` to ["node"] and does not pull in electron-vite's ambient types.
declare module '*?asset' {
  const assetPath: string;
  export default assetPath;
}
