import { For, Show } from 'solid-js';
import { cx, ic, Icon, createControllable } from '../core/util';
import { IconButton } from './actions';
import { Checkbox } from './selection';
import type { PillProps, BannerProps, TableProps, BreadcrumbsProps, MeterProps, SelectProps } from '../types';

/** Kumo badge: short label for status, plan or "New"/"Beta". */
export function Pill(props: PillProps) {
  return <span class={cx('aa-pill', 'aa-pill-' + (props.variant ?? 'neutral'), props.class)} style={props.style}><Show when={props.dot}><span class="aa-dot" /></Show>{ic(props.icon)}{props.children}</span>;
}

const BANNER_ICON = { info: 'info', warning: 'warning', danger: 'error', success: 'check_circle', brand: 'pets' } as const;

/** Inline, persistent message at the top of a page or card. */
export function Banner(props: BannerProps) {
  const v = () => props.variant ?? 'info';
  return (
    <div role={v() === 'danger' ? 'alert' : 'status'} class={cx('aa-banner', 'aa-banner-' + v(), props.class)} style={props.style}>
      <Icon name={props.icon ?? BANNER_ICON[v()]} />
      <div class="aa-banner-body"><Show when={props.title}><b>{props.title}</b></Show><Show when={props.children}><p>{props.children}</p></Show></div>
      {props.action}
      <Show when={props.onClose}><IconButton icon="close" label="Dismiss" size="xs" onClick={() => props.onClose?.()} /></Show>
    </div>
  );
}

/** Data table in a layer card, with optional row selection. */
export function Table<R extends Record<string, any>>(props: TableProps<R>) {
  const keyOf = (r: R, i: number) => (props.rowKey ? props.rowKey(r, i) : (r.key ?? i));
  const [sel, setSel] = createControllable<(string | number)[]>(() => props.selected, props.defaultSelected ?? [], props.onSelectedChange);
  const toggle = (k: string | number) => { const c = [...sel()]; const i = c.indexOf(k); if (i >= 0) c.splice(i, 1); else c.push(k); setSel(c); };
  const all = () => props.rows.length > 0 && sel().length === props.rows.length;
  return (
    <div class={cx('aa-table-wrap', props.class)} style={props.style}>
      <table class="aa-table">
        <thead><tr>
          <Show when={props.selectable}>
            <th style={{ width: '16px' }}><Checkbox aria-label="Select all" checked={all()} indeterminate={sel().length > 0 && !all()} onChange={(on) => setSel(on ? props.rows.map(keyOf) : [])} /></th>
          </Show>
          <For each={props.columns}>{(c) => <th class={c.numeric ? 'num' : undefined} style={c.width ? { width: typeof c.width === 'number' ? c.width + 'px' : c.width } : undefined}>{c.label}</th>}</For>
        </tr></thead>
        <tbody>
          <For each={props.rows}>{(r, i) => {
            const k = () => keyOf(r, i()); const on = () => sel().includes(k());
            return (
              <tr class={on() ? 'is-selected' : undefined}>
                <Show when={props.selectable}><td><Checkbox aria-label="Select row" checked={on()} onChange={() => toggle(k())} /></td></Show>
                <For each={props.columns}>{(c) => <td class={c.numeric ? 'num' : undefined}>{c.render ? c.render(r) : r[c.key]}</td>}</For>
              </tr>
            );
          }}</For>
        </tbody>
      </table>
    </div>
  );
}

export function Breadcrumbs(props: BreadcrumbsProps) {
  return (
    <nav aria-label="Breadcrumb" class={props.class} style={props.style}>
      <ol class="aa-crumbs" style={{ 'list-style': 'none', margin: 0, padding: 0 }}>
        <For each={props.items}>{(it, i) => {
          const last = () => i() === props.items.length - 1;
          return (
            <>
              <li><Show when={!last()} fallback={<span aria-current="page">{it.label}</span>}><a href={it.href ?? '#'} class="aa-focus">{it.label}</a></Show></li>
              <Show when={!last()}><li class="sep" aria-hidden="true">/</li></Show>
            </>
          );
        }}</For>
      </ol>
    </nav>
  );
}

/** Labelled usage meter; turns gold at warnAt and danger at 100%. */
export function Meter(props: MeterProps) {
  const max = () => props.max ?? 1;
  const r = () => Math.max(0, Math.min(1, (props.value ?? 0) / max()));
  return (
    <div class={cx('aa-meter', r() >= 1 ? 'is-over' : r() >= (props.warnAt ?? 0.8) && 'is-warn', props.class)} style={props.style}>
      <div class="aa-meter-row"><span class="l">{ic(props.icon)}{props.label}</span><span class="v">{props.valueLabel ?? props.value + ' / ' + max()}</span></div>
      <div class="aa-lprog" role="meter" aria-label={props.label} aria-valuemin={0} aria-valuemax={max()} aria-valuenow={props.value}><span class="aa-lprog-a" style={{ width: r() * 100 + '%' }} /></div>
    </div>
  );
}

/** Native select styled as a Kumo control. */
export function Select(props: SelectProps) {
  const [val, setVal] = createControllable(() => props.value, props.defaultValue ?? props.options[0]?.value ?? '', props.onChange);
  return (
    <select class={cx('aa-select', props.class)} aria-label={props.label} value={val()} disabled={props.disabled} style={props.style} onChange={(e) => setVal(e.currentTarget.value)}>
      <For each={props.options}>{(o) => <option value={o.value} selected={o.value === val()}>{o.label}</option>}</For>
    </select>
  );
}
