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
  TaskDetail: { taskId: string }
  CreateTask: undefined
}

export type ListProps = NativeStackScreenProps<TaskStackParamList, 'List'>
export type TaskDetailProps = NativeStackScreenProps<TaskStackParamList, 'TaskDetail'>
export type CreateTaskProps = NativeStackScreenProps<TaskStackParamList, 'CreateTask'>

export type RootTabParamList = {
  PriorityTab: undefined
  ReadingTab: undefined
  ToolsTab: undefined
  MoreTab: undefined
}
