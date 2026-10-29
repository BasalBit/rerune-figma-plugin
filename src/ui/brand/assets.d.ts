// Font files are bundled as bytes (build-figma-plugin.ui.js: loader ".woff2": "binary").
declare module "*.woff2" {
  const bytes: Uint8Array
  export default bytes
}
