// A short name for this browser, shown in the account's list of devices so its owner can
// tell them apart. A rough reading of the user agent is enough: it is a label, not a fact.

const BROWSERS: [RegExp, string][] = [
  [/Edg\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\//, 'Firefox'],
  [/Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
]

const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux/, 'Linux'],
]

const first = (table: [RegExp, string][], text: string) => table.find(([pattern]) => pattern.test(text))?.[1]

export const deviceLabel = (userAgent: string = navigator.userAgent): string => {
  const browser = first(BROWSERS, userAgent)
  const system = first(SYSTEMS, userAgent)
  if (browser !== undefined && system !== undefined) return `${browser} on ${system}`
  return browser ?? system ?? 'Unknown device'
}
