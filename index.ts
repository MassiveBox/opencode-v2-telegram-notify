// Conventional root entrypoint for local-path loading.
//
// OpenCode resolves local plugin directories conventionally
// (`<dir>/server.<ext>` then `<dir>/index.<ext>`); the package.json
// `exports` map is only honored for installed (npm) packages. Keep this
// file so the plugin loads when referenced by absolute/local path.
export { default } from "./src/index.js";
