import { cx } from '../core/util';
import type { ScrollAreaProps } from '../types';

const size = (v: number | string | undefined) => (v === undefined ? undefined : typeof v === 'number' ? v + 'px' : v);

/**
 * A scroll container with the system's scrollbar. Give it a max height (or width) and content that overflows.
 * It is focusable and labelled so keyboard users can scroll it with the arrow keys.
 * For whole pages, put the `aa-scroll` class on <html> instead.
 */
export function ScrollArea(props: ScrollAreaProps) {
  const dir = () => props.direction ?? 'vertical';
  return (
    <div
      role="region" aria-label={props.label} tabindex={props.label ? 0 : undefined}
      class={cx('aa-scroll', 'aa-scroll-' + dir(), props.subtle && 'aa-scroll-subtle', props.class)}
      style={{ 'max-height': size(props.maxHeight), 'max-width': size(props.maxWidth), height: size(props.height), ...(props.style as object) }}
    >
      {props.children}
    </div>
  );
}
