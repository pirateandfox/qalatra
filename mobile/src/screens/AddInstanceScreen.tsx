import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { TaskStackParamList } from '../navigation/types'
import { Screen } from '../components/ui'
import { ConnectForm } from '../components/ConnectForm'

type Props = NativeStackScreenProps<TaskStackParamList, 'AddInstance'>

export function AddInstanceScreen({ navigation }: Props) {
  return (
    <Screen>
      <ConnectForm
        title="Connect another server"
        subtitle="Add a Qalatra server using its URL and access token."
        onConnected={() => navigation.goBack()}
      />
    </Screen>
  )
}
