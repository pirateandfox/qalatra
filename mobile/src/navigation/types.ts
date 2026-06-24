import type { NativeStackScreenProps } from '@react-navigation/native-stack'

/** Every section tab is a stack with the same shape: a list, a task detail, and
 *  a create-task modal. */
export type TaskStackParamList = {
  List: undefined
  Menu: undefined
  Backlog: undefined
  Code: undefined
  DailyNote: undefined
  Habits: undefined
  Instances: undefined
  AddInstance: undefined
  TaskDetail: { taskId: string }
  CreateTask: undefined
  MarkdownViewer: { path: string; title?: string }
  MarkdownEditor: { path: string; title?: string }
  Terminal: undefined
  TerminalSession: { sessionId: string; title?: string }
  CreateTerminal: undefined
  FileBrowser: { path?: string; title?: string } | undefined
}

export type ListProps = NativeStackScreenProps<TaskStackParamList, 'List'>
export type TaskDetailProps = NativeStackScreenProps<TaskStackParamList, 'TaskDetail'>
export type CreateTaskProps = NativeStackScreenProps<TaskStackParamList, 'CreateTask'>
export type MarkdownViewerProps = NativeStackScreenProps<TaskStackParamList, 'MarkdownViewer'>
export type MarkdownEditorProps = NativeStackScreenProps<TaskStackParamList, 'MarkdownEditor'>
export type TerminalListProps = NativeStackScreenProps<TaskStackParamList, 'Terminal'>
export type TerminalSessionProps = NativeStackScreenProps<TaskStackParamList, 'TerminalSession'>
export type CreateTerminalProps = NativeStackScreenProps<TaskStackParamList, 'CreateTerminal'>
export type FileBrowserProps = NativeStackScreenProps<TaskStackParamList, 'FileBrowser'>

export type RootTabParamList = {
  PriorityTab: undefined
  SearchTab: undefined
  ReadingTab: undefined
  ToolsTab: undefined
  MoreTab: undefined
}
