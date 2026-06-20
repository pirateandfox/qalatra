import { useWindowDimensions } from 'react-native'

/**
 * Adaptive layout, driven by available WIDTH — never `Platform.isPad`, so iPad
 * Split View / Slide Over (which makes an iPad narrow) correctly collapses to the
 * compact phone layout, and a large phone in landscape can go two-pane.
 */
export function useLayout() {
  const { width, height } = useWindowDimensions()
  return {
    width,
    height,
    /** Master-detail when there's room; stacked navigation otherwise. */
    twoPane: width >= 768,
  }
}
