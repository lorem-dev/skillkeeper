/** Whether a controlled search value is empty -- the collapse-on-blur test for
 *  `ExpandingSearch` (the field only shrinks back to a button when left empty).
 *  A non-string controlled value (e.g. a number) is treated as empty. */
export function isSearchEmpty(value: unknown): boolean {
  return !(typeof value === 'string' && value.length > 0);
}
