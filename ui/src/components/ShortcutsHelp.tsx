import './ShortcutsHelp.css'

const SECTIONS = [
  {
    title: 'Navigation',
    rows: [
      ['1 – 7', 'Jump to sidebar section (Priority → Heartbeats)'],
      ['d', 'Open Daily Note'],
      [', (comma)', 'Toggle Settings'],
      ['t', 'Toggle terminal'],
      ['Ctrl+`', 'Toggle terminal (alternative)'],
    ],
  },
  {
    title: 'Tasks',
    rows: [
      ['j / k', 'Select next / previous task'],
      ['n', 'New task'],
      ['c', 'Complete selected task'],
      ['b', 'Move selected task to backlog'],
      ['r', 'Refresh current view'],
      ['Escape', 'Close panel / dismiss dialog'],
    ],
  },
  {
    title: 'Help',
    rows: [
      ['?', 'Show / hide this reference'],
    ],
  },
]

interface Props {
  onClose: () => void
}

export default function ShortcutsHelp({ onClose }: Props) {
  return (
    <div className="shortcuts-overlay" onClick={onClose}>
      <div className="shortcuts-card" onClick={e => e.stopPropagation()}>
        <div className="shortcuts-header">
          <span className="shortcuts-title">Keyboard Shortcuts</span>
          <button className="shortcuts-close" onClick={onClose}>✕</button>
        </div>
        <div className="shortcuts-body">
          {SECTIONS.map(section => (
            <div key={section.title} className="shortcuts-section">
              <div className="shortcuts-section-title">{section.title}</div>
              <table className="shortcuts-table">
                <tbody>
                  {section.rows.map(([key, desc]) => (
                    <tr key={key}>
                      <td className="shortcuts-key"><kbd>{key}</kbd></td>
                      <td className="shortcuts-desc">{desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
