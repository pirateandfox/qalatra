// @mention typeahead for MDXEditor.
//
// Generic over where suggestions come from: a MentionProvider supplies a
// cached "static" list (filtered locally on every keystroke) and/or a remote
// search (debounced). Selecting an item replaces `@query` with the item's
// plain-text insert, so mentions stay ordinary markdown text.
//
// Built on @lexical/react's LexicalTypeaheadMenuPlugin, which MDXEditor already
// depends on. ui/package.json pins @lexical/react + lexical to the same range as
// @mdxeditor/editor, and vite.config.ts dedupes them — two Lexical copies break
// the composer context at runtime.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  useBasicTypeaheadTriggerMatch,
  type MenuTextMatch,
} from '@lexical/react/LexicalTypeaheadMenuPlugin'
import { $createTextNode, COMMAND_PRIORITY_HIGH, type TextNode } from 'lexical'
import './mentions.css'

export interface MentionItem {
  /** Group key, e.g. 'task' | 'project' | 'context'. */
  kind: string
  id: string
  /** Primary text shown in the menu and matched against the query. */
  label: string
  /** Text inserted (after `@`) in place of `@query`. */
  insertText: string
  /** Extra text matched against the query but not displayed as the label. */
  searchText?: string
  /** Secondary text shown muted on the right. */
  detail?: string
  /** Lower sorts first within a group (e.g. active tasks before backlog). */
  rank?: number
}

export interface MentionProvider {
  /** Group display order + headings. Kinds not listed are dropped. */
  groups: { kind: string; label: string; limit?: number }[]
  /** Small lists filtered locally; the provider should cache. */
  loadStatic?: () => Promise<MentionItem[]>
  /** Remote search for a non-empty query; the plugin debounces calls. */
  search?: (query: string) => Promise<MentionItem[]>
  /** Debounce for `search`, ms. Default 150. */
  debounceMs?: number
}

export interface MentionsPluginParams {
  provider: MentionProvider
}

// Lexical's default punctuation set minus `-`, `_`, `/` and `.` so slugs like
// `pirate-and-fox` or `v1.2` stay inside the query.
const MENTION_PUNCTUATION = ",\\+\\*\\?\\$\\@\\|#{}\\(\\)\\^\\[\\]\\\\!%'\"~=<>:;"
const DEFAULT_LIMIT = 6

class MentionOption extends MenuOption {
  item: MentionItem
  constructor(item: MentionItem) {
    super(`${item.kind}:${item.id}`)
    this.item = item
  }
}

function normalize(s: string) {
  return s.toLowerCase()
}

function matchScore(label: string, query: string): number | null {
  if (!query) return 1
  const l = normalize(label)
  const q = normalize(query.trim())
  if (!q) return 1
  if (l.startsWith(q)) return 0
  if (l.includes(q)) return 1
  // Every word of the query appears somewhere in the label.
  const words = q.split(/\s+/).filter(Boolean)
  return words.every(w => l.includes(w)) ? 2 : null
}

function buildOptions(provider: MentionProvider, query: string, items: MentionItem[]): MentionOption[] {
  const out: MentionOption[] = []
  for (const group of provider.groups) {
    const seen = new Set<string>()
    const scored: { item: MentionItem; score: number; index: number }[] = []
    items.forEach((item, index) => {
      if (item.kind !== group.kind || seen.has(item.id)) return
      const score = matchScore(item.searchText ? `${item.label} ${item.searchText}` : item.label, query)
      if (score === null) return
      seen.add(item.id)
      scored.push({ item, score, index })
    })
    scored.sort((a, b) =>
      (a.item.rank ?? 0) - (b.item.rank ?? 0) ||
      a.score - b.score ||
      a.index - b.index)
    for (const s of scored.slice(0, group.limit ?? DEFAULT_LIMIT)) out.push(new MentionOption(s.item))
  }
  return out
}

// Lexical positions the anchor at the top of the matched `@query` text (the
// anchor's own height is pinned to 0 in mentions.css so its offset maths stays
// stable), so push the menu down by the caret's line height. Reading the live
// caret rect keeps it right in headings as well as body text.
function MentionMenu({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const sel = window.getSelection()
    const caret = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).getBoundingClientRect() : null
    el.style.marginTop = `${Math.round(caret && caret.height > 0 ? caret.height : 22) + 3}px`
  })
  return <div ref={ref} className="qa-mention-menu">{children}</div>
}

export function MentionsTypeahead({ provider }: MentionsPluginParams) {
  const [editor] = useLexicalComposerContext()
  const [query, setQuery] = useState<string | null>(null)
  const [staticItems, setStaticItems] = useState<MentionItem[]>([])
  const [remoteItems, setRemoteItems] = useState<MentionItem[]>([])
  // The text of the mention we just inserted. The trigger regex allows spaces
  // (multi-word titles), so without this the menu would reopen on "@Inserted Title ".
  const lastInserted = useRef<string | null>(null)
  const requestSeq = useRef(0)

  const baseTrigger = useBasicTypeaheadTriggerMatch('@', {
    minLength: 0,
    maxLength: 60,
    punctuation: MENTION_PUNCTUATION,
    allowWhitespace: true,
  })

  const triggerFn = useCallback((text: string, ed: typeof editor): MenuTextMatch | null => {
    const match = baseTrigger(text, ed)
    if (!match) return null
    // "@ 3pm" is prose, not a mention.
    if (/^\s/.test(match.matchingString)) return null
    if (lastInserted.current && match.replaceableString.startsWith(lastInserted.current)) return null
    return match
  }, [baseTrigger])

  const open = query !== null

  useEffect(() => {
    if (!open || !provider.loadStatic) return
    let cancelled = false
    provider.loadStatic().then(items => { if (!cancelled) setStaticItems(items) }).catch(() => {})
    return () => { cancelled = true }
  }, [open, provider])

  useEffect(() => {
    const q = query?.trim() ?? ''
    if (!provider.search) return
    if (!q) {
      requestSeq.current++
      setRemoteItems([])
      return
    }
    const seq = ++requestSeq.current
    const timer = setTimeout(() => {
      provider.search!(q)
        .then(items => { if (seq === requestSeq.current) setRemoteItems(items) })
        .catch(() => {})
    }, provider.debounceMs ?? 150)
    return () => clearTimeout(timer)
  }, [query, provider])

  // Previous remote results are re-filtered locally while the next request is
  // in flight, so narrowing the query never flashes an empty list.
  const options = useMemo(
    () => (query === null ? [] : buildOptions(provider, query, [...remoteItems, ...staticItems])),
    [provider, query, remoteItems, staticItems],
  )

  const onSelectOption = useCallback((option: MentionOption, nodeToReplace: TextNode | null, closeMenu: () => void) => {
    const text = `@${option.item.insertText}`
    editor.update(() => {
      // No trailing space: MDXEditor serialises a paragraph-final space as
      // `&#x20;`, which would litter the saved note when a mention ends a line.
      const node = $createTextNode(text)
      if (nodeToReplace) {
        node.setFormat(nodeToReplace.getFormat())
        node.setStyle(nodeToReplace.getStyle())
        nodeToReplace.replace(node)
      }
      node.select()
    })
    lastInserted.current = text
    closeMenu()
  }, [editor])

  const onClose = useCallback(() => {
    setQuery(null)
    setRemoteItems([])
  }, [])

  const groupLabel = useMemo(() => {
    const m = new Map<string, string>()
    for (const g of provider.groups) m.set(g.kind, g.label)
    return m
  }, [provider])

  return (
    <LexicalTypeaheadMenuPlugin<MentionOption>
      triggerFn={triggerFn}
      onQueryChange={q => {
        // triggerFn already rejected continuations of the last insert, so any
        // query that gets here is a fresh `@`.
        if (q !== null) lastInserted.current = null
        setQuery(q)
      }}
      onSelectOption={onSelectOption}
      onClose={onClose}
      options={options}
      commandPriority={COMMAND_PRIORITY_HIGH}
      anchorClassName="qa-mention-anchor"
      menuRenderFn={(anchorRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex, options: opts }) => {
        if (!anchorRef.current || opts.length === 0) return null
        return createPortal(
          <MentionMenu>
            {opts.map((opt, i) => {
              const showHeader = i === 0 || opts[i - 1].item.kind !== opt.item.kind
              return (
                <div key={opt.key}>
                  {showHeader && (
                    <div className="qa-mention-group">{groupLabel.get(opt.item.kind) ?? opt.item.kind}</div>
                  )}
                  <div
                    ref={opt.setRefElement}
                    role="option"
                    aria-selected={selectedIndex === i}
                    className={`qa-mention-item${selectedIndex === i ? ' selected' : ''}`}
                    onMouseEnter={() => setHighlightedIndex(i)}
                    // Keep focus (and the selection) in the editor.
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => {
                      setHighlightedIndex(i)
                      selectOptionAndCleanUp(opt)
                    }}
                  >
                    <span className="qa-mention-label">{opt.item.label}</span>
                    {opt.item.detail && <span className="qa-mention-detail">{opt.item.detail}</span>}
                  </div>
                </div>
              )
            })}
          </MentionMenu>,
          anchorRef.current,
        )
      }}
    />
  )
}
