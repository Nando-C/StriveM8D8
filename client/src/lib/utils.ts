export { cn } from "cn"

// For a scroll area holding rows that truncate. Its viewport wraps the content in a
// `display: table` element, which grows to fit the longest line instead of letting it be
// cut short; as a block it takes the width it is given.
export const SCROLL_AREA_ROWS = '[&_[data-slot=scroll-area-viewport]>div]:!block'
