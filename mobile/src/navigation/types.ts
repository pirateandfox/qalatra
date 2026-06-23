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
}

export type ListProps = NativeStackScreenProps<TaskStackParamList, 'List'>
export type TaskDetailProps = NativeStackScreenProps<TaskStackParamList, 'TaskDetail'>
export type CreateTaskProps = NativeStackScreenProps<TaskStackParamList, 'CreateTask'>
export type MarkdownViewerProps = NativeStackScreenProps<TaskStackParamList, 'MarkdownViewer'>

export type RootTabParamList = {
  PriorityTab: undefined
  SearchTab: undefined
  ReadingTab: undefined
  ToolsTab: undefined
  MoreTab: undefined
}
