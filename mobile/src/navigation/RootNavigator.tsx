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
import { ToolsScreen } from '../screens/ToolsScreen'
import { MoreScreen } from '../screens/MoreScreen'
import { DailyNoteScreen } from '../screens/DailyNoteScreen'
import { HabitsScreen } from '../screens/HabitsScreen'

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
    </Stack.Navigator>
  )
}

function PriorityStack() {
  return <TaskStack list={PriorityScreen} title="Priority" />
}
function ReadingStack() {
  return <TaskStack list={ReadingScreen} title="Reading" />
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
      <Stack.Screen name="TaskDetail" component={TaskDetailScreen} options={{ title: 'Task' }} />
      <Stack.Screen name="CreateTask" component={CreateTaskScreen} options={{ title: 'New Task', presentation: 'modal' }} />
    </Stack.Navigator>
  )
}

function tabIcon(emoji: string) {
  return ({ color }: { color: string }) => <Text style={{ fontSize: 18, color }}>{emoji}</Text>
}

export function RootNavigator() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted2,
      }}
    >
      <Tab.Screen name="PriorityTab" component={PriorityStack} options={{ title: 'Priority', tabBarIcon: tabIcon('★') }} />
      <Tab.Screen name="ReadingTab" component={ReadingStack} options={{ title: 'Reading', tabBarIcon: tabIcon('📖') }} />
      <Tab.Screen
        name="ToolsTab"
        component={ToolsScreen}
        options={{
          title: 'Tools',
          headerShown: true,
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.text,
          tabBarIcon: tabIcon('🧰'),
        }}
      />
      <Tab.Screen name="MoreTab" component={MoreStack} options={{ title: 'More', tabBarIcon: tabIcon('⋯') }} />
    </Tab.Navigator>
  )
}
