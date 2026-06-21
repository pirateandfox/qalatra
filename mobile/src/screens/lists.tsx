import { fetchBacklog, fetchCodingTasks, fetchReadingTasks } from '@qalatra/shared'
import { TaskListView } from '../components/TaskListView'

export function ReadingScreen() {
  return <TaskListView loader={fetchReadingTasks} emptyMessage="No reading items." />
}

export function BacklogScreen() {
  return <TaskListView loader={fetchBacklog} emptyMessage="Backlog is empty." />
}

export function CodeScreen() {
  return <TaskListView loader={fetchCodingTasks} emptyMessage="No coding tasks." />
}
