import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { fetchDailyNote, saveDailyNote } from '../api'
import {
  MDXEditor,
  type MDXEditorMethods,
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  CodeToggle,
  CreateLink,
  DiffSourceToggleWrapper,
  InsertCodeBlock,
  InsertTable,
  InsertThematicBreak,
  ListsToggle,
  Separator,
  UndoRedo,
  codeBlockPlugin,
  codeMirrorPlugin,
  diffSourcePlugin,
  headingsPlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
} from '@mdxeditor/editor'
import '@mdxeditor/editor/style.css'
import './DailyNote.css'

interface Props {
  date: string
  refreshToken?: number
}

const CODE_BLOCK_LANGUAGES = {
  txt: 'Plain text',
  markdown: 'Markdown',
  js: 'JavaScript',
  jsx: 'JSX',
  ts: 'TypeScript',
  tsx: 'TSX',
  bash: 'Bash',
  json: 'JSON',
  html: 'HTML',
  css: 'CSS',
  sql: 'SQL',
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export default function DailyNote({ date, refreshToken = 0 }: Props) {
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSave = useRef<{ date: string; text: string } | null>(null)
  const lastSaved = useRef<Record<string, string>>({})
  const editorRef = useRef<MDXEditorMethods>(null)

  const plugins = useMemo(() => [
    headingsPlugin(),
    listsPlugin(),
    quotePlugin(),
    thematicBreakPlugin(),
    linkPlugin(),
    linkDialogPlugin(),
    tablePlugin(),
    codeBlockPlugin({ defaultCodeBlockLanguage: 'txt' }),
    codeMirrorPlugin({ codeBlockLanguages: CODE_BLOCK_LANGUAGES, autoLoadLanguageSupport: false }),
    diffSourcePlugin({ viewMode: 'rich-text' }),
    markdownShortcutPlugin(),
    toolbarPlugin({
      toolbarContents: () => (
        <DiffSourceToggleWrapper options={['rich-text', 'source']}>
          <UndoRedo />
          <Separator />
          <BlockTypeSelect />
          <BoldItalicUnderlineToggles />
          <CodeToggle />
          <Separator />
          <ListsToggle options={['bullet', 'number', 'check']} />
          <Separator />
          <CreateLink />
          <InsertTable />
          <InsertCodeBlock />
          <InsertThematicBreak />
        </DiffSourceToggleWrapper>
      ),
    }),
  ], [])

  const save = useCallback(async (targetDate: string, text: string) => {
    if (text === (lastSaved.current[targetDate] ?? '')) return
    setSaving(true)
    try {
      await saveDailyNote(targetDate, text)
      lastSaved.current[targetDate] = text
      setError(null)
    } catch (err: unknown) {
      setError(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }, [])

  const flushSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    const pending = pendingSave.current
    pendingSave.current = null
    if (pending) void save(pending.date, pending.text)
  }, [save])

  const scheduleSave = useCallback((targetDate: string, text: string) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    pendingSave.current = { date: targetDate, text }
    saveTimer.current = setTimeout(() => {
      const pending = pendingSave.current
      pendingSave.current = null
      if (pending) void save(pending.date, pending.text)
    }, 800)
  }, [save])

  useEffect(() => {
    flushSave()
    let cancelled = false
    setLoading(true)
    setError(null)

    fetchDailyNote(date).then(r => {
      if (cancelled) return
      setContent(r.content)
      lastSaved.current[date] = r.content
      editorRef.current?.setMarkdown(r.content)
      setTimeout(() => editorRef.current?.focus(undefined, { defaultSelection: 'rootEnd', preventScroll: true }), 50)
    }).catch((err: unknown) => {
      if (!cancelled) setError(getErrorMessage(err))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })

    return () => { cancelled = true }
  }, [date, refreshToken, flushSave])

  useEffect(() => () => flushSave(), [flushSave])

  function handleChange(markdown: string, initialMarkdownNormalize: boolean) {
    setContent(markdown)
    if (!initialMarkdownNormalize) scheduleSave(date, markdown)
  }

  const wordCount = countWords(content)

  return (
    <div className="daily-note-view">
      <div className="daily-note-header">
        <div>
          <h1>Daily Note</h1>
          <div className="daily-note-date">{date}</div>
        </div>
        <div className="daily-note-meta">
          {loading && <span>Loading...</span>}
          {!loading && saving && <span>Saving...</span>}
          {!loading && !saving && error && <span className="daily-note-error">Save failed</span>}
          {!loading && !saving && !error && <span>{wordCount} words</span>}
        </div>
      </div>
      <div className="daily-note-editor-shell">
        <MDXEditor
          ref={editorRef}
          markdown={content}
          className="daily-note-editor"
          contentEditableClassName="daily-note-content"
          autoFocus={{ defaultSelection: 'rootEnd', preventScroll: true }}
          onChange={handleChange}
          onBlur={flushSave}
          onError={payload => setError(payload.error)}
          placeholder="What's on your mind today? Jot down thoughts, context, intentions..."
          plugins={plugins}
          spellCheck
        />
      </div>
    </div>
  )
}
