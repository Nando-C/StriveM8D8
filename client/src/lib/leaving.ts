// Things to say to the server as the page is left, before the connection is closed —
// which is done in one place (`useChat`), and must come last.

const farewells = new Set<() => void>()

/** Registers something to do just before the page's connection is closed. Returns what unregisters it. */
export const onLeaving = (farewell: () => void): (() => void) => {
  farewells.add(farewell)
  return () => {
    farewells.delete(farewell)
  }
}

export const sayFarewells = () => {
  for (const farewell of farewells) farewell()
}
