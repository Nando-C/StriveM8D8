interface ImportMetaEnv {
  /** Base URL of the chat server, e.g. http://localhost:3001 */
  readonly VITE_BACKEND_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
