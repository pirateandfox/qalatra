// Must be the very first import — sets up gesture handling for React Navigation
// (required on the New Architecture for touch/scroll to reach screen content).
import 'react-native-gesture-handler'

import { registerRootComponent } from 'expo'
import App from './App'

registerRootComponent(App)
