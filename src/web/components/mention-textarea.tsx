import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type TextareaHTMLAttributes } from 'react';
import { NotebookPen } from 'lucide-react';
import type { Asset } from '../../shared/types';
import { libraryDocuments } from '../lib/library-index';
import { filterMentions, insertMention, mentionQuery, type MentionQuery } from '../lib/mentions';
import { relativeTime } from '../lib/utils';

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
  value: string;
  onChange: (value: string) => void;
  /** Where the suggestion list opens; composers at the bottom of a view open it above the field. */
  placement?: 'above' | 'below';
};

/**
 * A textarea where typing `@` offers the project's Library documents. Picking one inserts a Markdown asset
 * reference, the same `[name](asset://ID)` form agents receive in prompts and the app renders as a link.
 */
export function MentionTextarea({ value, onChange, onKeyDown, onClick, onKeyUp, onBlur, placement = 'above', ...rest }: Props) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [index, setIndex] = useState(0);
  const [caret, setCaret] = useState<number | null>(null);
  const options = mention && assets ? filterMentions(assets, mention.query) : [];
  const open = Boolean(mention) && options.length > 0;
  useEffect(() => {
    if (!mention || assets) return;
    let live = true;
    libraryDocuments().then(list => { if (live) setAssets(list); }).catch(() => { if (live) setAssets([]); });
    return () => { live = false; };
  }, [mention, assets]);
  useEffect(() => { setIndex(0); }, [mention?.query]);
  // The caret lands after the inserted reference once the parent has rendered the new value.
  useLayoutEffect(() => {
    if (caret === null || !field.current) return;
    field.current.setSelectionRange(caret, caret);
    setCaret(null);
  }, [caret, value]);
  function sync(element: HTMLTextAreaElement) {
    const next = mentionQuery(element.value, element.selectionStart ?? element.value.length);
    setMention(current => current && next && current.start === next.start && current.query === next.query ? current : next);
    if (!next) setAssets(null);
  }
  function pick(asset: Asset) {
    const element = field.current;
    if (!mention || !element) return;
    const inserted = insertMention(value, mention, element.selectionStart ?? value.length, asset);
    onChange(inserted.text);
    setCaret(inserted.caret);
    setMention(null);
    setAssets(null);
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (open && !event.nativeEvent.isComposing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setIndex(current => (current + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); pick(options[index] ?? options[0]); return; }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMention(null); setAssets(null); return; }
    }
    onKeyDown?.(event);
  }
  const listId = `${rest.id ?? 'mention'}-documents`;
  return <div className={`mention-field ${placement}`}>
    <textarea ref={field} {...rest} value={value} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? listId : undefined}
      onChange={event => { onChange(event.target.value); sync(event.target); }}
      onKeyDown={keyDown}
      onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) sync(event.currentTarget); onKeyUp?.(event); }}
      onClick={event => { sync(event.currentTarget); onClick?.(event); }}
      onBlur={event => { setMention(null); setAssets(null); onBlur?.(event); }} />
    {open && <ul id={listId} className="mention-menu" role="listbox" aria-label="Library documents">
      {options.map((asset, position) => <li key={asset.id} role="option" aria-selected={position === index} className={position === index ? 'active' : ''} onMouseDown={event => { event.preventDefault(); pick(asset); }} onMouseEnter={() => setIndex(position)}>
        <NotebookPen size={13} aria-hidden="true" /><span>{asset.name}</span><small>{relativeTime(asset.createdAt)}</small>
      </li>)}
    </ul>}
    {mention && assets && options.length === 0 && <div className="mention-menu mention-empty" role="status">{assets.some(asset => !asset.latestVersionId) ? `No Library document matches “${mention.query}”` : 'No Library documents yet'}</div>}
  </div>;
}
