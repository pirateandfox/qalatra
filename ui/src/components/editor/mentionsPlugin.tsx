// MDXEditor plugin wrapper for the @mention typeahead (see MentionsTypeahead.tsx).
// Reusable by any MDXEditor instance; currently enabled only in DailyNote.

import { addComposerChild$, realmPlugin } from '@mdxeditor/editor'
import { MentionsTypeahead, type MentionsPluginParams } from './MentionsTypeahead'

export type { MentionItem, MentionProvider, MentionsPluginParams } from './MentionsTypeahead'

/** MDXEditor plugin: `@` opens a typeahead fed by `provider`. */
export const mentionsPlugin = realmPlugin<MentionsPluginParams>({
  init(realm, params) {
    if (!params?.provider) return
    const provider = params.provider
    realm.pubIn({
      [addComposerChild$]: () => <MentionsTypeahead provider={provider} />,
    })
  },
})
