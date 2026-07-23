import { Text } from 'react-native'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack'
import type { ComponentType } from 'react'
import type { RootTabParamList, TaskStackParamList } from './types'
import { colors } from '../theme'
import { PriorityScreen } from '../screens/PriorityScreen'
import { BacklogScreen, CodeScreen, ReadingScreen } from '../screens/lists'
import { TaskDetailScreen } from '../screens/TaskDetailScreen'
import { CreateTaskScreen } from '../screens/CreateTaskScreen'
import { MarkdownViewerScreen } from '../screens/MarkdownViewerScreen'
import { MarkdownEditorScreen } from '../screens/MarkdownEditorScreen'
import { TerminalListScreen } from '../screens/TerminalListScreen'
import { TerminalSessionScreen } from '../screens/TerminalSessionScreen'
import { CreateTerminalScreen } from '../screens/CreateTerminalScreen'
import { FileBrowserScreen } from '../screens/FileBrowserScreen'
import { ToolsScreen } from '../screens/ToolsScreen'
import { MoreScreen } from '../screens/MoreScreen'
import { DailyNoteScreen } from '../screens/DailyNoteScreen'
import { HabitsScreen } from '../screens/HabitsScreen'
import { SearchScreen } from '../screens/SearchScreen'
import { InstancesScreen } from '../screens/InstancesScreen'
import { AddInstanceScreen } from '../screens/AddInstanceScreen'
import { NavigationSettingsScreen } from '../screens/NavigationSettingsScreen'
import { isHidden, TAB_ROUTE, toolsLabelOrDefault, useNavConfig } from '../lib/navConfig'

const Stack = createNativeStackNavigator<TaskStackParamList>()
const Tab = createBottomTabNavigator<RootTabParamList>()

const stackScreenOptions: NativeStackNavigationOptions = {
  headerStyle: { backgroundColor: colors.surface },
  headerTintColor: colors.text,
  headerTitleStyle: { color: colors.text },
  contentStyle: { backgroundColor: colors.bg },
}

function AddButton({ onPress }: { onPress: () => void }) {
  return <Text onPress={onPress} style={{ color: colors.accent, fontSize: 28, paddingHorizontal: 6 }}>＋</Text>
}

/** A list → detail → create-task stack, parameterized by the list screen. */
function TaskStack({ list, title }: { list: ComponentType; title: string }) {
  return (
    <Stack.Navigator screenOptions={stackScreenOptions}>
      <Stack.Screen
        name="List"
        component={list}
        options={({ navigation }) => ({
          title,
          headerRight: () => <AddButton onPress={() => navigation.navigate('CreateTask')} />,
        })}
      />
      <Stack.Screen name="TaskDetail" component={TaskDetailScreen} options={{ title: 'Task' }} />
      <Stack.Screen name="CreateTask" component={CreateTaskScreen} options={{ title: 'New Task', presentation: 'modal' }} />
      <Stack.Screen name="MarkdownViewer" component={MarkdownViewerScreen} options={{ title: 'Document' }} />
      <Stack.Screen name="MarkdownEditor" component={MarkdownEditorScreen} options={{ title: 'Editor' }} />
    </Stack.Navigator>
  )
}

function PriorityStack() {
  return <TaskStack list={PriorityScreen} title="Priority" />
}
function ReadingStack() {
  return <TaskStack list={ReadingScreen} title="Reading" />
}
function SearchStack() {
  return <TaskStack list={SearchScreen} title="Search" />
}

function MoreStack() {
  return (
    <Stack.Navigator screenOptions={stackScreenOptions}>
      <Stack.Screen name="Menu" component={MoreScreen} options={{ title: 'More' }} />
      <Stack.Screen
        name="Backlog"
        component={BacklogScreen}
        options={({ navigation }) => ({ title: 'Backlog', headerRight: () => <AddButton onPress={() => navigation.navigate('CreateTask')} /> })}
      />
      <Stack.Screen
        name="Code"
        component={CodeScreen}
        options={({ navigation }) => ({ title: 'Code', headerRight: () => <AddButton onPress={() => navigation.navigate('CreateTask')} /> })}
      />
      <Stack.Screen name="DailyNote" component={DailyNoteScreen} options={{ title: 'Daily Note' }} />
      <Stack.Screen name="Habits" component={HabitsScreen} options={{ title: 'Habits' }} />
      <Stack.Screen name="Terminal" component={TerminalListScreen} options={{ title: 'Terminals' }} />
      <Stack.Screen name="TerminalSession" component={TerminalSessionScreen} options={{ title: 'Terminal' }} />
      <Stack.Screen name="CreateTerminal" component={CreateTerminalScreen} options={{ title: 'New Terminal' }} />
      <Stack.Screen name="FileBrowser" component={FileBrowserScreen} options={{ title: 'Files' }} />
      <Stack.Screen name="Instances" component={InstancesScreen} options={{ title: 'Backends' }} />
      <Stack.Screen name="AddInstance" component={AddInstanceScreen} options={{ title: 'Add Backend', presentation: 'modal' }} />
      <Stack.Screen name="NavigationSettings" component={NavigationSettingsScreen} options={{ title: 'Navigation' }} />
      <Stack.Screen name="TaskDetail" component={TaskDetailScreen} options={{ title: 'Task' }} />
      <Stack.Screen name="CreateTask" component={CreateTaskScreen} options={{ title: 'New Task', presentation: 'modal' }} />
      <Stack.Screen name="MarkdownViewer" component={MarkdownViewerScreen} options={{ title: 'Document' }} />
      <Stack.Screen name="MarkdownEditor" component={MarkdownEditorScreen} options={{ title: 'Editor' }} />
    </Stack.Navigator>
  )
}

function tabIcon(emoji: string) {
  return ({ color }: { color: string }) => <Text style={{ fontSize: 18, color }}>{emoji}</Text>
}

export function RootNavigator() {
  const navConfig = useNavConfig()
  // The landing tab is guaranteed visible by normalizeNavConfig, so
  // initialRouteName always points at a rendered screen.
  return (
    <Tab.Navigator
      initialRouteName={TAB_ROUTE[navConfig.landing]}
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted2,
      }}
    >
      {!isHidden(navConfig, 'priority') && (
        <Tab.Screen name="PriorityTab" component={PriorityStack} options={{ title: 'Priority', tabBarIcon: tabIcon('★') }} />
      )}
      {!isHidden(navConfig, 'search') && (
        <Tab.Screen name="SearchTab" component={SearchStack} options={{ title: 'Search', tabBarIcon: tabIcon('🔍') }} />
      )}
      {!isHidden(navConfig, 'reading') && (
        <Tab.Screen name="ReadingTab" component={ReadingStack} options={{ title: 'Reading', tabBarIcon: tabIcon('📖') }} />
      )}
      {/* Tools (boxWeb) is opt-in with a custom label — a per-backend nav preference,
          not a standard toggleable tab. */}
      {navConfig.toolsEnabled && (
        <Tab.Screen
          name="ToolsTab"
          component={ToolsScreen}
          options={{
            title: toolsLabelOrDefault(navConfig),
            headerShown: true,
            headerStyle: { backgroundColor: colors.surface },
            headerTintColor: colors.text,
            tabBarIcon: tabIcon('🧰'),
          }}
        />
      )}
      {/* The More tab is structural — it holds Backends, Disconnect, and Navigation
          settings — so it is always shown and can't be hidden. */}
      <Tab.Screen name="MoreTab" component={MoreStack} options={{ title: 'More', tabBarIcon: tabIcon('⋯') }} />
    </Tab.Navigator>
  )
}
