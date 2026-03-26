import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { oneDark } from '@codemirror/theme-one-dark'

export interface MarkdownEditorHandle {
  insertPageBreak: () => void
}

interface Props {
  value: string
  onChange: (value: string) => void
  wordCount: number
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, Props>(
  function MarkdownEditor({ value, onChange, wordCount }, ref) {
    const editorRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    const onChangeRef = useRef(onChange)
    onChangeRef.current = onChange

    useImperativeHandle(ref, () => ({
      insertPageBreak() {
        const view = viewRef.current
        if (!view) return
        const { from } = view.state.selection.main
        // Find end of current line
        const line = view.state.doc.lineAt(from)
        const insert = `\n\n<!-- pagebreak -->\n\n`
        view.dispatch({
          changes: { from: line.to, insert },
          selection: { anchor: line.to + insert.length },
        })
        view.focus()
      },
    }))

    useEffect(() => {
      if (!editorRef.current) return

      const view = new EditorView({
        state: EditorState.create({
          doc: value,
          extensions: [
            history(),
            lineNumbers(),
            highlightActiveLine(),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            markdown({ base: markdownLanguage, codeLanguages: languages }),
            oneDark,
            keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
            EditorView.lineWrapping,
            EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                onChangeRef.current(update.state.doc.toString())
              }
            }),
            EditorView.theme({
              '&': { height: '100%', background: '#1e1e21' },
              '.cm-scroller': {
                overflow: 'auto',
                fontFamily: "'Fira Code', 'Courier New', monospace",
              },
              '.cm-content': { padding: '12px 0' },
              '.cm-line': { padding: '0 16px' },
              '.cm-gutters': { background: '#1a1a1d', borderRight: '1px solid #27272a' },
              '.cm-lineNumbers .cm-gutterElement': { color: '#52525b', minWidth: '40px' },
              '.cm-activeLine': { background: '#ffffff08' },
              '.cm-activeLineGutter': { background: '#ffffff08' },
            }),
          ],
        }),
        parent: editorRef.current,
      })

      viewRef.current = view
      return () => {
        view.destroy()
        viewRef.current = null
      }
    }, [])

    // Sync external value changes (e.g. when file is opened)
    useEffect(() => {
      const view = viewRef.current
      if (!view) return
      const current = view.state.doc.toString()
      if (current !== value) {
        view.dispatch({
          changes: { from: 0, to: current.length, insert: value },
        })
      }
    }, [value])

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          overflow: 'hidden',
        }}
      >
        <div className="editor-header">
          <span>Markdown</span>
          <span style={{ marginLeft: 'auto', color: '#52525b' }}>{wordCount} words</span>
        </div>
        <div
          ref={editorRef}
          style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
        />
      </div>
    )
  }
)
